-- =====================================================================
--  0039 Â· the RECYCLE BIN answers to a DOCTOR too, and delete works
-- ---------------------------------------------------------------------
--  WHY THIS FILE EXISTS
--
--  Two symptoms, one cause: the soft-delete chain was never finished for
--  anyone who is not an administrator.
--
--  1. "Could not delete this record: Supabase API error (403):
--      new row violates row-level security policy for table \"reports\""
--
--     That is a WITH CHECK failure on UPDATE. A soft delete is an UPDATE
--     that sets deleted_at, so the NEW row is what gets judged - and after
--     0037 the only UPDATE policies that can judge it are:
--
--       reports_update_owner       (0037)
--           (deleted_at IS NULL AND may_edit)      <- demands a LIVE new row
--        OR (deleted_at IS NULL AND is_my_doctor)  <- demands a LIVE new row
--        OR (deleted_at IS NOT NULL AND active_admin AND own clinic)
--
--     The first two arms require deleted_at IS NULL, which is exactly what
--     a delete destroys. So for a doctor, a secretary, or an admin outside
--     the owning clinic there is NO arm that accepts the row being
--     written, and the write is refused with 42501. Only an active admin
--     of the owning clinic survives, via arm 3.
--
--     The policy that is supposed to answer "who may MARK this row
--     deleted" is reports_update_own_doctor, whose USING *and* WITH CHECK
--     are both ent_may_soft_delete - so it does not care which way
--     deleted_at is moving, and the same policy therefore also carries
--     restore. 0030 introduced it and 0034 documented it as the restore
--     path, but nothing in the chain re-asserts that it is still present.
--     On a database that missed 0030, or had it dropped, every delete and
--     every restore fails for every non-admin with precisely the message
--     above.
--
--     Section 2 re-creates it. RLS policies are PERMISSIVE and OR
--     together, so re-creating it can only ADD the ability to ask: it
--     cannot weaken 0037's admin-only restore arm, and it grants no hard
--     delete.
--
--  2. "Could not read the recycle bin: ... refused: only an active
--      administrator may read the recycle bin."
--
--     That exact sentence exists in only ONE version of
--     ent_deleted_reports: 0026's, which has no role branch at all and
--     refuses everybody except an active admin. 0034 and 0037 both
--     replaced it with a two-shape guard, and in both of those the admin
--     branch that still carries this sentence is unreachable: it is
--     entered only when the caller's own staff_profiles row says
--     role = 'admin', and ent_is_active_admin() reads that same row for
--     role = 'admin' AND is_active - so having reached the branch the
--     predicate is necessarily true. A doctor there gets the other
--     message ("...or an assigned secretary"). Seeing this sentence
--     therefore means the deployed function is still 0026's, whatever
--     else has been applied.
--
--     Section 3 replaces it with the rule this release was asked for: the
--     bin answers to THREE shapes, each scoped by what it already owns -
--     an active admin over his own clinic, a secretary over the doctors
--     she is assigned to, and now a doctor over his own shelf. A doctor
--     is no longer told to ask; he can see what he removed and put it
--     back himself. The payload stays withheld: the bin names the patient
--     and says who deleted it and when, and nothing more.
--
--  WHAT IS DELIBERATELY NOT TOUCHED
--    Â· reports_select_owner  - deleted rows stay hidden from every
--                              ordinary read. The bin is still the only
--                              door, and it is still a function.
--    Â· reports_delete_admin  - the only hard delete: still admin-only,
--                              still over an ALREADY-deleted row.
--    Â· reports_delete_own_doctor - stays absent. Nothing here gains an
--                              irreversible delete.
--    Â· ent_may_edit_report / ent_may_read_own_clinic - the read rule and
--                              the own-clinic write rule are unchanged, so
-- ---------------------------------------------------------------------
-- 1. THE PREDICATE - five arms, none removed
-- ---------------------------------------------------------------------
-- Kept byte-compatible with the substrings 0029, 0030 and 0034 verify
-- against, so re-running any of those files after this one still passes:
--   is_draft AND created_by          (0029, the author arm)
--   p_doctor = public.ent_auth_uid() (0026, the row's own doctor)
--   ent_is_active_admin()            (0026, an active admin)
--   ent_claim_clinic_id()            (0026, of the OWNING clinic)
--   me.assigned_doctor_id            (0034, the secretary's shelf)
--   FROM public.staff_profiles me    (0034, resolved from her own row)
--
-- THE ONE ADDITION (0039). 0034's secretary arm is clinic-bound: it
-- demands me.clinic_id = reports.clinic_id. That was correct while a
-- secretary had exactly one clinic, but 0037 then let one secretary work
-- for doctors in OTHER clinics and widened her read and write to that
-- whole assigned set. Delete was left behind on the narrow rule, so a
-- cross-clinic secretary could open a record, save it, and then be
-- refused when she tried to remove it - and refused again at restore.
-- ent_is_my_doctor() is the single definition of "is this doctor one I
-- may work under" that 0037 already put in front of read, write and the
-- bin, so her delete scope becomes exactly her assigned set and cannot
-- drift from the rest of them.
--
-- The 0034 arm is kept as well, not replaced: it is what makes a re-run
-- of 0034's own guard still pass, and it is the same-clinic case.
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
        -- 0029, unchanged: the author of an UNFINISHED draft may always
        -- remove her own. Draft-only on purpose - see 0029's header.
        (is_draft AND created_by = public.ent_auth_uid())
     OR -- 0026, unchanged: the row's own doctor
        (p_doctor = public.ent_auth_uid()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- 0026, unchanged: an active admin of the OWNING clinic
        (public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- 0034, unchanged: a secretary on her PRIMARY doctor's shelf,
        -- in her own clinic.
        EXISTS (
            SELECT 1
              FROM public.staff_profiles me
             WHERE me.id = public.ent_auth_uid()
               AND me.is_active
               AND me.role = 'secretary'
               AND me.clinic_id = reports.clinic_id
               AND p_doctor = me.assigned_doctor_id
        )
     OR -- 0039, NEW: a secretary on ANY doctor she is assigned to
        -- (0037's junction set, which may sit in another clinic). The
        -- same predicate the read, write and bin arms already use. It
        -- reaches no doctor she was not assigned to: ent_is_my_doctor
        -- requires her own active secretary row, and a real active
        -- doctor on the other end.
        public.ent_is_my_doctor(p_doctor)
    FROM public.reports
    WHERE id = p_id
$$;

COMMENT ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) IS
    'True when the caller may mark this report deleted, and - because the policy sets USING and WITH CHECK to the same call - also when he may put it back: the author of an UNFINISHED draft (0029), the row''s own doctor (0026), an active admin of the OWNING clinic (0026), a secretary on her primary doctor''s shelf (0034), or a secretary on any doctor she is assigned to (0039, ent_is_my_doctor). Never a clinic manager, never a cross-clinic grantee, never a hard delete.';

REVOKE ALL ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. THE POLICY THAT MAKES DELETE - AND RESTORE - WORK
-- ---------------------------------------------------------------------
-- Re-created here for the reason in the header: it is the ONLY policy on
-- reports whose USING and WITH CHECK are the same predicate, so it is the
-- only one that can judge a row in EITHER direction. Setting deleted_at
-- and clearing it again both pass or both fail, which is why one missing
-- policy produced two broken buttons.
--
-- WHY THIS IS SAFE TO RE-CREATE BLINDLY. RLS policies are PERMISSIVE: a
-- row passes if ANY policy passes, so adding one can only widen what may
-- be asked for, never narrow it. The reach of this particular policy is
-- ent_may_soft_delete, and every arm of that predicate is a shelf the
-- caller already owns (author of her own draft, the row's own doctor, an
-- active admin of the owning clinic, an assigned secretary). Nothing here
-- grants a DELETE, so no irreversible path is opened: 0026 removed
-- reports_delete_own_doctor and this file does not restore it.
--
-- WHY THE OLD AND NEW ROW BOTH GO THROUGH THE SAME CALL. USING sees the
-- OLD row and answers "may this person touch it"; WITH CHECK sees the NEW
-- one. Setting them to the same predicate is the whole trick - it means
-- this policy alone can never move a row into a state the caller may not
-- leave. A doctor cannot use it to resurrect somebody else's record,
-- because the predicate still has to answer true for the row's own shelf.
DROP POLICY IF EXISTS reports_update_own_doctor ON public.reports;

CREATE POLICY reports_update_own_doctor ON public.reports
    FOR UPDATE TO authenticated
    USING (
        public.ent_may_soft_delete(clinic_id, doctor_id, id)
    )
    WITH CHECK (
        public.ent_may_soft_delete(clinic_id, doctor_id, id)
    );

COMMENT ON POLICY reports_update_own_doctor ON public.reports IS
    '0030 created it, 0039 re-asserts it: wires the ent_may_soft_delete predicate to a policy so a soft delete (and the matching restore) actually reach the database. Additive only - RLS policies OR together, so this adds the ability to MARK A ROW DELETED and to UNMARK it for the author of her own unfinished draft, the row''s own doctor, an active admin of the owning clinic, and an assigned secretary. It grants no hard delete (0026 removed that) and lets nobody undelete a row they may not otherwise touch: 0037''s admin-only restore arm is untouched.';

-- ---------------------------------------------------------------------
-- 3. THE RECYCLE BIN - three readers, three scopes
-- ---------------------------------------------------------------------
-- SECURITY DEFINER, because reports_select_owner hides deleted rows from
-- EVERY reader including an admin (0026), and this is the single,
-- deliberate exception. The guard and the scope live in the same WHERE
-- clause, so a widened guard can never outrun the rows it returns:
--
--   active admin  -> every deleted row in a clinic he OWNS
--                    (ent_claim_clinic_id(), NOT ent_is_member_of,
--                     which is also true for a clinic manager)
--   secretary     -> deleted rows of EVERY doctor she is assigned to
--                    (ent_is_my_doctor, 0037) - may sit in another clinic
--   doctor        -> NEW. Deleted rows of HIS OWN shelf only.
--
-- A doctor was previously told to ask an administrator. That was
-- defensible while the bin was an admin tool, but the doctor is the person
-- who fat-fingered "New form": making him wait on someone else to undo
-- his own mistake is what sends people looking for a hard delete instead.
-- His scope is no wider than his own read scope - he sees exactly the rows
-- he could already see while they were live, and nothing from another
-- shelf or another clinic.
--
-- NO PAYLOAD IS RETURNED, unchanged from 0026. The bin answers "what was
-- removed and can I put it back", not "reproduce the patient's record".
-- Restoring makes the row readable again through the ordinary policies,
-- which is the point: the bytes come back when they are actually needed.
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
    me public.staff_profiles%ROWTYPE;
BEGIN
    -- Resolve the caller from the verified JWT once. Every guard below is
    -- written against THIS row, never against anything the request sent.
    SELECT * INTO me
      FROM public.staff_profiles
     WHERE id = public.ent_auth_uid();

    -- Guard 1: a signed-in, active staff member. No profile, or a
    -- deactivated one, is refused before any scope is even considered.
    IF me.id IS NULL OR me.is_active = false THEN
        RAISE EXCEPTION
            'refused: only a signed-in, active staff member may read the recycle bin.'
            USING ERRCODE = '42501';
    END IF;

    -- Guard 2: the role must be one of the three readers. Kept as an
    -- explicit RAISE rather than an empty result set, because "you are
    -- not allowed" and "nothing was deleted" are different facts and the
    -- user needs to be told which one it is.
    IF me.role NOT IN ('admin', 'secretary', 'doctor') THEN
        RAISE EXCEPTION
            'refused: only an active administrator, an assigned secretary, or the record''s own doctor may read the recycle bin.'
            USING ERRCODE = '42501';
    END IF;

    -- An admin must still be an ACTIVE admin - 0026's own definition of
    -- "may administrate", re-used rather than restated.
    IF me.role = 'admin' AND NOT public.ent_is_active_admin() THEN
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
       AND (
              -- admin: the clinic he OWNS. ent_is_member_of() is NOT used,
              -- because it is also true for a clinic manager, who must not
              -- read another clinic's deleted patients.
              (me.role = 'admin'     AND r.clinic_id = public.ent_claim_clinic_id())
              -- secretary: every doctor she is assigned to (0037), which
              -- may sit in another clinic. Deliberately not clinic-gated,
              -- for the same reason the read and write arms are not.
           OR (me.role = 'secretary' AND public.ent_is_my_doctor(r.doctor_id))
              -- 0039, NEW: a doctor sees the deleted rows of HIS OWN
              -- shelf. Scoped to his own clinic too, so the arm is
              -- exactly his read scope and nothing beyond it.
           OR (me.role = 'doctor'    AND r.doctor_id = me.id
                                      AND r.clinic_id = me.clinic_id)
           )
     ORDER BY r.deleted_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$;

COMMENT ON FUNCTION public.ent_deleted_reports(integer) IS
    'The recycle bin. An active administrator sees every deleted row in a clinic he owns; a secretary sees the deleted rows of EVERY doctor she is assigned to (ent_is_my_doctor, 0037), not just her primary; a doctor sees the deleted rows of his OWN shelf (0039). Anyone else is refused. Deleted rows only, no payload - enough to recognise a mistaken deletion and restore it, not enough to read a deleted record end to end. Restoring is an ordinary UPDATE of deleted_at to NULL, authorised by the UPDATE policies; it is not a special door in this function on purpose.';

REVOKE ALL ON FUNCTION public.ent_deleted_reports(integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_deleted_reports(integer) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. THE FILE CHECKS ITSELF
-- ---------------------------------------------------------------------
-- Every migration in this schema asserts what it depends on and refuses to
-- apply when one is missing, because a silently half-applied security file
-- is worse than none. These guards are the test, not decoration - and they
-- are also what stops a FUTURE edit from quietly trading one of the arms
-- away for a convenience.
--
-- Comments are stripped before every text test, for the same reason 0020
-- and 0026 do it: the explanatory prose above each arm names the very
-- identifiers being asserted, and matching a COMMENT would let a policy
-- that only DISCUSSES a clause pass the check.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    fn_soft  text;
    fn_bin   text;
    pol_src  text;
    n_soft   int;
    n_owner  int;
    n_admin  int;
    n_own    int;
BEGIN
    -- (a) the predicate exists, and every earlier arm survived.
    SELECT pg_get_functiondef(oid) INTO fn_soft
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_may_soft_delete(uuid,uuid,uuid)');

    IF fn_soft IS NULL THEN
        RAISE EXCEPTION
            'refused: ent_may_soft_delete is missing. Apply 0026 first - this file widens it, it does not define it.';
    END IF;

    fn_soft := regexp_replace(fn_soft, chr(45) || chr(45) || '[^\n]*', '', 'g');

    -- 0029 / 0026 / 0034 each assert these; 0039 must not look like it
    -- removed one, or re-running those files would fail later.
    IF fn_soft NOT ILIKE '%is_draft AND created_by%' THEN
        RAISE EXCEPTION
            'refused: the author arm is gone from ent_may_soft_delete. Apply 0029 before 0039.';
    END IF;

    IF fn_soft NOT ILIKE '%p_doctor = public.ent_auth_uid()%' THEN
        RAISE EXCEPTION
            'refused: the own-doctor arm is gone from ent_may_soft_delete. 0039 must not ship a weaker predicate than the one it widens.';
    END IF;

    IF fn_soft NOT ILIKE '%ent_is_active_admin()%'
       OR fn_soft NOT ILIKE '%ent_claim_clinic_id()%' THEN
        RAISE EXCEPTION
            'refused: the active-admin / owning-clinic arm is gone from ent_may_soft_delete.';
    END IF;

    -- 0034 asserts these two; keeping them is what makes a re-run of 0034
    -- pass, and they are the same-clinic secretary case.
    IF fn_soft NOT ILIKE '%me.assigned_doctor_id%'
       OR fn_soft NOT ILIKE '%FROM public.staff_profiles me%' THEN
        RAISE EXCEPTION
            'refused: the 0034 secretary shelf arm is gone from ent_may_soft_delete. 0039 adds an arm; it must not remove one.';
    END IF;

    -- 0039's own addition must be present, or this file did nothing.
    IF fn_soft NOT ILIKE '%ent_is_my_doctor(p_doctor)%' THEN
        RAISE EXCEPTION
            'refused: the cross-clinic secretary arm (ent_is_my_doctor) is missing from ent_may_soft_delete, so an assigned secretary still cannot delete on a shelf she works.';
    END IF;

    -- (b) the soft-delete policy is now really there. This is the whole
    --     point of section 2: without it every delete answers 42501.
    SELECT count(*) INTO n_soft
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'reports'
       AND policyname = 'reports_update_own_doctor';

    IF n_soft <> 1 THEN
        RAISE EXCEPTION
            'refused: reports_update_own_doctor is missing or duplicated (found %). Without it a doctor or secretary cannot mark a row deleted, and cannot restore one either.', n_soft;
    END IF;

    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND policyname = 'reports_update_own_doctor';

    pol_src := regexp_replace(COALESCE(pol_src, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    -- USING must route through the predicate. If someone hand-writes the
    -- scope into the policy instead, the two answers drift apart and the
    -- next fix has to be made twice.
    IF pol_src IS NULL OR pol_src NOT ILIKE '%ent_may_soft_delete%' THEN
        RAISE EXCEPTION
            'refused: reports_update_own_doctor does not route through ent_may_soft_delete. (qual: %)', pol_src;
    END IF;

    SELECT with_check INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND policyname = 'reports_update_own_doctor';

    pol_src := regexp_replace(COALESCE(pol_src, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    -- WITH CHECK must match USING. A policy that only judges the old row
    -- is how "delete works, restore is refused" happens.
    IF pol_src IS NULL OR pol_src NOT ILIKE '%ent_may_soft_delete%' THEN
        RAISE EXCEPTION
            'refused: the WITH CHECK of reports_update_own_doctor does not route through ent_may_soft_delete, so a delete could be accepted while the matching restore is refused. (check: %)', pol_src;
    END IF;

    -- (c) 0037's policies are all still present. 0039 adds a policy; it
    --     must not have replaced one of these by name.
    SELECT count(*) INTO n_owner
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND policyname = 'reports_update_owner';
    IF n_owner <> 1 THEN
        RAISE EXCEPTION
            'refused: expected reports_update_owner (0037) to still exist exactly once, found %.', n_owner;
    END IF;

    SELECT count(*) INTO n_admin
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND policyname = 'reports_delete_admin';
    IF n_admin <> 1 THEN
        RAISE EXCEPTION
            'refused: reports_delete_admin is missing or duplicated (found %). The only hard delete must stay exactly that.', n_admin;
    END IF;

    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND policyname = 'reports_delete_admin';
    pol_src := regexp_replace(COALESCE(pol_src, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    -- The hard delete is still admin-only AND still only over a row that
    -- is ALREADY soft-deleted. Both halves are load-bearing.
    IF pol_src NOT ILIKE '%deleted_at IS NOT NULL%'
       OR pol_src NOT ILIKE '%ent_is_active_admin()%' THEN
        RAISE EXCEPTION
            'refused: reports_delete_admin no longer requires an already-soft-deleted row AND an active admin. (qual: %)', pol_src;
    END IF;

    -- And the irreversible doctor delete has not come back.
    SELECT count(*) INTO n_own
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND policyname = 'reports_delete_own_doctor';
    IF n_own <> 0 THEN
        RAISE EXCEPTION
            'refused: reports_delete_own_doctor exists again, so a doctor can hard-delete his own record. 0026 removed that on purpose and 0039 must not reopen it.';
    END IF;

    -- (d) the bin answers to three readers, and still refuses strangers.
    SELECT pg_get_functiondef(oid) INTO fn_bin
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_deleted_reports(integer)');
    IF fn_bin IS NULL THEN
        RAISE EXCEPTION
            'refused: ent_deleted_reports() is missing, so a deleted row would be invisible and unrecoverable.';
    END IF;

    fn_bin := regexp_replace(fn_bin, chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_bin NOT ILIKE '%me.role = ''doctor''%'
       OR fn_bin NOT ILIKE '%r.doctor_id = me.id%' THEN
        RAISE EXCEPTION
            'refused: ent_deleted_reports has no own-shelf scope for a doctor, so he is still told to ask an administrator for his own mistake.';
    END IF;

    IF fn_bin NOT ILIKE '%ent_is_my_doctor(r.doctor_id)%' THEN
        RAISE EXCEPTION
            'refused: ent_deleted_reports lost the 0037 secretary scope, so she would delete into a bin she cannot open.';
    END IF;

    IF fn_bin NOT ILIKE '%ent_is_active_admin()%'
       OR fn_bin NOT ILIKE '%ent_claim_clinic_id()%' THEN
        RAISE EXCEPTION
            'refused: the admin guard from 0026 is gone from ent_deleted_reports, or its scope was widened to ent_is_member_of - which is also true for a clinic manager.';
    END IF;

    -- ent_is_member_of must NOT appear: it is true for a manager of a
    -- clinic he does not own, and this function is a read of deleted
    -- patient names.
    IF fn_bin ILIKE '%ent_is_member_of%' THEN
        RAISE EXCEPTION
            'refused: ent_deleted_reports is scoped by ent_is_member_of, which a clinic manager also satisfies. Scope it to the clinic the caller OWNS.';
    END IF;

    IF fn_bin NOT ILIKE '%RAISE EXCEPTION%' THEN
        RAISE EXCEPTION
            'refused: ent_deleted_reports no longer refuses anyone - every signed-in member could read deleted patient names.';
    END IF;

    -- (e) the payload is still withheld. The bin returns identifying
    --     metadata only; a payload column would put a deleted record's
    --     contents one careless click away.
    IF fn_bin ILIKE '%r.payload%' OR fn_bin ILIKE '%reports.payload%' THEN
        RAISE EXCEPTION
            'refused: ent_deleted_reports returns the report payload. The bin must stay metadata-only (0026).';
    END IF;

    -- (f) deleted rows are still hidden from ordinary reads. This is the
    --     invariant the whole design rests on.
    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND cmd = 'SELECT' AND policyname = 'reports_select_owner';
    pol_src := regexp_replace(COALESCE(pol_src, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF pol_src IS NULL OR pol_src NOT ILIKE '%deleted_at IS NULL%' THEN
        RAISE EXCEPTION
            'refused: reports_select_owner no longer hides deleted rows, so a deleted patient is readable by anyone who queries the API. (qual: %)', pol_src;
    END IF;

    -- (g) deleted_by is still stamped from the JWT, not believed from the
    --     body (0034). Without the trigger any member could name a
    --     colleague as the person who deleted a patient.
    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger t
          JOIN pg_class     c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal
           AND t.tgname = 'trg_reports_stamp_deleaser'
           AND c.relname = 'reports'
           AND n.nspname = 'public'
    ) THEN
        RAISE EXCEPTION
            'refused: trg_reports_stamp_deleaser is missing, so deleted_by would be whatever the browser claimed. Apply 0034.';
    END IF;

    RAISE NOTICE
        '0039 verified: soft delete works for a doctor, an assigned secretary and an own-clinic admin; the bin reads for all three (own shelf / assigned doctors / owned clinic) and still refuses strangers without a payload; restore goes through the same predicate; the only hard delete is still an admin over an already-deleted row.';
END;
$$;

-- Reload PostgREST's schema cache, or the new policy and function stay
-- invisible to the API until the next restart.
NOTIFY pgrst, 'reload schema';

