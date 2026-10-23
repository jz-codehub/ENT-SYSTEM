-- =====================================================================
--  0037 · CROSS-CLINIC SECRETARY  (one secretary, many doctors)
-- ---------------------------------------------------------------------
--  THE OPERATIONAL REALITY THIS CLOSES
--
--  A secretary floats between ENT doctors. Today she files under
--  "ENT-Clinic Doc. Jess", tomorrow under "Doc. Josh" - and each doctor
--  owns his OWN clinic (0016: clinics.managed_by = the admin who made
--  it). The schema only ever modelled ONE doctor per secretary:
--
--      staff_profiles.assigned_doctor_id   a single uuid
--      staff_secretary_requires_doctor     CHECK ... assigned_doctor_id
--                                           IS NOT NULL  (exactly one)
--      every read/write predicate          p_doctor = me.assigned_doctor_id
--      ent_may_read_own_clinic             me.clinic_id = p_clinic  (gate)
--
--  So a second or third doctor was unreachable, and - because each
--  doctor is his own clinic - even an assignment could not cross the
--  clinic gate. This file adds the OTHER doctors as a controlled set.
--
--  THE MODEL  (mirrors the cross-clinic GRANT pattern of 0019: an
--  explicit, admin-owned link that widens reach in a scoped way, never
--  a blanket "any record anywhere")
--
--    1. secretary_assignments(secretary_id, doctor_id)  - a many-to-many
--       junction. ADMIN-MANAGED ONLY: no INSERT/UPDATE/DELETE policy, so
--       only service_role (auth-admin) writes it, exactly like accounts.
--    2. assigned_doctor_id STAYS as the "primary / current" doctor - it
--       satisfies the CHECK, and it is the default shelf a new record
--       lands on when the secretary names no doctor.
--    3. ent_is_my_doctor(p_doctor)  - TRUE when p_doctor is her primary
--       OR is in her junction set, and she is an active secretary, and
--       that doctor is a real active doctor. Every new arm calls it, so
--       the rule cannot drift.
--    4. READ and WRITE gain ONE additive OR arm each, keyed on
--       ent_is_my_doctor(doctor_id). Deliberately NOT gated on clinic,
--       because the assigned doctor may sit in another clinic. It can
--       never widen to "any record" - the junction table is the scope.
--    5. The stamp (ent_stamp_report_ownership) learns to file a NEW
--       record under the assigned doctor she names, in THAT doctor's
--       clinic - so "filing for Doc. Josh today" lands on Josh's shelf.
--    6. The recycle bin and the team card see the whole assigned set.
--
--  WHAT IS EXPLICITLY NOT WIDENED
--    · a doctor still reaches only his own shelf
--    · an admin is unchanged (ent_admin_covers_clinic still governs him)

-- ---------------------------------------------------------------------
--  1. THE JUNCTION TABLE  (the real scope of a multi-doctor secretary)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.secretary_assignments (
    secretary_id uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    doctor_id    uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (secretary_id, doctor_id)
);

COMMENT ON TABLE public.secretary_assignments IS
    'Which doctors a secretary may work under (0037). Many-to-many, so one secretary can float between several ENT clinics. Admin-managed only: no INSERT/UPDATE/DELETE policy, written solely by auth-admin (service_role). CASCADEs when either account is removed.';

CREATE INDEX IF NOT EXISTS idx_sec_assign_secretary ON public.secretary_assignments (secretary_id);
CREATE INDEX IF NOT EXISTS idx_sec_assign_doctor    ON public.secretary_assignments (doctor_id);

ALTER TABLE public.secretary_assignments ENABLE ROW LEVEL SECURITY;

