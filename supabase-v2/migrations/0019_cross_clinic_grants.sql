-- =====================================================================
--  0019 · cross-clinic editing is DENY-BY-DEFAULT
-- ---------------------------------------------------------------------
--  WHY
--  0016 widened admin reach to every clinic he owns, and it widened
--  ent_may_touch_report() - which is the function behind BOTH the read
--  policies AND the write policies. That conflation is the bug this file
--  removes.
--
--  "managed_by" answers a question about OWNERSHIP OF A CLINIC. It says
--  who administers the clinic's staff, its settings and its analytics.
--  It does NOT mean "this administrator may rewrite another clinic's
--  patient records". Those are different grants, and conflating them
--  means one admin's clinic can silently mutate a colleague's patients.
--
--  So:
--
--      READ   a clinic admin may still SEE the reports of a clinic he
--             manages. That is what 0016 was for, and the admin console
--             depends on it. Unchanged.
--
--      WRITE  cross-clinic editing is DENIED unless there is an EXPLICIT,
--             PER-PATIENT grant naming that report. Being the manager of
--             the clinic is NOT sufficient. No grant, no edit.
--
--  WHY A GRANT TABLE RATHER THAN A WIDENED RULE. Any rule of the form
--  "admin may edit clinic X's patients" is a standing, clinic-wide blank
--  cheque: it cannot be limited to one patient, cannot be expired, and
--  cannot be attributed afterwards. A row naming ONE report, ONE grantee
--  and ONE expiry answers all three. It also gives the patient record an
--  answerable question - "who was allowed to touch this, and until when?"
--
--  WHO MAY GRANT. Only an ACTIVE ADMIN OF THE PATIENT'S OWN CLINIC. A
--  manager of clinic B cannot authorise himself to edit clinic A's
--  patients - that would make the grant a self-signed cheque and restore
--  exactly the hole this file closes. Grants are issued by the side that
--  owns the data, never by the side asking for access.
--
--  WHAT NEVER CHANGES. clinic_id and doctor_id are immutable on UPDATE,
--  enforced by the trigger in 0018 section 1, which this file keeps and
--  re-asserts: an edit may correct the CONTENT of a report, never move
--  it to another clinic or another doctor's shelf. A grant widens WHO may
--  write; it does not widen WHERE the row may live.
--
--  WHAT THIS FILE DOES NOT DO
--    · It does not grant anything retroactively. No grant row is inserted.
--    · It does not widen any read path. ent_may_touch_report() keeps the
--      0016 behaviour verbatim, so the admin console still works.
--    · It does not touch the frontend. The DB is the boundary; a UI
--      affordance would be a convenience, never the control.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. THE GRANT TABLE.
--
--    One row = one patient, one grantee, one window of time. The primary
--    key is deliberately (report_id, grantee_id) rather than a surrogate:
--    re-granting the same pair must UPDATE the existing row, never create
--    a second one, or "who has access" stops being answerable.
--
--    expires_at is NULLABLE on purpose - NULL means "no expiry", which is
--    the correct semantic for a permanent delegation of authority over one
--    record. It is never the default for a new grant: every row states its
--    own lifetime explicitly, so "why can this person still edit?" is
--    answered by reading the row rather than by guessing.
--
--    granted_by is ON DELETE SET NULL, not CASCADE. Revoking the account
--    that issued a grant must not silently also delete the record of the
--    grant - an audit trail that erases itself when its author leaves is
--    not an audit trail.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.report_access_grants (
    report_id   uuid        NOT NULL REFERENCES public.reports(id)         ON DELETE CASCADE,
    grantee_id  uuid        NOT NULL REFERENCES public.staff_profiles(id)  ON DELETE CASCADE,
    granted_by  uuid        REFERENCES public.staff_profiles(id)           ON DELETE SET NULL,
    reason      text        NOT NULL DEFAULT '',
    expires_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (report_id, grantee_id),
    CONSTRAINT grants_reason_length CHECK (length(reason) <= 500),
    -- A grant that expired in the past is still a legitimate historical row;
    -- this only rejects an expires_at that is not a real instant at all.
    CONSTRAINT grants_expiry_sane CHECK (expires_at IS NULL OR expires_at > created_at - interval '1 day')
);

