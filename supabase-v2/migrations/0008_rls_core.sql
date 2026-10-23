-- =====================================================================
--  0008 · Row Level Security  (the actual authorization model)
-- ---------------------------------------------------------------------
--  NONE of these policies are carried over from the old project. The old
--  ones were `FOR ALL USING (true) WITH CHECK (true)` — i.e. RLS enabled
--  but authorizing nothing. Every policy below is scoped, and every one
--  that matters re-reads staff_profiles instead of trusting the JWT, so
--  a deactivated or reassigned account stops working immediately.
--
--  Two global facts enforced here:
--    1. No policy exists for the anon role, on any table. Combined with
--       0007 (no grants to anon) an unauthenticated request dies with
--       401/403 before touching data.
--    2. There is no policy that compares a column against a value taken
--       from the request body. Clinic and doctor always come from the
--       caller's profile.
-- =====================================================================


-- ---------------------------------------------------------------------
-- clinics — you may see the clinic you belong to. That is all.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS clinics_read_member ON public.clinics;
CREATE POLICY clinics_read_member ON public.clinics
    FOR SELECT TO authenticated
    USING (
        public.ent_is_member_of(id)
        OR public.ent_is_active_admin()
    );
-- No INSERT / UPDATE / DELETE policy: clinics change only via SQL console.


-- ---------------------------------------------------------------------
-- staff_profiles
--   * own row, always
--   * an admin may read everyone in HIS OWN clinic (that is what the
--     Admin -> Users table needs) — and nothing outside it
--   * updating is limited by 0007 to (full_name, specialty, license_no,
--     email, phone) AND by trg_staff_guard to non-privileged columns
--   * INSERT and DELETE have NO policy: only service_role creates or
--     removes accounts, via the auth-admin Edge Function
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_select_self ON public.staff_profiles;
CREATE POLICY profiles_select_self ON public.staff_profiles
    FOR SELECT TO authenticated
    USING ( id = public.ent_auth_uid() );

DROP POLICY IF EXISTS profiles_select_admin_clinic ON public.staff_profiles;
CREATE POLICY profiles_select_admin_clinic ON public.staff_profiles
    FOR SELECT TO authenticated
    USING (
        public.ent_is_active_admin()
        AND clinic_id = public.ent_claim_clinic_id()
        AND public.ent_is_member_of(clinic_id)
    );

DROP POLICY IF EXISTS profiles_update_self ON public.staff_profiles;
CREATE POLICY profiles_update_self ON public.staff_profiles
    FOR UPDATE TO authenticated
    USING ( id = public.ent_auth_uid() AND is_active )
    WITH CHECK ( id = public.ent_auth_uid() AND is_active );


-- ---------------------------------------------------------------------
-- reports — one rule, expressed once, used everywhere
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS reports_select_owner ON public.reports;
CREATE POLICY reports_select_owner ON public.reports
    FOR SELECT TO authenticated
    USING ( public.ent_may_touch_report(clinic_id, doctor_id) );

DROP POLICY IF EXISTS reports_insert_owner ON public.reports;
CREATE POLICY reports_insert_owner ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_may_touch_report(clinic_id, doctor_id)
        -- the author is the caller. ent_stamp_report_ownership already
        -- forces this; asserting it here means the invariant holds even
        -- if someone drops the trigger.
        AND created_by = public.ent_auth_uid()
    );

DROP POLICY IF EXISTS reports_update_owner ON public.reports;
CREATE POLICY reports_update_owner ON public.reports
    FOR UPDATE TO authenticated
    USING     ( public.ent_may_touch_report(clinic_id, doctor_id) )
    WITH CHECK( public.ent_may_touch_report(clinic_id, doctor_id) );

-- Deletion is deliberately narrower than editing: a secretary may file
-- and correct reports but may not destroy them. See DEC-03.
DROP POLICY IF EXISTS reports_delete_admin ON public.reports;
CREATE POLICY reports_delete_admin ON public.reports
    FOR DELETE TO authenticated
    USING (
        public.ent_is_active_admin()
        AND public.ent_is_member_of(clinic_id)
    );

DROP POLICY IF EXISTS reports_delete_own_doctor ON public.reports;
CREATE POLICY reports_delete_own_doctor ON public.reports
    FOR DELETE TO authenticated
    USING (
        doctor_id = public.ent_auth_uid()
        AND public.ent_may_touch_report(clinic_id, doctor_id)
    );


-- ---------------------------------------------------------------------
-- report_photos — readable/writable by whoever may touch the parent
-- report. Object bytes themselves are additionally guarded in 0009 by
-- policies on storage.objects, so a row here is a pointer, not a key.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS photos_select_owner ON public.report_photos;
CREATE POLICY photos_select_owner ON public.report_photos
    FOR SELECT TO authenticated
    USING ( public.ent_may_touch_report(clinic_id, doctor_id) );

