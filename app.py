"""Energy app: a small read-only web app (PWA) for a home energy system.

It shows what the house is doing now and how today went, from a TimescaleDB that another service
fills. It never talks to a device and never writes: it connects with a read-only database role and
reads three views (app_live, app_today, app_battery_savings_today). All calculation rules live in
those views, so the numbers match whatever else reads the same database.

One reader serves every open screen: a background task reads the live view every LIVE_INTERVAL
seconds and the day views every TODAY_INTERVAL seconds, but only while at least one screen is
connected, and pushes the result to all of them over Server-Sent Events (/api/stream). Ten open
screens cost the database the same as one.
"""

import asyncio
import datetime as dt
import decimal
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

log = logging.getLogger("energy-app")

STATIC_DIR = Path(__file__).parent / "static"
LIVE_INTERVAL = float(os.environ.get("LIVE_INTERVAL", "5"))
TODAY_INTERVAL = float(os.environ.get("TODAY_INTERVAL", "60"))
# Seconds between SSE comment lines, so proxies don't close an idle stream.
HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL", "15"))
# A plain GET of /api/live or /api/today re-reads the database at most this often.
API_MIN_AGE = float(os.environ.get("API_MIN_AGE", "4"))


def conninfo() -> str:
    parts = {
        "host": os.environ.get("DB_HOST", "localhost"),
        "port": os.environ.get("DB_PORT", "5432"),
        "dbname": os.environ.get("DB_NAME", "energy"),
        "user": os.environ.get("DB_USER", "energy_app"),
        "password": os.environ.get("DB_PASSWORD", ""),
        "application_name": "energy-app",
        "connect_timeout": "5",
    }
    return " ".join(f"{k}='{v}'" for k, v in parts.items() if v != "")


def parse_labels(raw: str) -> dict:
    """PLUG_LABELS="tv=TV,router=Router" -> {"tv": "TV", "router": "Router"}."""
    out = {}
    for item in raw.split(","):
        if "=" in item:
            key, label = item.split("=", 1)
            if key.strip():
                out[key.strip()] = label.strip()
    return out


def client_config() -> dict:
    """Site-specific settings for the page, all from the environment (none are secret)."""
    links = {}
    for key in ("day", "period", "battery", "money", "plugs", "tech"):
        url = os.environ.get(f"LINK_{key.upper()}", "").strip()
        if url:
            links[key] = url
    return {
        "links": links,
        "plugLabels": parse_labels(os.environ.get("PLUG_LABELS", "")),
        "timeZone": os.environ.get("TZ", "Europe/Amsterdam"),
        "liveInterval": LIVE_INTERVAL,
        "todayInterval": TODAY_INTERVAL,
        # Ages after which a source counts as stale on the status sheet, in seconds.
        "staleAfter": {"p1": 60, "battery": 60, "gas": 1200, "plug": 900, "outdoor": 10800},
    }


def to_json(value) -> str:
    def default(o):
        if isinstance(o, (dt.datetime, dt.date)):
            return o.isoformat()
        if isinstance(o, decimal.Decimal):
            return float(o)
        raise TypeError(f"not JSON serialisable: {type(o).__name__}")

    return json.dumps(value, default=default, separators=(",", ":"))


