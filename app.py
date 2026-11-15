"""Energy app: a small read-only web app (PWA) for a home energy system.

It shows what the house is doing now and how today went, from a TimescaleDB that another service
fills. It never talks to a device and never writes: it connects with a read-only database role and
reads views only (app_live, app_today, app_battery_savings_today, app_forecast, app_battery_* for
the Batterij screen) and four read-only functions (app_history for Historie, app_money for Geld,
app_contracts for Contracten, app_meer for Meer). All calculation rules live in those views, so the numbers match whatever else
reads the same database.

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
# The Batterij screen's day chart, counters and efficiency change slowly: read at most this often.
BATTERY_INTERVAL = float(os.environ.get("BATTERY_INTERVAL", "60"))
# A Historie answer (one week, month or year) is kept this long; past periods hardly change.
HISTORY_MAX_AGE = float(os.environ.get("HISTORY_MAX_AGE", "300"))
HISTORY_UNITS = ("day", "week", "month", "year")
# The Geld screen (app_money) is re-read at most this often.
MONEY_INTERVAL = float(os.environ.get("MONEY_INTERVAL", "60"))


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
    for key in ("day", "period", "battery", "money", "plugs", "tech", "car"):
        url = os.environ.get(f"LINK_{key.upper()}", "").strip()
        if url:
            links[key] = url
    return {
        "links": links,
        "plugLabels": parse_labels(os.environ.get("PLUG_LABELS", "")),
        # Site-specific lines for the forecast's info sheet (roof planes, location used, measured
        # accuracy); each one is left out when unset.
        "forecastNotes": {key: os.environ[env].strip() for key, env in (
            ("planes", "FORECAST_PLANES"), ("location", "FORECAST_LOCATION"),
            ("accuracy", "FORECAST_ACCURACY")) if os.environ.get(env, "").strip()},
        "timeZone": os.environ.get("TZ", "Europe/Amsterdam"),
        "liveInterval": LIVE_INTERVAL,
        "todayInterval": TODAY_INTERVAL,
        "batteryInterval": BATTERY_INTERVAL,
        # What the battery cost, for the payback bar on the Geld screen; no bar when unset.
        "batteryPriceEur": float(os.environ["BATTERY_PRICE_EUR"]) if os.environ.get("BATTERY_PRICE_EUR", "").strip() else None,
        # Ages after which a source counts as stale on the status sheet, in seconds.
        "staleAfter": {"p1": 60, "battery": 60, "gas": 1200, "plug": 900, "outdoor": 10800,
                       "forecast": 10800},
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
        self.battery: dict | None = None
        self.battery_read_at = 0.0
        self.history: dict[tuple, tuple[float, dict]] = {}
        self.money: dict | None = None
        self.money_read_at = 0.0
        self.contracts: dict | None = None
        self.contracts_read_at = 0.0
        self.meer: dict | None = None
        self.meer_read_at = 0.0
        self.last_ok = 0.0
        self.last_error: str | None = None
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()

    async def _query_all(self, sql: str) -> list[dict]:
        async with self.pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql)
                return await cur.fetchall()

    async def _query_one(self, sql: str, params: dict | None = None) -> dict | None:
        async with self.pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql, params)
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
            self.today = {"ok": True, "data": today, "savings": savings,
                          "forecast": await self._read_forecast()}
            self.last_ok = time.monotonic()
            self.last_error = None
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            log.warning("today read failed: %s", self.last_error)
            old = self.today or {}
            self.today = {"ok": False, "data": old.get("data"), "savings": old.get("savings"),
                          "forecast": old.get("forecast")}
        self.today_read_at = time.monotonic()

    async def _read_forecast(self) -> dict | None:
        """The solar forecast is an extra: a missing or failing view must not take today down."""
        try:
            return await self._query_one("SELECT * FROM app_forecast")
        except Exception as exc:
            log.warning("forecast read failed: %s: %s", type(exc).__name__, exc)
            return (self.today or {}).get("forecast")

    async def refresh_battery(self) -> None:
        """The Batterij screen: today's charge level, counters and health, efficiency per band.
        Read on request only (no screen open, no reads), at most every BATTERY_INTERVAL seconds."""
        try:
            self.battery = {
                "ok": True,
                "soc": await self._query_all("SELECT * FROM app_battery_soc_today"),
                "summary": await self._query_one("SELECT * FROM app_battery_summary"),
                "efficiency": await self._query_all("SELECT * FROM app_battery_efficiency"),
            }
            # the chart's x axis: local midnight to midnight (23 or 25 hours on a clock change)
            self.battery.update(await self._query_one(
                "SELECT date_trunc('day', now()) AS day_start, date_trunc('day', now()) + interval '1 day' AS day_end"))
        except Exception as exc:
            log.warning("battery read failed: %s: %s", type(exc).__name__, exc)
            old = self.battery or {}
            self.battery = {"ok": False, "soc": old.get("soc"), "summary": old.get("summary"),
                            "efficiency": old.get("efficiency"), "day_start": old.get("day_start"),
                            "day_end": old.get("day_end")}
        self.battery_read_at = time.monotonic()

    async def read_history(self, unit: str, anchor: dt.date) -> dict:
        """One week, month or year for the Historie screen, from app_history() (all rules in SQL).
        Cached per (unit, anchor) for HISTORY_MAX_AGE seconds; at most 32 entries."""
        key = (unit, anchor)
        now = time.monotonic()
        hit = self.history.get(key)
        # a period that is still running changes every minute; a past one hardly at all
        max_age = 60 if hit and (hit[1].get("data") or {}).get("running") else HISTORY_MAX_AGE
        if hit and now - hit[0] < max_age:
            return hit[1]
        try:
            row = await self._query_one("SELECT app_history(%(u)s, %(a)s) AS h", {"u": unit, "a": anchor})
            result = {"ok": True, "data": row["h"] if row else None}
        except Exception as exc:
            log.warning("history read failed: %s: %s", type(exc).__name__, exc)
            return {"ok": False, "data": hit[1]["data"] if hit else None}
        if len(self.history) >= 32:
            self.history.pop(min(self.history, key=lambda k: self.history[k][0]))
        self.history[key] = (now, result)
        return result

    async def read_money(self) -> dict:
        """The Geld screen, from app_money() (rules in SQL), at most every MONEY_INTERVAL seconds."""
        async with self.lock:
            if self.money and self.money["ok"] and time.monotonic() - self.money_read_at < MONEY_INTERVAL:
                return self.money
            try:
                row = await self._query_one("SELECT app_money() AS m")
                self.money = {"ok": True, "data": row["m"] if row else None}
            except Exception as exc:
                log.warning("money read failed: %s: %s", type(exc).__name__, exc)
                self.money = {"ok": False, "data": (self.money or {}).get("data")}
            self.money_read_at = time.monotonic()
            return self.money

    async def read_contracts(self) -> dict:
        """The Contracten page, from app_contracts(); contracts change rarely, so at most every
        MONEY_INTERVAL × 5 seconds (5 minutes by default)."""
        async with self.lock:
            if self.contracts and self.contracts["ok"] and time.monotonic() - self.contracts_read_at < MONEY_INTERVAL * 5:
                return self.contracts
            try:
                row = await self._query_one("SELECT app_contracts() AS c")
                self.contracts = {"ok": True, "data": row["c"] if row else None}
            except Exception as exc:
                log.warning("contracts read failed: %s: %s", type(exc).__name__, exc)
                self.contracts = {"ok": False, "data": (self.contracts or {}).get("data")}
            self.contracts_read_at = time.monotonic()
            return self.contracts

    async def read_meer(self) -> dict:
        """The Meer screen (base load, plugs today, car this year, source status), from app_meer(),
        at most every MONEY_INTERVAL seconds."""
        async with self.lock:
            if self.meer and self.meer["ok"] and time.monotonic() - self.meer_read_at < MONEY_INTERVAL:
                return self.meer
            try:
                row = await self._query_one("SELECT app_meer() AS m")
                self.meer = {"ok": True, "data": row["m"] if row else None}
            except Exception as exc:
                log.warning("meer read failed: %s: %s", type(exc).__name__, exc)
                self.meer = {"ok": False, "data": (self.meer or {}).get("data")}
            self.meer_read_at = time.monotonic()
            return self.meer

    async def ensure_fresh(self, kind: str) -> None:
        """For plain API calls: re-read only when the cached value is older than API_MIN_AGE."""
        async with self.lock:
            now = time.monotonic()
            if kind == "live" and (self.live is None or now - self.live_read_at > API_MIN_AGE):
                await self.refresh_live()
            if kind == "today" and (self.today is None or now - self.today_read_at > TODAY_INTERVAL):
                await self.refresh_today()
            if kind == "battery" and (self.battery is None or not self.battery["ok"]
                                      or now - self.battery_read_at > BATTERY_INTERVAL):
                await self.refresh_battery()

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


async def api_battery(request: Request) -> Response:
    await hub.ensure_fresh("battery")
    return Response(to_json(hub.battery), media_type="application/json", headers={"Cache-Control": "no-store"})


async def api_history(request: Request) -> Response:
    unit = request.query_params.get("unit", "month")
    if unit not in HISTORY_UNITS:
        return JSONResponse({"ok": False, "error": "unit must be day, week, month or year"}, status_code=400)
    try:
        anchor = dt.date.fromisoformat(request.query_params.get("date", "")) if request.query_params.get("date") else dt.date.today()
    except ValueError:
        return JSONResponse({"ok": False, "error": "date must be YYYY-MM-DD"}, status_code=400)
    result = await hub.read_history(unit, anchor)
    return Response(to_json(result), media_type="application/json", headers={"Cache-Control": "no-store"})


async def api_money(request: Request) -> Response:
    return Response(to_json(await hub.read_money()), media_type="application/json", headers={"Cache-Control": "no-store"})


async def api_contracts(request: Request) -> Response:
    return Response(to_json(await hub.read_contracts()), media_type="application/json", headers={"Cache-Control": "no-store"})


async def api_meer(request: Request) -> Response:
    return Response(to_json(await hub.read_meer()), media_type="application/json", headers={"Cache-Control": "no-store"})


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


class RevalidatedStatic(StaticFiles):
    """Static files that the browser must check before reusing. Without a Cache-Control header,
    browsers (Safari especially) keep app.js/app.css for a guessed time, and a new page could run
    with yesterday's script. Checking is cheap: unchanged files answer 304 on their ETag."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


routes = [
    Route("/", index),
    Route("/api/config", api_config),
    Route("/api/live", api_live),
    Route("/api/today", api_today),
    Route("/api/battery", api_battery),
    Route("/api/history", api_history),
    Route("/api/money", api_money),
    Route("/api/contracts", api_contracts),
    Route("/api/meer", api_meer),
    Route("/api/stream", api_stream),
    Route("/healthz", healthz),
    Route("/manifest.webmanifest", manifest),
    Route("/sw.js", service_worker),
    Mount("/static", RevalidatedStatic(directory=STATIC_DIR), name="static"),
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
