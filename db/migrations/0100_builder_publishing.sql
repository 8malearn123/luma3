-- ════════════════════════════════════════════════════════════════════════════
-- 0100 Storefront builder: publishing, customization proposals (diff/undo),
--      starter templates.
--
-- Publishing writes an immutable site_versions row and moves
-- tenants.published_version_id in one transaction (domain code). This migration
-- only adds what the builder/assistant need on top of 0007.
-- ════════════════════════════════════════════════════════════════════════════

-- Customization proposals: structured diff shown to the owner, the "before"
-- values needed to undo an accepted proposal, and the draft versions produced
-- by accepting it (undo is refused if the draft changed afterwards).
alter table customization_proposals add column diff jsonb not null default '[]'::jsonb;
alter table customization_proposals add column undo_snapshot jsonb;
alter table customization_proposals add column applied_versions jsonb;
alter table customization_proposals add column updated_at timestamptz not null default now();
alter table customization_proposals drop constraint customization_proposals_status_check;
alter table customization_proposals add constraint customization_proposals_status_check
  check (status in ('proposed', 'accepted', 'rejected', 'failed', 'invalid', 'undone'));
alter table customization_proposals add constraint customization_proposals_ai_run_fk
  foreign key (ai_run_id) references ai_runs(id);
create index customization_proposals_tenant_idx on customization_proposals (tenant_id, created_at desc);

create index site_versions_tenant_idx on site_versions (tenant_id, version_number desc);
create index preview_tokens_tenant_idx on preview_tokens (tenant_id, created_at desc);

-- ── Starter templates (platform-approved). Templates only carry structure and
-- shape tokens (radius/buttons/cards/density/fonts/navigation): they never
-- override a business's colours, logo, catalog or prices. Inserted only if
-- absent so platform edits are never overwritten.
insert into templates (key, name_ar, name_en, description_ar, description_en, document, status) values
('classic_elegance', 'أناقة كلاسيكية', 'Classic elegance',
 'واجهة هادئة، نبذة تعريفية ثم الخدمات والفريق.', 'A calm hero, an introduction, then services and team.',
 '{
   "brand": {"radius": "sm", "button_style": "outline", "card_style": "bordered", "density": "spacious"},
   "layout": {"nav_style": "simple", "service_display": "list"},
   "pages": {
     "home": [
       {"id": "tpl_hero_1", "type": "hero", "schemaVersion": 1, "visibility": {"enabled": true}, "action": {"type": "start_booking"},
        "props": {"title": {"ar": "جمالكِ بعناية", "en": "Beauty, with care"}, "subtitle": {"ar": "احجزي موعدكِ بسهولة", "en": "Book your appointment in seconds"}, "image_asset_id": null, "overlay": 0.35, "align": "center", "height": "lg", "cta_label": {"ar": "احجزي الآن", "en": "Book now"}}},
       {"id": "tpl_intro_1", "type": "intro", "schemaVersion": 1, "visibility": {"enabled": true},
        "props": {"title": {"ar": "من نحن", "en": "About us"}, "body": {"ar": [{"t": "p", "c": [{"text": "اكتبي هنا نبذة عن صالونك."}]}], "en": [{"t": "p", "c": [{"text": "Tell clients about your salon."}]}]}, "image_asset_id": null, "layout": "text_only"}},
       {"id": "tpl_svc_1", "type": "service_list", "schemaVersion": 1, "visibility": {"enabled": true},
        "props": {"title": {"ar": "خدماتنا", "en": "Our services"}, "display": "list", "category_id": null, "service_ids": [], "show_prices": true, "show_durations": true, "columns": 1, "group_by_category": true}},
       {"id": "tpl_team_1", "type": "team", "schemaVersion": 1, "visibility": {"enabled": true},
        "props": {"title": {"ar": "فريقنا", "en": "Our team"}, "staff_ids": [], "display": "cards", "show_bios": true}},
       {"id": "tpl_rev_1", "type": "reviews", "schemaVersion": 1, "visibility": {"enabled": true},
        "props": {"title": {"ar": "تجارب عميلاتنا", "en": "What clients say"}, "min_rating": 4, "limit": 6, "show_staff": true}},
       {"id": "tpl_hours_1", "type": "hours", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"title": {"ar": "ساعات العمل", "en": "Opening hours"}, "branch_id": null}},
       {"id": "tpl_contact_1", "type": "contact", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"show_phone": true, "show_email": true, "show_whatsapp": true, "show_address": true}}
     ]
   }
 }'::jsonb, 'approved'),
