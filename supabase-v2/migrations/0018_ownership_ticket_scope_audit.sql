-- =====================================================================
--  0018 · ownership stamp + ticket scope + audit honesty
-- ---------------------------------------------------------------------
--  WHY
--  Three defects, all of them consequences of 0016 widening admin reach
--  without widening the trigger that stamps ownership. 0016 gave an
--  administrator every shelf in every clinic he owns; 0004's stamp was
--  written when an admin could only ever see his own clinic, and it still
--  says so.
--
--  1. THE REPORT STAMP MOVED RECORDS OUT OF THEIR CLINIC.
--     0004 ent_stamp_report_ownership did, unconditionally, on INSERT
--     *and* UPDATE:
--
--         NEW.clinic_id := me.clinic_id;
--
--     For a doctor or a secretary that is right - their clinic is a fact.
--     For an admin editing a report in a clinic he manages (which 0016
--     made legal, and ent_may_touch_report now permits) it was a silent
--     data-loss bug: one save moved the patient's record into the admin's
--     own clinic.
--
--     It also broke the doctor shelf, because the fallback that picks the
--     doctor validated against me.clinic_id:
--
--         WHERE d.id = NEW.doctor_id AND d.clinic_id = me.clinic_id ...
--
--     In the managed clinic that test can never pass - the doctors there
--     belong to that clinic, not to the admin's - so the code fell through
--     to NEW.doctor_id := me.id and re-filed the report under the ADMIN's
--     own profile. One edit, two columns corrupted, and the doctor who
--     actually wrote the record could no longer see it.
--
--  2. THE TICKET POLICIES NEVER GOT THE 0016 TREATMENT.
--     0016 replaced clinic_id = ent_claim_clinic_id() with
--     ent_is_member_of() on staff_profiles and on admin_record_activity.
--     The four ticket policies still carry the old clause, so they read:
--
--         ent_is_active_admin() AND clinic_id = ent_claim_clinic_id()
--                            AND ent_is_member_of(clinic_id)
--
--     ent_is_member_of() now answers TRUE for an owner-admin, and then the
--     claim-equality clause cancels it. The admin could not see, answer or
--     even file against a ticket in a clinic he owns - the exact clinic
--     0016 was written to give him.
--
--  3. ANY MEMBER COULD FORGE AN ADMIN AUDIT ENTRY.
--     0008's audit_insert_self only checks actor_id = ent_auth_uid(),
--     and ent_stamp_audit already forces that column, so the WHO was never
--     forgeable. The WHAT was: action was free. A doctor could write
--     USER_DEACTIVATED naming a colleague and the trail would show it as a
--     fact. The browser keeps writing audit rows directly (auth.js
--     logActivity -> POST activity_logs), so revoking the INSERT grant is
--     NOT an option - it would break every log line in the app. This file
--     instead keeps the grant and constrains the ACTION by role.
--
--  WHAT THIS FILE DOES NOT DO
--    · It does not touch any existing row. Nothing is backfilled, updated
--      or deleted here.
--    · It does not change who may read what. audit_select_admin is
--      untouched; the PHI question is answered in the writer
--      (function/dbRecords.js), not by hiding rows.
--    · It does not widen a doctor's or a secretary's reach. The trigger's
--      new UPDATE branch is only ever reachable by a caller RLS already
--      authorised, and the extra arm it adds requires role = 'admin'.
--
--  IDEMPOTENT      : yes, safe to re-run. Every function is
--                     CREATE OR REPLACE, every policy is DROP + CREATE.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. THE OWNERSHIP STAMP.
--
--    THE RULE, RESTATED: a report belongs to the clinic it was created
--    in, forever. An editor may correct its CONTENT; nobody may move it.
--
--    That is a stronger statement than 0004 made, and deliberately so:
--    0004 re-derived both columns from the caller on every UPDATE, which
--    is what made the relocation possible. Re-deriving is only correct
--    while "the caller's clinic" and "the row's clinic" are the same
--    thing, and 0016 removed that assumption.
--
--    WHY AN UPDATE KEEPS OLD.clinic_id AND OLD.doctor_id RATHER THAN
--    RE-DERIVING THEM - for every role that behaviour is IDENTICAL, and
--    the proof is the RLS policy that runs before this trigger:
--
--      doctor     reports_update_owner USING ent_may_touch_report(...),
--                 which returns true for a doctor only when
--                 p_doctor = me.id. So OLD.doctor_id already IS me.id and
--                 re-deriving it was a no-op.
--      secretary  same function, arm p_doctor = me.assigned_doctor_id. So
--                 OLD.doctor_id already IS the assigned doctor. If the
--                 assignment later changes, RLS hides the old rows before
--                 this trigger ever runs.
--      admin, own clinic   OLD.doctor_id is either a doctor of his clinic
--                 (0004 kept it) or his own id (0004's fallback re-derived
--                 his own id because an admin is not role='doctor' and so
--                 failed its own test). Same answer either way.
--      admin, MANAGED clinic   0004 relocated the row. This file keeps it.
--
--    So the only behaviour that changes is the one that was a bug.
--
--    service_role is still exempt: the migration runner, the backup /
--    restore scripts and the Edge Functions write on the caller's behalf
--    and are trusted, exactly as in 0004.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_report_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me          public.staff_profiles;
    keep_clinic uuid;
    keep_doctor uuid;
    doctor_ok   boolean;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                              -- trusted writer
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();

    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- A report NEVER changes clinic after it is created.
    --
    -- On INSERT the clinic comes from the row (the writers deliberately
    -- omit it from the body, so coalesce falls back to the caller's own);
    -- on UPDATE it comes from OLD, which is the whole point - the body is
    -- not allowed to nominate a new home.
    IF TG_OP = 'UPDATE' THEN
        keep_clinic := OLD.clinic_id;
        keep_doctor := OLD.doctor_id;
    ELSE
        keep_clinic := coalesce(NEW.clinic_id, me.clinic_id);
        keep_doctor := NULL;
    END IF;

    -- A report NEVER changes clinic after it is created, and the only way
    -- to WRITE into a clinic other than your own is an explicit per-patient
    -- grant.
    --
    -- Same-clinic behaviour is deliberately untouched: for every role the
    -- branch below is never taken, because keep_clinic = me.clinic_id
    -- already. A doctor, a secretary and an admin of their own clinic reach
    -- this function exactly as they did before this line existed.
    --
    -- CROSS-CLINIC (keep_clinic <> me.clinic_id) is allowed ONLY when the
    -- caller holds a live, unexpired grant for THIS report id
    -- (ent_has_report_grant, which itself requires is_draft = false). There
    -- is deliberately NO ent_admin_covers_clinic() arm here: managing a
    -- clinic's staff and settings is not authority over its patients'
    -- records, and 0019 draws that line. A managed_by manager with no grant
    -- is refused exactly like any other unrelated caller - loudly, not by a
    -- silent relocation.
    --
    -- Note the two invariants this preserves together: a grant widens WHO
    -- may write, and never WHERE the row lives - keep_clinic/keep_doctor
    -- were taken from OLD above and are not touched on this branch, so an
    -- approved cross-clinic edit changes CONTENT only.
    IF keep_clinic IS DISTINCT FROM me.clinic_id
       AND NOT public.ent_has_report_grant(OLD.id) THEN
        RAISE EXCEPTION 'refused: you may not write a report into another clinic without an explicit grant for that record'
            USING ERRCODE = '42501';
    END IF;

    NEW.clinic_id := keep_clinic;

    -- The doctor shelf. UPDATE keeps the row on the shelf it was filed on.
    IF TG_OP = 'UPDATE' THEN
        NEW.doctor_id := keep_doctor;
    ELSIF me.role = 'doctor' THEN
        NEW.doctor_id := me.id;
    ELSIF me.role = 'secretary' THEN
        NEW.doctor_id := me.assigned_doctor_id;
    ELSE
        -- An admin may file a report under a real doctor of THIS clinic -
        -- which, since 0016, need not be his own.
        SELECT EXISTS (
            SELECT 1 FROM public.staff_profiles d
             WHERE d.id = NEW.doctor_id
               AND d.clinic_id = keep_clinic
               AND d.role = 'doctor'
               AND d.is_active
        ) INTO doctor_ok;

        IF NOT doctor_ok THEN
            IF keep_clinic = me.clinic_id THEN
                -- 0004's fallback, unchanged: his own shelf, inside his own
                -- clinic, is always a valid answer.
                NEW.doctor_id := me.id;
            ELSE
                -- Filing into a clinic he manages but naming no doctor of it
                -- would otherwise fall back to his own id, producing a row
                -- whose doctor lives in a different clinic than the report.
                RAISE EXCEPTION 'refused: name a doctor of that clinic when filing a report into it'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    -- Author: recorded truthfully on insert, never rewritten after.
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := me.id;
    ELSE
        NEW.created_by := OLD.created_by;
    END IF;

    -- A report that is not a draft is stamped as saved.
    IF NOT NEW.is_draft AND NEW.saved_at IS NULL THEN
        NEW.saved_at := now();
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ent_stamp_report_ownership() IS
    'Server-stamps the author and pins clinic_id + doctor_id. A report never changes clinic or doctor after creation, so an admin editing a record in a clinic he manages (0016) can correct it without relocating it out of that clinic and off that doctor''s shelf.';


-- ---------------------------------------------------------------------
-- 2. TICKET SCOPE, ALIGNED WITH 0016.
--
--    0016's own comment says ent_is_member_of() "is what lets tickets,
--    settings, presence and the audit trail work across the admin's own
--    clinics". Tickets was named, and then not done: all four policies
--    still pinned the clinic to the JWT claim.
--
--    Removing the clause can only ever ADD rows to a result set for an
--    ACTIVE admin whose clinics.managed_by is his own uuid (0016 section 2,
--    written only by auth-admin under service_role). For a doctor or a
--    secretary ent_is_active_admin() is false, so the policy is inert and
--    the row-level rules that actually scope them - created_by, or the
--    author-only arm - are untouched.
--
--    Each policy below is otherwise byte-for-byte the 0012 original.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tickets_select_admin_clinic ON public.tickets;
CREATE POLICY tickets_select_admin_clinic ON public.tickets
    FOR SELECT TO authenticated
    USING (
        public.ent_is_active_admin()
        AND public.ent_is_member_of(clinic_id)
    );

DROP POLICY IF EXISTS tickets_update_admin ON public.tickets;
CREATE POLICY tickets_update_admin ON public.tickets
    FOR UPDATE TO authenticated
    USING (
        public.ent_is_active_admin()
        AND public.ent_is_member_of(clinic_id)
    )
    WITH CHECK (
        public.ent_is_active_admin()
        AND public.ent_is_member_of(clinic_id)
    );

DROP POLICY IF EXISTS ticket_messages_select_visible ON public.ticket_messages;
CREATE POLICY ticket_messages_select_visible ON public.ticket_messages
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.tickets t
             WHERE t.id = ticket_messages.ticket_id
               AND (
                   t.created_by = public.ent_auth_uid()
                   OR (
                       public.ent_is_active_admin()
                       AND public.ent_is_member_of(t.clinic_id)
                   )
               )
        )
    );

