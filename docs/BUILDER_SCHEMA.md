# Storefront builder schema

| File | Role |
|---|---|
| `src/shared/builder/blocks.ts` | Block registry: prop schemas, placement, limits, actions, layout schema, migrations |
| `src/shared/builder/theme.ts` | Theme tokens, fonts, neutral theme, contrast checks, palette generation |
| `src/shared/builder/richtext.ts` | Restricted rich text helpers |
| `src/shared/builder/assistant.ts` | Assistant operation whitelist and strict JSON schema |
| `src/server/domains/builder/validation.ts`, `sanitize.ts` | Server validation, reference checks, text sanitisation |
| `src/server/domains/builder/service.ts`, `drafts.ts`, `brand.ts` | Draft reads and writes (optimistic concurrency) |
| `src/server/domains/builder/publish.ts` | Publish, versions, rollback, restore-to-draft, preview tokens |
| `src/server/domains/builder/templates.ts`, `generator.ts` | Platform templates and the onboarding draft generator |
| `src/server/domains/builder/assistant.ts` | Customization assistant (propose / accept / reject / undo) |

## Storage model (single source of truth)

```
brand_settings (theme tokens)  →  site_drafts.layout (nav/header/footer)  →  page_drafts.blocks (per page)
                         publish ⇒ site_versions.snapshot {brand, layout, pages}   (immutable)
                                   tenants.published_version_id → live version
```

Blocks are **configuration, never code**. No user or AI HTML or JavaScript is accepted or executed. Catalog references are IDs, and prices are always read live from the catalog when the page renders.

## Block document

```ts
type PageBlock = {
  id: string;                 // /^[a-zA-Z0-9_-]{6,40}$/, unique within the page
  type: BlockType;            // one of the 25 registry types
  schemaVersion: number;      // migrated forward by migrateBlock()
  props: Record<string, unknown>;   // validated by the type's strict zod schema
  visibility: { enabled: boolean; mobile?: boolean; desktop?: boolean };
  action?: BlockAction;       // only for types with actions = true
  children?: PageBlock[];     // only for 'columns' (max 6 entries; at most count × 2 children)
};
```

Limits: `MAX_BLOCKS_PER_PAGE = 80` (nested blocks count), `MAX_CHILDREN = 6`, and a per-type `maxPerPage`. Every type is currently at `schemaVersion: 1`. The migration hook exists, but no type defines a `migrate` function yet.

### Actions (`zAction`)

`start_booking` (optional preselected service), `service`, `product`, `category`, `staff`, `page` (each with a uuid `targetId`), `section` (the id of a block on the same page), and `external` (a safe URL).

