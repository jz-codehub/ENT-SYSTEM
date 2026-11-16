-- =====================================================================
--  0053 - allow report trigger to read the caller's admin context
-- ---------------------------------------------------------------------
--  0052 revoked EXECUTE on these helpers from authenticated, but
--  ent_stamp_report_ownership is an invoker-rights trigger and calls both
--  helpers directly on the admin report-save path. PostgreSQL therefore
--  rejected the report upsert with SQLSTATE 42501 before RLS could finish.
--
--  Both helpers are SECURITY DEFINER and derive their result only from the
--  current JWT/session and live admin ownership checks. They accept no
--  caller-selected user or clinic. Granting them to authenticated exposes
--  only that caller's active clinic/doctor context. anon and PUBLIC remain
--  denied.
-- =====================================================================

REVOKE ALL ON FUNCTION public.ent_admin_active_clinic_id()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ent_admin_active_doctor_id()
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ent_admin_active_clinic_id()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_admin_active_doctor_id()
    TO authenticated;

DO $$
BEGIN
    IF NOT has_function_privilege(
        'authenticated',
        'public.ent_admin_active_clinic_id()',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'authenticated',
        'public.ent_admin_active_doctor_id()',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION '0053 failed: authenticated report trigger context grants are missing';
    END IF;

    IF has_function_privilege(
        'anon',
        'public.ent_admin_active_clinic_id()',
        'EXECUTE'
    ) OR has_function_privilege(
        'anon',
        'public.ent_admin_active_doctor_id()',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION '0053 failed: anonymous execution must remain denied';
    END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
