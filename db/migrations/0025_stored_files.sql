-- 0025 File storage inside PostgreSQL for hosts without a persistent disk
-- (e.g. Vercel). Used when STORAGE_DRIVER=db. Keys already embed the tenant id
-- and files are only ever served through authorised routes (media/[id]), never
-- by key, so this table needs no tenant column of its own.
create table stored_files (
  key text primary key check (key ~ '^[a-z0-9][a-z0-9/_.-]{1,200}$' and position('..' in key) = 0),
  content bytea not null,
  content_type text not null,
  bytes integer not null check (bytes >= 0 and bytes <= 16 * 1024 * 1024),
  created_at timestamptz not null default now()
);

select app.apply_conventions('{{APP_ROLE}}');