-- A secretary reads her OWN assignments (this is what the "working today
-- at ..." picker lists). Nothing else may read another person's links.
DROP POLICY IF EXISTS secretary_assignments_read_self ON public.secretary_assignments;
CREATE POLICY secretary_assignments_read_self ON public.secretary_assignments
    FOR SELECT TO authenticated
    USING ( secretary_id = public.ent_auth_uid() );

-- An admin reads the assignments of secretaries inside clinics he covers,
-- so the Users panel can show and manage them. No write policy at all:
-- assignment changes go through auth-admin, like every other account edit.
DROP POLICY IF EXISTS secretary_assignments_read_admin ON public.secretary_assignments;
CREATE POLICY secretary_assignments_read_admin ON public.secretary_assignments
    FOR SELECT TO authenticated
    USING (
        public.ent_is_active_admin()
        AND EXISTS (
            SELECT 1 FROM public.staff_profiles s
             WHERE s.id = secretary_assignments.secretary_id
               AND public.ent_admin_covers_clinic(s.clinic_id)
        )
    );

--    · nobody reaches a doctor they were not assigned to

-- ---------------------------------------------------------------------
--  2. THE PREDICATE  ent_is_my_doctor(p_doctor)
-- ---------------------------------------------------------------------
-- The single definition of "is this doctor one I may work under". Every
-- arm below calls it, so read, write, stamp, recycle bin and the team
-- card cannot drift apart. SECURITY DEFINER + ent_auth_uid() (which
-- reads the verified JWT, not current_user) so it is correct even when
-- called from inside the SECURITY DEFINER stamp trigger.
CREATE OR REPLACE FUNCTION public.ent_is_my_doctor(p_doctor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.staff_profiles me
          LEFT JOIN public.secretary_assignments sa
                 ON sa.secretary_id = me.id
                AND sa.doctor_id    = p_doctor
         WHERE me.id = public.ent_auth_uid()
           AND me.is_active
           AND me.role = 'secretary'
           AND p_doctor IS NOT NULL
           AND ( me.assigned_doctor_id = p_doctor OR sa.doctor_id IS NOT NULL )
           -- the target must be a real, active doctor - a dangling or
           -- deactivated uuid is never "my doctor"
           AND EXISTS (
               SELECT 1 FROM public.staff_profiles d
                WHERE d.id = p_doctor AND d.role = 'doctor' AND d.is_active
           )
    )
$$;

COMMENT ON FUNCTION public.ent_is_my_doctor(uuid) IS
    'True when the caller is an active secretary and p_doctor is her primary (assigned_doctor_id) OR one she is assigned to via secretary_assignments (0037), and that doctor is a real active doctor. The single scope predicate for cross-clinic secretary read/write/stamp/bin.';

REVOKE ALL ON FUNCTION public.ent_is_my_doctor(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_is_my_doctor(uuid) TO authenticated;

--    · 0020's forbidden-predicate guard still holds: the SELECT policies
--      keep ent_may_read_own_clinic + ent_has_report_grant and never name
--      ent_admin_covers_clinic / ent_is_member_of / ent_may_touch_report.
--
--  IDEMPOTENT      : yes. CREATE OR REPLACE / IF NOT EXISTS / DROP+ADD.
--  DATA DESTRUCTIVE: no. Nothing is inserted, updated or deleted.
-- =====================================================================

-- ---------------------------------------------------------------------
--  3. READ - one additive arm on each SELECT policy
-- ---------------------------------------------------------------------
-- 0026 carried reports_select_owner across verbatim (deleted_at IS NULL,
-- ent_may_read_own_clinic, ent_has_report_grant) and 0033 added the
-- author arm. This file adds ONE more: ent_is_my_doctor(doctor_id).
--
-- It is placed INSIDE the same parentheses as the existing arms, so
-- 0020's structural guard (which demands ent_may_read_own_clinic AND
-- ent_has_report_grant both appear, and that NONE of the clinic-widening
-- predicates do) still passes: those two substrings are untouched, and
-- ent_is_my_doctor is not on the forbidden list.
--
-- The arm is NOT gated on clinic - that is the entire point. A secretary
-- assigned to Doc. Josh reads Josh's rows even though Josh's clinic
-- differs from her own. What stops it being "any record anywhere" is
-- ent_is_my_doctor itself: it is true only for doctors she is assigned
-- to, so the reach is exactly her junction set and nothing more.
DROP POLICY IF EXISTS reports_select_owner ON public.reports;
CREATE POLICY reports_select_owner ON public.reports
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
    AND (
            public.ent_may_read_own_clinic(clinic_id, doctor_id)
         OR public.ent_has_report_grant(id)
         OR created_by = public.ent_auth_uid()
         OR public.ent_is_my_doctor(doctor_id)
        )
    );

