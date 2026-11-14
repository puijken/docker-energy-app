#!/usr/bin/env bash
# Smoke test: run IMAGE against a throwaway Postgres holding stand-in views (tests/fixture.sql)
# and check that the page, the API, the live stream and the empty state all work.
#
# Building proves nothing about runtime: a Starlette, uvicorn or psycopg bump can still build and
# then fail on the first request. This drives the real code path end to end.
#
# Usage: ./smoke_test.sh IMAGE   (needs docker and curl; about 20 s)
set -euo pipefail
IMAGE="${1:?usage: smoke_test.sh IMAGE}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ID="energyapp-smoke-$$"
PORT="${SMOKE_PORT:-18080}"

cleanup() {
  docker rm -f "$ID-app" "$ID-db" >/dev/null 2>&1 || true
  docker network rm "$ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; echo "--- app log ---"; docker logs "$ID-app" 2>&1 | tail -30 || true; exit 1; }

docker network create "$ID" >/dev/null
docker run -d --name "$ID-db" --network "$ID" -e POSTGRES_PASSWORD=owner -e POSTGRES_DB=energy \
  -v "$HERE/tests/fixture.sql:/docker-entrypoint-initdb.d/fixture.sql:ro" postgres:17-alpine >/dev/null
for _ in $(seq 60); do
  docker exec "$ID-db" psql -U postgres -d energy -tAc "SELECT 1 FROM pg_roles WHERE rolname='energy_app'" 2>/dev/null | grep -q 1 && break
  sleep 1
done
# The init script runs on a temporary server first; wait for the real one to accept TCP.
for _ in $(seq 30); do docker exec "$ID-db" pg_isready -h 127.0.0.1 -q && break; sleep 1; done

docker run -d --name "$ID-app" --network "$ID" -p "127.0.0.1:$PORT:8080" \
  -e DB_HOST="$ID-db" -e DB_PASSWORD=smoke -e LIVE_INTERVAL=1 -e TODAY_INTERVAL=2 \
  -e PLUG_LABELS="tv=TV,router=Router" -e LINK_DAY="https://grafana.example/d/day" "$IMAGE" >/dev/null
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 30); do curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break; sleep 1; done

check() { # name, path, expected substring
  local body; body="$(curl -fsS --max-time 10 "$BASE$2")" || fail "$1: request failed"
  grep -q -- "$3" <<<"$body" || fail "$1: missing '$3'"
  echo "ok   $1"
}
check "health"     /healthz '"ok":true'
check "page"       /         '<html lang="nl">'
check "script"     /static/app.js 'EventSource'
check "styles"     /static/app.css '--zon'
check "manifest"   /manifest.webmanifest '"start_url"'
check "worker"     /sw.js    'energie-shell'
ctype="$(curl -fsS -o /dev/null -w '%{content_type}' "$BASE/static/icons/icon-192.png")" || fail "icon: request failed"
[ "$ctype" = "image/png" ] || fail "icon: content type $ctype"
echo "ok   icon"
check "config"     /api/config '"tv":"TV"'
check "live"       /api/live '"solar_w":1410.0'
check "live ok"    /api/live '"ok":true'
check "outdoor"    /api/live '"outdoor_c":8.0'
check "bat temp"   /api/live '"battery_temp_c":24.0'
check "flows"      /api/live '"flow_sun_house_w":240.0'
check "zelf benut" /api/today '"self_consumption":1.0'
check "today"      /api/today '"net_eur":2.47'
check "savings"    /api/today '"savings_eur":0.4'
check "forecast"   /api/today '"tomorrow_kwh":3.5'

# The stream must deliver a live event (the cache) and a fresh one from the background reader.
stream="$(curl -sN --max-time 4 "$BASE/api/stream" || true)"
[ "$(grep -c '^event: live' <<<"$stream")" -ge 2 ] || fail "stream: expected at least 2 live events, got: ${stream:0:300}"
grep -q '^event: today' <<<"$stream" || fail "stream: no today event"
echo "ok   stream"

# The app's role must not be able to write.
docker exec -e PGPASSWORD=smoke "$ID-db" psql -h 127.0.0.1 -U energy_app -d energy -c "CREATE TABLE x (i int)" >/dev/null 2>&1 \
  && fail "read-only role could create a table"
echo "ok   read-only role"

# Empty database: no measurements must give nulls, not an error.
docker exec "$ID-db" psql -U postgres -d energy -qc "UPDATE smoke_mode SET empty = true"
sleep 5
check "empty live"  /api/live '"flow_time":null'
check "empty today" /api/today '"data":null'
check "empty fcast" /api/today '"forecast":null'

# Database gone: the app keeps answering with ok:false and the last values.
docker stop "$ID-db" >/dev/null
sleep 6
check "db down"     /api/live '"ok":false'
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")"
[ "$code" = "503" ] || fail "healthz with the database down: expected 503, got $code"
echo "ok   healthz 503"
echo "PASS"
