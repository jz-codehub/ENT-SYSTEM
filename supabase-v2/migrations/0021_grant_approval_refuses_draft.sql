-- =====================================================================
--  0021 · grant approval must refuse a draft
-- ---------------------------------------------------------------------
--  WHY THIS FILE IS A REPAIR, NOT A FEATURE
--
--  0019 went live before its own draft guard existed. ent_may_grant_report_access()
--  landed with the owning-clinic rule already correct - an active admin of the
--  clinic that owns the report, or the report's own doctor, and never a manager
--  of another clinic - but WITHOUT the is_draft test that the reviewed version
--  of 0019 now carries.
--
--  So today an owning-clinic admin can approve a grant over a DRAFT. Nothing
--  is lost by that grant: every downstream predicate re-checks is_draft, so
--  ent_has_report_grant and ent_may_edit_report both refuse it and the row can
--  never open anything. But a grant row that means nothing is worse than no
--  row at all - it shows up in an audit of who was given access to what, and it
--  becomes live the instant that draft is finalised, without anyone approving
--  anything at that moment.
--
--  This file refuses the grant at the only place it can be refused: creation.
--
--  WHAT IT TOUCHES
--
--    replaces : ent_may_grant_report_access  (CREATE OR REPLACE, same signature)
--    creates  : nothing
--    drops    : nothing
--    writes   : nothing
--
--    report_access_grants and every row in it are untouched. reports,
--    staff_profiles and every other table are untouched. This file contains no
--    INSERT, UPDATE or DELETE of any kind - the whole repair is one function
--    definition.
--
--  ORDER: apply this BEFORE 0020. 0020's assertion E checks that
--  ent_may_grant_report_access carries the is_draft guard, and it will refuse
--  to let 0020 complete until it does. That is deliberate: the assertion is the
--  test, and a repair that skipped it would be a repair nobody verified.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE RULE, SPELLED OUT
--
--    You may approve, revoke or re-point an access grant for a report when:
--
--      · you are an ACTIVE ADMIN of the clinic that OWNS that report, or
--      · you are the report's OWN doctor.
--
--    You may not when:
--
--      · the report is a DRAFT - there is no finished patient to hand over,
--        and a grant issued now would silently activate the moment the draft
--        is finalised, with nobody approving anything at that moment;
--      · you merely manage that clinic (clinics.managed_by). Managing a
--        clinic's staff, settings and analytics is not authority over its
--        patients' records, and 0019 draws that line deliberately;
--      · you are a secretary, in any clinic. She may read and correct the
--        record, but widening its audience is not her decision;
--      · your account is deactivated.
--
--    The tenant check is the single equality me.clinic_id = r.clinic_id.
--    It is stated here directly rather than borrowed from a read predicate,
--    because a read predicate answers "may he see it" and this question is
--    "does he own it". Deriving one from the other is what let 0016 widen
--    writing by accident.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_grant_report_access(p_report uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.reports r
          JOIN public.staff_profiles me
            ON me.id = public.ent_auth_uid()
         WHERE r.id = p_report
           AND me.is_active
                -- DRAFTS ARE NOT GRANTABLE, and the refusal is here rather
                -- than in the predicate below. A draft is unfinished work
                -- inside one clinic: no cross-clinic view of it, no
                -- cross-clinic edit of it, and therefore no legitimate reason
                -- for anyone to hold permission over it. Refusing the GRANT
                -- means the row never comes into existence, instead of
                -- allowing one that every downstream check then has to
                -- remember to ignore.
           AND r.is_draft = false
           AND (
                -- 1. an active admin OF THE OWNING CLINIC. This single
                --    equality is the whole tenant check: no
                --    ent_admin_covers_clinic(), no ent_is_member_of(), and
                --    deliberately no read function.
                ( me.role = 'admin' AND me.clinic_id = r.clinic_id )
                -- 2. the clinician who owns the record himself
             OR ( me.role = 'doctor' AND r.doctor_id = me.id )
                -- A secretary is deliberately absent.
           )
    )
$$;

COMMENT ON FUNCTION public.ent_may_grant_report_access(uuid) IS
    'True when the caller may approve, revoke or re-point an access grant for this report: an active admin of the clinic that OWNS the report, or the report''s own doctor. Never a manager of another clinic - a manager-signed or self-signed grant would defeat the purpose of the whole table. Returns FALSE for any draft, so a grant over unfinished work can never be created at all.';


-- ---------------------------------------------------------------------
-- 2. PRIVILEGES
--
--    Restated rather than assumed. 0019 already grants this to authenticated
--    and not to anon; repeating it makes the repaired function's exposure
--    explicit at the point the repair happens, so a reader does not have to
--    check a file they are no longer applying.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ent_may_grant_report_access(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_grant_report_access(uuid) TO authenticated;


-- ---------------------------------------------------------------------
-- 3. THE ASSERTION
--
--    Fails loudly if the guard is missing. It is the one thing this repair
--    exists to install, so it is the one thing worth refusing to complete
--    without. 0020 asserts the same condition; having it here means the
--    repair can be verified on its own, before 0020 is even run.
-- ---------------------------------------------------------------------
DO $$
DECLARE fn_src text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_may_grant_report_access(uuid)');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION
            'refused: ent_may_grant_report_access is missing. Apply 0019 first.';
    END IF;

    -- Strip comments before testing. This function's comments name the
    -- predicates it must NOT use, so a raw substring test would fail on the
    -- very statement that is correct. chr(45) is a hyphen: written this way
    -- there is no literal hyphen pair for a line-oriented comment stripper to
    -- trip over, which is the same guard 0020 uses.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_src NOT ILIKE '%is_draft = false%' THEN
        RAISE EXCEPTION
            'refused: a grant over a draft is approvable. 0021 exists to close exactly this.';
    END IF;

    IF fn_src ILIKE '%ent_admin_covers_clinic%'
       OR fn_src ILIKE '%ent_is_member_of%'
       OR fn_src ILIKE '%ent_may_touch_report%'
       OR fn_src ILIKE '%ent_may_read_own_clinic%'
       OR fn_src ILIKE '%ent_may_open_report%' THEN
        RAISE EXCEPTION
            'refused: grant approval is still derived from a read or membership rule. It must be decided against the report''s owning clinic directly.';
    END IF;

    IF fn_src NOT ILIKE '%me.clinic_id = r.clinic_id%'
       OR fn_src NOT ILIKE '%r.doctor_id = me.id%' THEN
        RAISE EXCEPTION
            'refused: the owning-clinic admin arm or the owning-doctor arm is missing.';
    END IF;
END $$;


-- 0020 follows this file. It re-asserts assertion E on the same function, so
-- by the time 0020 finishes, the draft guard has been checked twice.
NOTIFY pgrst, 'reload schema';

