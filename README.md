# docker-energy-app

A small, read-only web app (installable as a PWA) for a home energy system with solar panels, a home
battery, a smart meter and smart plugs. It answers two questions at a glance: *what is the house
doing now* and *how did today go*. The interface is in Dutch.

It is built for daily use on a phone, a tablet and a wall screen. Analysis stays in Grafana; every
card can link to the matching Grafana dashboard.

## What it shows

### Thuis

- **Nu:** a flow picture of who feeds whom: sun on top, grid left, house right, battery at the
  bottom, one line per pair (`app_live.flow_*_w`), coloured by source (green = solar, red = grid or
  battery), with idle routes as faint grey dashes. Each circle holds an icon, the live value and,
  where it applies, today's kWh. Gas today sits top left, the outdoor temperature top right (the time of the reading
  is in its detail sheet).
- **Stekkers:** one chip per smart plug with its live power, and their sum.
- **Vandaag:** generated with the share used yourself (not exported: used directly or stored),
  house use, self-sufficiency, imported and exported, 00:00 – now.
- **Geld vandaag:** the energy bill so far, and an estimate of what the battery saved today under the
  2027 rules (no net metering), clearly marked as calculated.
- **Batterij:** (also in the flow picture: charge level, state and the temperature the battery
  reports) charge level with the lower limit, energy available above it, charged and discharged
  today.
- A status pill (stale sources, warnings) and an info sheet behind every number: what it is, how it
  is calculated, the period (live or today), and the source.
- A wall view at `/?kiosk`: always dark, large numbers, a clock, a small shift every minute against
  burn-in, dimmed at night, and a screen wake lock.

### Batterij

- **Nu:** charge level with the lower limit, the power of the cells (laadt / ontlaadt / rust),
  energy available above the lower limit, temperature. Live, from the same stream as Thuis.
