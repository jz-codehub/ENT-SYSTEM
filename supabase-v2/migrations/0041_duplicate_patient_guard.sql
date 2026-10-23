-- =====================================================================
--  0041 · DUPLICATE PATIENT GUARD  (identity-level idempotency)
-- ---------------------------------------------------------------------
--  THE PROBLEM THIS CLOSES
--
--  reports already has UNIQUE (clinic_id, doctor_id, record_key) (0004),
--  and the browser upserts against it. That stops the SAME record from
--  being inserted twice — but record_key is a CLIENT-minted string, so
--  two different keys for the same real-world visit still produced two
--  real rows. That is exactly how the old project went ~95 patients ->
--  ~275 rows: a fresh session mints a new uuid key per save, a retry
--  after a timeout mints another, and two tabs racing each other both
--  insert. Nothing server-side compared the PATIENT. This file makes
--  the database itself say "this patient already has a record of this
--  type on this date on this shelf".
--
--  WHICH IDENTIFIER IS TRUSTED — AND WHICH IS NOT
--
--  A NAME is NOT a unique identifier: two different people can be called
--  "Juan Dela Cruz". So there is deliberately NO name-based constraint
--  here. The reliable identifiers this schema carries are:
--
--    patient_id  the hospital / chart number typed into the form
--                (patientPin / mrn / patientId / caseNumber — the same
--                chain patientRecords.extractMetadata reads). Unique per
--                person within a hospital.
--    case_number a secondary hospital reference; used ONLY when
--                patient_id is empty, so the two rules can never fight.
--
--  A name-only match is never blocked and never merged: it is surfaced
--  for HUMAN review through ent_possible_duplicates() at the bottom,
--  which lists groups but has no merge/delete power at all.
--
--  WHAT IS ENFORCED, AND IN WHAT SCOPE
--
--  Two PARTIAL unique indexes over LIVE, FINAL rows only:
--
--    uniq_reports_patient_day
--        (clinic_id, doctor_id, report_type, lower(btrim(patient_id)),
--         coalesce(procedure_date, 'epoch'))
--        WHERE NOT is_draft AND deleted_at IS NULL AND patient_id <> ''
--
--    uniq_reports_case_number_day
--        same shape on case_number, only where patient_id is empty, so
--        a patient carrying BOTH numbers is judged on patient_id alone.
--
--  Scope notes, each deliberate:
--    · per doctor shelf — the same patient legitimately appears on two
--      doctors' shelves (two specialists saw them); collapsing across
--      doctors would destroy that truth. Same shelf + same form + same
--      date + same identity = one visit = one row. THAT is the dup.
--    · drafts excluded — a recovery draft is an unfinished scratch row
--      and must never block the final save that supersedes it.
--    · soft-deleted rows excluded — a deleted row must not stop the
--      patient being re-registered; a restore that would now collide
--      honestly fails with 23505, which is the safe answer.
--    · procedure_date coalesced to the epoch — plain unique indexes
--      treat NULLs as distinct, so this makes two dateless rows for
--      the same patient collide the way two same-dated rows do.
--
--  HOW THE APP MEETS THE CONSTRAINT
--
--  dbRecords.saveToDatabase (frontend, same release) now:
--    1. before writing, looks up a live final row with the same
--       patient_id + report_type + procedure_date (RLS-scoped) and
--       ADOPTS its record_key, so the upsert merges into the existing
--       row and the user is told the existing patient was updated;
--    2. if two devices race past that check, the unique index answers
--       23505 and the save re-queries the winner and merges into IT.
--  Name-similar rows keep today's behaviour: a prompt that lets the
--  human decide (open existing / save as a new visit), never an
--  auto-merge.
--
--  IDEMPOTENT      : yes (CREATE UNIQUE INDEX IF NOT EXISTS,
--                    CREATE OR REPLACE FUNCTION).
--  DATA DESTRUCTIVE: no. Nothing is inserted, updated or deleted.
--  PRE-EXISTING DATA: over a database that already holds duplicates,
--                    index creation FAILS naming the offending rows —
--                    by design: reconcile first (the review function
--                    below lists candidates), never silently pick a
--                    winner. The new fresh project has nothing to
--                    reconcile.
-- ---------------------------------------------------------------------