DROP POLICY IF EXISTS photos_insert_owner ON public.report_photos;
CREATE POLICY photos_insert_owner ON public.report_photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_may_touch_report(clinic_id, doctor_id)
        AND uploaded_by = public.ent_auth_uid()
    );

-- A re-upload replaces metadata; it never reparents the photo.
DROP POLICY IF EXISTS photos_update_owner ON public.report_photos;
CREATE POLICY photos_update_owner ON public.report_photos
    FOR UPDATE TO authenticated
    USING     ( public.ent_may_touch_report(clinic_id, doctor_id) )
    WITH CHECK( public.ent_may_touch_report(clinic_id, doctor_id) );

-- No DELETE policy: removing an object is done through the patient-photos
-- Edge Function, which soft-deletes (deleted_at) and logs PHOTO_DELETE.


-- ---------------------------------------------------------------------
-- activity_logs — append your own, read your clinic's if you are admin
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS audit_insert_self ON public.activity_logs;
CREATE POLICY audit_insert_self ON public.activity_logs
    FOR INSERT TO authenticated
    WITH CHECK (
        actor_id = public.ent_auth_uid()
        AND public.ent_is_member_of(clinic_id)
    );

DROP POLICY IF EXISTS audit_select_admin ON public.activity_logs;
CREATE POLICY audit_select_admin ON public.activity_logs
    FOR SELECT TO authenticated
    USING (
        public.ent_is_active_admin()
        AND public.ent_is_member_of(clinic_id)
    );

-- A non-admin can always see their own footprint.
DROP POLICY IF EXISTS audit_select_self ON public.activity_logs;
CREATE POLICY audit_select_self ON public.activity_logs
    FOR SELECT TO authenticated
    USING ( actor_id = public.ent_auth_uid() );


-- ---------------------------------------------------------------------
-- user_presence — heartbeat your own row; admins read the clinic
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS presence_select ON public.user_presence;
CREATE POLICY presence_select ON public.user_presence
    FOR SELECT TO authenticated
    USING (
        user_id = public.ent_auth_uid()
        OR (
            public.ent_is_active_admin()
            AND public.ent_is_member_of(clinic_id)
        )
    );

DROP POLICY IF EXISTS presence_write_self ON public.user_presence;
CREATE POLICY presence_write_self ON public.user_presence
    FOR INSERT TO authenticated
    WITH CHECK ( user_id = public.ent_auth_uid() );

DROP POLICY IF EXISTS presence_update_self ON public.user_presence;
CREATE POLICY presence_update_self ON public.user_presence
    FOR UPDATE TO authenticated
    USING     ( user_id = public.ent_auth_uid() )
    WITH CHECK( user_id = public.ent_auth_uid() );

-- Admin "sign this device out" therefore does NOT revoke here (there is
-- nothing to revoke); it calls auth.admin.signOut(user_id,'global'),
-- which really does end the Supabase session. See edge-functions/auth-admin/index.ts.


-- ---------------------------------------------------------------------
-- system_flags — the app reads capabilities; only an admin flips them
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS flags_select ON public.system_flags;
CREATE POLICY flags_select ON public.system_flags
    FOR SELECT TO authenticated
    USING ( public.ent_is_authenticated() );   -- any signed-in role may READ
                                               -- capability names, nobody
                                               -- may flip them but an admin

DROP POLICY IF EXISTS flags_update_admin ON public.system_flags;
CREATE POLICY flags_update_admin ON public.system_flags
    FOR UPDATE TO authenticated
    USING     ( public.ent_is_active_admin() )
    WITH CHECK( public.ent_is_active_admin() );


-- ---------------------------------------------------------------------
-- clinic_settings — every active member reads and edits their own
-- clinic's copy. These are UI defaults (logos, physician lists), not
-- security material, so a secretary may update them; clinic_id is
-- stamped by trg_settings_stamp so nobody can write into another clinic.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS settings_select_member ON public.clinic_settings;
CREATE POLICY settings_select_member ON public.clinic_settings
    FOR SELECT TO authenticated
    USING ( public.ent_is_member_of(clinic_id) );

DROP POLICY IF EXISTS settings_write_member ON public.clinic_settings;
CREATE POLICY settings_write_member ON public.clinic_settings
    FOR INSERT TO authenticated
    WITH CHECK ( public.ent_is_member_of(clinic_id) );

DROP POLICY IF EXISTS settings_update_member ON public.clinic_settings;
CREATE POLICY settings_update_member ON public.clinic_settings
    FOR UPDATE TO authenticated
    USING     ( public.ent_is_member_of(clinic_id) )
    WITH CHECK( public.ent_is_member_of(clinic_id) );

NOTIFY pgrst, 'reload schema';
