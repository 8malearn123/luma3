-- 0026 Periodic task schedule kept in the database, so several workers or
-- short-lived serverless invocations (scheduled HTTP calls) run each task at
-- most once per interval instead of once per process.
create table periodic_runs (
  name text primary key,
  last_started_at timestamptz not null
);

select app.apply_conventions('{{APP_ROLE}}');