COMMENT ON TABLE  public.report_access_grants IS
    'Explicit, per-patient permission to edit one report from outside its clinic. Deny-by-default: no row means no cross-clinic edit.';
COMMENT ON COLUMN public.report_access_grants.reason IS
    'Why this person was given access. Free text, no PHI.';
COMMENT ON COLUMN public.report_access_grants.expires_at IS
    'NULL = no expiry. Non-NULL = access ends at this instant, checked live on every write.';

CREATE INDEX IF NOT EXISTS idx_grants_grantee ON public.report_access_grants (grantee_id, expires_at);

ALTER TABLE public.report_access_grants ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- 2. WHO MAY GRANT.
--
--    An ACTIVE ADMIN OF THE PATIENT'S OWN CLINIC, and nobody else. Note
--    what is absent: ent_admin_covers_clinic(). If it were here, the
--    manager of clinic B could sign himself permission to edit clinic A's
--    patients, and the grant table would be a self-signed cheque - the
--    precise hole this migration exists to close.
--
--    The owning doctor may also grant, because he is the clinician
--    responsible for the record and the natural party to say "a colleague
--    from the other clinic may correct this entry".
-- ---------------------------------------------------------------------
--    EXPLICIT, NOT DERIVED. The rule is stated here directly against the
--    report's OWNING clinic, and it deliberately does not call any read
--    function to decide reach:
--
--      admin of the clinic that OWNS this report  -> may approve/revoke
--      the report's own doctor                    -> may approve/revoke
--      a manager of another clinic (managed_by)   -> REFUSED
--
--    An earlier draft gated this on ent_may_touch_report(). That was wrong
--    twice over: it inherited 0016's managed_by widening, so a clinic
--    manager could authorise access to patients he cannot even see; and it
--    made the grant rule change silently whenever the read rule changed.
--    Authorisation to hand over a record is a fact about the OWNER, so it
--    is now compared directly against r.clinic_id.
--
--    Note the asymmetry that makes this safe: the granter must be in the
--    owning clinic, while the grantee (0019's table) must be OUTSIDE it.
--    So a clinic can never issue a grant to itself, and can never issue one
--    on behalf of a clinic it merely manages.
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
                -- than in the predicate.
                --
                -- A draft is unfinished work inside one clinic. There is no
                -- cross-clinic view of it, no cross-clinic edit of it, and
                -- therefore no legitimate reason for anyone to hold
                -- permission over it. Blocking the GRANT means the row can
                -- never come into existence, instead of allowing a grant
                -- that every downstream predicate then has to remember to
                -- ignore - four layers of defence against a state the
                -- database should simply refuse to enter.
                --
                -- It also removes an awkward edge: a grant issued while a
                -- record was still a draft would silently become LIVE the
                -- moment that record was finalised, without anyone
                -- approving anything at that moment. Refusing up front
                -- means authority is always a deliberate act about a
                -- finished record.
           AND r.is_draft = false
           AND (
                -- 1. an active admin OF THE OWNING CLINIC. This single
                --    equality is the whole tenant check: no
                --    ent_admin_covers_clinic(), no ent_is_member_of(), and
                --    deliberately no read function, because both of those
                --    answer "may he read it" rather than "does he own it".
                ( me.role = 'admin' AND me.clinic_id = r.clinic_id )
                -- 2. the clinician who owns the record himself
             OR ( me.role = 'doctor' AND r.doctor_id = me.id )
                -- A secretary is deliberately absent. She may read and
                -- correct the record, but widening its audience is not a
                -- secretary's decision.
           )
    )
$$;