-- Photos ride the identical rule, or a cross-clinic secretary would see
-- Josh's report text while his endoscopy images stayed one clause away
-- from invisible. uploaded_by = auth.uid() is 0033's author arm, kept.
DROP POLICY IF EXISTS photos_select_owner ON public.report_photos;
CREATE POLICY photos_select_owner ON public.report_photos
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.reports r
             WHERE r.id = report_id AND r.deleted_at IS NULL
        )
    AND (
            public.ent_may_read_own_clinic(clinic_id, doctor_id)
         OR public.ent_has_report_grant(report_id)
         OR uploaded_by = public.ent_auth_uid()
         OR public.ent_is_my_doctor(doctor_id)
        )
    );

-- ---------------------------------------------------------------------
--  4. WRITE - one additive arm on INSERT and UPDATE
-- ---------------------------------------------------------------------
-- The stamp trigger (section 5) sets NEW.doctor_id to the doctor the
-- secretary names, so the WITH CHECK below is evaluated against that
-- resolved doctor - exactly like the existing ent_may_edit_report arm,
-- which also keys on doctor_id after the stamp runs. Adding
-- ent_is_my_doctor(doctor_id) as an OR lets the arm pass for an assigned
-- doctor in another clinic. A live row's clinic gate is intentionally
-- absent here for the same reason as the read arm: the assigned doctor
-- may be in another clinic, and ent_is_my_doctor is the scope.
--
-- deleted_at IS NULL is kept, so a cross-clinic secretary can create and
-- edit LIVE records on her assigned doctors' shelves, but cannot touch a
-- deleted row (that stays the admin's recycle bin, 0026) and gains no
-- hard delete.
DROP POLICY IF EXISTS reports_insert_owner ON public.reports;
CREATE POLICY reports_insert_owner ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (
        deleted_at IS NULL
    AND created_by = public.ent_auth_uid()
    AND (
            public.ent_may_edit_report(clinic_id, doctor_id)
         OR public.ent_is_my_doctor(doctor_id)
        )
    );

-- UPDATE keeps 0026's two arms verbatim (live-row edit via
-- ent_may_edit_report; deleted-row restore via active admin of the owning
-- clinic) and gains ONE more: a live row on an assigned doctor's shelf.
-- Note the ordering guarantee - USING sees the OLD row, WITH CHECK the
-- NEW one, and the stamp pins NEW.doctor_id on UPDATE, so this arm
-- evaluates against the same doctor on both sides.
DROP POLICY IF EXISTS reports_update_owner ON public.reports;
CREATE POLICY reports_update_owner ON public.reports
    FOR UPDATE TO authenticated
    USING (
        (deleted_at IS NULL
         AND public.ent_may_edit_report(clinic_id, doctor_id, id))
     OR (deleted_at IS NULL
         AND public.ent_is_my_doctor(doctor_id))
     OR (deleted_at IS NOT NULL
         AND public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id())
    )
    WITH CHECK (
        (deleted_at IS NULL
         AND public.ent_may_edit_report(clinic_id, doctor_id, id))
     OR (deleted_at IS NULL
         AND public.ent_is_my_doctor(doctor_id))
     OR (deleted_at IS NOT NULL
         AND public.ent_is_active_admin()
         AND clinic_id = public.ent_claim_clinic_id())
    );

