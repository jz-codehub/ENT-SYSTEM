-- =====================================================================
--  0020 · View All (read-only index) + draft privacy
-- ---------------------------------------------------------------------
--  THE THREE-VIEW MODEL THIS FILE ENFORCES
--
--      1. My Drafts            -> own clinic ONLY
--      2. DB Records           -> own clinic ONLY
--      3. View All Patient Recs-> cross-clinic LIST only, metadata only
--
--  AND THE RULE UNDERNEATH ALL THREE:
--
--      a patient belonging to ANOTHER clinic is READ-ONLY until an
--      explicit, per-patient permission is approved by someone authorised
--      in the clinic that OWNS the patient. Only then does View Full
--      Record, Edit and photo download open.
--
--  WHY THIS CANNOT BE ONE RLS POLICY
--
--  RLS decides ROWS. It cannot decide COLUMNS, and it cannot know which
--  button the user pressed. "Show me the list but not the payload" and
--  "show me the payload only after permission" are therefore not expressible
--  as a USING (...) clause on reports - that clause would have to choose
--  between refusing everything and leaking everything.
--
--  So the reads are split into three paths, each with its own rule:
--
--      PATH A  reports table, direct SELECT     -> strict own clinic.
--              This is My Drafts and DB Records. UNCHANGED BEHAVIOUR,
--              tightened only where 0016 had leaked.
--      PATH B  ent_view_all_index()             -> the cross-clinic LIST.
--              SECURITY DEFINER, final records only, a hard-coded column
--              list that contains no payload and no photo bytes.
--      PATH C  ent_open_report(id)              -> the FULL record.
--              SECURITY DEFINER, refused cross-clinic unless an approved,
--              unexpired grant names that report.
--
--  WHAT 0016 GOT WRONG, AND WHY PATH A IS NOW STRICT
--
--  0016 widened ent_may_touch_report() to cover every clinic an admin
--  manages, and that one function sat behind BOTH the read policies and
--  the write policies. Widening read for the admin console therefore also
--  widened read everywhere else, which meant two leaks:
--
--      · DRAFTS of another clinic became visible, because a draft is just
--        a reports row with is_draft = true and nothing filtered it out.
--      · The PHOTO rows of another clinic became visible, so the bytes
--        could be downloaded without asking anyone.
--
--  Path A therefore drops the widening entirely. It is the strict 0003
--  rule, verbatim: your clinic, your role. Nothing else.
--
--  ONE DELIBERATE CHOICE, FLAGGED FOR REVIEW
--
--  ent_view_all_index() is callable by ANY active staff member, not only
--  admins - the requirement describes "if the user is from Clinic B", with
--  no role attached. It returns metadata only (name, clinic, type, date),
--  never the payload. If the intent is admin-only, add
--  `AND public.ent_is_active_admin()` to the WHERE clause in section 5;
--  it is one line and nothing else depends on it.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE STRICT OWN-CLINIC READ.
--
--    This is 0003's ent_may_touch_report with 0016's managed_by arm
--    REMOVED - nothing else changed. It is deliberately a NEW name rather
--    than a redefinition, because the old function is still referenced by
--    storage and by older policies; changing its meaning in place would
--    silently alter whatever still calls it. Path A names this one
--    explicitly, so the rule it obeys is readable at the call site.
--
--    A doctor reaches his own shelf, a secretary her assigned doctor's,
--    an admin every shelf of HIS OWN clinic - and nothing beyond.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_read_own_clinic(
    p_clinic uuid,
    p_doctor uuid
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
           AND me.clinic_id = p_clinic
           AND (
                me.role = 'admin'
             OR (me.role = 'doctor'    AND p_doctor = me.id)
             OR (me.role = 'secretary' AND p_doctor = me.assigned_doctor_id)
           )
    )
$$;

COMMENT ON FUNCTION public.ent_may_read_own_clinic(uuid, uuid) IS
    'May the caller READ this row under the plain own-clinic rule? No managed_by widening: a clinic manager does NOT get another clinic''s patients, drafts or photos through this path. This is My Drafts and DB Records.';


