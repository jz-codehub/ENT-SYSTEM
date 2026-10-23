-- =====================================================================
--  0043 · FIX: delete / recycle-bin refused (403) + ambiguous "id"
-- ---------------------------------------------------------------------
--  TWO defects, both found live (2026-10-12), both blocking delete:
--
--  DEFECT 1 — soft delete returns 403 for a DOCTOR and a SECRETARY.
--    "new row violates row-level security policy for table reports"
--    (42501, a WITH CHECK refusal).
--
--    Proven by live probe:
--      · an ordinary UPDATE (file_name)              -> 200 OK
--      · a soft delete (deleted_at = now())          -> 403, for BOTH
--        the row's own doctor AND an assigned secretary
--      · ent_may_soft_delete(clinic,doctor,id)        -> true
--
--    RLS arithmetic. reports has TWO permissive UPDATE policies and they
--    OR together:
--      · reports_update_owner (0026): WITH CHECK allows a new row only
--        when (deleted_at IS NULL AND may_edit) OR (deleted_at IS NOT
--        NULL AND active admin). A non-admin soft-deleting sets
--        deleted_at, so this policy's WITH CHECK is FALSE for them.
--      · reports_update_own_doctor (0030/0039): WITH CHECK =
--        ent_may_soft_delete(...) = TRUE.
--    If the second policy is present, the OR is TRUE and the delete
--    lands. It does not land, and the predicate is TRUE - so the second
--    policy is NOT in force on this database. Re-asserting it is the
--    whole fix; it is additive (an OR arm) and grants no hard delete.
--
--  DEFECT 2 — ent_deleted_reports() fails at runtime with
--    `42702: column reference "id" is ambiguous`. The function declares
--    `me public.staff_profiles%ROWTYPE` (which has an `id` column) AND a
--    RETURNS TABLE whose first output column is also named `id`; inside a
--    plpgsql function those output names are variables too, so an
--    unqualified `id` collides. Rewritten below with the caller resolved
--    into explicitly-named scalars, so no %ROWTYPE name ever shadows a
--    column or an output variable.
--
--  IDEMPOTENT      : yes (CREATE OR REPLACE, DROP+ADD policy, grants).
--  DATA DESTRUCTIVE: no. Nothing is inserted, updated or deleted. Only a
--                    policy is (re)created and one function rewritten.
--  SECURITY        : RLS is NOT relaxed. The policy is the SAME additive
--                    arm 0030/0039 already ship; the function keeps every
--                    guard (active staff, admin/secretary/doctor, clinic
--                    + assigned-doctor scope) and still returns no payload.
-- =====================================================================

