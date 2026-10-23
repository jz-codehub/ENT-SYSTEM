-- =====================================================================
--  0034 . a secretary may delete on her doctor's shelf, and the bin
-- ---------------------------------------------------------------------
--  THE ASK
--
--      "The admin or the secretary must be able to delete a record, but
--       SOFT delete only, with a recycle bin - and that is where the
--       real final delete happens."
--
--  Three quarters of that already exists. 0026 built the soft-delete
--  columns, hid deleted rows from every reader and gave the admin a
--  recycle bin. 0029 let an author dispose of her own draft. 0030 wired
--  ent_may_soft_delete to a policy so the button actually works. What
--  was missing is exactly one role and one UI path:
--
--    1. THE SECRETARY. ent_may_soft_delete (0026/0029) says, in as many
--       words, "Secretaries are deliberately absent" - so a secretary
--       could only ever remove a draft SHE wrote, never a saved patient
--       on the shelf she works every day. The ask is the opposite: the
--       secretary may mark ANY record on her assigned doctor's shelf
--       deleted. Scope that to assigned_doctor_id and nothing else
--       widens - the same rule ent_may_edit_report (0019 rule 1) and
--       every read policy already use. Never another doctor's shelf,
--       never another clinic, and still never a hard delete.
--
--    2. THE BIN, FOR HER. ent_deleted_reports() is admin-only, which
--       is right for the Admin Console but leaves a secretary with no
--       way to see what she just removed or to put it back. The
--       function now answers to TWO shapes, each with its own scope:
--
--           active admin   -> every deleted row in a clinic he OWNS
--           secretary      -> deleted rows on her assigned doctor's
--                             shelf, in her own clinic
--           anyone else    -> refused (a doctor included: he does not
--                             administrate the bin, he asks)
--
--       The payload stays withheld. The list says WHO and WHEN, not
--       the patient's record.
--
--    3. THE FINAL DELETE. Nothing here hands that to a secretary.
--       0026's rule stands: the only hard DELETE policy on reports is
--       reports_delete_admin, and it only accepts a row that is ALREADY
--       soft-deleted. The Admin Console's "Delete forever" button is the
--       single place it is offered. A secretary's delete is a mark, and
--       stays a mark.
--
--  WHO MAY DO WHAT AFTER THIS FILE (the whole flow, in one table)
--
--      soft delete   admin  - any row in his own clinic
--                    doctor - his own rows (0026)
--                    author - her own UNFINISHED draft (0029)
--                    secretary - ANY row on her assigned doctor's
--                                shelf (0034, this file)
--      restore       admin  - anywhere in his own clinic (0026)
--                    secretary - her assigned doctor's shelf (0034,
--                                through 0030's policy; the predicate
--                                does not care that the row is deleted)
--                    doctor - his own rows (through 0030's policy)
--      hard delete   admin ONLY, and ONLY over an already-soft-deleted
--                    row (0026) - the "Delete forever" button
--
--  deleted_by IS STAMPED, NOT BELIEVED
--
--  The browser sends deleted_by with the row it marks (draftsBrowser
--  already does). A client-supplied uuid is a claim, and claims can be
--  false: any signed-in member could name a colleague as the person who
--  deleted a patient record. The stamp trigger below overwrites the
--  column from the verified JWT on every authenticated soft delete - the
--  same rule ent_stamp_report_ownership (0004) applies to clinic_id and
--  doctor_id. service_role is exempt so backup/restore round-trips keep
--  the row's real history.
--
--  IDEMPOTENT      : yes, safe to re-run. Every function is
--                    CREATE OR REPLACE, the trigger is DROP + CREATE.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted; this
--                    file only changes who MAY ask, who may READ the
--                    bin, and who is recorded as having deleted.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. THE PREDICATE - now four arms
-- ---------------------------------------------------------------------
-- Kept byte-compatible with the strings 0029 and 0030 verify against
-- (is_draft AND created_by, p_doctor = ent_auth_uid, ent_is_active_admin,
-- ent_claim_clinic_id): re-running the chain re-checks those files BEFORE
-- this one, and this file must never look like it removed an arm.
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
        -- remove her own. Draft-only - see 0029's header for why.
        (is_draft AND created_by = public.ent_auth_uid())
     OR -- 0026, unchanged: the row's own doctor
        (p_doctor = public.ent_auth_uid()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- 0026, unchanged: an active admin of the OWNING clinic
        (public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id()
         AND public.ent_may_edit_report(p_clinic, p_doctor, p_id))
     OR -- 0034, NEW: a secretary on the shelf she is assigned to.
        -- Deliberately NOT routed through ent_may_edit_report: that
        -- function's second arm is the cross-clinic GRANT, and a grant
        -- to correct a patient must never become a grant to destroy
        -- one (0019 says so in as many words). This arm is shelf-only:
        -- active row, role = secretary, the ROW's clinic equals HER
        -- clinic, and p_doctor is her assigned doctor. The uuid comes
        -- from her own staff_profiles row, so it cannot be forged.
        EXISTS (
            SELECT 1
              FROM public.staff_profiles me
             WHERE me.id = public.ent_auth_uid()
               AND me.is_active
               AND me.role = 'secretary'
               AND me.clinic_id = reports.clinic_id
               AND p_doctor = me.assigned_doctor_id
        )
    FROM public.reports
    WHERE id = p_id
$$;

COMMENT ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) IS
    'True when the caller may mark this report deleted: the author of an UNFINISHED draft (0029), the row''s own doctor (0026), an active admin of the OWNING clinic (0026), or a secretary on her assigned doctor''s shelf (0034). Never a clinic manager, never a cross-clinic grantee, never a hard delete. Restore goes through the same predicate, so whoever may mark a row deleted may also put it back.';

REVOKE ALL ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_soft_delete(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. THE RECYCLE BIN - admin OR the shelf's secretary
-- ---------------------------------------------------------------------
-- SECURITY DEFINER, because reports_select_owner hides deleted rows from
-- everybody and this is the single, deliberate exception (0026). The
-- guard is now two-shaped, and the SCOPE lives in the same WHERE clause
-- that the guard implies, so a widened guard can never outrun the rows:
--
--   admin     ent_is_active_admin() AND clinic = ent_claim_clinic_id()
--   secretary her clinic AND doctor_id = her assigned_doctor_id
--   else      RAISE - including doctors, deliberately
--
-- NO payload is returned - unchanged from 0026. The bin answers "what
-- was removed and can I put it back", not "reproduce the patient's
-- record".
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

    IF me.id IS NULL OR me.is_active = false THEN
        RAISE EXCEPTION
            'refused: only a signed-in, active staff member may read the recycle bin.'
            USING ERRCODE = '42501';
    END IF;

    IF me.role = 'admin' THEN
        -- Keep 0026's own definition of "may administer": the live helper,
        -- not a re-statement of role = admin in this file.
        IF NOT public.ent_is_active_admin() THEN
            RAISE EXCEPTION
                'refused: only an active administrator may read the recycle bin.'
                USING ERRCODE = '42501';
        END IF;
    ELSIF me.role <> 'secretary' THEN
        -- A doctor does not administrate the bin. He asks an admin (or the
        -- secretary on the shelf) to put a record back - unchanged from
        -- 0026, which refused everybody but an admin.
        RAISE EXCEPTION
            'refused: only an active administrator or the shelf''s secretary may read the recycle bin.'
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
       -- guard 2, as scopes:
       --   admin     -> only the clinic he OWNS (ent_is_member_of() is NOT
       --                used here, because it is also true for a manager)
       --   secretary -> only her OWN clinic AND her assigned doctor's shelf
       AND (
              (me.role = 'admin'      AND r.clinic_id = public.ent_claim_clinic_id())
           OR (me.role = 'secretary'  AND r.clinic_id = me.clinic_id
                                     AND r.doctor_id = me.assigned_doctor_id)
           )
     ORDER BY r.deleted_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$;

COMMENT ON FUNCTION public.ent_deleted_reports(integer) IS
    'The recycle bin. Two readers: an active administrator sees every deleted row in a clinic he owns; a secretary sees the deleted rows on her assigned doctor''s shelf in her own clinic. Anyone else - including a doctor - is refused. Deleted rows only, and deliberately WITHOUT the patient payload: enough to recognise a mistaken deletion and restore it, not enough to read a deleted record end to end. Restoring is an ordinary UPDATE of deleted_at to NULL, authorised by the UPDATE policies; it is not a special door in this function on purpose.';

REVOKE ALL ON FUNCTION public.ent_deleted_reports(integer) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_deleted_reports(integer) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. THE STAMP - deleted_by comes from the JWT, never from the body
-- ---------------------------------------------------------------------
-- Same shape as ent_stamp_report_ownership (0004): the server owns the
-- column and overwrites whatever the request claimed. Only the
-- NULL -> set transition is stamped (pressing Delete); a restore clears
-- the column alongside deleted_at so the two can never disagree.
CREATE OR REPLACE FUNCTION public.ent_stamp_deleaser()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- service_role (backup/restore tooling) is exempt on purpose: a
    -- round-tripped row must keep its real history, and service_role has
    -- no JWT uid to stamp with anyway.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        NEW.deleted_by := public.ent_auth_uid();
    ELSIF NEW.deleted_at IS NULL THEN
        NEW.deleted_by := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reports_stamp_deleaser ON public.reports;
CREATE TRIGGER trg_reports_stamp_deleaser
    BEFORE UPDATE ON public.reports
    FOR EACH ROW
    WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
    EXECUTE FUNCTION public.ent_stamp_deleaser();

COMMENT ON FUNCTION public.ent_stamp_deleaser() IS
    '0034: overwrites reports.deleted_by from the verified JWT on the exact UPDATE that sets deleted_at (and clears it again on restore). The browser may SEND deleted_by; it is not believed. service_role is exempt so backup/restore keeps the recorded history.';

-- ---------------------------------------------------------------------
-- 4. THE FILE CHECKS ITSELF
-- ---------------------------------------------------------------------
DO $$
DECLARE
    fn_soft text;
    fn_bin  text;
    fn_trig text;
    pol_src text;
BEGIN
    -- (a) the new arm is in the predicate - executable text only, so a
    --     comment discussing secretaries cannot satisfy it.
    SELECT pg_get_functiondef(oid) INTO fn_soft
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_may_soft_delete(uuid,uuid,uuid)');
    IF fn_soft IS NULL THEN
        RAISE EXCEPTION 'refused: ent_may_soft_delete is missing. Apply 0026/0029 first.';
    END IF;
    fn_soft := regexp_replace(COALESCE(fn_soft, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_soft NOT ILIKE '%me.role = ''secretary''%'
       OR fn_soft NOT ILIKE '%me.assigned_doctor_id%'
       OR fn_soft NOT ILIKE '%FROM public.staff_profiles me%' THEN
        RAISE EXCEPTION 'refused: the secretary shelf arm is not in ent_may_soft_delete, so she still cannot delete on the shelf she works. (fn: %)', fn_soft;
    END IF;

    -- (b) no arm was traded away for it.
    IF fn_soft NOT ILIKE '%is_draft AND created_by%'
       OR fn_soft NOT ILIKE '%p_doctor = public.ent_auth_uid()%'
       OR fn_soft NOT ILIKE '%ent_is_active_admin()%'
       OR fn_soft NOT ILIKE '%ent_claim_clinic_id()%' THEN
        RAISE EXCEPTION 'refused: an earlier arm (author, own doctor, own-clinic admin) is gone from ent_may_soft_delete. 0034 adds an arm; it must not remove one.';
    END IF;

    -- (c) the bin answers to a secretary, keeps the admin guard, and still
    --     refuses everyone else with an explicit RAISE.
    SELECT pg_get_functiondef(oid) INTO fn_bin
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_deleted_reports(integer)');
    IF fn_bin IS NULL THEN
        RAISE EXCEPTION 'refused: ent_deleted_reports() is missing, so a deleted row would be invisible and unrecoverable.';
    END IF;
    fn_bin := regexp_replace(COALESCE(fn_bin, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_bin NOT ILIKE '%me.role = ''secretary''%'
       OR fn_bin NOT ILIKE '%me.assigned_doctor_id%' THEN
        RAISE EXCEPTION 'refused: ent_deleted_reports has no secretary scope, so she would delete into a bin she cannot open.';
    END IF;
    IF fn_bin NOT ILIKE '%ent_is_active_admin()%' THEN
        RAISE EXCEPTION 'refused: the admin guard from 0026 is gone from ent_deleted_reports.';
    END IF;
    IF fn_bin NOT ILIKE '%RAISE EXCEPTION%' THEN
        RAISE EXCEPTION 'refused: ent_deleted_reports no longer refuses anyone - everyone with a uid could read deleted patient names.';
    END IF;

    -- (d) the stamp trigger exists. pg_get_triggerdef, NOT
    --     pg_get_functiondef: pg_trigger.oid is the TRIGGER, and handing
    --     that to pg_get_functiondef returns nothing rather than failing.
    SELECT pg_get_triggerdef(t.oid) INTO fn_trig
      FROM pg_trigger t
      JOIN pg_class     c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
       AND t.tgname = 'trg_reports_stamp_deleaser'
       AND c.relname = 'reports'
       AND n.nspname = 'public';
    IF fn_trig IS NULL THEN
        RAISE EXCEPTION 'refused: trg_reports_stamp_deleaser was not created, so deleted_by would be whatever the browser claimed it was.';
    END IF;

    -- (e) the final delete is STILL admin-only, and STILL only over an
    --     already-soft-deleted row. This file must not have moved it.
    IF EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename  = 'reports'
           AND policyname = 'reports_delete_own_doctor'
    ) THEN
        RAISE EXCEPTION 'refused: reports_delete_own_doctor exists again, so a doctor can hard-delete. 0034 must not reopen that.';
    END IF;

    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'reports'
       AND policyname = 'reports_delete_admin';
    pol_src := regexp_replace(COALESCE(pol_src, ''), chr(45) || chr(45) || '[^\n]*', '', 'g');
    IF pol_src IS NULL
       OR pol_src NOT ILIKE '%deleted_at IS NOT NULL%'
       OR pol_src NOT ILIKE '%ent_is_active_admin()%' THEN
        RAISE EXCEPTION 'refused: reports_delete_admin no longer requires an already-soft-deleted row AND an active admin. The final delete must stay exactly that narrow.';
    END IF;

    RAISE NOTICE
        '0034 verified: a secretary may soft-delete and restore on her assigned doctor''s shelf, the bin reads for her (shelf-scoped) and for an admin (clinic-scoped), deleted_by is JWT-stamped, and the only hard delete left is an admin''s over an already-deleted row.';
END;
$$;

NOTIFY pgrst, 'reload schema';