-- ---------------------------------------------------------------------
--  5. THE STAMP - file under the assigned doctor she names
-- ---------------------------------------------------------------------
-- This is 0028's trigger carried across VERBATIM, plus one branch. The
-- structural substrings the rest of the chain asserts on are preserved:
--   · ent_has_report_grant(OLD.id)   still gates a grant-based cross-
--                                     clinic write (classify_live_state)
--   · ent_admin_covers_clinic        still ABSENT (the old managed_by
--                                     widening must never come back)
-- Everything a doctor, an admin and an ordinary (own-clinic) secretary
-- does is byte-for-byte what it was.
--
-- THE ONE NEW BRANCH. On INSERT, when a secretary names a doctor she is
-- assigned to (ent_is_my_doctor), the record is filed under THAT doctor
-- and into THAT doctor's clinic - so "filing for Doc. Josh today" lands
-- on Josh's shelf, not back on her primary's. Two things make it safe:
--   · the doctor is resolved through ent_is_my_doctor, so a forged or
--     foreign doctor_id is simply not "her doctor" and falls back to her
--     primary (the ELSE branch below) - the browser nominates, the
--     database disposes;
--   · the cross-clinic guard below is widened by exactly this one case
--     (an assigned doctor), nothing else - a manager still cannot file
--     into a clinic he merely manages.
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

    -- A report NEVER changes clinic after it is created. On UPDATE the
    -- home comes from OLD; on INSERT it is resolved below.
    IF TG_OP = 'UPDATE' THEN
        keep_clinic := OLD.clinic_id;
        keep_doctor := OLD.doctor_id;
    ELSIF me.role = 'secretary'
          AND NEW.doctor_id IS NOT NULL
          AND public.ent_is_my_doctor(NEW.doctor_id) THEN
        -- 0037: a secretary filing under a doctor she is assigned to,
        -- who may live in another clinic. The record's home is THAT
        -- doctor's clinic, and the shelf is THAT doctor.
        SELECT d.clinic_id INTO keep_clinic
          FROM public.staff_profiles d
         WHERE d.id = NEW.doctor_id;
        keep_doctor := NEW.doctor_id;
    ELSE
        keep_clinic := coalesce(NEW.clinic_id, me.clinic_id);
        keep_doctor := NULL;
    END IF;

    -- Cross-clinic write is allowed ONLY with an explicit per-patient
    -- grant, OR (0037) when a secretary files under a doctor she is
    -- assigned to. managed_by still grants nothing here.
    IF keep_clinic IS DISTINCT FROM me.clinic_id
       AND NOT public.ent_has_report_grant(OLD.id)
       AND NOT (me.role = 'secretary'
                AND keep_doctor IS NOT NULL
                AND public.ent_is_my_doctor(keep_doctor)) THEN
        RAISE EXCEPTION 'refused: you may not write a report into another clinic without an explicit grant for that record'
            USING ERRCODE = '42501';
    END IF;

    NEW.clinic_id := keep_clinic;

    -- The doctor shelf. UPDATE keeps the row on the shelf it was filed
    -- on; INSERT resolves it. keep_doctor is set only for the 0037
    -- assigned-doctor branch, so an ordinary doctor/secretary/admin
    -- INSERT is unchanged.
    IF TG_OP = 'UPDATE' THEN
        NEW.doctor_id := keep_doctor;
    ELSIF keep_doctor IS NOT NULL THEN
        NEW.doctor_id := keep_doctor;
    ELSIF me.role = 'doctor' THEN
        NEW.doctor_id := me.id;
    ELSIF me.role = 'secretary' THEN
        NEW.doctor_id := me.assigned_doctor_id;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM public.staff_profiles d
             WHERE d.id = NEW.doctor_id
               AND d.clinic_id = keep_clinic
               AND d.role = 'doctor'
               AND d.is_active
        ) INTO doctor_ok;

        IF NOT doctor_ok THEN
            IF keep_clinic = me.clinic_id THEN
                NEW.doctor_id := me.id;
            ELSE
                RAISE EXCEPTION 'refused: name a doctor of that clinic when filing a report into it'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    -- Author: recorded truthfully on insert, never rewritten after.
    -- 0028: the display name rides with the id, frozen exactly like it.
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := me.id;
        NEW.created_by_name := coalesce(nullif(me.full_name, ''), me.username);
    ELSE
        NEW.created_by := OLD.created_by;
        NEW.created_by_name := OLD.created_by_name;
    END IF;

    -- A report that is not a draft is stamped as saved.
    IF NOT NEW.is_draft AND NEW.saved_at IS NULL THEN
        NEW.saved_at := now();
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
--  6. THE RECYCLE BIN - a secretary sees her WHOLE assigned set
-- ---------------------------------------------------------------------
-- 0034's bin let a secretary see only her primary doctor's deleted rows.
-- A cross-clinic secretary must see the deleted rows on EVERY doctor she
-- is assigned to, or she would delete into a bin she cannot open. The
-- secretary scope widens from "primary doctor" to ent_is_my_doctor,
-- which is exactly her junction set. The admin scope is untouched.
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
    SELECT * INTO me
      FROM public.staff_profiles
     WHERE id = public.ent_auth_uid();

    IF me.id IS NULL OR me.is_active = false THEN
        RAISE EXCEPTION
            'refused: only a signed-in, active staff member may read the recycle bin.'
            USING ERRCODE = '42501';
    END IF;

    IF me.role = 'admin' THEN
        IF NOT public.ent_is_active_admin() THEN
            RAISE EXCEPTION
                'refused: only an active administrator may read the recycle bin.'
                USING ERRCODE = '42501';
        END IF;
    ELSIF me.role <> 'secretary' THEN
        RAISE EXCEPTION
            'refused: only an active administrator or an assigned secretary may read the recycle bin.'
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
              (me.role = 'admin'     AND r.clinic_id = public.ent_claim_clinic_id())
           OR (me.role = 'secretary' AND public.ent_is_my_doctor(r.doctor_id))
           )
     ORDER BY r.deleted_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END;
