-- =====================================================================
--  0026 · soft delete, and an administrator's recycle bin
-- ---------------------------------------------------------------------
--  WHY SOFT DELETE
--
--  A doctor fat-fingers "New form" and a patient's whole record appears in
--  the list. Today the only way out is a hard DELETE, and once that row is
--  gone it is gone: no undo, no audit, and the doctor cannot tell the
--  difference between "I made a mistake" and "somebody made a mistake and I
--  covered for them".
--
--  So deletion becomes a MARK, not an erasure:
--
--      deleted_at      timestamptz   when it was deleted, NULL when it is not
--      deleted_by      uuid         who did it (ON DELETE SET NULL: losing the
--                                     account must not lose the fact)
--      deleted_reason  text         why, for the recycle-bin list
--
--  Nothing is ever removed by this file. A "deleted" row is still a row,
--  still restorable. That is the point.
--
--  WHERE THE GUARD LIVES, AND WHY IT IS NOT IN THE BROWSER
--
--  The temptation is to add `deleted_at = 'is.null'` to the app's queries and
--  call it done. That does not work: a doctor who queries the REST endpoint
--  by hand, or any client that forgets the filter, still RECEIVES the deleted
--  rows. Hiding a record by asking the reader not to look at it is not access
--  control.
--
--  So the hiding is in RLS, and it is unconditional: reports_select_owner
--  gains `deleted_at IS NULL`, which applies to EVERY authenticated caller
--  INCLUDING administrators. A deleted record is unreachable through ordinary
--  PostgREST no matter who asks. Administrators read them through
--  ent_deleted_reports() instead, which is SECURITY DEFINER, admin-only, and
--  scoped to the clinics that caller actually owns.
--
--  Two consequences worth stating plainly:
--
--    1. Administrators MUST use the RPC to see the recycle bin. There is no
--       query that returns deleted rows to them, by design.
--    2. The app's existing queries need no change to be CORRECT - deleted
--       rows vanish from "My Drafts" and "DB Records" because RLS stops
--       returning them, not because a filter was added and could be forgotten.
--       (The frontend still filters explicitly, so the intent is readable.)
--
--  RESTORE IS AN UPDATE, NOT A SPECIAL DOOR
--
--  reports_update_owner below gains one arm: an active administrator of the
--  OWNING clinic may update a row whose deleted_at is set, and may not update
--  one that is not theirs. Restoring is then an ordinary PATCH of deleted_at
--  back to NULL, going through the same RLS as every other write - no RPC, no
--  bypass, and no second definition of "who may undo this".
--
--  A doctor or secretary cannot edit a deleted row at all: the existing arm
--  requires deleted_at IS NULL, and the new arm requires the admin role. So a
--  deleted record is frozen, which is what makes it safe to leave lying around
--  for an administrator to look at.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. THE COLUMNS
-- ---------------------------------------------------------------------
-- IF NOT EXISTS throughout, so this file is re-runnable like every other
-- migration in this schema.
ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS deleted_by uuid
    REFERENCES public.staff_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS deleted_reason text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.reports.deleted_at IS
    'Soft-delete marker. NULL means live. Set means deleted but NOT erased: the row, its payload and its photos are all still here, only RLS stops returning it. Cleared again to restore. Nothing in this schema ever issues a hard DELETE as part of the delete flow.';
COMMENT ON COLUMN public.reports.deleted_by IS
    'The staff account that marked the row deleted. ON DELETE SET NULL on purpose: deleting an account must not erase the fact that somebody deleted a patient record.';
COMMENT ON COLUMN public.reports.deleted_reason IS
    'Free text supplied by the person deleting. Shown in the recycle bin so the next person understands what happened. No PHI.';

-- The recycle bin is queried by deleted_at descending and is a small slice of
-- the table, so a plain btree on the marker is enough. Partial, because the
-- overwhelming majority of rows are never deleted and must not be in it.
CREATE INDEX IF NOT EXISTS idx_reports_deleted
    ON public.reports (deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. WHO MAY SOFT-DELETE
-- ---------------------------------------------------------------------
-- Two callers, and the distinction matters:
--
--   own doctor        the row's own doctor may delete his own record, which
--                      is the "I fat-fingered a new form" case this file
--                      exists for
--   admin of clinic   an active admin of the OWNING clinic may delete any
--                      row in it
--
-- A clinic MANAGER (an admin whose clinic is covered by another) is refused:
-- clinic_id = ent_claim_clinic_id() is the same explicit own-clinic test the
-- hard-delete policy in 0019 uses, and it is restated here rather than
-- widened. A manager may not destroy another clinic's patients.
--
-- Secretaries are deliberately absent. A secretary works on her doctor's
-- shelf, but "my drafts" are the doctor's to dispose of; she is not the author
-- of the record and should not be able to remove it from the shelf.
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
        -- the row's own doctor
        (p_doctor = public.ent_auth_uid()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- an active admin of the OWNING clinic
        (public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
    FROM public.reports
    WHERE id = p_id
$$;

COMMENT ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) IS
    'True when the caller may mark this report deleted: the row''s own doctor, or an active admin of the OWNING clinic. Never a clinic manager, never a secretary. Answers the same question the hard-delete policies answered in 0019, but by marking the row instead of destroying it.';

REVOKE ALL ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. READ. Deleted rows are hidden from EVERYONE.
-- ---------------------------------------------------------------------
-- This replaces the 0020 policy verbatim, plus one clause. Nothing else about
-- the rule changes - the own-clinic arm and the grant arm are carried across
-- character for character, so this file cannot quietly widen anyone's reach.
DROP POLICY IF EXISTS reports_select_owner ON public.reports;
CREATE POLICY reports_select_owner ON public.reports
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
    AND (
            public.ent_may_read_own_clinic(clinic_id, doctor_id)
         OR public.ent_has_report_grant(id)
        )
    );

-- report_photos inherits the same rule, or a deleted patient's endoscopy
-- images would stay readable to anyone who could read the record: the text
-- would vanish from every list while the pictures were one click away.
DROP POLICY IF EXISTS photos_select_owner ON public.report_photos;
CREATE POLICY photos_select_owner ON public.report_photos
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
              FROM public.reports r
             WHERE r.id = report_id
               AND r.deleted_at IS NULL
        )
    AND (
            public.ent_may_read_own_clinic(clinic_id, doctor_id)
         OR public.ent_has_report_grant(report_id)
        )
    );