COMMENT ON FUNCTION public.ent_may_grant_report_access(uuid) IS
    'True when the caller may approve, revoke or re-point an access grant for this report: an active admin of the clinic that OWNS the report, or the report''s own doctor. Never a manager of another clinic - a self-signed or manager-signed grant would defeat the purpose of the whole table. Compared directly against the report''s clinic, with no dependency on any read rule. Returns FALSE for any draft, so a grant over unfinished work can never be created at all.';


-- ---------------------------------------------------------------------
-- 2b. THE GRANT AS A LIVE PREDICATE.
--
--    One function so that "does this person hold permission for this
--    patient" has exactly one answer in the whole schema. It is called
--    from the read policies in 0020, from ent_open_report, from the photo
--    authorisation path and from ent_may_edit_report - if any of those
--    re-derived the test themselves they would drift, and one of them
--    would eventually forget a condition.
--
--    It lives in 0019 rather than 0020 on purpose: 0018's ownership stamp
--    already calls it, so a deployment that applied 0018 without 0020
--    would break on every write. It has to exist as soon as a grant table
--    exists.
--
--    TWO CONDITIONS THAT ARE EASY TO LOSE:
--
--      · the GRANTEE must be ACTIVE right now, so a deactivated account
--        loses access on its next request rather than at token expiry;
--      · the REPORT must be FINAL (is_draft = false), so a grant can never
--        reach an unfinished record. Drafts stay inside their clinic and
--        never enter the cross-clinic permission system at all.
--
--    Both live INSIDE the EXISTS, so a grant row that happens to name a
--    draft simply never matches - it is not filtered out afterwards, where
--    a future edit could move it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_has_report_grant(p_report uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.report_access_grants g
          JOIN public.reports r        ON r.id = g.report_id
          JOIN public.staff_profiles t ON t.id = g.grantee_id
         WHERE g.report_id = p_report
           AND g.grantee_id = public.ent_auth_uid()
           AND t.is_active
           AND r.is_draft = false
           AND (g.expires_at IS NULL OR g.expires_at > now())
    )
$$;

COMMENT ON FUNCTION public.ent_has_report_grant(uuid) IS
    'True when the caller holds a live, approved, unexpired grant for this specific FINAL report. The single source of truth for "permission for this patient": the grantee must be active and the report must not be a draft. Both conditions sit inside the EXISTS.';

