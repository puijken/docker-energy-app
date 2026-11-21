-- Stand-ins for the views the app reads, with the same columns as the real ones, so the
-- smoke test can run the image against a throwaway Postgres. Values are made up but plausible.
-- The real views (and the rules behind each number) live with the deployment, not in this repo.
CREATE ROLE energy_app LOGIN PASSWORD 'smoke' CONNECTION LIMIT 4;
ALTER ROLE energy_app SET default_transaction_read_only = on;
ALTER ROLE energy_app SET statement_timeout = '5s';

-- Switch between a filled and an empty database: SELECT set_config(...) can't be used by a
-- read-only role, so the test flips this one-row table as the owner instead.
CREATE TABLE smoke_mode (empty boolean NOT NULL);
INSERT INTO smoke_mode VALUES (false);

CREATE VIEW app_live AS
SELECT now() AS db_now,
       CASE WHEN m.empty THEN NULL ELSE now() - interval '2 seconds' END AS flow_time,
       CASE WHEN m.empty THEN NULL ELSE 1410.0 END::double precision AS solar_w,
       CASE WHEN m.empty THEN NULL ELSE 150.0 END::double precision AS grid_w,
       CASE WHEN m.empty THEN NULL ELSE 240.0 END::double precision AS battery_ac_w,
       0.0::double precision AS socket_in_w,
       CASE WHEN m.empty THEN NULL ELSE 390.0 END::double precision AS house_w,
       CASE WHEN m.empty THEN NULL ELSE now() - interval '2 seconds' END AS battery_time,
       CASE WHEN m.empty THEN NULL ELSE 88.0 END::double precision AS soc,
       CASE WHEN m.empty THEN NULL ELSE -1170.0 END::double precision AS battery_cells_w,
       10.0::double precision AS discharge_limit_soc,
       100.0::double precision AS charge_limit_soc,
       7.1::double precision AS rated_kwh,
       CASE WHEN m.empty THEN NULL ELSE 5.538 END::double precision AS available_kwh,
       CASE WHEN m.empty THEN NULL ELSE now() - interval '1 second' END AS p1_time,
       CASE WHEN m.empty THEN NULL ELSE now() - interval '2 seconds' END AS battery_last_time,
       CASE WHEN m.empty THEN NULL ELSE now() - interval '3 minutes' END AS gas_time,
       CASE WHEN m.empty THEN '[]'::json
            ELSE '[{"name":"tv","w":114,"time":"2026-01-01T12:00:00+00:00"},{"name":"router","w":42,"time":"2026-01-01T12:00:00+00:00"}]'::json END AS plugs,
       CASE WHEN m.empty THEN NULL ELSE date_trunc('hour', now()) END AS outdoor_time,
       CASE WHEN m.empty THEN NULL ELSE 8.0 END::double precision AS outdoor_c,
       CASE WHEN m.empty THEN NULL ELSE 24.0 END::double precision AS battery_temp_c,
       CASE WHEN m.empty THEN NULL ELSE 1170.0 END::double precision AS flow_sun_bat_w,
       CASE WHEN m.empty THEN NULL ELSE 240.0 END::double precision AS flow_sun_house_w,
       CASE WHEN m.empty THEN NULL ELSE 0.0 END::double precision AS flow_sun_grid_w,
       CASE WHEN m.empty THEN NULL ELSE 0.0 END::double precision AS flow_bat_house_w,
       CASE WHEN m.empty THEN NULL ELSE 0.0 END::double precision AS flow_bat_grid_w,
       CASE WHEN m.empty THEN NULL ELSE 150.0 END::double precision AS flow_grid_house_w,
       CASE WHEN m.empty THEN NULL ELSE 0.0 END::double precision AS flow_grid_bat_w
FROM smoke_mode m;

