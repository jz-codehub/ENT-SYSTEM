-- =====================================================================
--  0030 . wire ent_may_soft_delete() to a POLICY
-- ---------------------------------------------------------------------
--  THE BUG
--
--  Deleting a patient fails, in My Drafts and in DB Records alike:
--
--      Could not delete: Supabase API error (403) 42501
--      "new row violates row-level security policy for table reports"
--
--  The cause is a gap between two migrations, not a mistake in either.
--
--  0026 replaced hard deletes with soft ones and wrote its UPDATE policy
--  this way (0026:201):
--
--      WITH CHECK( (deleted_at IS NULL AND may_edit)
--               OR (deleted_at IS NOT NULL AND is_active_admin) )
--
--  That reads correctly - the second arm is the recycle bin, where an
--  ADMIN undeletes. But it was written as the ONLY way to produce a
--  deleted row, so the first arm demands the NEW row be LIVE. Setting
--  deleted_at at all is left to the admin arm.
--
--  0026 line 228 then says, in as many words: "the delete button in the
--  app issues an UPDATE, so nothing needs it" - it assumed a policy
--  already existed to let an ordinary user mark a row deleted. None did.
--
--  0029 introduced ent_may_soft_delete(), the predicate always meant to
--  answer "who may mark this row deleted", and its header calls it "the
--  predicate behind reports_update_own_doctor". That policy is in no
--  file. So as shipped:
--
--      the FUNCTION exists      (0029)
--      the POLICY does not      (missing)
--
--  Every delete therefore failed at the WITH CHECK - and it failed for
--  EVERY role including the admin, because a doctor is not an admin.
--
--  THE FIX - one policy, nothing else touched
--
--  RLS policies are PERMISSIVE and combine with OR. Adding one can only
--  ADD what a row may do; it cannot take anything away. So this is
--  additive by construction, and 0026's policy is deliberately left in
--  place to keep the recycle bin: a doctor cannot bring a deleted row
--  back (still needs the admin arm) and cannot HARD delete (0026 dropped
--  reports_delete_own_doctor and nothing here restores it).
--
--  The predicate is ent_may_soft_delete rather than a restatement, so the
--  answer stays in one place and 0029's three arms stay the rule:
--  the AUTHOR of her own UNFINISHED draft (0029), the row's own DOCTOR
--  (0026), an ACTIVE ADMIN of the OWNING clinic (0026). Never a clinic
--  manager, never a secretary on a record she did not write.
--
--  USING and WITH CHECK are set to the same call, and that is the whole
--  trick. USING sees the OLD row and answers "may this person touch it";
--  WITH CHECK sees the NEW row - the one with deleted_at set. A soft
--  delete must pass BOTH, so this policy alone can never move a row into
--  a state the caller may not leave: an admin cannot undelete somebody
--  else's row through it, because ent_may_soft_delete keeps the admin arm
--  bound to the owning clinic. Restore stays exactly where 0026 put it.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted; this
--                    file only grants the ability to ASK.
-- =====================================================================

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
    '0030: wires the ent_may_soft_delete predicate that 0029 defined but that no policy ever used. Additive only - RLS policies OR together, so this adds the ability to MARK A ROW DELETED for the author of her own unfinished draft, the row''s own doctor, or an active admin of the owning clinic. It grants no hard delete (0026 removed that) and lets nobody undelete a row they may not otherwise touch: the restore arm remains 0026''s admin-only branch.';

-- ---------------------------------------------------------------------
--  Refuse to apply unless this is really the gap it claims to close.
--
--  Applying on a database where someone has hand-written their own answer
--  to the same question would quietly stack a second, differently-worded
--  policy on top. And applying without 0029 would point a policy at a
--  function that does not exist - a migration that half-works.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    fn_src text;
    n_policies int;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_may_soft_delete(uuid,uuid,uuid)');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION
            'refused: ent_may_soft_delete(uuid,uuid,uuid) is missing. Apply 0029 first - this migration only wires the function to a policy, it does not define it.';
    END IF;

    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^' || chr(10) || ']*', '', 'g');

    -- The arms 0029 promised must still be inside the function. A policy
    -- built on a predicate that lost an arm would grant less than 0026
    -- did, and more than this file's comment claims.
    IF fn_src NOT ILIKE '%is_draft AND created_by%' THEN
        RAISE EXCEPTION
            'refused: the author arm is gone from ent_may_soft_delete. Apply 0029 before 0030.';
    END IF;

    IF fn_src NOT ILIKE '%p_doctor = public.ent_auth_uid()%' THEN
        RAISE EXCEPTION
            'refused: the own-doctor arm is gone from ent_may_soft_delete. 0030 must not ship a weaker predicate than the one it wires.';
    END IF;

    IF fn_src NOT ILIKE '%ent_is_active_admin()%' THEN
        RAISE EXCEPTION
            'refused: the active-admin arm is gone from ent_may_soft_delete.';
    END IF;

    -- 0026's own UPDATE policy must still be there. This file leans on it
    -- for the recycle bin: it is what lets an admin bring a deleted row
    -- back. Replacing it by name would take the undo away.
    SELECT count(*) INTO n_policies
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'reports'
       AND policyname = 'reports_update_owner';

    IF n_policies <> 1 THEN
        RAISE EXCEPTION
            'refused: expected reports_update_owner (0026) to still exist on public.reports, found %. Apply 0026 before 0030.',
            n_policies;
    END IF;

    RAISE NOTICE
        '0030 verified: deleting a patient now works for the row''s own doctor, the author of her own draft, and an active own-clinic admin. Hard delete is still admin-only, and still only over an already-deleted row.';
END;
$$;

NOTIFY pgrst, 'reload schema';