('soft_modern', 'عصري ناعم', 'Soft modern',
 'بطاقات ناعمة، تنقّل بأزرار دائرية، والعروض في المقدمة.', 'Soft cards, pill navigation and offers up front.',
 '{
   "brand": {"radius": "lg", "button_style": "soft", "card_style": "elevated", "density": "comfortable"},
   "layout": {"nav_style": "pill", "service_display": "cards"},
   "pages": {
     "home": [
       {"id": "tpl_welcome_1", "type": "welcome", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"message": {"ar": "أهلاً بكِ! احجزي موعدكِ القادم أونلاين", "en": "Welcome! Book your next visit online"}, "style": "banner", "dismissible": true}},
       {"id": "tpl_hero_2", "type": "hero", "schemaVersion": 1, "visibility": {"enabled": true}, "action": {"type": "start_booking"},
        "props": {"title": {"ar": "إطلالتكِ تبدأ هنا", "en": "Your look starts here"}, "image_asset_id": null, "overlay": 0.3, "align": "start", "height": "md", "cta_label": {"ar": "احجزي موعدكِ", "en": "Book an appointment"}}},
       {"id": "tpl_offers_2", "type": "offers", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"title": {"ar": "العروض والباقات", "en": "Offers & packages"}, "package_ids": [], "display": "cards"}},
       {"id": "tpl_cats_2", "type": "categories", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"kind": "service", "display": "tiles"}},
       {"id": "tpl_svc_2", "type": "service_list", "schemaVersion": 1, "visibility": {"enabled": true},
        "props": {"title": {"ar": "الأكثر طلباً", "en": "Most loved"}, "display": "cards", "category_id": null, "service_ids": [], "show_prices": true, "show_durations": true, "columns": 2, "group_by_category": false}},
       {"id": "tpl_rev_2", "type": "reviews", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"min_rating": 4, "limit": 6, "show_staff": true}},
       {"id": "tpl_contact_2", "type": "contact", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"show_phone": true, "show_email": true, "show_whatsapp": true, "show_address": true}},
       {"id": "tpl_social_2", "type": "social", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"style": "buttons"}}
     ]
   }
 }'::jsonb, 'approved'),
('portfolio_first', 'المعرض أولاً', 'Portfolio first',
 'لخبيرات المكياج والأظافر: الأعمال أولاً ثم الخدمات.', 'For makeup and nail artists: your work first, then services.',
 '{
   "brand": {"radius": "md", "button_style": "solid", "card_style": "flat", "density": "compact"},
   "layout": {"nav_style": "bottom", "service_display": "cards"},
   "pages": {
     "home": [
       {"id": "tpl_hero_3", "type": "hero", "schemaVersion": 1, "visibility": {"enabled": true}, "action": {"type": "start_booking"},
        "props": {"title": {"ar": "أعمالي تتحدث عني", "en": "My work speaks for me"}, "image_asset_id": null, "overlay": 0.4, "align": "center", "height": "md", "cta_label": {"ar": "احجزي جلستكِ", "en": "Book a session"}}},
       {"id": "tpl_gallery_3", "type": "gallery", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"title": {"ar": "من أعمالي", "en": "My work"}, "layout": "grid", "columns": 3, "items": [], "lightbox": true}},
       {"id": "tpl_svc_3", "type": "service_list", "schemaVersion": 1, "visibility": {"enabled": true},
        "props": {"title": {"ar": "الخدمات", "en": "Services"}, "display": "cards", "category_id": null, "service_ids": [], "show_prices": true, "show_durations": true, "columns": 2, "group_by_category": false}},
       {"id": "tpl_cta_3", "type": "cta", "schemaVersion": 1, "visibility": {"enabled": true}, "action": {"type": "start_booking"}, "props": {"label": {"ar": "احجزي الآن", "en": "Book now"}, "style": "primary", "align": "center", "full_width": true}},
       {"id": "tpl_rev_3", "type": "reviews", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"min_rating": 4, "limit": 6, "show_staff": false}},
       {"id": "tpl_social_3", "type": "social", "schemaVersion": 1, "visibility": {"enabled": true}, "props": {"style": "icons"}}
     ]
   }
 }'::jsonb, 'approved')
on conflict (key) do nothing;

select app.apply_conventions('{{APP_ROLE}}');