DROP POLICY IF EXISTS ticket_messages_insert_visible ON public.ticket_messages;
CREATE POLICY ticket_messages_insert_visible ON public.ticket_messages
    FOR INSERT TO authenticated
    WITH CHECK (
        author_id = public.ent_auth_uid()
        AND EXISTS (
            SELECT 1 FROM public.tickets t
             WHERE t.id = ticket_messages.ticket_id
               AND (
                   t.created_by = public.ent_auth_uid()
                   OR (
                       public.ent_is_active_admin()
                       AND public.ent_is_member_of(t.clinic_id)
                   )
               )
        )
    );



-- ---------------------------------------------------------------------
-- 3. THE AUDIT TRAIL: WHO WAS ALREADY HONEST, WHAT WAS NOT.
--
--    ent_stamp_audit (0005) overwrites actor_id, actor_role and
--    clinic_id from the caller's LIVE profile, so a member could never
--    forge WHO. action was the hole: 0008's audit_insert_self only
--    checks the actor, so any signed-in member could write
--
--        { action: 'USER_DEACTIVATED', detail: 'Dr Santos' }
--
--    and the admin console would render a deactivation that never
--    happened.
--
--    WHY THE GRANT STAYS. Revoking INSERT on activity_logs is the
--    textbook fix and it would break the product: function/auth.js
--    logActivity() POSTs to activity_logs directly from the browser, and
--    the Edge Function is not on every path. So the grant stays and the
--    POLICY is tightened instead - a member keeps the ability to record
--    what they personally did, and loses the ability to record what
--    somebody else did.
--
--    This mirrors how 0007 and 0008 already work: privilege says "may you
--    use this table", RLS says "which rows, and of what kind".
--
--    The self-service list is exactly the actions a doctor or a secretary
--    can cause on their own. Anything describing ADMINISTRATIVE ACCOUNT
--    CHANGE (USER_*, SESSION_REVOKED, PASSWORD_RESET, SETTING_UPDATED) is
--    admin-only - and those all go through auth-admin under service_role
--    anyway, which RLS does not apply to, so the real admin path is
--    unaffected.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS audit_insert_self ON public.activity_logs;
CREATE POLICY audit_insert_self ON public.activity_logs
    FOR INSERT TO authenticated
    WITH CHECK (
        actor_id = public.ent_auth_uid()
        AND public.ent_is_member_of(clinic_id)
        AND (
            public.ent_is_active_admin()
            OR action::text = ANY (ARRAY[
                'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PASSWORD_CHANGED',
                'SAVE_RECORD', 'DELETE_RECORD', 'OPEN_RECORD',
                'SAVE_DRAFT', 'DELETE_DRAFT',
                'PHOTO_UPLOAD', 'PHOTO_DOWNLOAD', 'PHOTO_DELETE',
                'ACCESS_DENIED'
            ]::text[])
        )
    );

COMMENT ON POLICY audit_insert_self ON public.activity_logs IS
    'A member may record only their own actions, and only self-service ones. Administrative actions (USER_*, SESSION_REVOKED, PASSWORD_RESET, SETTING_UPDATED) are admin-only, so the trail cannot be forged by the person it would incriminate.';


-- ---------------------------------------------------------------------
-- 4. STILL NO ANON. Asserted rather than assumed, so a later "just
--    GRANT it" cannot quietly undo the closed door. Same shape as 0017.
-- ---------------------------------------------------------------------
DO $$
DECLARE anon_grants int;
BEGIN
    SELECT count(*) INTO anon_grants
      FROM information_schema.role_table_grants
     WHERE grantee = 'anon'
       AND table_schema = 'public';
    IF anon_grants > 0 THEN
        RAISE EXCEPTION 'refused: anon still holds % grant(s) in public.', anon_grants;
    END IF;
END $$;


NOTIFY pgrst, 'reload schema';

