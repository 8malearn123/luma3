#!/usr/bin/env bash
# Regenerates src/server/db/schema.generated.ts from the migrated dev database.
set -euo pipefail
source <(grep -E '^DATABASE_OWNER_URL=' .env)
DATABASE_URL="$DATABASE_OWNER_URL" npx kysely-codegen --dialect postgres \
  --out-file src/server/db/schema.generated.ts \
  --exclude-pattern "schema_migrations" \
  --numeric-parser number \
  --type-mapping '{"int8":"number","tstzrange":"string","inet":"string"}'
