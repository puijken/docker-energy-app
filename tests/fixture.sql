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
    SELECT u, s, s + CASE u WHEN 'week' THEN interval '1 week' WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END AS e,
           s - CASE u WHEN 'week' THEN interval '52 weeks' ELSE interval '1 year' END AS ls,
           CASE WHEN u = 'year' THEN 'month' ELSE 'day' END AS b
    FROM (SELECT p_unit AS u, date_trunc(p_unit, p_anchor::timestamptz) AS s) x
), m AS (SELECT empty FROM smoke_mode)
SELECT jsonb_build_object(
    'unit', u, 'bucket', b, 'start', s, 'end', e, 'ly_start', ls, 'ly_end', ls + (e - s), 'ly_compare_end', ls + (e - s),
    'running', now() >= s AND now() < e, 'first_day', CASE WHEN NOT m.empty THEN '2020-10-10'::timestamptz END,
    'buckets', CASE WHEN m.empty THEN '[]'::jsonb ELSE (SELECT jsonb_agg(jsonb_build_object('t', t, 'generated_kwh', 4.0, 'consumption_kwh', 15.0,
                 'import_kwh', 11.0, 'export_kwh', 0.5, 'gas_m3', 3.0, 'net_eur', 6.0, 'degree_days', 9.0) ORDER BY t)
                 FROM generate_series(s, least(e - interval '1 day', now()), ('1 ' || b)::interval) AS t) END,
    'ly_buckets', CASE WHEN m.empty THEN '[]'::jsonb ELSE (SELECT jsonb_agg(jsonb_build_object('t', t, 'generated_kwh', 3.5, 'consumption_kwh', 14.0,
                 'gas_m3', 2.5, 'net_eur', 5.0) ORDER BY t)
                 FROM generate_series(ls, ls + (e - s) - interval '1 day', ('1 ' || b)::interval) AS t) END,
    'totals', CASE WHEN m.empty THEN jsonb_build_object('days', 0) ELSE jsonb_build_object('days', 14, 'generated_kwh', 56.0, 'consumption_kwh', 210.0,
                 'self_used_kwh', 49.0, 'import_kwh', 161.0, 'export_kwh', 7.0, 'gas_m3', 42.0, 'net_eur', 84.0, 'degree_days', 126.0,
                 'self_sufficiency', 0.233, 'self_consumption', 0.875, 'gas_per_degree_day', 0.333) END,
    'ly_totals', CASE WHEN m.empty THEN jsonb_build_object('days', 0) ELSE jsonb_build_object('days', 14, 'generated_kwh', 49.0, 'consumption_kwh', 196.0,
                 'self_used_kwh', 40.0, 'import_kwh', 156.0, 'export_kwh', 9.0, 'gas_m3', 35.0, 'net_eur', 70.0, 'degree_days', 110.0,
                 'self_sufficiency', 0.204, 'self_consumption', 0.816, 'gas_per_degree_day', 0.318) END)
FROM p, m;
$f$;
GRANT EXECUTE ON FUNCTION app_history(text, date) TO energy_app;

-- Geld: the same JSON shape as the real app_money(), made-up numbers; savings without the daily
-- table filled look like this too (filled_at null).
CREATE FUNCTION app_money() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
SELECT CASE WHEN empty THEN jsonb_build_object('savings', jsonb_build_object('days', 0), 'bill_month', NULL, 'bill_year', NULL,
                                                'bill_2027', NULL, 'year_start', date_trunc('year', now()))
ELSE jsonb_build_object(
    'savings', jsonb_build_object('today_eur', 0.40, 'month_eur', 1.41, 'total_eur', 1.41, 'days', 3,
                                  'since', '2026-03-02T10:30:00+01:00'::timestamptz, 'filled_at', now() - interval '20 minutes'),
    'bill_month', jsonb_build_object('days', 14, 'net_eur', 120.0, 'import_eur', 50.0, 'export_eur', 6.06, 'gas_eur', 70.0,
                                     'fixed_eur', 5.67, 'import_kwh', 170.0, 'export_kwh', 22.3, 'gas_m3', 46.3),
    'bill_year', jsonb_build_object('days', 318, 'net_eur', 1010.0, 'import_eur', 800.0, 'export_eur', 600.0, 'gas_eur', 650.0,
                                    'fixed_eur', 160.0, 'import_kwh', 3000.0, 'export_kwh', 3000.0, 'gas_m3', 530.0),
    'bill_2027', jsonb_build_object('days', 318, 'real_eur', 1010.0, 'import_eur', 900.0, 'export_eur', 30.0, 'gas_eur', 700.0,
                                    'fixed_eur', 160.0, 'net_eur', 1730.5, 'import_kwh', 3000.0, 'export_kwh', 3000.0, 'gas_m3', 530.0,
                                    'p_import', 0.30, 'p_feedin', 0.05, 'p_feedin_cost', 0.04, 'p_gas', 1.40, 'p_fixed', 0.50),
    'year_start', date_trunc('year', now()))
END FROM smoke_mode;
$f$;
GRANT EXECUTE ON FUNCTION app_money() TO energy_app;

GRANT SELECT ON app_live, app_today, app_battery_savings_today, app_forecast,
                app_battery_soc_today, app_battery_summary, app_battery_efficiency TO energy_app;