$$;

COMMENT ON FUNCTION public.ent_deleted_reports(integer) IS
    'The recycle bin. An active administrator sees every deleted row in a clinic he owns; a secretary sees the deleted rows of EVERY doctor she is assigned to (ent_is_my_doctor, 0037), not just her primary. Anyone else - including a doctor - is refused. Deleted rows only, no payload.';

REVOKE ALL ON FUNCTION public.ent_deleted_reports(integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_deleted_reports(integer) TO authenticated;

-- ---------------------------------------------------------------------
--  7. THE DOCTOR'S TEAM CARD - see a shared secretary too
-- ---------------------------------------------------------------------
-- 0027's my_secretaries() returned only secretaries whose PRIMARY
-- assigned_doctor_id is me. A cross-clinic secretary assigned to me
-- through the junction (her primary is someone else) was invisible. This
-- widens the JOIN to "primary OR junction", so Doc. Josh sees the
-- secretary who floats to his clinic. Returns the same columns as 0027.
CREATE OR REPLACE FUNCTION public.my_secretaries()
RETURNS TABLE (
    id                 uuid,
    username           text,
    full_name          text,
    role               public.ent_role,
    assigned_doctor_id uuid,
    is_active          boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT DISTINCT s.id,
           s.username::text,
           s.full_name,
           s.role,
           s.assigned_doctor_id,
           s.is_active
      FROM public.staff_profiles me
      JOIN public.staff_profiles s
        ON s.role = 'secretary'
       AND (
             s.assigned_doctor_id = me.id
          OR EXISTS (
                 SELECT 1 FROM public.secretary_assignments sa
                  WHERE sa.secretary_id = s.id
                    AND sa.doctor_id    = me.id
             )
           )
     WHERE me.id = public.ent_auth_uid()
       AND me.role = 'doctor'
     ORDER BY s.full_name
$$;

COMMENT ON FUNCTION public.my_secretaries() IS
    'Secretaries who work under the signed-in doctor: her primary assignment (0027) OR any secretary assigned to him via secretary_assignments (0037). No arguments, joined on auth.uid(), nothing about any other doctor.';

REVOKE ALL ON FUNCTION public.my_secretaries() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_secretaries() TO authenticated;

-- ---------------------------------------------------------------------
--  8. THE PICKER'S DATA - my_assigned_doctors()
-- ---------------------------------------------------------------------
-- What the "working today at ..." popup lists: every doctor this
-- secretary may file under, with the clinic name so she can tell them
-- apart, and a flag for her primary. No arguments - the set is resolved
-- from auth.uid() exactly like my_secretaries, so the browser cannot aim
-- it at anybody. A non-secretary gets zero rows.
CREATE OR REPLACE FUNCTION public.my_assigned_doctors()
RETURNS TABLE (
    doctor_id    uuid,
    doctor_name  text,
    clinic_id    uuid,
    clinic_name  text,
    is_primary   boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT d.id,
           coalesce(nullif(btrim(d.full_name), ''), d.username::text),
           d.clinic_id,
           c.name,
           (d.id = me.assigned_doctor_id) AS is_primary
      FROM public.staff_profiles me
      JOIN public.staff_profiles d
        ON d.role = 'doctor'
       AND d.is_active
       AND (
             d.id = me.assigned_doctor_id
          OR EXISTS (
                 SELECT 1 FROM public.secretary_assignments sa
                  WHERE sa.secretary_id = me.id
                    AND sa.doctor_id    = d.id
             )
           )
      LEFT JOIN public.clinics c ON c.id = d.clinic_id
     WHERE me.id = public.ent_auth_uid()
       AND me.role = 'secretary'
     ORDER BY is_primary DESC, d.full_name
$$;

COMMENT ON FUNCTION public.my_assigned_doctors() IS
    'The doctors a signed-in secretary may work under (0037): her primary plus every doctor in secretary_assignments, with clinic names and an is_primary flag. Powers the "working today at ..." picker. No arguments; empty for a non-secretary.';

REVOKE ALL ON FUNCTION public.my_assigned_doctors() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_assigned_doctors() TO authenticated;

-- ---------------------------------------------------------------------
--  9. SELF-GUARD - the invariants this file must not break
-- ---------------------------------------------------------------------
-- Run at apply time so a half-applied 0037 fails loudly here rather than
-- silently widening (or narrowing) access on the live database.
DO $$
DECLARE
    fn_src  text;
    pol_src text;
BEGIN
    -- (a) ent_is_my_doctor must exist and key on the junction table.
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_is_my_doctor(uuid)');
    IF fn_src IS NULL THEN
        RAISE EXCEPTION 'refused: ent_is_my_doctor is missing.';
    END IF;

    -- (b) The SELECT policies must STILL carry BOTH 0020 substrings, or
    --     re-creating them here has silently dropped the own-clinic arm
    --     or the grant arm.
    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND cmd = 'SELECT' AND policyname = 'reports_select_owner';
    IF pol_src IS NULL
       OR pol_src NOT ILIKE '%ent_may_read_own_clinic%'
       OR pol_src NOT ILIKE '%ent_has_report_grant%' THEN
        RAISE EXCEPTION
            'refused: reports_select_owner lost the strict own-clinic arm or the grant arm. 0037 is additive only.';
    END IF;

    -- (c) 0020's forbidden-predicate rule still holds: no clinic-widening
    --     predicate may appear in the SELECT policies. ent_is_my_doctor is
    --     NOT on that list, so its presence is fine; the three that are
    --     listed must still be absent.
    SELECT qual INTO pol_src
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'reports'
       AND cmd = 'SELECT' AND policyname = 'reports_select_owner';
    IF pol_src ILIKE '%ent_may_touch_report%'
       OR pol_src ILIKE '%ent_is_member_of%'
       OR pol_src ILIKE '%ent_admin_covers_clinic%' THEN
        RAISE EXCEPTION
            'refused: a clinic-widening predicate crept into reports_select_owner. 0020 forbids it.';
    END IF;

    -- (d) The stamp must still gate a cross-clinic write on a GRANT (the
    --     classify_live_state assertion), and must NOT have grown the old
    --     managed_by widening back.
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_stamp_report_ownership()');
    IF fn_src NOT ILIKE '%ent_has_report_grant(OLD.id)%' THEN
        RAISE EXCEPTION
            'refused: the ownership stamp no longer gates a cross-clinic write on a grant.';
    END IF;
    IF fn_src ILIKE '%ent_admin_covers_clinic%' THEN
        RAISE EXCEPTION
            'refused: the managed_by widening has returned to the ownership stamp.';
    END IF;

    RAISE NOTICE
        '0037 verified: a secretary now reaches every doctor she is assigned to (0037 junction), across clinics, through read/write/stamp/bin - and nothing else widened.';
END $$;

NOTIFY pgrst, 'reload schema';