-- ---------------------------------------------------------------------
-- 2. PATH A - THE DIRECT READ POLICIES.
--
--    These are the policies behind My Drafts and DB Records. Every one of
--    them now names ent_may_read_own_clinic, so:
--
--      My Drafts      own clinic only, INCLUDING drafts (0016's leak closed)
--      DB Records     own clinic only
--      syncEngine     own clinic only, unchanged for the doctor
--
--    The behaviour a doctor or secretary has today is identical. What
--    changes is that a clinic manager no longer receives another clinic's
--    rows through the generic SELECT path - that now requires section 5.
--
--    A draft is still just a reports row, so this policy is what keeps it
--    private. There is no separate draft table and no draft-specific
--    policy; the clinic check below is the whole protection.
--
--  THE GRANT ARM, AND WHY IT IS HERE
--
--    Both policies below carry an extra OR arm for report_photos /
--    report_id respectively, gated on ent_has_report_grant. That is what
--    makes "approved permission = can download that patient's photos" true
--    end to end: the browser reaches the bytes through the
--    patient-photos Edge Function, and that function resolves the row with
--    asUser(jwt) - i.e. through THESE policies - before it touches Storage.
--    Without this arm a granted editor could correct a cross-clinic record
--    but never see its photos, which is not what "approved permission"
--    means.
--
--    The grant is per-REPORT. ent_has_report_grant is called with the row's
--    own report_id / id, so a grant for patient A can never surface
--    patient B, and can never surface another record in the same clinic.
--
--    Note what the grant arm does NOT do: it does not make another
--    clinic's DRAFT readable, because ent_has_report_grant refuses any
--    report with is_draft = true. My Drafts therefore stays own-clinic
--    only, which is exactly the required separation.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS reports_select_owner ON public.reports;
CREATE POLICY reports_select_owner ON public.reports
    FOR SELECT TO authenticated
    USING (
        public.ent_may_read_own_clinic(clinic_id, doctor_id)
     OR public.ent_has_report_grant(id)
    );

DROP POLICY IF EXISTS photos_select_owner ON public.report_photos;
CREATE POLICY photos_select_owner ON public.report_photos
    FOR SELECT TO authenticated
    USING (
        public.ent_may_read_own_clinic(clinic_id, doctor_id)
     OR public.ent_has_report_grant(report_id)
    );


-- ---------------------------------------------------------------------
-- 3. THE GRANT PREDICATE - ALREADY DEFINED IN 0019.
--
--    ent_has_report_grant() is created in 0019 section 2b, not here, and
--    deliberately so: 0018's ownership stamp calls it, so the function has
--    to exist the moment a grant table exists. Re-creating it in 0020 would
--    work (Postgres resolves at call time) but it would give the schema two
--    apparent homes for the same rule, and the next person to edit "the
--    one in 0020" would silently fork the behaviour.
--
--    The predicate, restated so this file is readable on its own:
--
--      ent_has_report_grant(report_id) = EXISTS (
--          grant row for (report_id, me)
--          AND the grantee is active right now
--          AND the report is FINAL (is_draft = false)
--          AND (expires_at IS NULL OR expires_at > now())
--      )
--
--    The is_draft condition is what keeps drafts out of the cross-clinic
--    permission system: a grant row naming a draft can never match, so
--    there is no configuration of grant data that opens a draft.
--
--    Asserted again at the bottom of this file, because this is the single
--    function the whole grant model rests on.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 4. MAY THE CALLER OPEN THE FULL RECORD?
--
--    Own clinic -> yes, that is Path A and it needs no special case here.
--    Another clinic -> only with a live grant.
--
--    This is the single predicate behind ent_open_report, so the refusal
--    lives in exactly one place and cannot drift from the RPC that exposes
--    the payload.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_open_report(p_report uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.reports r
         WHERE r.id = p_report
           AND (
                public.ent_may_read_own_clinic(r.clinic_id, r.doctor_id)
             OR public.ent_has_report_grant(p_report)
           )
    )
$$;



-- ---------------------------------------------------------------------
-- 5. PATH B - THE CROSS-CLINIC LIST.
--
--    ent_view_all_index() returns one row per FINAL patient report across
--    every clinic, and NOTHING that belongs inside the record.
--
--    THE COLUMN LIST IS THE SECURITY CONTROL, so it is enumerated rather
--    than written as `SELECT *`. What is here: who the patient is, which
--    clinic, which type, which date. What is deliberately absent: payload,
--    file_name, photo_count bytes, photo paths, and anything the payload
--    contains. A future column added to reports therefore does NOT appear
--    here by accident - someone has to add it on purpose and notice that
--    they are widening an unauthenticated-ish index.
--
--    `WHERE NOT is_draft` is not a display filter. It is inside the
--    SECURITY DEFINER body, which bypasses RLS, so it is the only thing
--    standing between the caller and another clinic's unfinished work.
--
--    can_view and can_edit are convenience flags so the UI can render the
--    right button. They are DERIVED from the same predicates that guard
--    section 6 and 0019's write policy, so a UI that trusts them and a UI
--    that ignores them and just tries the action both end up at the same
--    answer: the database refuses.
--
--    p_limit is clamped server-side. A caller cannot ask for the whole
--    table in one call and use this as an exfiltration primitive.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_view_all_index(
    p_search text   DEFAULT NULL,
    p_limit  integer DEFAULT 100,
    p_offset integer DEFAULT 0
)
RETURNS TABLE (
    report_id      uuid,
    clinic_id      uuid,
    clinic_name    text,
    doctor_name    text,
    patient_name   text,
    case_number    text,
    report_type    text,
    procedure_date date,
    created_at     timestamptz,
    can_view       boolean,
    can_edit       boolean,
    can_delete     boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH me AS (
        SELECT p.id, p.clinic_id, p.role
          FROM public.staff_profiles p
         WHERE p.id = public.ent_auth_uid()
           AND p.is_active
    )
    SELECT
        r.id,
        r.clinic_id,
        -- clinics.name is NOT NULL (0002) and staff_profiles.username is
        -- citext (0003), so the casts and coalesces below are about
        -- emptiness, not about null-safety: a blank full_name falls back to
        -- the username, and a deleted doctor (ON DELETE RESTRICT prevents
        -- it, but the join is LEFT anyway) degrades to a label rather than
        -- dropping the patient out of the list.
        coalesce(nullif(btrim(c.name), ''), c.code),
        coalesce(nullif(btrim(sp.full_name), ''), btrim(sp.username::text), 'Unknown'),
        r.patient_name,
        r.case_number,
        r.report_type::text,
        r.procedure_date,
        r.created_at,
        -- 0020 (rev 2): the SAME predicate that ent_open_report() itself
        -- uses. An earlier draft answered this inline as
        --     (me.clinic_id = r.clinic_id OR ent_has_report_grant(r.id))
        -- which was not the same question and therefore not the same answer:
        -- "same clinic" is a blanket TRUE, while ent_may_read_own_clinic is
        -- role-scoped. For a doctor, a colleague's record in his OWN clinic
        -- would have been reported can_view = true while ent_open_report()
        -- refused it - the list would promise a button that could only fail.
        --
        -- Routing both through one function means the UI and the database
        -- cannot disagree: if this says true, ent_open_report() returns the
        -- record, and if it says false, nothing was ever disclosed.
        public.ent_may_open_report(r.id)                                  AS can_view,
        -- edit follows the 0019 rule; delete is never granted cross-clinic
        public.ent_may_edit_report(r.clinic_id, r.doctor_id, r.id)   AS can_edit,
        (me.role = 'admin' AND me.clinic_id = r.clinic_id)           AS can_delete
      FROM public.reports r
      JOIN me ON true
      LEFT JOIN public.clinics c        ON c.id  = r.clinic_id
      LEFT JOIN public.staff_profiles sp ON sp.id = r.doctor_id
     WHERE r.is_draft = false
       -- Final records only. This is the clause that keeps drafts out of
       -- the cross-clinic index, and it cannot be overridden by a caller.
       AND (
              p_search IS NULL
           OR btrim(p_search) = ''
           OR r.patient_name ILIKE '%' || p_search || '%'
           OR r.case_number  ILIKE '%' || p_search || '%'
           -- same shape as the projected clinic_name, so a search for a
           -- clinic finds it by the exact label the list displays
           OR coalesce(nullif(btrim(c.name), ''), c.code, '') ILIKE '%' || p_search || '%'
       )
     ORDER BY r.created_at DESC
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
    OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

COMMENT ON FUNCTION public.ent_view_all_index(text, integer, integer) IS
    'The View All PATIENT LIST across every clinic: identity and metadata only, final records only, no payload and no photo bytes. can_view/can_edit are derived from the same predicates that guard ent_open_report and the 0019 write policy, so they cannot be more permissive than the truth.';



-- ---------------------------------------------------------------------
-- 6. PATH C - THE FULL RECORD, BEHIND PERMISSION.
--
--    This is the only route to reports.payload for a patient in another
--    clinic, and it refuses unless ent_may_open_report says yes. That
--    predicate is section 4, which is own-clinic OR a live grant, so the
--    refusal below is the only place the decision is made.
--
--    WHY jsonb AND NOT RETURNS TABLE: the caller asked for ONE record by
--    id, so a single object is the honest shape, and it lets the refusal
--    carry a machine-readable code the UI can branch on without parsing a
--    sentence.
--
--    THE REFUSAL IS NOT AN ERROR. A 403 would look like a bug and would
--    make "ask for permission" impossible to distinguish from "this does
--    not exist". Returning ok=false with a code keeps the two separate,
--    while still disclosing nothing: the response for "no permission" and
--    for "no such record" is deliberately the same text, so the function
--    cannot be used to confirm that a patient exists in a clinic you have
--    no relationship with.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_open_report(p_report uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r public.reports;
BEGIN
    SELECT * INTO r FROM public.reports WHERE id = p_report;

    -- One message for "absent" and for "not yours". Confirming existence
    -- to an unrelated caller is itself a small disclosure.
    IF r.id IS NULL OR NOT public.ent_may_open_report(p_report) THEN
        RETURN jsonb_build_object(
            'ok',      false,
            'code',    'PERMISSION_REQUIRED',
            'message', 'You do not have permission to open this record. Ask the clinic that owns it for access.'
        );
    END IF;

    RETURN jsonb_build_object(
        'ok',      true,
        'code',    'OK',
        'report',  to_jsonb(r),
        'can_edit', public.ent_may_edit_report(r.clinic_id, r.doctor_id, r.id),
        -- Ownership is reported, never reassigned. A grant does not move
        -- the record: clinic_id and doctor_id come from the row as it is.
        'can_delete', (public.ent_is_active_admin()
                       AND r.clinic_id = public.ent_claim_clinic_id())
    );
END;
$$;

COMMENT ON FUNCTION public.ent_open_report(uuid) IS
    'Returns the full reports row for one patient. Refused cross-clinic without a live per-patient grant. Returns the row unchanged, so clinic_id and doctor_id are never rewritten by the act of opening it.';



-- ---------------------------------------------------------------------
-- 7. PHOTOS - LEAK #1.
--
--    Found while designing this: photos_select_owner was reading through
--    ent_may_touch_report, which 0016 had widened. So a clinic manager
--    could read the report_photos rows of another clinic - and
--    patient-photos' download action resolves paths through RLS one at a
--    time, so the BYTES came back too. The list was meant to be metadata
--    only; the photo path was quietly handing over the record.
--
--    The download decision is now ent_may_open_report, so a cross-clinic
--    photo resolves only for a caller who could open the record itself. No
--    grant, no row, no bytes - and no error that distinguishes "refused"
--    from "gone", so the function cannot be probed for what exists.
--
--    Storage's own policies are not touched here: 0009b has to be applied
--    through Dashboard > Storage because storage.objects is not owned by
--    postgres. ent_may_access_photo is redefined so that when those
--    policies ARE applied, they resolve through the same rule rather than
--    the old widened one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_access_photo(
    p_operation     text,
    p_object_name   text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.report_photos p
          JOIN public.reports       r ON r.id = p.report_id
         WHERE p.object_path = btrim(p_object_name)
           AND p.deleted_at IS NULL
           AND r.clinic_id = public.ent_photo_object_clinic(p_object_name)
           AND r.id        = public.ent_photo_object_report(p_object_name)
           -- 0020: opening the record is the same decision as fetching its
           -- photo. A grant that allows View Full Record allows the
           -- download; without one, neither resolves.
           AND public.ent_may_open_report(r.id)
    )
$$;

COMMENT ON FUNCTION ent_may_access_photo(text, text) IS
    'Storage authorization for one photo object. Resolves through ent_may_open_report, so the bytes are released only to someone who could open the record itself - own clinic, or a live per-patient grant.';


-- ---------------------------------------------------------------------
-- 8. THE WRITE SIDE IS UNCHANGED, AND THAT IS DELIBERATE.
--
--    0019 already made ent_may_edit_report the predicate for INSERT,
--    UPDATE and DELETE on reports, and for the photo write policies. That
--    function grants nothing to a clinic manager across clinics and takes
--    ownership columns from OLD, so the write path already satisfies
--    "permission does not transfer ownership".
--
--    One thing IS re-asserted here: the grant predicate used by
--    ent_has_report_grant in section 3 excludes drafts, so an
--    already-issued grant against a row that later became a draft stops
--    matching. No cross-clinic route to a draft exists anywhere in this
--    file, and this is the line that guarantees it stays that way if a
--    grant table row is ever added by hand.
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
-- 9. EXECUTE PRIVILEGES.
--
--    The two RPCs are the View All surface, so they are granted to
--    authenticated and to nobody else. anon is revoked explicitly rather
--    than assumed away, because 0010's own history is a function that was
--    reachable with the anon key.
--
--    Note that ent_view_all_index is SECURITY DEFINER: it deliberately
--    bypasses the Path A policies to see across clinics. That makes it the
--    single most privileged read in the schema, and it is why its column
--    list is written out longhand in section 5. Widening it is a security
--    change, not a feature change.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ent_view_all_index(text, integer, integer) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_view_all_index(text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.ent_open_report(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_open_report(uuid) TO authenticated;

-- ent_has_report_grant is granted in 0019 section 2b, where it is created.
-- Repeating it here would be harmless but would give the impression that
-- 0020 is what makes it reachable, which is not true and would mislead the
-- next person auditing the grants.

REVOKE ALL ON FUNCTION public.ent_may_open_report(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_open_report(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.ent_may_read_own_clinic(uuid, uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_read_own_clinic(uuid, uuid) TO authenticated;


-- ---------------------------------------------------------------------
-- 10. THE ASSERTIONS.
--
--     A. anon still holds nothing, anywhere.
--     B. The SELECT policies on reports / report_photos are EXACTLY the two
--        expected ones, and neither carries a clinic-widening predicate.
--        This is the check that would have caught the 0016 draft leak and
--        the photo leak, so it is worth failing loudly if a later migration
--        reintroduces one.
--     C. The View All index has not started returning record content, and
--        still excludes drafts.
--     D. ent_open_report still refuses through ent_may_open_report, and the
--        grant predicate still excludes drafts.
--     E. Grant approval stays an OWNERSHIP test, never derived from a read
--        or membership rule.
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

DO $$
DECLARE
    widened      text;
    strict_cnt   int;
    expected_cnt int;
BEGIN
    -- EXACTLY TWO authenticated SELECT policies across both tables, and each
    -- must be the shape this file creates.
    --
    -- The count is what makes this assertion trustworthy. A substring test
    -- alone would pass a policy shaped
    --     ent_may_read_own_clinic(...) OR ent_admin_covers_clinic(...)
    -- because the good function name appears in it - and that policy would
    -- hand another clinic's patients straight back. So the check is "the set
    -- of SELECT policies is exactly the two I created, and each contains
    -- the strict arm AND nothing but the grant arm", not "somebody mentioned
    -- the right word".
    SELECT count(*) INTO expected_cnt
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('reports', 'report_photos')
       AND cmd = 'SELECT'
       AND roles && ARRAY['authenticated']::name[];

    IF expected_cnt <> 2 THEN
        RAISE EXCEPTION
            'refused: expected exactly 2 authenticated SELECT policies on reports/report_photos, found %. Run the counts by hand before continuing.', expected_cnt;
    END IF;

    -- Each of the two policies must contain BOTH arms, and the grant arm must
    -- be keyed to the row's own column so a grant for patient A can never
    -- surface patient B.
    --
    -- WHY NOT AN EXACT STRING MATCH. This assertion originally compared
    -- pg_policies.qual against a literal, and it failed on a database whose
    -- policies were correct: Postgres normalises the expression it stores, so
    -- the same policy can come back parenthesised, un-parenthesised, or with
    -- different spacing depending on how it was written. Testing the SHAPE -
    -- both function names present, the right column in the grant arm, and no
    -- widening predicate - asks the question we actually care about and is not
    -- hostage to the server's formatting.
    --
    -- Both arms are required together. A policy carrying only the strict arm
    -- would be safer but would silently break the granted-editor workflow,
    -- and one carrying only the grant arm would leak nothing either - but
    -- neither is the reviewed state, so both are demanded.
    SELECT count(*) INTO strict_cnt
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('reports', 'report_photos')
       AND cmd = 'SELECT'
       AND roles && ARRAY['authenticated']::name[]
       AND policyname IN ('reports_select_owner', 'photos_select_owner')
       AND qual ILIKE '%ent_may_read_own_clinic%'
       AND qual ILIKE '%ent_has_report_grant%';

    IF strict_cnt <> 2 THEN
        -- Name the offenders and show what they actually say, because the
        -- whole point of failing here is that somebody has to read this.
        SELECT string_agg(format('%s.%I = %s', tablename, policyname, qual), E'\n      ')
          INTO widened
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('reports', 'report_photos')
           AND cmd = 'SELECT'
           AND roles && ARRAY['authenticated']::name[]
           AND NOT (qual ILIKE '%ent_may_read_own_clinic%'
                    AND qual ILIKE '%ent_has_report_grant%');

        RAISE EXCEPTION
            'refused: only % of the 2 SELECT policies carry BOTH the strict own-clinic arm and the per-report grant arm. Actual policies:%s%s',
            strict_cnt, E'\n      ', coalesce(widened, ' (none listed)');
    END IF;

    -- The grant arm must be keyed to the row's own id column: id on reports,
    -- report_id on report_photos.
    --
    -- WHY posITION() AND NOT A LIKE PATTERN. 'ent_has_report_grant(report_id)'
    -- does not contain 'ent_has_report_grant(id)' as a whole token, but a
    -- LIKE '%ent_has_report_grant(id)%' WOULD match it, because _ is a LIKE
    -- wildcard standing for any single character - "report_" would be consumed
    -- and the test would pass a policy that reads the wrong column. position()
    -- looks for a literal substring with no wildcard semantics, so
    -- 'ent_has_report_grant(id)' can only be found where the argument really
    -- is "id" followed immediately by the closing parenthesis.
    --
    -- Each policy is tested against its OWN expected grant call, so the two
    -- can never be swapped for one another.
    IF NOT EXISTS (
            SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'reports'
               AND cmd = 'SELECT' AND policyname = 'reports_select_owner'
               AND position('ent_has_report_grant(id)' in qual) > 0
               AND position('ent_has_report_grant(report_id)' in qual) = 0
           )
       OR NOT EXISTS (
            SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'report_photos'
               AND cmd = 'SELECT' AND policyname = 'photos_select_owner'
               AND position('ent_has_report_grant(report_id)' in qual) > 0
           ) THEN
        RAISE EXCEPTION
            'refused: a SELECT policy is not the reviewed strict-plus-grant shape. reports_select_owner must be ent_may_read_own_clinic(clinic_id,doctor_id) OR ent_has_report_grant(id); photos_select_owner the same OR ent_has_report_grant(report_id).';
    END IF;

    -- Belt and braces, and the part that actually matters: neither policy may
    -- mention any predicate that widens by clinic. This catches a future edit
    -- that ADDS an OR arm to a policy whose name still looks right.
    SELECT string_agg(format('%s.%I', tablename, policyname), ', ')
      INTO widened
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('reports', 'report_photos')
       AND cmd = 'SELECT'
       AND roles && ARRAY['authenticated']::name[]
       AND ( qual ILIKE '%ent_admin_covers_clinic%'
          OR qual ILIKE '%ent_is_member_of%'
          OR qual ILIKE '%ent_may_touch_report%' );

    IF widened IS NOT NULL THEN
        RAISE EXCEPTION
            'refused: % still reaches outside the caller''s own clinic through a read predicate. managed_by is not permission to read another clinic''s patients.', widened;
    END IF;

    -- And nothing may have crept in for another role (service_role is
    -- exempt on purpose - it is the Edge Function key, which bypasses RLS
    -- by design and is never used for a browser request).
    SELECT string_agg(format('%s.%I as %I', schemaname, tablename, policyname), ', ')
      INTO widened
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('reports', 'report_photos')
       AND cmd = 'SELECT'
       AND NOT (roles && ARRAY['authenticated']::name[])
       AND NOT (roles && ARRAY['service_role']::name[]);

    IF widened IS NOT NULL THEN
        RAISE EXCEPTION
            'refused: a SELECT policy for an unexpected role exists on %. Only authenticated and service_role may have one.', widened;
    END IF;
END $$;

-- C. The View All index must not be able to grow a payload column. This is
--    a structural guard, not a comment: ent_view_all_index is the only
--    function in the schema that is SECURITY DEFINER and still reads
--    reports across clinics, so a later "just add one more column" edit
--    there is the exact change that would leak the whole record. The check
--    fails loudly if the word payload ever appears in its definition.
DO $$
DECLARE fn_src text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_view_all_index(text,integer,integer)');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION 'refused: ent_view_all_index is missing; apply 0020 section 5 first.';
    END IF;

    -- pg_get_functiondef returns the body verbatim, comments included. This
    -- function's own comments DISCUSS the words "payload" and "photo bytes"
    -- to explain that they are absent, so an unstripped substring test would
    -- fail on a function that is in fact correct. Strip comments first.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_src ILIKE '%payload%'
       OR fn_src ILIKE '%photo_count%'
       OR fn_src ILIKE '%file_name%' THEN
        RAISE EXCEPTION
            'refused: ent_view_all_index has started returning record content. It is a metadata index only.';
    END IF;

    IF fn_src NOT ILIKE '%is_draft = false%' THEN
        RAISE EXCEPTION
            'refused: ent_view_all_index no longer excludes drafts. Drafts must never appear cross-clinic.';
    END IF;
END $$;

-- D. ent_open_report must still refuse through ent_may_open_report, and
--    ent_has_report_grant must still exclude drafts. Together these are
--    the two conditions that make "no permission, no record" true.
DO $$
DECLARE fn_src text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_open_report(uuid)');
    IF fn_src IS NULL THEN
        RAISE EXCEPTION 'refused: ent_open_report is missing.';
    END IF;
    -- strip comments: this function's comments discuss the payload in order
    -- to explain that it is only released after permission.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');
    IF fn_src NOT ILIKE '%ent_may_open_report%' THEN
        RAISE EXCEPTION 'refused: ent_open_report no longer routes through ent_may_open_report.';
    END IF;

    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_has_report_grant(uuid)');
    IF fn_src IS NULL THEN
        RAISE EXCEPTION 'refused: ent_has_report_grant is missing.';
    END IF;
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');
    IF fn_src NOT ILIKE '%is_draft = false%' THEN
        RAISE EXCEPTION 'refused: ent_has_report_grant no longer excludes drafts.';
    END IF;
END $$;

-- E. The grant-approval rule must stay OWNED, not inherited.
--
--    0019 originally gated approval on ent_may_touch_report(), which
--    carries 0016's managed_by widening. That let a clinic manager approve
--    access to patients in a clinic he cannot even read. The rule is now a
--    direct comparison against the report's own clinic, and these two
--    assertions keep it that way: the function must not name the widening
--    helper, and it must not name any read predicate at all. Approval is a
--    fact about the owner, so it must not be derived from a read rule that
--    is free to change.
DO $$
DECLARE fn_src text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_may_grant_report_access(uuid)');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION
            'refused: ent_may_grant_report_access is missing. Apply 0019 section 2 before 0020.';
    END IF;

    -- Same trap as assertion F: these comments deliberately NAME the
    -- predicates that must not be used, so the raw body would match on its
    -- own explanation. Strip comments before testing executable text only.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_src ILIKE '%ent_admin_covers_clinic%'
       OR fn_src ILIKE '%ent_is_member_of%'
       OR fn_src ILIKE '%ent_may_touch_report%'
       OR fn_src ILIKE '%ent_may_read_own_clinic%'
       OR fn_src ILIKE '%ent_may_open_report%' THEN
        RAISE EXCEPTION
            'refused: grant approval must be decided against the report''s owning clinic directly, not through a read or membership rule. A managed_by manager must never be able to approve a grant.';
    END IF;

    -- Strip comments from the function body before testing it.
    --
    -- The pattern is assembled at runtime from chr(45) rather than written as
    -- a literal pair of hyphens. That is deliberate: this file's own audit
    -- tooling (check_migrations.mjs S11) removes SQL comments with a regular
    -- expression that does not understand string literals, so a literal pair
    -- of hyphens inside a quoted string makes the rest of that LINE look like
    -- a comment to it. The SQL here would be correct, but the offline reviewer
    -- would report a false PL/pgSQL imbalance in the one place that is meant to
    -- prove the migration is well formed.
    --
    -- chr(45) is the hyphen character. Written this way there is no literal
    -- hyphen pair anywhere in the statement, so a line-oriented comment
    -- stripper leaves it alone.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    -- The two allowed granter shapes, spelled out so a later edit that
    -- adds a third arm fails here rather than in a clinic.
    IF fn_src NOT ILIKE '%me.clinic_id = r.clinic_id%'
       OR fn_src NOT ILIKE '%r.doctor_id = me.id%' THEN
        RAISE EXCEPTION
            'refused: ent_may_grant_report_access no longer carries both the owning-clinic admin arm and the owning-doctor arm.';
    END IF;

    -- A draft must not be grantable AT ALL, not merely un-matchable later.
    -- Asserting it here means the refusal lives at the only place a grant
    -- can be created, instead of being re-implemented as an ignored
    -- condition in four downstream predicates.
    IF fn_src NOT ILIKE '%is_draft = false%' THEN
        RAISE EXCEPTION
            'refused: a grant over a draft has become creatable. Drafts must be refused at approval time, not merely ignored afterwards.';
    END IF;
END $$;

-- F. The invariant that ties the whole model together: a grant must never
--    be able to move a record. 0018's stamp takes clinic_id and doctor_id
--    from OLD on every UPDATE, so ownership is immutable for every caller -
--    including one holding a valid cross-clinic grant. This assertion
--    exists so that a future "helpful" change to the trigger cannot quietly
--    reintroduce a transfer, because that is the one failure mode the grant
--    system must be incapable of.
DO $$
DECLARE fn_src text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_stamp_report_ownership()');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION
            'refused: ent_stamp_report_ownership is missing. Apply 0018 section 1 before 0020.';
    END IF;

    -- Ownership is read from OLD, and the cross-clinic branch is gated on a
    -- GRANT rather than on any clinic-widening predicate.
    IF fn_src NOT ILIKE '%OLD.clinic_id%'
       OR fn_src NOT ILIKE '%OLD.doctor_id%' THEN
        RAISE EXCEPTION
            'refused: the ownership stamp no longer pins clinic_id and doctor_id from the existing row.';
    END IF;

    -- Strip SQL comments before testing. pg_get_functiondef returns the body
    -- verbatim, comments included, and this trigger's comments deliberately
    -- name ent_admin_covers_clinic() to say it is NOT used. A raw substring
    -- test would therefore fail on the very file that is correct. Only
    -- executable text is allowed to contain the widening predicate.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_src ILIKE '%ent_admin_covers_clinic%' THEN
        RAISE EXCEPTION
            'refused: the ownership stamp still widens on managed_by. Cross-clinic writes require a grant for that exact report.';
    END IF;

    -- And the cross-clinic branch must actually be gated on the grant,
    -- not merely free of the widening predicate.
    IF fn_src NOT ILIKE '%ent_has_report_grant(OLD.id)%' THEN
        RAISE EXCEPTION
            'refused: the ownership stamp no longer gates cross-clinic writes on an explicit per-report grant.';
    END IF;
END $$;

-- PostgREST caches the function list; without this the two new RPCs can
-- return "function not found" for a few seconds after apply.
NOTIFY pgrst, 'reload schema';