-- 1. THE HARD RULE — same patient, same form, same date, same shelf.
--    lower(btrim(...)) makes "  Juan23 " and "juan23" one identity,
--    which is what a re-typed number actually looks like.
DROP INDEX IF EXISTS public.uniq_reports_patient_day;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reports_patient_day
    ON public.reports (
        clinic_id, doctor_id, report_type,
        lower(btrim(patient_id)),
        coalesce(procedure_date, DATE '1970-01-01')
    )
    WHERE NOT is_draft
      AND public.reports.deleted_at IS NULL
      AND btrim(patient_id) <> '';

COMMENT ON INDEX public.uniq_reports_patient_day IS
    '0041: one live final row per patient_id / report_type / date / doctor shelf. The database-level backstop against duplicate patient registration (double-clicks, retries, concurrent tabs). Drafts and soft-deleted rows are deliberately out of scope.';

-- 2. THE FALLBACK RULE — case_number only when patient_id is empty, so a
--    patient carrying both identifiers is never judged twice.
DROP INDEX IF EXISTS public.uniq_reports_case_number_day;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reports_case_number_day
    ON public.reports (
        clinic_id, doctor_id, report_type,
        lower(btrim(case_number)),
        coalesce(procedure_date, DATE '1970-01-01')
    )
    WHERE NOT is_draft
      AND public.reports.deleted_at IS NULL
      AND btrim(patient_id) = ''
      AND btrim(case_number) <> '';

COMMENT ON INDEX public.uniq_reports_case_number_day IS
    '0041: the case_number twin of uniq_reports_patient_day, active only where patient_id is empty so the two identifiers never both judge the same row.';

-- 3. THE REVIEW LIST — potential NAME duplicates, for human eyes only.
--    SECURITY INVOKER on purpose (the default): it reads public.reports
--    through the CALLER's own RLS, so it can never show more than the
--    caller's policies already allow, and it needs no grants of its own
--    on the table. It has NO merge and NO delete power — it lists
--    groups of live final rows sharing a normalised name + date + type
--    inside the caller's visible set, and a human decides.
CREATE OR REPLACE FUNCTION public.ent_possible_duplicates()
RETURNS TABLE (
    clinic_id      uuid,
    doctor_id      uuid,
    name_key       text,
    report_type    public.ent_report_type,
    procedure_date date,
    row_count      bigint,
    report_ids     uuid[],
    name_variants  text[]
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        r.clinic_id,
        r.doctor_id,
        lower(btrim(r.patient_name))            AS name_key,
        r.report_type,
        r.procedure_date,
        count(*)::bigint                        AS row_count,
        array_agg(r.id ORDER BY r.created_at)   AS report_ids,
        array_agg(DISTINCT r.patient_name)      AS name_variants
      FROM public.reports r
     WHERE r.deleted_at IS NULL
       AND NOT r.is_draft
       AND btrim(r.patient_name) <> ''
     GROUP BY 1, 2, 3, 4, 5
    HAVING count(*) > 1
     ORDER BY count(*) DESC, min(r.created_at)
     LIMIT 200;
$$;

COMMENT ON FUNCTION public.ent_possible_duplicates() IS
    '0041: read-only review list of potential NAME-based duplicate groups (same normalised name + date + type + shelf, live final rows) inside the caller''s own RLS-visible set. SECURITY INVOKER: RLS is not bypassed, so an admin, doctor or secretary sees only what their policies already allow. No merge, no delete — a human decides.';

REVOKE ALL ON FUNCTION public.ent_possible_duplicates() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_possible_duplicates() TO authenticated;

-- =====================================================================
--  END 0041
--  GUARD — everything above must exist exactly once, in this order:
--    · public.uniq_reports_patient_day      (unique index)
--    · public.uniq_reports_case_number_day  (unique index)
--    · public.ent_possible_duplicates()     (function, invoker)
-- =====================================================================
DO $$
BEGIN
    IF to_regclass('public.uniq_reports_patient_day') IS NULL THEN
        RAISE EXCEPTION '0041 GUARD FAILED: uniq_reports_patient_day missing';
    END IF;
    IF to_regclass('public.uniq_reports_case_number_day') IS NULL THEN
        RAISE EXCEPTION '0041 GUARD FAILED: uniq_reports_case_number_day missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'ent_possible_duplicates'
    ) THEN
        RAISE EXCEPTION '0041 GUARD FAILED: ent_possible_duplicates() missing';
    END IF;
    RAISE NOTICE '0041 OK: patient-day uniqueness + case-number fallback + invoker review function in place';
END $$;