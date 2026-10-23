-- =====================================================================
--  ONE-SHOT LIVE STATE DIAGNOSTIC  —  read-only, single result set.
--
--  Paste this WHOLE block into the Supabase SQL Editor and Run it once.
--  Then copy the ENTIRE result grid back.
--
--  Every row is a text report of one fact, prefixed by its section, so a
--  single grid carries everything: functions, their bodies, policies,
--  anon grants, triggers, and the grant table's shape. PostgREST cannot
--  reach pg_catalog at all, so this has to be run from the SQL Editor;
--  a browser tool cannot produce it.
--
--  It contains no INSERT / UPDATE / DELETE / DDL. Nothing is modified.
--
--  HOW TO COPY THE RESULT: click the grid, Ctrl+A, Ctrl+C, and paste it
--  into supabase-v2/scripts/_live_paste.txt. Include the FN rows even
--  though the BODY text is long - the classifier needs it to tell an old
--  function body from the revised one.
-- =====================================================================

WITH facts AS (

  -- A1  functions: signature + SECURITY DEFINER flag
  SELECT 'FN' AS section,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
         'security_definer=' || p.prosecdef
           || ' returns=' || pg_get_function_result(p.oid) AS detail
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

  UNION ALL

  -- A2  the bodies. This is what decides old vs revised.
  SELECT 'BODY', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         pg_get_functiondef(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
         'ent_may_edit_report','ent_may_grant_report_access',
         'ent_has_report_grant','ent_stamp_report_ownership',
         'ent_stamp_photo_ownership','ent_stamp_grant',
         'ent_may_touch_report','ent_may_access_photo')

  UNION ALL

  -- B  every policy on the patient tables and the grant table
  SELECT 'POLICY', tablename || '.' || policyname || ' [' || cmd || ']',
         'roles=' || roles::text
           || ' using=' || coalesce(regexp_replace(qual, '\s+', ' ', 'g'), '-')
           || ' check=' || coalesce(regexp_replace(with_check, '\s+', ' ', 'g'), '-')
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('reports', 'report_photos', 'report_access_grants')

  UNION ALL

  -- C  anon grants. MUST produce zero rows here.
  SELECT 'ANON', table_name, privilege_type
    FROM information_schema.role_table_grants
   WHERE grantee = 'anon' AND table_schema = 'public'

  UNION ALL

  -- D  triggers. 0018 and 0019 are mostly trigger statements.
  SELECT 'TRIGGER', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND c.relname IN ('reports', 'report_photos', 'report_access_grants')

  UNION ALL

  -- E  grant table columns
  SELECT 'COLUMN', column_name,
         data_type || ' nullable=' || is_nullable
           || ' default=' || coalesce(column_default, '-')
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'report_access_grants'

  UNION ALL

  -- F  grant table constraints
  SELECT 'CONSTRAINT', con.conname, pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'report_access_grants'

  UNION ALL

  -- G  row counts, so the repair plan can prove nothing was lost
  SELECT 'COUNT', 'clinics', count(*)::text FROM public.clinics
  UNION ALL SELECT 'COUNT', 'staff_profiles', count(*)::text FROM public.staff_profiles
  UNION ALL SELECT 'COUNT', 'reports', count(*)::text FROM public.reports
  UNION ALL SELECT 'COUNT', 'reports_final', count(*)::text FROM public.reports WHERE NOT is_draft
  UNION ALL SELECT 'COUNT', 'reports_draft', count(*)::text FROM public.reports WHERE is_draft
  UNION ALL SELECT 'COUNT', 'report_photos', count(*)::text FROM public.report_photos
  UNION ALL SELECT 'COUNT', 'report_access_grants',
                coalesce((SELECT count(*)::text FROM public.report_access_grants), 'table-absent')
)
SELECT section, name, detail FROM facts
 ORDER BY
   CASE section WHEN 'FN' THEN 1 WHEN 'BODY' THEN 2 WHEN 'TRIGGER' THEN 3
                WHEN 'POLICY' THEN 4 WHEN 'ANON' THEN 5
                WHEN 'COLUMN' THEN 6 WHEN 'CONSTRAINT' THEN 7 ELSE 8 END,
   name;