**Safe URLs** (`isSafeExternalUrl`): at most 2000 characters; `https:` with a hostname and no credentials; or `mailto:` / `tel:` without quotes, angle brackets or whitespace. `javascript:`, `data:`, `file:` and `http:` are rejected. WhatsApp links are accepted only as `https://` URLs. (The registry's header comment mentions a "WhatsApp" protocol; the code allows https, tel and mailto only.)

### Restricted rich text (`zRich`)

`{ ar?: Node[], en?: Node[] }`, at most 60 nodes per language. Nodes: `p` (up to 50 inline runs), `h2`, `h3` (up to 10), `ul`, `ol` (up to 30 items of up to 20 runs). Inline run: `{ text ≤ 2000, bold?, italic?, href?: safe URL }`.

### Registry

Localized short text (`zShort`) means `{ ar?, en? }` with each value at most 160 characters. All prop objects are `.strict()`, so unknown keys are rejected.

| Type | Category | Placement | Max/page | Action | Plan feature | Props (defaults in brackets) |
|---|---|---|---|---|---|---|
| `hero` | media | page | 2 | yes | — | `title`, `subtitle?`, `image_asset_id` [null], `overlay` 0–0.8 [0.35], `align` start/center/end, `height` sm/md/lg [md], `cta_label?`, `focal` |
| `image_ad` | media | page, columns | 10 | yes | — | `image_asset_id`, `alt?`, `caption?`, `aspect` 16:9/3:1/4:3/1:1 [3:1], `focal` |
| `image` | media | page, columns | 30 | yes | — | `image_asset_id`, `alt?`, `aspect` 16:9/4:3/1:1/3:4/auto [auto], `rounded` [true], `focal` |
| `text` | content | page, columns | 30 | no | — | `content` (rich), `align`, `background` none/surface/primary/secondary/accent/image |
| `cta` | content | page, columns | 20 | yes | — | `label`, `style` primary/secondary/outline, `align` [center], `full_width` [false] |
| `service_list` | catalog | page | 6 | no | — | `title?`, `display` list/cards [cards], `category_id` [null], `service_ids[]` ≤ 50, `show_prices`, `show_durations`, `columns` 1–4 [2], `group_by_category` |
| `service_feature` | catalog | page, columns | 12 | no | — | `service_id`, `layout` image_start/image_end/stacked, `show_price` |
| `categories` | catalog | page | 4 | no | — | `title?`, `kind` service/product, `display` chips/tiles |
| `product_grid` | commerce | page | 6 | no | `feature.products` | `title?`, `display` grid/list, `category_id`, `product_ids[]` ≤ 50, `columns` 1–4 [3], `show_prices` |
| `product_feature` | commerce | page, columns | 12 | no | `feature.products` | `product_id`, `layout` |
| `team` | people | page | 3 | no | — | `title?`, `staff_ids[]` ≤ 50, `display` cards/avatars, `show_bios` |
| `gallery` | media | page | 6 | no | — | `title?`, `layout` grid/masonry/carousel, `columns` 2–5 [3], `items[]` ≤ 60 `{image_asset_id, alt?, caption?}`, `lightbox` |
| `offers` | catalog | page | 4 | no | — | `title?`, `package_ids[]` ≤ 20, `display` cards/list |
| `reviews` | trust | page | 2 | no | — | `title?`, `min_rating` 1–5 [4], `limit` 1–20 [6], `show_staff` |
| `intro` | content | page | 4 | yes | — | `title?`, `body` (rich), `image_asset_id`, `layout` image_start/image_end/text_only |
| `map` | info | page, columns | 2 | no | — | `title?`, `branch_id`, `zoom` 10–18 [15] |
| `hours` | info | page, columns | 2 | no | — | `title?`, `branch_id` |
| `contact` | info | page, columns | 2 | no | — | `title?`, `show_phone`, `show_email`, `show_whatsapp`, `show_address` |
| `social` | info | page, columns | 2 | no | — | `title?`, `style` icons/buttons |
| `faq` | content | page | 3 | no | — | `title?`, `items[]` ≤ 40 `{q: short, a: localized ≤ 2000}` |
| `policies` | trust | page, columns | 2 | no | — | `title?`, `page_ids[]` ≤ 10 |
| `page_link` | content | page, columns | 12 | no | — | `page_id`, `label?`, `description?`, `image_asset_id` |
| `welcome` | content | page | 1 | yes | — | `message`, `style` banner/card, `dismissible` |
| `spacer` | layout | page, columns | 30 | no | — | `size` sm/md/lg, `divider` |
| `columns` | layout | page | 10 | no | — | `count` 2–3, `gap` sm/md/lg, `stack_on_mobile`; children are blocks allowed in `columns` |

`focal` is one of `center`, `top`, `bottom`, `start` or `end` (CSS `object-position` for fixed-aspect crops).

### Layout (`zLayout`)

| Field | Values (default) |
|---|---|
| `nav_style` | `simple`, `pill`, `bottom` (simple) |
| `header` | `show_logo`, `show_name`, `sticky`, `show_book_button` (all true) |
| `footer` | `show_social`, `show_hours`, `show_policies`, `show_powered_by` (all true) |
| `booking_entry` | `header`, `floating`, `both` (both). An always-available booking entry: it cannot be removed, only placed. |
| `service_display` | `list`, `cards` (cards) |
| `product_display` | `grid`, `list` (grid) |

`footer.show_powered_by = false` is refused when saving (`planFeature('feature.remove_powered_by')`) and when publishing (`powered_by_required`) unless the plan has `feature.remove_powered_by`. Rollback and restore-to-draft re-apply the plan rule, so an old version cannot bring back a hidden mark.

## Brand and theme tokens

### Two token namespaces (`src/app/globals.css`)

| Namespace | Used for | Source |
|---|---|---|
| `luma-*` | LUMA's own identity: marketing site, dashboard, admin. The brand-guide palette is `#E4B5CA`, `#CF97BA`, `#9E6898`, `#5B3764`. | static Tailwind theme |
| `sf-*` | A business storefront | CSS variables (`--sf-primary`, …) set on the storefront root from that business's `brand_settings` |

A storefront **never** uses LUMA's palette by default. New businesses start from `NEUTRAL_BRAND`: primary `#2F2A26`, background `#FBF9F6`, heading font El Messiri, body font IBM Plex Sans Arabic, radius `md`, `solid` buttons, `bordered` cards, `comfortable` density.

### Brand schema (`zBrand`)

| Token | Values |
|---|---|
| `colors` | `primary`, `on_primary`, `secondary`, `accent`, `background`, `surface`, `text`, `muted`, `border`; each `#RRGGBB` |
| `fonts.heading`, `fonts.body` | allowlist of Arabic-capable Google Fonts: `ibm_plex_arabic`, `tajawal`, `cairo`, `almarai`, `readex_pro`, `noto_kufi`, `el_messiri`, `reem_kufi`, `amiri`, `noto_naskh`, `markazi` |
| `radius` | `none`, `sm`, `md`, `lg`, `pill` (0, 4, 10, 18, 999 px) |
| `button_style` | `solid`, `outline`, `soft` |
| `card_style` | `flat`, `bordered`, `elevated` |
| `density` | `compact`, `comfortable`, `spacious` |
| `spacing_scale` | 0.75–1.5 |
| `logo_asset_id`, `wordmark_text` (≤ 60), `tagline_ar` / `tagline_en` (≤ 140) | — |

`brand_settings` also stores `excluded_colors`, `brand_character` (onboarding answers) and `pending_palette`. Palette suggestions **are never applied automatically**; the owner must accept them.

### Contrast checks

`contrastWarnings()` computes WCAG contrast ratios and returns **warnings** shown in the builder. Colours are never "fixed" silently.

| Pair | Minimum ratio |
|---|---|
| `text` / `background` | 4.5 |
| `text` / `surface` | 4.5 |
| `on_primary` / `primary` | 4.5 |
| `muted` / `background` | 3 |

`paletteFromSeeds(seeds, mood, excluded)` builds a deterministic palette from one or two seed colours (chosen by the owner or taken from a logo) and a mood (`soft`, `bold`, `classic`). It nudges tokens away from excluded colours and sets `on_primary` with `onColor()`.

## Validation and sanitisation

Each save (`PUT builder/pages/{pageId}/blocks`) and the publish step run `validatePage()`:

1. **Structure** (`validateBlocks`): strict schema per block, unique ids, placement (page vs columns), `action` only where `actions` is true, `children` only on `columns`, per-type `maxPerPage`, 80 blocks in total. Any structural issue rejects the save (422).
2. **Sanitisation** (`sanitizeBlocks` → `sanitizeText`): every string prop except `url` / `href` (which the registry validates) has all markup stripped with `sanitize-html` (no allowed tags; `script`, `style`, `textarea`, `noscript`, `iframe` and `object` contents dropped) and control characters removed. Basic entities are decoded back so "A & B" stays readable. React escaping on render is a second layer.
3. **Reference checks** (`checkReferences`) against **this tenant's** rows:
   - **Errors** (the save is rejected): a service, product, category, staff member, page, package, branch or asset id that does not exist in this tenant, including another tenant's id. Also any asset that is not `public`: private evidence or receipts can never be placed on a page.
   - **Warnings** (saved; the storefront shows a fallback): `archived`, `hidden`, `inactive`, `missing_section`, a category of the wrong kind for the block, `feature_disabled` (product blocks without `feature.products`), and `broken_asset` (asset not `ready`).

Drafts use **optimistic concurrency**: each write carries the `version` it read. `page_drafts.version`, `site_drafts.version` and `brand_settings.version` must match, otherwise 409 `version_conflict`. Pages are archived, not deleted. Custom pages count against `limit.custom_pages`, and reserved slugs (`home`, `services`, `booking`, `checkout`, `account`, `api`, `preview`, …) are refused.

## Publishing, versions, rollback and preview

| Operation | Endpoint | Rules |
|---|---|---|
| Publish | `POST builder/publish` (`builder.publish`, idempotency key required) | Per-tenant advisory lock (`publish:<tenant>`). The **readiness checklist** must pass (bookable service, a provider, a working schedule, contact details, a confirmed booking policy); otherwise 422 `not_ready`. Then **full validation** of every page and the layout; otherwise 422 `publish_validation_failed`. An immutable `site_versions` snapshot is inserted (`version_number = max + 1`), and `tenants.published_version_id` moves in the **same transaction**. The first publication moves the tenant from `onboarding` to `active`. Audited. |
| Versions | `GET builder/versions` | Last 100 versions, with `is_live`, publisher and `restored_from` |
| Rollback | `POST builder/versions/{id}/rollback` (`builder.publish`, idempotency key required) | Republishes the old snapshot **as a new version** (`restored_from_version_id`, note "rollback to vN"). Only the design moves; bookings, orders, inventory and catalog are untouched and prices stay live. The old pages must pass **structural** validation. Reference checks and the readiness checklist are not re-run. The powered-by rule is re-applied. |
| Restore to draft | `POST builder/versions/{id}/restore-draft` (`builder.edit`) | Copies a version into the drafts **without publishing**. Bumps every draft version so open editors get a conflict. Keeps the current logo if the old one is gone. Pages that no longer exist are skipped. |
| Preview tokens | `POST/GET builder/preview-tokens`, `DELETE builder/preview-tokens/{id}` | A random 32-byte token is returned **once**; only its keyed hash is stored. TTL is capped at 168 h (DB CHECK of 7 days). Revocable. `/preview/{token}` renders the draft with `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` (`next.config.ts`). Analytics events from previews and from the builder are marked excluded. |

## Templates

- Platform-managed in `/platform/templates` (`platform.templates.manage`). Businesses see only `approved` templates whose `business_types` include their type.
- Three starter templates are seeded by migration `0100` (only if absent): `classic_elegance`, `soft_modern` and `portfolio_first`.
- A template document carries only **structure and shape tokens**: radius, button and card style, density, fonts, a partial layout, and page block arrays. Applying one (`POST builder/templates/{id}/apply`) changes the **draft** only, gives every block a fresh id, and **never** changes colours, logo, catalog or prices.
- Platform owners can toggle block types in `builder_components` (`/platform/builder-components`). **Gap:** `disabledComponentTypes()` is never called by the builder or storefront, and `min_plan_feature` is never read, so these switches currently have no effect.

## Customization assistant

Requires `feature.customization_ai` and a connected AI provider. Without a provider, `POST builder/proposals` returns 503 `ai_unavailable`, and the manual builder keeps working.

### Whitelisted operations (`ASSISTANT_OPS`)

| Operation | Fields | Effect |
|---|---|---|
| `set_color` | `token` (one of the 9 colour tokens), `hex` | brand colour |
| `set_font` | `slot` heading/body, `font_key` (allowlist) | brand font |
| `set_radius`, `set_button_style`, `set_card_style`, `set_density` | `value` (enum) | brand shape |
| `set_nav_style` | `value` simple/pill/bottom | layout |
| `move_block` | `page_id`, `block_id`, exactly one of `before_id` / `after_id` / `to_index` | reorder within one page |
| `set_block_visibility` | `page_id`, `block_id`, `enabled` | show or hide a block |
| `set_text` | `page_id`, `block_id`, `field`, `ar?` / `en?` | one text field listed in `TEXT_FIELDS` for that block type |

`TEXT_FIELDS` allows: `hero` (`title`, `subtitle`, `cta_label`), `intro` (`title`, `body` rich), `text` (`content` rich), `cta` (`label`), `welcome` (`message`), `image_ad` (`caption`, `alt`), `image` (`alt`), `page_link` (`label`, `description`), and `title` on the list-style blocks.

### Safety rules

- **Inexpressible by design**: prices, payments, policies, appointments, permissions, links/URLs and publishing. The operation schema has no fields for them.
- The provider is called with a **strict JSON schema** (`ASSISTANT_JSON_SCHEMA`, every property present, unused ones `null`, at most 30 operations). The loose envelope is re-validated, and then **each operation is validated individually** with `zAssistantOp` against the current draft. Rejected operations are kept with a reason: `unsupported_operation`, `unsupported_property`, `invalid_value`, `unknown_page`, `unknown_block`, `move_needs_one_target`, `links_not_allowed` (any URL-like or tag-like text), `text_too_long` (short fields over 160 characters), `empty_text`.
- **Prompt-injection handling**: the system prompt tells the model that `input.owner_request` is untrusted text describing design changes only and can never change the rules. Even if the model complies with an injection, only whitelisted operations on ids present in the input can be applied.
- **Proposals, not changes**: a proposal stores the accepted operations, a before/after diff, the rejected operations, the explanation (sanitised, at most 2000 characters) and the base draft versions. An output with no acceptable operations is stored as `invalid` and cannot be accepted. Provider failures are stored as `failed`, and nothing is changed.
- **Accept** applies to the **draft only** (never publishes). It is refused with 409 `proposal_stale` if the brand, layout or touched pages changed since the proposal, or if re-evaluating the operations rejects any of them. It stores an `undo_snapshot` and the resulting versions.
- **Undo** restores the before values, and is refused with 409 if the draft was edited after accepting.
- Every propose, accept, reject and undo is audited. The AI call is recorded in `ai_runs` (see [AI_AND_MARKETING.md](AI_AND_MARKETING.md)).
- Gap: assistant calls do not consume `limit.ai_runs_monthly`.
