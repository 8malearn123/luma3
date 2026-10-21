-- 0010 The runtime role never touches migration bookkeeping.
revoke all on schema_migrations from {{APP_ROLE}};
