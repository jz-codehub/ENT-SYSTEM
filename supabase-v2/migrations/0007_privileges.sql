-- =====================================================================
--  0007 · explicit privileges  (anon gets NOTHING at all)
-- ---------------------------------------------------------------------
--  The old schema did this:
--      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
--      ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon;
--  ...and then used USING (true) policies as the only wall. When those
--  policies were permissive, the anon key became a master key. That is
--  audit findings 1 and 2, and this file is what prevents a repeat:
--  privileges are granted table-by-table, to authenticated only.
--
--  VERIFY AFTER APPLY (must return 0 rows):
--    SELECT table_name FROM information_schema.role_table_grants
--     WHERE grantee = 'anon' AND table_schema = 'public';
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Nothing for anon, anywhere.
-- ---------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, public;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, public;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, public;
REVOKE ALL ON SCHEMA public                    FROM anon, public;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, public;


-- ---------------------------------------------------------------------
-- 2. authenticated: exactly the rights the app needs, table by table.
--    RLS in 0008 then decides WHICH ROWS. Privilege says "may you use
--    this table at all", RLS says "which of these rows are yours".
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO authenticated;

-- clinics: read only. Clinics are created by an admin through the SQL
-- console / auth-admin, never from the browser.
GRANT SELECT ON public.clinics TO authenticated;

-- staff_profiles: a user reads profiles, and may patch ONLY their own
-- contact details. The column list is granted on purpose: an account
-- cannot even attempt to write `role` if it has no column privilege.
GRANT SELECT           ON public.staff_profiles TO authenticated;
GRANT UPDATE (full_name, specialty, license_no, email, phone)
                       ON public.staff_profiles TO authenticated;

-- reports
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reports         TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.report_photos   TO authenticated;

-- audit + presence
GRANT SELECT, INSERT   ON public.activity_logs  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_presence TO authenticated;

-- flags + settings
GRANT SELECT           ON public.system_flags    TO authenticated;
GRANT SELECT, UPDATE   ON public.system_flags    TO authenticated;
GRANT SELECT, INSERT, UPDATE   ON public.clinic_settings TO authenticated;


-- ---------------------------------------------------------------------
-- 3. Helper functions: callable by authenticated, never by anon.
--    (They are already unreachable because anon has no schema usage, but
--     revoke explicitly so a future "GRANT ALL TO anon" mistake — the
--     exact mistake made before — does not silently re-expose them.)
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, public;

GRANT EXECUTE ON FUNCTION
      public.ent_auth_uid()              ,
      public.ent_claim_clinic_id()       ,
      public.ent_claim_role()            ,
      public.ent_is_admin()              ,
      public.ent_is_authenticated()      ,
      public.ent_current_profile()       ,
      public.ent_is_member_of(uuid)      ,
      public.ent_is_active_admin()       ,
      public.ent_visible_doctor_id()     ,
      public.ent_may_touch_report(uuid, uuid)
  TO authenticated;

-- service_role keeps full rights (it is the Edge Function / migration key).
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';