REVOKE ALL ON FUNCTION public.ent_has_report_grant(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_has_report_grant(uuid) TO authenticated;



-- ---------------------------------------------------------------------
-- 3. GRANT POLICIES.
--
--    INSERT   only ent_may_grant_report_access(), and granted_by is forced
--             to the caller by ent_stamp_grant() below, so a row cannot
--             claim to have been authorised by somebody else.
--    SELECT   the granter may list what it issued; the grantee may list
--             what it holds. Nobody else - in particular, a manager of the
--             GRANTEE's clinic does not get to read the grant list of the
--             clinic that owns the patient.
--    UPDATE   narrowing only: the granter may shorten or revoke, never
--             widen. Widening is done by granting again, so every change
--             of scope is a visible event rather than an edit in place.
--             enforced further down by trg_grants_narrow_only.
--    DELETE   the granter may remove the row outright.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS grants_insert_owner ON public.report_access_grants;
CREATE POLICY grants_insert_owner ON public.report_access_grants
    FOR INSERT TO authenticated
    WITH CHECK ( public.ent_may_grant_report_access(report_id) );

DROP POLICY IF EXISTS grants_select_parties ON public.report_access_grants;
CREATE POLICY grants_select_parties ON public.report_access_grants
    FOR SELECT TO authenticated
    USING (
        grantee_id = public.ent_auth_uid()
        OR granted_by = public.ent_auth_uid()
    );

DROP POLICY IF EXISTS grants_update_narrow ON public.report_access_grants;
CREATE POLICY grants_update_narrow ON public.report_access_grants
    FOR UPDATE TO authenticated
    USING     ( public.ent_may_grant_report_access(report_id) )
    WITH CHECK ( public.ent_may_grant_report_access(report_id) );

DROP POLICY IF EXISTS grants_delete_owner ON public.report_access_grants;
CREATE POLICY grants_delete_owner ON public.report_access_grants
    FOR DELETE TO authenticated
    USING ( public.ent_may_grant_report_access(report_id) );


-- ---------------------------------------------------------------------
-- 4. THE GRANT STAMPS ITSELF.
--
--    granted_by and created_at come from the session, so a grant row
--    cannot be written claiming an authority the writer did not have. This
--    mirrors ent_stamp_audit (0005): the actor is server-owned.
--
--    it also re-checks the grantee. A grant naming a deactivated staff
--    member, or somebody from the same clinic (who never needed one - the
--    base rule already allows it), is refused rather than stored as a row
--    that looks meaningful and grants nothing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me     public.staff_profiles;
    target public.staff_profiles;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                              -- trusted writer
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO target FROM public.staff_profiles WHERE id = NEW.grantee_id;
    IF target.id IS NULL OR NOT target.is_active THEN
        RAISE EXCEPTION 'refused: the grantee is not an active staff member'
            USING ERRCODE = '42501';
    END IF;

    -- A same-clinic grantee is already covered by the base rule; storing a
    -- grant for it would be a row that grants nothing and confuses an audit.
    IF target.clinic_id = me.clinic_id THEN
        RAISE EXCEPTION 'refused: that person is in your own clinic and needs no grant'
            USING ERRCODE = '42501';
    END IF;

    -- The granter must still be allowed on the patient at write time, not
    -- merely when the grant was created. A revoked admin cannot leave a
    -- trail of standing permissions behind.
    IF NOT public.ent_may_grant_report_access(NEW.report_id) THEN
        RAISE EXCEPTION 'refused: you may not grant access to that report'
            USING ERRCODE = '42501';
    END IF;

    NEW.granted_by := me.id;
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grants_stamp ON public.report_access_grants;
CREATE TRIGGER trg_grants_stamp
    BEFORE INSERT ON public.report_access_grants
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_grant();


-- ---------------------------------------------------------------------
-- 4b. A GRANT CAN BE NARROWED, NEVER WIDENED.
--
--    The UPDATE policy above would otherwise let the granter extend its
--    own grant in place - move it to a different patient, name a
--    different person, or push the expiry further out. Widening is a new
--    decision, so it is recorded as a new event by revoking and issuing
--    again, not smuggled through an UPDATE.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_grants_narrow_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.grantee_id IS DISTINCT FROM OLD.grantee_id
       OR NEW.report_id IS DISTINCT FROM OLD.report_id THEN
        RAISE EXCEPTION 'refused: a grant cannot be re-pointed at another patient or person'
            USING ERRCODE = '42501';
    END IF;

    IF OLD.expires_at IS NOT NULL
       AND (NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at) THEN
        RAISE EXCEPTION 'refused: a grant cannot be extended; revoke and issue a new one'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grants_narrow_only ON public.report_access_grants;
CREATE TRIGGER trg_grants_narrow_only
    BEFORE UPDATE ON public.report_access_grants
    FOR EACH ROW EXECUTE FUNCTION public.ent_grants_narrow_only();


-- ---------------------------------------------------------------------
-- 5. THE EDIT DECISION. This is the heart of the migration.
--
--    ent_may_touch_report() answers "may you SEE this row" and keeps the
--    0016 widening, because the admin console needs it.
--
--    ent_may_edit_report() answers a DIFFERENT question - "may you CHANGE
--    this row" - and is deliberately NOT the same function:
--
--        own clinic, own shelf   the original per-role rule, unchanged
--        cross-clinic, granted   an ACTIVE, UNEXPIRED grant naming THIS
--                                 report and THIS grantee
--        cross-clinic, no grant  FALSE. Denied.
--
--    The grant arm requires an ACTIVE grantee and checks expiry live on
--    every write, so a deactivated account or a lapsed window loses access
--    on its next request rather than at token expiry.
--
--    WHY NOT JUST ent_may_touch_report(...) AND EXISTS(grant)? That would
--    also work, but it reads as "allowed, unless told otherwise", and the
--    default of a security rule should be visible in its own shape. Here
--    the two allowed cases are enumerated and nothing else can return true.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_edit_report(
    p_clinic uuid,
    p_doctor uuid,
    p_report uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.staff_profiles me
         WHERE me.id = public.ent_auth_uid()
           AND me.is_active
           AND (
                -- 1. your own clinic, by your own role. Exactly 0008's rule,
                --    unchanged: a doctor his own shelf, a secretary her
                --    assigned doctor, an admin the whole clinic.
                ( me.clinic_id = p_clinic
                  AND (
                        me.role = 'admin'
                     OR (me.role = 'doctor'    AND p_doctor = me.id)
                     OR (me.role = 'secretary' AND p_doctor = me.assigned_doctor_id)
                  )
                )
                -- 2. SOMEONE ELSE'S patient, with an explicit live grant.
                --    Note: being the manager of that clinic is NOT one of
                --    the conditions. managed_by grants nothing here.
                --
                --    0020: r.is_draft = false is REQUIRED here, not just in
                --    ent_has_report_grant. Without it a grant naming a draft
                --    would satisfy this arm, and since a PostgreSQL UPDATE is
                --    gated by this policy's USING clause alone - the SELECT
                --    policy is not consulted - a granted caller could WRITE
                --    to a draft row they are not permitted to read. That is
                --    exactly the "drafts never enter the grant system" rule,
                --    so the same guard is enforced on the write side.
             OR (
                    p_report IS NOT NULL
                AND EXISTS (
                        SELECT 1
                          FROM public.report_access_grants g
                          JOIN public.reports rr        ON rr.id = g.report_id
                          JOIN public.staff_profiles t  ON t.id  = g.grantee_id
                         WHERE g.report_id = p_report
                           AND g.grantee_id = me.id
                           AND t.is_active
                           AND rr.is_draft = false
                           AND (g.expires_at IS NULL OR g.expires_at > now())
                    )
                )
           )
    )
$$;

COMMENT ON FUNCTION public.ent_may_edit_report(uuid, uuid, uuid) IS
    'May the caller CHANGE this report. Own clinic by role, or an active unexpired per-patient grant. Cross-clinic WITHOUT a grant is denied even for a clinic manager. Pass the report id, or the grant arm cannot be evaluated and cross-clinic edits are always refused.';



-- ---------------------------------------------------------------------
-- 6. THE WRITE POLICIES. Every one of them names ent_may_edit_report.
--
--    Note that p_report is passed explicitly on UPDATE and DELETE. The
--    default NULL exists only so the INSERT policy - which has no report
--    id yet - cannot accidentally match a grant row. On insert there is
--    nothing to have been granted access to yet, so the grant arm is
--    structurally unreachable.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS reports_insert_owner ON public.reports;
CREATE POLICY reports_insert_owner ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_may_edit_report(clinic_id, doctor_id)
        AND created_by = public.ent_auth_uid()
    );

