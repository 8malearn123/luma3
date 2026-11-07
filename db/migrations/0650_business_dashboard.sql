-- 0650 Business dashboard batch: manual service badges, low-stock alert state
-- (one alert per crossing until restocked), image crop data on derived assets,
-- and the weekly owner digest (schedule in tenant settings + stored digests).

-- ── Service badges (manual only) ────────────────────────────────────────────
-- Presets are rendered from the translation files; 'custom' carries its own text.
alter table services add column badge_kind text check (badge_kind in ('popular', 'new', 'offer', 'custom'));
alter table services add column badge_text_ar text check (char_length(badge_text_ar) <= 24);
alter table services add column badge_text_en text check (char_length(badge_text_en) <= 24);
alter table services add constraint services_badge_custom_text
  check (badge_kind is distinct from 'custom' or coalesce(nullif(badge_text_ar, ''), nullif(badge_text_en, '')) is not null);

-- ── Low-stock alerts ────────────────────────────────────────────────────────
-- Set when an alert is sent for the current low period; cleared when the
-- available quantity rises above the minimum again (restock), so the next
-- crossing alerts again but repeated movements while low do not.
alter table inventory_items add column low_stock_alerted_at timestamptz;

-- ── Image crop ──────────────────────────────────────────────────────────────
-- A cropped image is a new asset (same WebP pipeline); it records the crop
-- rectangle (source pixels, after EXIF rotation) and the asset it was cut from.
alter table assets add column crop jsonb check (crop is null or jsonb_typeof(crop) = 'object');
alter table assets add column source_asset_id uuid references assets(id);

-- ── Weekly owner digest ─────────────────────────────────────────────────────
-- weekday: 0 = Sunday … 6 = Saturday; hour: business-local 0-23.
alter table tenant_settings add column digest_enabled boolean not null default true;
alter table tenant_settings add column digest_weekday smallint not null default 0 check (digest_weekday between 0 and 6);
alter table tenant_settings add column digest_hour smallint not null default 9 check (digest_hour between 0 and 23);

create table weekly_digests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  period_start date not null,
  period_end date not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  delivered_channels text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, period_end),
  check (period_end >= period_start)
);
create index weekly_digests_tenant_idx on weekly_digests (tenant_id, period_end desc);

select app.apply_conventions('{{APP_ROLE}}');