-- ---------------------------------------------------------------------
-- 4. WRITE. The arm that makes RESTORE work.
-- ---------------------------------------------------------------------
-- Carried across from 0019 verbatim, and given one extra arm:
--
--   live row      deleted_at IS NULL  - unchanged, ent_may_edit_report as before
--   deleted row   deleted_at IS NOT NULL AND an active admin of the OWNING
--                 clinic - this is the restore path
--
-- Why the admin arm is scoped to ent_claim_clinic_id() and not to
-- ent_is_member_of(): ent_is_member_of() is true for a clinic MANAGER, who
-- would then be able to restore (and, worse, to rewrite) another clinic's
-- deleted patients. The explicit own-clinic test is the same one 0019 uses
-- for hard deletes, for exactly this reason.
--
-- WITH CHECK matters as much as USING: without the same clause on the way
-- back out, an admin could start from a deleted row of their own clinic and
-- write it into another clinic.
DROP POLICY IF EXISTS reports_update_owner ON public.reports;
CREATE POLICY reports_update_owner ON public.reports
    FOR UPDATE TO authenticated
    USING (
        (deleted_at IS NULL
         AND public.ent_may_edit_report(clinic_id, doctor_id, id))
     OR (deleted_at IS NOT NULL
         AND public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id())
    )
    WITH CHECK(
        (deleted_at IS NULL
         AND public.ent_may_edit_report(clinic_id, doctor_id, id))
     OR (deleted_at IS NOT NULL
         AND public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id())
    );

-- INSERT is unchanged, but stated here so a row cannot be created already
-- deleted and invisible: a new row is always a live row.
DROP POLICY IF EXISTS reports_insert_owner ON public.reports;
CREATE POLICY reports_insert_owner ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (
        deleted_at IS NULL
    AND public.ent_may_edit_report(clinic_id, doctor_id)
    AND created_by = public.ent_auth_uid()
    );

-- ---------------------------------------------------------------------
-- 5. HARD DELETE IS NOW THE ADMIN'S ALONE, AND ONLY OVER A DEAD ROW
-- ---------------------------------------------------------------------
-- This is a tightening, not a loosening, and it is the point of the file.
--
-- Previously a doctor's own row could be hard-deleted through
-- reports_delete_own_doctor - which is precisely the irreversible delete this
-- migration exists to replace. That policy is REMOVED, not weakened: the
-- delete button in the app issues an UPDATE, so nothing needs it.
--
-- An administrator may still hard-delete, but only a row that is ALREADY
-- soft-deleted. That preserves a genuine "this must never come back" action
-- for a record that should not sit in the recycle bin at all, while making it
-- impossible to destroy live patient data with one careless click.
DROP POLICY IF EXISTS reports_delete_own_doctor ON public.reports;

DROP POLICY IF EXISTS reports_delete_admin ON public.reports;
CREATE POLICY reports_delete_admin ON public.reports
    FOR DELETE TO authenticated
    USING (
        deleted_at IS NOT NULL
    AND public.ent_is_active_admin()
    AND public.ent_is_member_of(clinic_id)
    AND clinic_id = public.ent_claim_clinic_id()
    );