DROP POLICY IF EXISTS reports_update_owner ON public.reports;
CREATE POLICY reports_update_owner ON public.reports
    FOR UPDATE TO authenticated
    USING     ( public.ent_may_edit_report(clinic_id, doctor_id, id) )
    WITH CHECK( public.ent_may_edit_report(clinic_id, doctor_id, id) );

-- Deletion is cross-clinic-denied too: a grant that permits correcting a
-- record must not silently permit destroying it. An admin of the OWNING
-- clinic may still delete outright, which is the 0008 rule preserved -
-- note the explicit clinic_id = ent_claim_clinic_id() that 0008 did NOT
-- have, so a clinic manager cannot delete another clinic's patients.
DROP POLICY IF EXISTS reports_delete_admin ON public.reports;
CREATE POLICY reports_delete_admin ON public.reports
    FOR DELETE TO authenticated
    USING (
        public.ent_is_active_admin()
        AND public.ent_is_member_of(clinic_id)
        AND clinic_id = public.ent_claim_clinic_id()
    );

DROP POLICY IF EXISTS reports_delete_own_doctor ON public.reports;
CREATE POLICY reports_delete_own_doctor ON public.reports
    FOR DELETE TO authenticated
    USING (
        doctor_id = public.ent_auth_uid()
        AND public.ent_may_edit_report(clinic_id, doctor_id, id)
    );


