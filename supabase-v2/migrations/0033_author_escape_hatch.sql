-- =====================================================================
--  0033 · THE AUTHOR ESCAPE-HATCH  (a secretary sees her own work)
-- ---------------------------------------------------------------------
--  THE BUG THIS FIXES.
--
--  A secretary enters CF4 records for months. Then her assigned_doctor_id
--  changes (a reassignment, a doctor leaving, an account re-linked), or a
--  row was written long ago when the column read differently. From that
--  moment her OLD records vanish from "DB Records" - not because they were
--  deleted, but because the read rule keys on the row's doctor_id:
--
--        ent_may_read_own_clinic(clinic_id, doctor_id)
--          ... OR (role = 'secretary' AND p_doctor = me.assigned_doctor_id)
--
--  A row stamped doctor_id = <the old doctor> no longer equals her current
--  assigned_doctor_id, so the predicate is FALSE, so RLS simply does not
--  RETURN the row. It is not a browser bug and no amount of client-side
--  paging can recover it: the row never leaves the server. This is exactly
--  the "my secretary's older CF4 patients disappeared" report, and the
--  reason the list showed one card while the patient counter still said
--  "2 records".
--
--  The same mechanism multiplies the table. ent_stamp_report_ownership
--  (0004/0018) sets doctor_id from the caller's LIVE profile on INSERT, and
--  the sync upsert targets on_conflict=(clinic_id, doctor_id, record_key).
--  Re-save under a new assignment therefore MISSES the old row and INSERTs
--  a fresh one - so one patient accrues several real rows, each on a
--  different doctor shelf. 300 rows for ~95 patients is this, not data loss.
--
--  THE FIX - AND WHY IT IS ONLY A READ ARM.
--
--  created_by is the ONE column that names who truly made the row: the
--  server stamps it on INSERT (me.id) and then FREEZES it on every UPDATE
--  (0018: NEW.created_by := OLD.created_by). It is therefore safe to key a
--  read rule on: "you may always read what you yourself created." This
--  arm is added to the SELECT policy ONLY.
--
--    - It cannot widen a clinic. ent_auth_uid() is the caller; created_by is
--      the author. A member of clinic A still cannot read clinic B's rows -
--      the arm matches ONLY rows where created_by = the caller.
--    - It still hides soft-deleted rows: deleted_at IS NULL is preserved.
--    - It grants NO write. INSERT/UPDATE/DELETE policies are untouched, so
--      reading your own old row does not let you re-stamp or move it.
--
--  DATA DESTRUCTIVE: no. Nothing is inserted, updated or deleted.
--  IDEMPOTENT: yes. Every statement is DROP ... CREATE / OR REPLACE.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. THE READ ESCAPE-HATCH on reports. The 0026 policy carried across
--     verbatim (deleted_at IS NULL, own-clinic arm, grant arm) plus ONE
--     clause: the author arm. The reviewed substrings ent_may_read_own_clinic
--     and ent_has_report_grant(id) are still present, so 0020's structural
--     assertion keeps passing.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS reports_select_owner ON public.reports;
CREATE POLICY reports_select_owner ON public.reports
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
    AND (
            public.ent_may_read_own_clinic(clinic_id, doctor_id)
         OR public.ent_has_report_grant(id)
         OR created_by = public.ent_auth_uid()
        )
    );

-- Photos ride the same rule, or a rescued report would show its text while
-- its images stayed one RLS clause away from invisible.
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
         OR uploaded_by = public.ent_auth_uid()
        )
    );


-- ---------------------------------------------------------------------
--  2. A READ-ONLY DUPLICATE REPORTER for the admin console. One row per
--     (clinic_id, doctor_id, record_key) holding MORE THAN ONE live row -
--     the real duplicate groups behind the "300 rows for 95 patients"
--     symptom - so a human can SEE the damage before anything merges.
--     Deletes nothing. Plain SQL (no plpgsql) so it stays a pure reader.
--     The admin gate lives in the WHERE clause: a non-admin gets zero rows,
--     never another clinic's counts. There is deliberately NO merge/delete
--     RPC: combining two real rows is a judgement call (which copy holds the
--     photos? the newer payload?) and must stay a human decision.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_report_duplicate_groups()
RETURNS TABLE (
    clinic_id      uuid,
    doctor_id      uuid,
    record_key     text,
    patient_name   text,
    report_type    ent_report_type,
    procedure_date date,
    row_count      bigint,
    kept_id        uuid,
    dup_ids        uuid[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH live AS (
        SELECT r.* FROM public.reports r WHERE r.deleted_at IS NULL
    ),
    grouped AS (
        SELECT clinic_id, doctor_id, record_key, count(*) AS row_count
          FROM live
         GROUP BY clinic_id, doctor_id, record_key
        HAVING count(*) > 1
    )
    SELECT g.clinic_id, g.doctor_id, g.record_key,
           (SELECT l.patient_name FROM live l
             WHERE l.clinic_id = g.clinic_id AND l.doctor_id = g.doctor_id
               AND l.record_key = g.record_key
             ORDER BY l.updated_at DESC LIMIT 1),
           (SELECT l.report_type FROM live l
             WHERE l.clinic_id = g.clinic_id AND l.doctor_id = g.doctor_id
               AND l.record_key = g.record_key
             ORDER BY l.updated_at DESC LIMIT 1),
           (SELECT l.procedure_date FROM live l
             WHERE l.clinic_id = g.clinic_id AND l.doctor_id = g.doctor_id
               AND l.record_key = g.record_key
             ORDER BY l.updated_at DESC LIMIT 1),
           g.row_count,
           (SELECT l.id FROM live l
             WHERE l.clinic_id = g.clinic_id AND l.doctor_id = g.doctor_id
               AND l.record_key = g.record_key
             ORDER BY l.updated_at DESC, l.id DESC LIMIT 1),
           (SELECT array_agg(l.id ORDER BY l.updated_at DESC)
              FROM (SELECT id, updated_at FROM live
                     WHERE clinic_id = g.clinic_id AND doctor_id = g.doctor_id
                       AND record_key = g.record_key
                     ORDER BY updated_at DESC, id DESC OFFSET 1) l)
      FROM grouped g
     WHERE public.ent_is_active_admin()
     ORDER BY g.row_count DESC, g.record_key;
$$;

COMMENT ON FUNCTION public.ent_report_duplicate_groups() IS
    'READ-ONLY: lists (clinic_id, doctor_id, record_key) groups with more than one live row, with the id to keep and the duplicate ids. Admin-only (empty for non-admins). Deletes nothing.';

REVOKE ALL ON FUNCTION public.ent_report_duplicate_groups() FROM anon;
GRANT EXECUTE ON FUNCTION public.ent_report_duplicate_groups() TO authenticated;

-- PostgREST caches the function list; reload so the new RPC is callable.
NOTIFY pgrst, 'reload schema';
