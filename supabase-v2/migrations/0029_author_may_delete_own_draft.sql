-- =====================================================================
--  0029 . the AUTHOR may delete her own DRAFT
-- ---------------------------------------------------------------------
--  0026 said, on purpose: "Secretaries are deliberately absent. A
--  secretary works on her doctor's shelf, but 'my drafts' are the
--  doctor's to dispose of; she is not the author of the record and
--  should not be able to remove it from the shelf."
--
--  The first half of that is right and stays. What it did not notice is
--  its own consequence: the rule keys on the row's DOCTOR, so it also
--  refused a secretary deleting a draft SHE WROTE. The Drafts screen
--  offers that button, the database answers "no", and the user is told
--  "Could not delete this draft in the database, so nothing was
--  removed" - with no way to get rid of her own unfinished work at all.
--
--  THE FIX IS ONE ARM, AND IT IS DRAFT-ONLY.
--
--      is_draft AND created_by = ent_auth_uid()
--
--  Draft-only is the load-bearing word. ent_may_soft_delete is the
--  predicate behind reports_update_own_doctor, which governs EVERY
--  update including deleted_at - so an unscoped author arm would have
--  handed a secretary the power to remove her own FINISHED patient
--  record too. That is a different question and this file does not
--  answer it. Only the unfinished row comes back, and only for the
--  person who typed it.
--
--  UNCHANGED, deliberately:
--    · the row's own doctor may still dispose of anything on his shelf,
--    · an active admin of the OWNING clinic may still remove any row,
--    · a clinic MANAGER is still refused (ent_claim_clinic_id),
--    · a secretary may still NOT touch a draft her doctor wrote. The
--      Team Drafts view added in this release shows her that draft so
--      she can continue the work; it does not make it hers to delete,
--      and the UI hides the button rather than offering a refusal.
--
--  IDEMPOTENT      : yes, safe to re-run (CREATE OR REPLACE).
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted; this
--                    file only changes who MAY ask.
-- =====================================================================

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
        -- 0029, new: the author of an UNFINISHED draft may always remove
        -- her own. Scoped to is_draft on purpose - see the header.
        (is_draft AND created_by = public.ent_auth_uid())
     OR -- 0026, unchanged: the row's own doctor
        (p_doctor = public.ent_auth_uid()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- 0026, unchanged: an active admin of the OWNING clinic
        (public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
    FROM public.reports
    WHERE id = p_id
$$;

COMMENT ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) IS
    'True when the caller may mark this report deleted: the author of an UNFINISHED draft (0029), the row''s own doctor, or an active admin of the OWNING clinic. Never a clinic manager, never a secretary on a record she did not write. Answers the same question the hard-delete policies answered in 0019, but by marking the row instead of destroying it.';

REVOKE ALL ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
--  Refuse to apply unless the arms this file depends on are all there.
--  The author arm without the doctor arm would quietly take a right away
--  from the man who has always had it, and an author arm missing is_draft
--  would hand out more than intended - both are worse than not applying.
-- ---------------------------------------------------------------------
DO $$
DECLARE fn_src text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_may_soft_delete(uuid,uuid,uuid)');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION
            'refused: ent_may_soft_delete(uuid,uuid,uuid) is missing. Apply 0026 first.';
    END IF;

    -- Comments name the arms too, so strip them before testing; only
    -- executable text may satisfy (or break) a rule.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_src NOT ILIKE '%created_by = public.ent_auth_uid()%' THEN
        RAISE EXCEPTION
            'refused: the author arm is missing, so a secretary still cannot remove a draft she wrote.';
    END IF;

    IF fn_src NOT ILIKE '%is_draft AND created_by%' THEN
        RAISE EXCEPTION
            'refused: the author arm is not draft-only. It must read "is_draft AND created_by = ..." or it would also allow deleting a finished patient record.';
    END IF;

    IF fn_src NOT ILIKE '%p_doctor = public.ent_auth_uid()%'
       OR fn_src NOT ILIKE '%public.ent_is_active_admin()%'
       OR fn_src NOT ILIKE '%ent_claim_clinic_id()%' THEN
        RAISE EXCEPTION
            'refused: the doctor or own-clinic-admin arm from 0026 is gone. 0029 adds an arm; it must not remove one.';
    END IF;

    RAISE NOTICE
        '0029 verified: an author may delete her own UNFINISHED draft; the doctor and own-clinic-admin arms are intact.';
END;
$$;

NOTIFY pgrst, 'reload schema';