CREATE VIEW app_today AS
SELECT date_trunc('day', now()) AS day_start,
       5.8::double precision AS generated_kwh, 4.7::double precision AS consumption_kwh,
       1.7::double precision AS import_kwh, 0.0::double precision AS export_kwh,
       3.0::double precision AS self_used_kwh, 0.638::double precision AS self_sufficiency,
       1.06::double precision AS gas_m3, 0.46::double precision AS import_eur, 0.0::double precision AS export_eur,
       1.60::double precision AS gas_eur, 0.41::double precision AS fixed_eur, 2.47::double precision AS net_eur,
       4.4::double precision AS battery_charged_kwh, 2.5::double precision AS battery_discharged_kwh,
       2.3::double precision AS battery_out_kwh, 0.0::double precision AS battery_in_kwh,
       1.0::double precision AS self_consumption
FROM smoke_mode WHERE NOT empty;

CREATE VIEW app_battery_savings_today AS
SELECT 12000::bigint AS samples, 47000.0::double precision AS covered_s,
       1.7::double precision AS import_with_kwh, 0.0::double precision AS export_with_kwh,
       3.4::double precision AS import_without_kwh, 2.9::double precision AS export_without_kwh,
       0.30::double precision AS p_import, 0.05::double precision AS p_feedin, 0.04::double precision AS p_feedin_cost,
       0.46::double precision AS cost_with_eur, 0.86::double precision AS cost_without_eur, 0.40::double precision AS savings_eur
FROM smoke_mode WHERE NOT empty;

CREATE VIEW app_forecast AS
SELECT now() - interval '10 minutes' AS fetched_at,
       9.4::double precision AS today_kwh, 1.2::double precision AS rest_today_kwh,
       3.5::double precision AS tomorrow_kwh, 24::bigint AS tomorrow_hours
FROM smoke_mode WHERE NOT empty;

-- Batterij screen. A made-up day: discharging to 30 % by 07:00, charging to 100 % by 13:00, full
-- until 17:00, then discharging; the lower limit goes from 5 to 10 % at 00:40.
CREATE VIEW app_battery_soc_today AS
SELECT t AS time,
       CASE WHEN h < 7 THEN 60 - 30 * h / 7 WHEN h < 13 THEN 30 + 70 * (h - 7) / 6
            WHEN h < 17 THEN 100 ELSE 100 - 15 * (h - 17) / 3 END::double precision AS soc,
       100.0::double precision AS charge_limit_soc,
       CASE WHEN h < 0.67 THEN 5.0 ELSE 10.0 END::double precision AS discharge_limit_soc
FROM smoke_mode,
     generate_series(date_trunc('day', now()), date_trunc('day', now()) + interval '20 hours', interval '5 minutes') AS t,
     LATERAL (SELECT extract(epoch FROM t - date_trunc('day', now())) / 3600 AS h) AS hh
WHERE NOT empty;

-- Like the real view, one row even when there are no measurements (then all NULL).
CREATE VIEW app_battery_summary AS
SELECT CASE WHEN empty THEN NULL ELSE now() - interval '3 seconds' END AS battery_time,
       CASE WHEN empty THEN NULL ELSE 10.5 END::double precision AS charged_total_kwh,
       CASE WHEN empty THEN NULL ELSE 9.0 END::double precision AS discharged_total_kwh,
       CASE WHEN empty THEN NULL ELSE 7.1 END::double precision AS rated_kwh,
       CASE WHEN empty THEN NULL ELSE 1.48 END::double precision AS full_cycles,
       CASE WHEN empty THEN NULL ELSE 100.0 END::double precision AS soh,
       CASE WHEN empty THEN NULL ELSE 24.0 END::double precision AS temp_c,
       CASE WHEN empty THEN NULL ELSE 22.0 END::double precision AS temp_min_c,
       CASE WHEN empty THEN NULL ELSE 29.0 END::double precision AS temp_max_c,
       CASE WHEN empty THEN NULL ELSE 30.0 END::double precision AS min_soc,
       CASE WHEN empty THEN NULL ELSE 100.0 END::double precision AS max_soc,
       CASE WHEN empty THEN NULL ELSE 0.933 END::double precision AS cell_efficiency_30d,
       CASE WHEN empty THEN NULL ELSE 9.2 END::double precision AS charged_30d_kwh,
       CASE WHEN empty THEN NULL ELSE now() - interval '3 days' END AS efficiency_since,
       CASE WHEN empty THEN NULL ELSE now() - interval '3 days' END AS first_reading