- **Geladen en ontladen:** today, since new (the battery's lifetime counters), and the efficiency at
  the cells over the last 30 days.
- **Gezondheid:** the battery's own state-of-health figure, its rated capacity, full cycles since new
  (charged ÷ capacity) and today's temperature range.
- **Laadniveau vandaag:** the charge level from midnight to now with the two limits as dashed steps.
- **Rendement per vermogen:** per power band over the last 30 days, which share comes out on the other
  side for each path (sun → battery + house, battery → house, socket → battery, sun → house).

The screens switch by the address's `#hash` (`#batterij`); the Batterij data is fetched only while
that screen is open.

## How it works

- **Read-only by construction.** The app connects to PostgreSQL/TimescaleDB with a role that may only
  `SELECT` four views. It never talks to a device and never writes.
- **All rules live in SQL.** The views decide what each number means, so the app shows the same
  figures as anything else reading that database. The app formats and draws.
- **One reader for every screen.** While at least one screen is connected, a background task reads
  the live view every `LIVE_INTERVAL` seconds and the day views every `TODAY_INTERVAL` seconds, and
  pushes the result to all screens over Server-Sent Events. With no screen open it reads nothing.
- **No build step.** Python (Starlette, uvicorn, psycopg 3) on the server; plain HTML, CSS and
  JavaScript modules in the browser. The flow picture is SVG.
- **Offline:** a service worker keeps the app shell; the page keeps the last values and marks them
  "verouderd" (stale).

### The views it expects

| View | Rows | Used for |
|---|---|---|
| `app_live` | one | newest power values, charge level, limits, source timestamps, plugs (JSON array), outdoor temperature and its time, and who feeds whom for the flow picture: `flow_sun_bat_w`, `flow_sun_house_w`, `flow_sun_grid_w`, `flow_bat_house_w`, `flow_bat_grid_w`, `flow_grid_house_w`, `flow_grid_bat_w` (all ≥ 0; null hides the line) |
| `app_today` | zero or one | today's totals and money |
| `app_battery_savings_today` | zero or one | the calculated battery savings and their inputs |
| `app_battery_soc_today` | 0 – 288 | Batterij screen: `time` (5-minute buckets from local midnight), `soc`, `charge_limit_soc`, `discharge_limit_soc` |
| `app_battery_summary` | one (all null without data) | lifetime counters, `rated_kwh`, `full_cycles`, `soh`, temperature now and today's range, today's lowest/highest charge level, `cell_efficiency_30d` and its inputs, `first_reading` |
| `app_battery_efficiency` | nine | per power band (`band`, `label`): out ÷ in for `solar`, `battery`, `socket`, `direct`; null when there are too few readings |
| `app_forecast` | zero or one | solar forecast: `fetched_at`, `today_kwh`, `rest_today_kwh` (now → midnight), `tomorrow_kwh`, `tomorrow_hours` (24 when tomorrow is complete). Optional: when it is missing or fails, the rest of the screen works and the card shows “—” |

`tests/fixture.sql` has stand-ins with exactly the columns the app reads. The real definitions belong
to your deployment.

## Configuration

All settings come from the environment. None of them is secret except the database password.

| Variable | Default | Meaning |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` | `localhost`, `5432`, `energy`, `energy_app` | database connection |
| `DB_PASSWORD` | (empty) | password of the read-only role |
| `DB_POOL_SIZE` | `2` | maximum database connections |
| `LIVE_INTERVAL` | `5` | seconds between live reads |
| `TODAY_INTERVAL` | `60` | seconds between reads of the day views |
| `BATTERY_INTERVAL` | `60` | the Batterij screen's data is re-read at most this often (only while a screen asks for it) |
| `PLUG_LABELS` | (empty) | display names, `source=Label,...`; also the plugs the status sheet expects |
| `LINK_DAY`, `LINK_PERIOD`, `LINK_MONEY`, `LINK_BATTERY`, `LINK_PLUGS`, `LINK_TECH` | (empty) | Grafana links per card and tab; a missing link hides it |
| `FORECAST_PLANES`, `FORECAST_LOCATION`, `FORECAST_ACCURACY` | (empty) | extra lines on the forecast's info sheet: the roof planes, the location sent to the forecast service, how accurate it was when tested; each is left out when unset |
| `TZ` | `Europe/Amsterdam` | time zone for clocks and labels |
| `PORT` | `8080` | listening port |

Example service:

```yaml
services:
  energy-app:
    image: ghcr.io/puijken/docker-energy-app:latest
    restart: unless-stopped
    environment:
      - DB_HOST=timescaledb
      - DB_PASSWORD=${ENERGY_APP_DB_PASSWORD:?set it in .env}
      - PLUG_LABELS=tv=TV,router=Router
      - LINK_DAY=https://grafana.example.com/d/day
    ports:
      - "8080:8080"
```

Put it behind your own login (a forward-auth proxy, for example). The app has no authentication of
its own. When a forward-auth session expires, the live stream fails; the page notices and offers to
log in again (the wall view reloads by itself). The web manifest is requested with credentials so the
login proxy lets it through.

### A read-only role (PostgreSQL)

```sql
CREATE ROLE energy_app LOGIN CONNECTION LIMIT 4;
ALTER ROLE energy_app SET default_transaction_read_only = on;
ALTER ROLE energy_app SET statement_timeout = '5s';
GRANT USAGE ON SCHEMA public TO energy_app;
GRANT SELECT ON app_live, app_today, app_battery_savings_today, app_forecast,
                app_battery_soc_today, app_battery_summary, app_battery_efficiency TO energy_app;
-- then set its password by hand, not in a file you commit
```

## Endpoints

| Path | What |
|---|---|
| `/` | the page |
| `/api/stream` | Server-Sent Events: `live` and `today` events, a comment line every 15 s |
| `/api/live`, `/api/today` | the same data as JSON (re-read at most every few seconds) |
| `/api/battery` | the Batterij screen: today's charge level, the summary row, efficiency per band, the day's start and end (re-read at most every `BATTERY_INTERVAL` seconds) |
| `/api/config` | links, plug labels, intervals, time zone |
| `/healthz` | 200 when the database answers, 503 otherwise (used by the image's `HEALTHCHECK`) |

## Tests

```sh
docker build -t energy-app:dev .
./smoke_test.sh energy-app:dev
```

`smoke_test.sh` starts a throwaway Postgres with `tests/fixture.sql`, runs the image against it, and
checks the page, static files, the API, the event stream, that the role cannot write, the empty
state (no measurements gives nulls, not errors) and a stopped database (`ok:false`, last values kept,
`/healthz` 503). It needs Docker and curl and takes about 20 seconds. CI runs it before every push of
`:latest`.

## CI

Same triggers as the other `docker-*` repos: a push to `main`, manual dispatch, and monthly on the 1st
(to pick up base-image rebuilds). Dependabot runs weekly for Docker, pip and GitHub Actions;
non-major bumps auto-merge after the smoke test.

## License

See [LICENSE](LICENSE).