-- ---------------------------------------------------------------------
--  DEFECT 1 — the policy that lets a non-admin soft-delete is not in
--  force. Re-assert the predicate and the policy exactly as 0039 ships
--  them. Additive: RLS ORs permissive policies, so this only ADDS the
--  missing arm; it removes nothing and grants no hard delete.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_soft_delete(
    p_clinic uuid,
    p_doctor uuid,
    p_id     uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        -- 0029: the author of an UNFINISHED draft may always remove her own.
        (is_draft AND created_by = public.ent_auth_uid())
     OR -- 0026: the row's own doctor
        (p_doctor = public.ent_auth_uid()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- 0026: an active admin of the OWNING clinic
        (public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- 0034: a secretary on her PRIMARY doctor's shelf, in her own clinic.
        EXISTS (
            SELECT 1
              FROM public.staff_profiles me
             WHERE me.id = public.ent_auth_uid()
               AND me.is_active
               AND me.role = 'secretary'
               AND me.clinic_id = reports.clinic_id
               AND p_doctor = me.assigned_doctor_id
        )
     OR -- 0039: a secretary on ANY doctor she is assigned to (0037 set).
        public.ent_is_my_doctor(p_doctor)
    FROM public.reports
    WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) TO authenticated;

-- The policy. USING and WITH CHECK are the SAME predicate on purpose: that
-- is what lets the very same rule authorise setting deleted_at (delete) AND
-- clearing it (restore), so one missing policy never breaks two buttons again.
DROP POLICY IF EXISTS reports_update_own_doctor ON public.reports;
CREATE POLICY reports_update_own_doctor ON public.reports
    FOR UPDATE TO authenticated
    USING     ( public.ent_may_soft_delete(clinic_id, doctor_id, id) )
    WITH CHECK( public.ent_may_soft_delete(clinic_id, doctor_id, id) );

COMMENT ON POLICY reports_update_own_doctor ON public.reports IS
    '0030/0039/0043: the additive UPDATE arm that lets the author of her own unfinished draft, the row''s own doctor, an active admin of the owning clinic, or a secretary on any doctor she is assigned to MARK A ROW DELETED (and restore it). ORs with reports_update_owner; grants no hard delete.';


-- ---------------------------------------------------------------------
--  DEFECT 2 — ent_deleted_reports() rewrite. The 0039 body declares
--  `me public.staff_profiles%ROWTYPE` while the RETURNS TABLE also names
--  an output column `id`; in plpgsql those output names are variables, so
--  the unqualified `id`/`clinic_id` references collide (42702). Resolved
--  by pulling the caller into explicitly-named scalars (me_id, me_role,
--  me_clinic) so nothing shadows a column or an output variable. Logic,
--  guards and scope are otherwise identical to 0039.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_deleted_reports(p_limit integer DEFAULT 100)
RETURNS TABLE (
    id             uuid,
    patient_name   text,
    report_type    public.ent_report_type,
    clinic_id      uuid,
    clinic_name    text,
    is_draft       boolean,
    deleted_at     timestamptz,
    deleted_by     uuid,
    deleted_who    text,
    deleted_reason text,
    created_by     uuid,
    created_at     timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me_id     uuid;
    me_role   text;
    me_clinic uuid;
    me_active boolean;
BEGIN
    SELECT s.id, s.role, s.clinic_id, s.is_active
      INTO me_id, me_role, me_clinic, me_active
      FROM public.staff_profiles s
     WHERE s.id = public.ent_auth_uid();

    IF me_id IS NULL OR me_active = false THEN
        RAISE EXCEPTION 'refused: only a signed-in, active staff member may read the recycle bin.'
            USING ERRCODE = '42501';
    END IF;

    IF me_role NOT IN ('admin', 'secretary', 'doctor') THEN
        RAISE EXCEPTION 'refused: only an active administrator, an assigned secretary, or the record''s own doctor may read the recycle bin.'
            USING ERRCODE = '42501';
    END IF;

    IF me_role = 'admin' AND NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: only an active administrator may read the recycle bin.'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT r.id,
           r.patient_name,
           r.report_type,
           r.clinic_id,
           c.name,
           r.is_draft,
           r.deleted_at,
           r.deleted_by,
           COALESCE(NULLIF(btrim(sp.full_name), ''), NULLIF(btrim(sp.username), ''), ''),
           r.deleted_reason,
           r.created_by,
           r.created_at
      FROM public.reports r
      LEFT JOIN public.clinics        c  ON c.id  = r.clinic_id
      LEFT JOIN public.staff_profiles sp ON sp.id = r.deleted_by
     WHERE r.deleted_at IS NOT NULL
       AND (
              (me_role = 'admin'     AND r.clinic_id = public.ent_claim_clinic_id())
           OR (me_role = 'secretary' AND public.ent_is_my_doctor(r.doctor_id))
           OR (me_role = 'doctor'    AND r.doctor_id = me_id
                                      AND r.clinic_id = me_clinic)
           )
     ORDER BY r.deleted_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$;

REVOKE ALL ON FUNCTION public.ent_deleted_reports(integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_deleted_reports(integer) TO authenticated;

-- ---------------------------------------------------------------------
--  3. THE FILE CHECKS ITSELF
-- ---------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND policyname = 'reports_update_own_doctor';
    IF n <> 1 THEN
        RAISE EXCEPTION '0043 guard failed: reports_update_own_doctor is not present (count=%)', n;
    END IF;
    RAISE NOTICE '0043 OK: delete/recycle-bin fixed — reports_update_own_doctor re-asserted, ent_deleted_reports disambiguated';
END $$;