FROM smoke_mode;

-- Nine power bands, like the real view; a path without enough readings is NULL.
CREATE VIEW app_battery_efficiency AS
SELECT b.band, b.label,
       CASE WHEN NOT m.empty THEN b.solar END::double precision AS solar,
       CASE WHEN NOT m.empty THEN b.battery END::double precision AS battery,
       CASE WHEN NOT m.empty THEN b.socket END::double precision AS socket,
       NULL::double precision AS direct
FROM smoke_mode m,
     (VALUES (0, '< 250 W', NULL, 0.771, NULL), (1, '250–500 W', 0.715, 0.842, NULL),
             (2, '500–750 W', 0.834, NULL, NULL), (3, '750 W – 1 kW', 0.873, NULL, 0.909),
             (4, '1 – 1,5 kW', 0.904, NULL, NULL), (5, '1,5 – 2 kW', 0.936, NULL, NULL),
             (6, '2 – 2,5 kW', NULL, NULL, NULL), (7, '2,5 – 3 kW', NULL, NULL, NULL),
             (8, '> 3 kW', NULL, NULL, NULL)) AS b(band, label, solar, battery, socket)
ORDER BY b.band;

-- Historie: the same JSON shape as the real app_history(unit, anchor), with made-up numbers:
-- 4 kWh solar and 15 kWh use per day so far this period, last year a bit less of each.
CREATE FUNCTION app_history(p_unit text, p_anchor date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
WITH p AS (
    SELECT u, s, s + CASE u WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week' WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END AS e,
           s - CASE u WHEN 'week' THEN interval '52 weeks' ELSE interval '1 year' END AS ls,
           CASE u WHEN 'year' THEN 'month' WHEN 'day' THEN 'hour' ELSE 'day' END AS b
    FROM (SELECT p_unit AS u, date_trunc(p_unit, p_anchor::timestamptz) AS s) x
), m AS (SELECT empty FROM smoke_mode)
SELECT jsonb_build_object(
    'unit', u, 'bucket', b, 'start', s, 'end', e, 'ly_start', ls, 'ly_end', ls + (e - s), 'ly_compare_end', ls + (e - s),
    'running', now() >= s AND now() < e, 'first_day', CASE WHEN NOT m.empty THEN '2020-10-10'::timestamptz END,
    'buckets', CASE WHEN m.empty THEN '[]'::jsonb ELSE (SELECT jsonb_agg(jsonb_build_object('t', t, 'generated_kwh', 4.0, 'consumption_kwh', 15.0,
                 'import_kwh', 11.0, 'export_kwh', 0.5, 'gas_m3', 3.0, 'net_eur', 6.0, 'degree_days', 9.0) ORDER BY t)
                 FROM generate_series(s, least(e - ('1 ' || b)::interval, now()), ('1 ' || b)::interval) AS t) END,
    'ly_buckets', CASE WHEN m.empty THEN '[]'::jsonb ELSE (SELECT jsonb_agg(jsonb_build_object('t', t, 'generated_kwh', 3.5, 'consumption_kwh', 14.0,
                 'gas_m3', 2.5, 'net_eur', 5.0) ORDER BY t)
                 FROM generate_series(ls, ls + (e - s) - ('1 ' || b)::interval, ('1 ' || b)::interval) AS t) END,
    'totals', CASE WHEN m.empty THEN jsonb_build_object('days', 0) ELSE jsonb_build_object('days', 14, 'generated_kwh', 56.0, 'consumption_kwh', 210.0,
                 'self_used_kwh', 49.0, 'import_kwh', 161.0, 'export_kwh', 7.0, 'gas_m3', 42.0, 'net_eur', 84.0, 'degree_days', 126.0,
                 'self_sufficiency', 0.233, 'self_consumption', 0.875, 'gas_per_degree_day', 0.333) END,
    'ly_totals', CASE WHEN m.empty THEN jsonb_build_object('days', 0) ELSE jsonb_build_object('days', 14, 'generated_kwh', 49.0, 'consumption_kwh', 196.0,
                 'self_used_kwh', 40.0, 'import_kwh', 156.0, 'export_kwh', 9.0, 'gas_m3', 35.0, 'net_eur', 70.0, 'degree_days', 110.0,
                 'self_sufficiency', 0.204, 'self_consumption', 0.816, 'gas_per_degree_day', 0.318) END)
FROM p, m;
$f$;
GRANT EXECUTE ON FUNCTION app_history(text, date) TO energy_app;

-- The battery's charge level for the same period, the shape of the real app_history_soc(): a day
-- has 5-minute points, longer periods a made-up 30-90 % range per day (per month for a year).
CREATE FUNCTION app_history_soc(p_unit text, p_anchor date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
WITH p AS (
    SELECT p_unit AS u, s, s + CASE p_unit WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week'
                                           WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END AS e
    FROM (SELECT date_trunc(p_unit, p_anchor::timestamptz) AS s) x
), m AS (SELECT empty FROM smoke_mode)
SELECT jsonb_build_object('unit', u, 'start', s, 'end', e, 'first', CASE WHEN NOT m.empty THEN '2026-01-01T00:00:00+01:00'::timestamptz END,
    'points', CASE WHEN m.empty OR u <> 'day' THEN '[]'::jsonb ELSE (SELECT jsonb_agg(jsonb_build_object('time', t, 'soc', 60, 'charge_limit_soc', 100, 'discharge_limit_soc', 10) ORDER BY t)
                                                  FROM generate_series(s, least(e, now()) - interval '5 minutes', interval '5 minutes') AS t) END,
    'ranges', CASE WHEN m.empty OR u = 'day' THEN '[]'::jsonb ELSE (SELECT jsonb_agg(jsonb_build_object('t', t, 'min', 30, 'max', 90) ORDER BY t)
                                                  FROM generate_series(s, least(e, now()) - interval '1 hour', CASE u WHEN 'year' THEN interval '1 month' ELSE interval '1 day' END) AS t) END)
FROM p, m;
$f$;
GRANT EXECUTE ON FUNCTION app_history_soc(text, date) TO energy_app;

-- Geld: the same JSON shape as the real app_money(), made-up numbers; savings without the daily
-- table filled look like this too (filled_at null).
CREATE FUNCTION app_money() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
SELECT CASE WHEN empty THEN jsonb_build_object('savings', jsonb_build_object('days', 0), 'bill_month', NULL, 'bill_year', NULL,
                                                'bill_2027', NULL, 'year_start', date_trunc('year', now()))
ELSE jsonb_build_object(
    'savings', jsonb_build_object('today_eur', 0.40, 'month_eur', 1.41, 'total_eur', 1.41, 'days', 3,
                                  'since', '2026-03-02T10:30:00+01:00'::timestamptz, 'filled_at', now() - interval '20 minutes'),
    'bill_month', jsonb_build_object('days', 14, 'net_eur', 120.0, 'import_eur', 50.0, 'export_eur', 6.0, 'gas_eur', 70.0,
                                     'fixed_eur', 6.0, 'import_kwh', 170.0, 'export_kwh', 20.0, 'gas_m3', 50.0),
    'bill_year', jsonb_build_object('days', 318, 'net_eur', 1010.0, 'import_eur', 800.0, 'export_eur', 600.0, 'gas_eur', 650.0,
                                    'fixed_eur', 160.0, 'import_kwh', 3000.0, 'export_kwh', 3000.0, 'gas_m3', 500.0),
    'bill_2027', jsonb_build_object('days', 318, 'real_eur', 1010.0, 'import_eur', 900.0, 'export_eur', 30.0, 'gas_eur', 700.0,
                                    'fixed_eur', 160.0, 'net_eur', 1730.5, 'import_kwh', 3000.0, 'export_kwh', 3000.0, 'gas_m3', 500.0,
                                    'p_import', 0.30, 'p_feedin', 0.05, 'p_feedin_cost', 0.04, 'p_gas', 1.40, 'p_fixed', 0.50),
    'year_start', date_trunc('year', now()))
END FROM smoke_mode;
$f$;
GRANT EXECUTE ON FUNCTION app_money() TO energy_app;

-- Contracten: the same JSON shape as the real app_contracts(), two made-up contracts.
CREATE FUNCTION app_contracts() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
SELECT jsonb_build_object('today', current_date, 'contracts', CASE WHEN empty THEN '[]'::jsonb ELSE jsonb_build_array(
    jsonb_build_object('id', 2, 'name', 'Leverancier B', 'start', '2026-03-01', 'end', '2026-12-31', 'kind', 'stroom en gas', 'status', 'lopend',
        'p_normal', 0.30, 'p_low', 0.30, 'f_normal', 0.05, 'f_low', 0.05, 'p_gas', 1.40, 'p_fixed', 0.50,
        'feedin_bands', true, 'feedin_cost_per_kwh', NULL, 'el_days', 258, 'gas_days', 258, 'days', 258,
        'first_day', '2026-03-01T00:00:00+01:00', 'last_day', '2026-11-14T00:00:00+01:00',
        'import_kwh', 2000.0, 'export_kwh', 2200.0, 'import_eur', 600.0, 'export_eur', 110.0, 'gas_m3', 300.0, 'gas_eur', 420.0,
        'fixed_eur', 129.0, 'net_eur', 1039.0, 'generated_kwh', 4800.0, 'consumption_kwh', 4600.0, 'self_sufficiency', 0.52, 'salderen', true),
    jsonb_build_object('id', 1, 'name', 'Leverancier A', 'start', '2025-03-01', 'end', '2026-03-01', 'kind', 'stroom en gas', 'status', 'afgelopen',
        'p_normal', 0.25, 'p_low', 0.25, 'f_normal', 0.03, 'f_low', 0.03, 'p_gas', 1.20, 'p_fixed', 0.70,
        'feedin_bands', true, 'feedin_cost_per_kwh', NULL, 'el_days', 365, 'gas_days', 365, 'days', 365,
        'first_day', '2025-03-01T00:00:00+01:00', 'last_day', '2026-02-28T00:00:00+01:00',
        'import_kwh', 4000.0, 'export_kwh', 3000.0, 'import_eur', 1000.0, 'export_eur', 90.0, 'gas_m3', 700.0, 'gas_eur', 840.0,
        'fixed_eur', 255.5, 'net_eur', 2005.5, 'generated_kwh', 5500.0, 'consumption_kwh', 6500.0, 'self_sufficiency', 0.38, 'salderen', true)) END)
FROM smoke_mode;
$f$;
GRANT EXECUTE ON FUNCTION app_contracts() TO energy_app;

-- Meer: the same JSON shape as the real app_meer(), made-up numbers: 60 nights around 380 W, every
-- seventh one with the car charging at home (2 kW, left out of the median), two plugs, three places.
CREATE FUNCTION app_meer() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
SELECT CASE WHEN empty THEN jsonb_build_object(
    'usage', jsonb_build_object('nights', '[]'::jsonb, 'last', NULL, 'median_30', NULL, 'n_30', 0, 'ly_median_30', NULL, 'plugs', '[]'::jsonb),
    'car', jsonb_build_object('year_start', date_trunc('year', now()), 'places', '[]'::jsonb, 'net_eur', NULL, 'last_session', NULL, 'reading_day', NULL),
    'status', jsonb_build_object('monta_fetched', NULL, 'knmi_fetched', NULL, 'knmi_day', NULL, 'reading_day', NULL,
                                 'jobs_total', 0, 'jobs_failed', '[]'::jsonb, 'jobs_last_ok', NULL, 'uploads', '{}'::jsonb))
ELSE jsonb_build_object(
    'usage', jsonb_build_object(
        'nights', (SELECT jsonb_agg(jsonb_build_object('night', current_date - i, 'w', CASE WHEN i % 7 = 3 THEN 2000 ELSE 380 + (i % 5) * 10 END,
                                                       'car', i % 7 = 3) ORDER BY i DESC) FROM generate_series(0, 59) AS i),
        'last', jsonb_build_object('night', current_date, 'w', 380, 'car', false),
        'median_30', 390, 'n_30', 26, 'ly_median_30', 350,
        'plugs', '[{"name":"tv","today_kwh":0.9,"night_w":12.5},{"name":"router","today_kwh":0.5,"night_w":42.0}]'::jsonb),
    'car', jsonb_build_object(
        'year_start', date_trunc('year', now()),
        'places', '[{"kind":"home","sessions":100,"kwh":2000.0,"solar_kwh":600.0,"reimbursed_eur":550.0,"real_cost_eur":420.0,"billed_eur":null},
                    {"kind":"work","sessions":50,"kwh":1000.0,"solar_kwh":null,"reimbursed_eur":null,"real_cost_eur":null,"billed_eur":250.0},
                    {"kind":"public","sessions":10,"kwh":100.0,"solar_kwh":null,"reimbursed_eur":null,"real_cost_eur":null,"billed_eur":45.0}]'::jsonb,
        'net_eur', 130.5,
        'last_session', jsonb_build_object('time', now() - interval '2 days', 'kind', 'work', 'kwh', 20.0),
        'reading_day', current_date - 20),
    'status', jsonb_build_object('monta_fetched', now() - interval '3 hours', 'knmi_fetched', now() - interval '5 hours',
                                 'knmi_day', current_date - 3, 'reading_day', current_date - 20,
                                 'jobs_total', 15, 'jobs_failed', '[]'::jsonb, 'jobs_last_ok', now() - interval '10 minutes',
                                 'uploads', jsonb_build_object(
                                     'pvoutput', jsonb_build_object('last_attempt', now() - interval '2 minutes', 'last_ok', now() - interval '2 minutes', 'last_error', NULL, 'detail', NULL),
                                     'mindergas', jsonb_build_object('last_attempt', now() - interval '12 hours', 'last_ok', now() - interval '12 hours', 'last_error', NULL, 'detail', 'gisteren: 1234.567 m3'),
                                     'monta', jsonb_build_object('last_attempt', now() - interval '1 hour', 'last_ok', now() - interval '25 hours', 'last_error', 'made-up timeout', 'detail', '2 session(s)'))))
END
FROM smoke_mode;
$f$;
GRANT EXECUTE ON FUNCTION app_meer() TO energy_app;

-- Zon sheet: the newest reading per string, with East stuck at low voltage (as the real view flags
-- it), and a made-up day per hour: East peaks at 10:00, West at 14:00, East stuck 08:00-10:00.
CREATE VIEW app_solar_live AS
SELECT now() AS db_now,
       CASE WHEN empty THEN NULL ELSE now() - interval '3 seconds' END AS strings_time,
       CASE WHEN empty THEN NULL ELSE 102.0::double precision END AS east_v,
       CASE WHEN empty THEN NULL ELSE 0.65::double precision END AS east_a,
       CASE WHEN empty THEN NULL ELSE 66.3::double precision END AS east_w,
       CASE WHEN empty THEN NULL ELSE 261.0::double precision END AS west_v,
       CASE WHEN empty THEN NULL ELSE 0.51::double precision END AS west_a,
       CASE WHEN empty THEN NULL ELSE 133.1::double precision END AS west_w,
       NOT empty AS east_stuck, false AS west_stuck
FROM smoke_mode;

CREATE FUNCTION app_solar() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
WITH d AS (SELECT date_trunc('day', now()) AS t0, date_trunc('day', now()) + interval '1 day' AS t1),
h AS (
    SELECT t AS hour, extract(hour FROM t)::int AS hr FROM d, generate_series(d.t0, d.t1 - interval '1 hour', interval '1 hour') AS t
), v AS (
    SELECT hour, hr,
           CASE WHEN hr BETWEEN 8 AND 16 THEN greatest(0, 1000 - 220 * abs(hr - 10)) * CASE WHEN hr < 10 THEN 0.4 ELSE 1 END END AS east_wh,
           CASE WHEN hr BETWEEN 8 AND 16 THEN greatest(0, 1000 - 220 * abs(hr - 14)) END AS west_wh,
           CASE WHEN hr BETWEEN 8 AND 16 THEN greatest(0, 1100 - 240 * abs(hr - 10)) END AS east_fc_wh,
           CASE WHEN hr BETWEEN 8 AND 16 THEN greatest(0, 1100 - 240 * abs(hr - 14)) END AS west_fc_wh,
           CASE WHEN hr IN (8, 9) THEN 50 - 10 * (hr - 8) END AS east_low_min
    FROM h
)
SELECT CASE WHEN m.empty THEN jsonb_build_object(
    'day_start', d.t0, 'day_end', d.t1, 'last_time', NULL, 'fetched_at', NULL,
    'hours', (SELECT jsonb_agg(jsonb_build_object('hour', hour, 'east_wh', NULL, 'west_wh', NULL, 'east_fc_wh', NULL,
                                                  'west_fc_wh', NULL, 'east_low_min', NULL, 'west_low_min', NULL) ORDER BY hour) FROM h),
    'east_kwh', NULL, 'west_kwh', NULL, 'east_fc_kwh', NULL, 'west_fc_kwh', NULL,
    'east_fc_sofar_kwh', NULL, 'west_fc_sofar_kwh', NULL, 'east_low_min', 0, 'west_low_min', 0,
    'east_low_first', NULL, 'east_low_last', NULL, 'west_low_first', NULL, 'west_low_last', NULL)
ELSE jsonb_build_object(
    'day_start', d.t0, 'day_end', d.t1, 'last_time', now() - interval '3 seconds', 'fetched_at', now() - interval '20 minutes',
    'hours', (SELECT jsonb_agg(jsonb_build_object('hour', hour, 'east_wh', east_wh, 'west_wh', west_wh, 'east_fc_wh', east_fc_wh,
                                                  'west_fc_wh', west_fc_wh, 'east_low_min', east_low_min, 'west_low_min', NULL) ORDER BY hour) FROM v),
    'east_kwh', (SELECT round(sum(east_wh) / 1000, 2) FROM v), 'west_kwh', (SELECT round(sum(west_wh) / 1000, 2) FROM v),
    'east_fc_kwh', (SELECT round(sum(east_fc_wh) / 1000, 2) FROM v), 'west_fc_kwh', (SELECT round(sum(west_fc_wh) / 1000, 2) FROM v),
    'east_fc_sofar_kwh', (SELECT round(sum(east_fc_wh) / 1000, 2) FROM v), 'west_fc_sofar_kwh', (SELECT round(sum(west_fc_wh) / 1000, 2) FROM v),
    'east_low_min', 90, 'west_low_min', 0,
    'east_low_first', d.t0 + interval '8 hours 5 minutes', 'east_low_last', d.t0 + interval '9 hours 55 minutes',
    'west_low_first', NULL, 'west_low_last', NULL)
END
FROM d, smoke_mode m;
$f$;
GRANT EXECUTE ON FUNCTION app_solar() TO energy_app;

GRANT SELECT ON app_live, app_today, app_battery_savings_today, app_forecast, app_solar_live,
                app_battery_soc_today, app_battery_summary, app_battery_efficiency TO energy_app;
