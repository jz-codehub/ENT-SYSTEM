-- =====================================================================
--  LIVE STATE DIAGNOSTIC  —  paste these five queries into the SQL Editor
--  and send the raw output back. READ-ONLY: no DDL, no writes.
--
--  WHY (A) IS SPLIT INTO TWO HERE. The earlier version of query (A)
--  returned proname/args/returns/prosecdef, which proves a function
--  EXISTS but says nothing about what is INSIDE it - so it cannot tell
--  the revised 0019 from the pre-revision one. A2 returns the full
--  definition, which is what the comparison actually needs.
--
--  Run them in this order and paste each result.
-- =====================================================================


-- ---------------------------------------------------------------------
-- A1) WHICH FUNCTIONS EXIST  (signatures + SECURITY DEFINER)
-- ---------------------------------------------------------------------
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)             AS returns,
       p.prosecdef                               AS security_definer,
       coalesce(array_to_string(p.proconfig, ','), '') AS config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
       'ent_may_touch_report','ent_may_edit_report',
       'ent_may_grant_report_access','ent_has_report_grant',
       'ent_stamp_grant','ent_grants_narrow_only',
       'ent_stamp_report_ownership','ent_stamp_photo_ownership',
       'ent_may_read_own_clinic','ent_may_open_report',
       'ent_view_all_index','ent_open_report','ent_may_access_photo')
 ORDER BY p.proname;


-- ---------------------------------------------------------------------
-- A2) FULL FUNCTION BODY  (this is what gets compared against the files)
--     The body is long. Paste it in full - even a truncated body is
--     enough to identify which revision is live, because the markers
--     that matter all appear near the top of each function.
-- ---------------------------------------------------------------------
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
       p.prosecdef AS security_definer,
       pg_get_functiondef(p.oid) AS body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
       'ent_may_edit_report','ent_may_grant_report_access',
       'ent_has_report_grant','ent_stamp_report_ownership',
       'ent_stamp_photo_ownership','ent_stamp_grant',
       'ent_may_touch_report','ent_may_access_photo')
 ORDER BY p.proname;


-- ---------------------------------------------------------------------
-- B) EVERY POLICY ON THE TWO PATIENT TABLES  (all commands, not just SELECT)
-- ---------------------------------------------------------------------
SELECT tablename,
       policyname,
       cmd,
       roles::text,
       coalesce(regexp_replace(qual, '\s+', ' ', 'g'), '-')                  AS using_expr,
       coalesce(regexp_replace(with_check, '\s+', ' ', 'g'), '-')            AS check_expr
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('reports','report_photos','report_access_grants')
 ORDER BY tablename, cmd, policyname;


-- ---------------------------------------------------------------------
-- C) ANON GRANTS  -- MUST return 0 rows
-- ---------------------------------------------------------------------
SELECT grantee, table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'anon'
   AND table_schema = 'public'
 ORDER BY table_name;


-- ---------------------------------------------------------------------
-- D) TRIGGERS  -- the decisive one. 0018 and 0019 are both mostly
--     trigger statements, and trigger functions are invisible to REST.
-- ---------------------------------------------------------------------
SELECT c.relname AS tbl,
       t.tgname,
       pg_get_triggerdef(t.oid) AS def
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal
   AND n.nspname = 'public'
   AND c.relname IN ('reports','report_photos','report_access_grants')
 ORDER BY c.relname, t.tgname;


-- ---------------------------------------------------------------------
-- E) GRANT TABLE REAL COLUMNS  (proves which schema version created it)
-- ---------------------------------------------------------------------
SELECT column_name,
       data_type,
       is_nullable,
       coalesce(column_default, '-') AS default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'report_access_grants'
 ORDER BY ordinal_position;


-- ---------------------------------------------------------------------
-- F) GRANT TABLE CONSTRAINTS  (an older schema may lack the newer ones)
-- ---------------------------------------------------------------------
SELECT con.conname,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname = 'report_access_grants'
 ORDER BY con.conname;
