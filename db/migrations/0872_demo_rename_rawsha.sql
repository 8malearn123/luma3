-- Demo display name «صالون نورة» → «الروشة» on databases seeded before the rename
-- (the seed only runs on an empty database). Display/legal name only: the slug
-- noura-salon, emails, credentials and the owner's personal name are unchanged.
-- Touches only the flagged demo business that still carries the old name; a no-op
-- on fresh databases and on every real business.
do $$
declare
  t uuid;
  nv uuid;
begin
  select id into t from tenants where slug = 'noura-salon' and is_demo and name = 'صالون نورة';
  if t is null then
    return;
  end if;

  update tenants set name = 'الروشة', updated_at = now() where id = t;

  update tenant_settings set legal_name = replace(legal_name, 'صالون نورة', 'الروشة')
    where tenant_id = t and legal_name like '%صالون نورة%';

  update brand_settings set
    wordmark_text = replace(wordmark_text, 'صالون نورة', 'الروشة'),
    tagline_ar = replace(tagline_ar, 'بلمسة نورة', 'بلمسة الروشة')
    where tenant_id = t;

  update onboarding_progress
    set answers = replace(replace(answers::text, 'صالون نورة', 'الروشة'), 'بلمسة نورة', 'بلمسة الروشة')::jsonb
    where tenant_id = t and answers::text like '%نورة%';

  update page_drafts
    set blocks = replace(replace(blocks::text, 'صالون نورة', 'الروشة'), 'بلمسة نورة', 'بلمسة الروشة')::jsonb
    where tenant_id = t and blocks::text like '%نورة%';

  -- The live storefront reads the published snapshot, which is append-only: publish a new
  -- version carrying the renamed copy (as the builder's publish does) and move the pointer.
  insert into site_versions (tenant_id, version_number, snapshot, schema_version, note, restored_from_version_id, published_by)
  select v.tenant_id,
         (select coalesce(max(version_number), 0) + 1 from site_versions where tenant_id = t),
         replace(replace(v.snapshot::text, 'صالون نورة', 'الروشة'), 'بلمسة نورة', 'بلمسة الروشة')::jsonb,
         v.schema_version, 'Demo display name renamed to «الروشة»', v.id, v.published_by
    from tenants tn join site_versions v on v.tenant_id = tn.id and v.id = tn.published_version_id
   where tn.id = t and v.snapshot::text like '%نورة%'
  returning id into nv;
  if nv is not null then
    update tenants set published_version_id = nv where id = t;
  end if;
end
$$;