-- ---------------------------------------------------------------------
-- 6. THE RECYCLE BIN - an admin's one way to see a deleted row
-- ---------------------------------------------------------------------
-- SECURITY DEFINER, because reports_select_owner hides deleted rows from
-- everybody and this is the single, deliberate exception. It is therefore the
-- most security-sensitive object in this file, and the guard below is stated
-- three times over on purpose:
--
--   1. the caller must be an ACTIVE admin  (ent_is_active_admin)
--   2. the row must be in a clinic they OWN (clinic_id = ent_claim_clinic_id)
--   3. the row must actually be deleted   (deleted_at IS NOT NULL)
--
-- ent_is_active_admin() resolves the caller from ent_auth_uid(), i.e. the
-- verified JWT. A service_role caller has no such uid, so the guard is FALSE
-- for it - which is correct: this is an admin console feature, and the
-- service_role path already has the whole table if it wants it.
--
-- NO payload is returned. The recycle bin needs to answer "what was removed
-- and can I put it back", not "reproduce the patient's whole record". Naming
-- a patient in a list of removed rows is the minimum an admin needs to
-- recognise the mistake; carrying the entire payload would put a deleted
-- record's contents one careless click away. Restoring makes the row readable
-- again through the normal policies, which is the point - the bytes come
-- back when they are actually needed.
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
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION
            'refused: only an active administrator may read the recycle bin.'
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
       -- guard 2: only the caller's OWN clinic. ent_is_member_of() is NOT used
       -- here, because it is also true for a clinic manager.
       AND r.clinic_id = public.ent_claim_clinic_id()
     ORDER BY r.deleted_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$;

COMMENT ON FUNCTION public.ent_deleted_reports(integer) IS
    'The recycle bin. Active administrators only, own clinic only, deleted rows only, and deliberately WITHOUT the patient payload - enough to recognise a mistaken deletion and restore it, not enough to read a deleted record end to end. Restoring is an ordinary UPDATE of deleted_at to NULL, authorised by reports_update_owner; it is not a special door in this function on purpose.';

REVOKE ALL ON FUNCTION public.ent_deleted_reports(integer) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_deleted_reports(integer) TO authenticated;

-- ---------------------------------------------------------------------
-- 7. THE FILE CHECKS ITSELF
-- ---------------------------------------------------------------------
-- Every migration in this schema asserts the rules it depends on before it
-- completes, and refuses to apply itself when one is missing. 0024 and 0025 do
-- this because a silently half-applied security file is worse than none: the
-- guards inside these files are the test, not decoration.
--
-- So: a soft-delete column that is not in the SELECT policy, or an update
-- policy that cannot restore, means this file did not do its job. Refuse.
DO $$
DECLARE
    pol_src text;
BEGIN
    -- (a) the column exists and is nullable, so "live" is the default state
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'reports'
           AND column_name = 'deleted_at'
           AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION
            'refused: reports.deleted_at is missing or NOT NULL. Live rows must be able to have no deletion timestamp.';
    END IF;

    -- (b) SELECT really does hide deleted rows
    --
    -- READ FROM pg_policies, NOT pg_class. This looked a policy up in
    -- pg_class with pg_get_viewdef(), which can never work: a POLICY is not a
    -- relation, so it has no row in pg_class at all, `pol_src` came back NULL,
    -- and the check below fired on a file that had applied its own policies
    -- correctly. The whole migration then rolled back - which is the safe
    -- outcome, but for entirely the wrong reason.
    --
    -- pg_policies.qual holds the USING expression as text, which is what is
    -- being asserted about, so that is the right source.
    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'reports'
       AND policyname = 'reports_select_owner';

    -- Comments are stripped before testing, for the same reason 0020 does it:
    -- the explanatory comment above this policy names deleted_at, and matching
    -- it would let a policy that only DISCUSSES the clause pass the check.
    pol_src := regexp_replace(COALESCE(pol_src, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF pol_src IS NULL OR pol_src NOT ILIKE '%deleted_at IS NULL%' THEN
        RAISE EXCEPTION
            'refused: reports_select_owner does not hide deleted rows. Without this clause a deleted patient is still readable by anyone who queries the API. (policy qual: %)',
            pol_src;
    END IF;

    -- (c) an admin can actually restore, i.e. the UPDATE policy has the
    --     deleted-row arm. Without it the recycle bin would be read-only.
    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'reports'
       AND policyname = 'reports_update_owner';

    pol_src := regexp_replace(COALESCE(pol_src, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF pol_src IS NULL OR pol_src NOT ILIKE '%deleted_at IS NOT NULL%' THEN
        RAISE EXCEPTION
            'refused: reports_update_owner has no arm for a deleted row, so nothing can ever be restored. (policy qual: %)',
            pol_src;
    END IF;

    -- (d) a doctor can no longer hard-delete. The irreversible path is gone.
    IF EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'reports'
           AND policyname = 'reports_delete_own_doctor'
    ) THEN
        RAISE EXCEPTION
            'refused: reports_delete_own_doctor still exists, so a doctor can still irreversibly destroy his own record. 0026 exists to replace that.';
    END IF;

    -- (e) the recycle bin exists at all
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'ent_deleted_reports'
    ) THEN
        RAISE EXCEPTION
            'refused: ent_deleted_reports() was not created, so a deleted record would be invisible and unrecoverable.';
    END IF;

    RAISE NOTICE
        '0026 verified: deleted rows hidden from every reader, restore available to an admin of the owning clinic, hard delete gone for doctors.';
END;
$$;

-- Reload PostgREST's schema cache, or the new column and function stay
-- invisible to the API until the next restart.
NOTIFY pgrst, 'reload schema';