-- ---------------------------------------------------------------------
-- 7. PHOTOS TRAVEL WITH THE PATIENT.
--
--    report_photos inherits the same rule, or a granted editor could fix
--    the text of a record but be blocked from correcting its photo - or,
--    worse, a future policy that reused the READ function would let anyone
--    who can see a record attach photos to it. Same decision, same helper.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS photos_insert_owner ON public.report_photos;
CREATE POLICY photos_insert_owner ON public.report_photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_may_edit_report(clinic_id, doctor_id, report_id)
        AND uploaded_by = public.ent_auth_uid()
    );

DROP POLICY IF EXISTS photos_update_owner ON public.report_photos;
CREATE POLICY photos_update_owner ON public.report_photos
    FOR UPDATE TO authenticated
    USING     ( public.ent_may_edit_report(clinic_id, doctor_id, report_id) )
    WITH CHECK( public.ent_may_edit_report(clinic_id, doctor_id, report_id) );



-- ---------------------------------------------------------------------
-- 8. THE TRIGGER, RE-ASSERTED AGAINST THE GRANT PATH.
--
--    0018 already made clinic_id and doctor_id immutable on UPDATE. That
--    trigger is unchanged and still fires first. This section exists to
--    make the guarantee legible in the context of grants: a grant widens
--    WHO may write a row, never WHERE the row may live, and a granted
--    editor editing another clinic's patient changes the CONTENT and
--    nothing else.
--
--    The photo trigger gets the same treatment, because a photo is
--    re-parented by ent_stamp_photo_ownership (0004) and that trigger
--    calls ent_may_touch_report - the READ function. Left alone it would
--    let a cross-clinic editor attach a photo to a patient the write
--    policy just refused to let them edit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_photo_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    r public.reports;
BEGIN
    SELECT * INTO r FROM public.reports WHERE id = NEW.report_id;

    IF r.id IS NULL THEN
        RAISE EXCEPTION 'refused: no report with id % for this photo', NEW.report_id
            USING ERRCODE = '23503';
    END IF;

    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    -- 0019: the EDIT rule, not the READ rule. Attaching a photo is a write.
    IF NOT public.ent_may_edit_report(r.clinic_id, r.doctor_id, r.id) THEN
        RAISE EXCEPTION 'refused: you may not attach a photo to that report'
            USING ERRCODE = '42501';
    END IF;

    -- Server owns these two columns, and 0018's rule is unchanged: a photo
    -- takes the clinic and doctor of its parent report, always.
    NEW.clinic_id := r.clinic_id;
    NEW.doctor_id := r.doctor_id;
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------
-- 9. PRIVILEGES.
--
--    The grant table is NOT service_role-only: the owning clinic's admin
--    issues and revokes grants from the database, and forcing that through
--    an Edge Function would add a hop without adding a control, because
--    the row-level rules above are the control. What anon must never get
--    is stated, not assumed.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.report_access_grants TO authenticated;
GRANT ALL            ON public.report_access_grants TO service_role;
REVOKE ALL          ON public.report_access_grants FROM anon, public;

REVOKE ALL ON FUNCTION public.ent_may_grant_report_access(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_may_grant_report_access(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.ent_may_edit_report(uuid, uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_may_edit_report(uuid, uuid, uuid) TO authenticated;

-- ent_may_touch_report keeps its 0016 body and its existing grants; the
-- EXECUTE grant from 0007/0016 survives CREATE OR REPLACE.

-- Nothing in the read path changed, so the 0018 ticket and audit policies
-- are untouched here too. They are not about patient content.


-- ---------------------------------------------------------------------
-- 10. STILL NO ANON. Asserted rather than assumed. Same shape as 0017/0018.
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

