-- Stand-ins for the four views the app reads, with the same columns as the real ones, so the
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

GRANT SELECT ON app_live, app_today, app_battery_savings_today, app_forecast TO energy_app;