class Hub:
    """Holds the newest readings and fans them out to connected screens."""

    def __init__(self, pool: AsyncConnectionPool):
        self.pool = pool
        self.subscribers: set[asyncio.Queue] = set()
        self.live: dict | None = None
        self.today: dict | None = None
        self.live_read_at = 0.0
        self.today_read_at = 0.0
        self.last_ok = 0.0
        self.last_error: str | None = None
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()

    async def _query_one(self, sql: str) -> dict | None:
        async with self.pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql)
                return await cur.fetchone()

    async def refresh_live(self) -> None:
        try:
            row = await self._query_one("SELECT * FROM app_live")
            self.live = {"ok": True, "data": row}
            self.last_ok = time.monotonic()
            self.last_error = None
        except Exception as exc:  # report, keep the last good values, try again next round
            self.last_error = f"{type(exc).__name__}: {exc}"
            log.warning("live read failed: %s", self.last_error)
            self.live = {"ok": False, "data": (self.live or {}).get("data")}
        self.live_read_at = time.monotonic()

    async def refresh_today(self) -> None:
        try:
            today = await self._query_one("SELECT * FROM app_today")
            savings = await self._query_one("SELECT * FROM app_battery_savings_today")
            self.today = {"ok": True, "data": today, "savings": savings}
            self.last_ok = time.monotonic()
            self.last_error = None
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            log.warning("today read failed: %s", self.last_error)
            old = self.today or {}
            self.today = {"ok": False, "data": old.get("data"), "savings": old.get("savings")}
        self.today_read_at = time.monotonic()

    async def ensure_fresh(self, kind: str) -> None:
        """For plain API calls: re-read only when the cached value is older than API_MIN_AGE."""
        async with self.lock:
            now = time.monotonic()
            if kind == "live" and (self.live is None or now - self.live_read_at > API_MIN_AGE):
                await self.refresh_live()
            if kind == "today" and (self.today is None or now - self.today_read_at > TODAY_INTERVAL):
                await self.refresh_today()

    def broadcast(self, event: str, payload: dict) -> None:
        message = f"event: {event}\ndata: {to_json(payload)}\n\n"
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # A screen that can't keep up skips this update; the next one replaces it anyway.
                pass

    async def run(self) -> None:
        """Background loop: reads only while screens are connected."""
        while True:
            if not self.subscribers:
                self.wake.clear()
                await self.wake.wait()
            async with self.lock:
                now = time.monotonic()
                if now - self.today_read_at >= TODAY_INTERVAL or self.today is None:
                    await self.refresh_today()
                    self.broadcast("today", self.today)
                await self.refresh_live()
                self.broadcast("live", self.live)
            await asyncio.sleep(LIVE_INTERVAL)


hub: Hub | None = None


@asynccontextmanager
async def lifespan(app: Starlette):
    global hub
    pool = AsyncConnectionPool(
        conninfo(), min_size=0, max_size=int(os.environ.get("DB_POOL_SIZE", "2")),
        open=False, timeout=4, reconnect_timeout=0,
    )
    await pool.open(wait=False)
    hub = Hub(pool)
    task = asyncio.create_task(hub.run())
    try:
        yield
    finally:
        task.cancel()
        await pool.close()


async def index(request: Request) -> Response:
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


async def api_config(request: Request) -> Response:
    return JSONResponse(client_config(), headers={"Cache-Control": "no-cache"})


async def api_live(request: Request) -> Response:
    await hub.ensure_fresh("live")
    return Response(to_json(hub.live), media_type="application/json", headers={"Cache-Control": "no-store"})


async def api_today(request: Request) -> Response:
    await hub.ensure_fresh("today")
    return Response(to_json(hub.today), media_type="application/json", headers={"Cache-Control": "no-store"})


async def api_stream(request: Request) -> Response:
    queue: asyncio.Queue = asyncio.Queue(maxsize=8)

    async def events():
        hub.subscribers.add(queue)
        hub.wake.set()
        try:
            # Whatever is cached goes out at once, so a new screen isn't blank for a round.
            if hub.today is not None:
                yield f"event: today\ndata: {to_json(hub.today)}\n\n"
            if hub.live is not None:
                yield f"event: live\ndata: {to_json(hub.live)}\n\n"
            yield f"retry: {int(LIVE_INTERVAL * 1000)}\n\n"
            while True:
                try:
                    yield await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_INTERVAL)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            hub.subscribers.discard(queue)

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


async def healthz(request: Request) -> Response:
    """200 when the database answers; used by the image's HEALTHCHECK."""
    try:
        await hub._query_one("SELECT 1 AS ok")
        return JSONResponse({"ok": True})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": type(exc).__name__}, status_code=503)


async def manifest(request: Request) -> Response:
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


async def service_worker(request: Request) -> Response:
    # Served from the root so its scope is the whole app; never cached by the browser itself.
    return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache"})


routes = [
    Route("/", index),
    Route("/api/config", api_config),
    Route("/api/live", api_live),
    Route("/api/today", api_today),
    Route("/api/stream", api_stream),
    Route("/healthz", healthz),
    Route("/manifest.webmanifest", manifest),
    Route("/sw.js", service_worker),
    Mount("/static", StaticFiles(directory=STATIC_DIR), name="static"),
]

app = Starlette(routes=routes, lifespan=lifespan)


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(
        app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")),
        proxy_headers=True, forwarded_allow_ips="*", access_log=False,
        # Open event streams never end by themselves; don't let them hold up a stop.
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()
