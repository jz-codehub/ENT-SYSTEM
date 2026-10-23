-- =====================================================================
--  0016 . one clinic per doctor  (an admin may manage several clinics)
-- ---------------------------------------------------------------------
--  THE FEATURE
--  A clinic is named after its doctor ("ENT Clinic Doc Jess") and belongs
--  to the administrator who created it. So the admin console can rank
--  clinics (the "Top clinics by records" podium) and every doctor's work
--  is its own, named, tally instead of one undifferentiated pot.
--
--  WHY A COLUMN AND NOT A NEW TABLE
--  `clinics` already IS the tenant boundary: every other table points at
--  it, and every policy already asks "is the caller a member of THIS
--  clinic?". The only thing missing was "which admin does this clinic
--  belong to", which is exactly one column. A second table would mean a
--  second definition of tenancy, and the two would drift.
--
--  THE RULE, STATED ONCE
--      ent_admin_covers_clinic(c)  =  caller is an ACTIVE admin AND
--                                     (c is his own clinic
--                                      OR c.managed_by = caller)
--  Everything else in this file is that one sentence applied to the
--  places that previously said "me.clinic_id = p_clinic" for an admin.
--
--  WHAT DOES NOT CHANGE
--    · a doctor still reaches ONLY his own shelf
--    · a secretary still reaches ONLY her assigned doctor's shelf
--    · a clinic with managed_by = NULL (the two seeded clinics) keeps the
--      old behaviour: the admin's own clinic
--    · anon still has nothing, anywhere. This file keeps that assertion
--      so a later "just GRANT it" cannot quietly undo it.
--  Cross-clinic access exists ONLY for the admin who owns the clinic he
--  is reading - never for a doctor or a secretary, and never across two
--  unrelated administrators.
--
--  IDEMPOTENT       : yes, safe to re-run.
--  DATA DESTRUCTIVE : no. Adds one nullable column, re-creates functions
--                     and policies. No row is deleted or rewritten, and
--                     existing doctors keep the clinic they already have.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Which administrator owns this clinic?
--    Nullable on purpose: the two seeded clinics predate this and are
--    left exactly as they are, so nothing that works today stops working.
-- ---------------------------------------------------------------------
ALTER TABLE public.clinics
    ADD COLUMN IF NOT EXISTS managed_by uuid
        REFERENCES public.staff_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.clinics.managed_by IS
    'The administrator who owns this clinic (each doctor gets his own, named '
    'after him). NULL for the seeded clinics, which behave as before.';

CREATE INDEX IF NOT EXISTS idx_clinics_managed_by ON public.clinics (managed_by);


-- ---------------------------------------------------------------------
-- 2. The one rule, as a function, so it cannot drift between call sites.
--    Re-read from the rows on every call, exactly like ent_is_member_of:
--    a demoted or deactivated admin loses the reach on his NEXT request,
--    not at token expiry.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_admin_covers_clinic(p_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.staff_profiles me
          LEFT JOIN public.clinics c ON c.id = p_clinic
         WHERE me.id = public.ent_auth_uid()
           AND me.is_active
           AND me.role = 'admin'
           -- his own clinic, or a clinic he created and therefore owns
           AND ( me.clinic_id = p_clinic OR c.managed_by = me.id )
    )
$$;

COMMENT ON FUNCTION public.ent_admin_covers_clinic(uuid) IS
    'True when the caller is an active admin and p_clinic is his own clinic '
    'or one he manages (clinics.managed_by = him). The only widening of '
    'admin reach in v2, and it is scoped to clinics the admin created.';


-- ---------------------------------------------------------------------
-- 3. Membership. An admin who OWNS a clinic is a member of it for every
--    policy that asks. This single definition is what lets tickets,
--    settings, presence and the audit trail work across the admin's own
--    clinics without repeating the ownership test in five places.
--    It cannot widen anything for a doctor or a secretary: the OR arm
--    requires role = 'admin'.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_is_member_of(p_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.staff_profiles
         WHERE id = public.ent_auth_uid()
           AND clinic_id = p_clinic
           AND is_active
    )
    OR public.ent_admin_covers_clinic(p_clinic)
$$;

-- ---------------------------------------------------------------------
-- 4. Reports. The original rule is preserved word for word for doctors
--    and secretaries; an ACTIVE admin gains one extra arm - every shelf
--    in every clinic he owns. Without this the reports stay invisible to
--    the admin (RLS filters them out) and the whole feature would be a
--    name on a card and nothing behind it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_touch_report(
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
           AND (
                -- unchanged: your own clinic, and the original per-role rule
                ( me.clinic_id = p_clinic
                  AND (
                        me.role = 'admin'
                     OR (me.role = 'doctor'    AND p_doctor = me.id)
                     OR (me.role = 'secretary' AND p_doctor = me.assigned_doctor_id)
                  )
                )
                -- added: an admin reaches every shelf in a clinic he owns
             OR ( me.role = 'admin' AND public.ent_admin_covers_clinic(p_clinic) )
           )
    )
$$;


-- ---------------------------------------------------------------------
-- 5. The admin analytics RPC. 0010 pinned it to ent_claim_clinic_id(), so
--    a doctor's own clinic was invisible to the admin's Overview - the
--    "Top clinics by records" podium would have shown one row forever.
--    The live-admin gate and the live-membership test stay; only the
--    claim-equality clause is dropped, because ent_is_member_of() now
--    already answers "may he read this clinic" for an owner-admin.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_record_activity(
    p_days int DEFAULT 365,
    p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
    clinic_id   text,
    doctor_id   text,
    created_by  text,
    report_type text,
    day         date,
    n           bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        coalesce(r.clinic_id::text,   '')      AS clinic_id,
        coalesce(r.doctor_id::text,   '')      AS doctor_id,
        coalesce(r.created_by::text,  '')      AS created_by,
        coalesce(r.report_type::text, 'other') AS report_type,
        date_trunc(
            'day',
            r.created_at AT TIME ZONE
                (CASE WHEN EXISTS (SELECT 1
                                     FROM pg_catalog.pg_timezone_names tz
                                    WHERE tz.name = coalesce(p_tz, 'UTC'))
                      THEN coalesce(p_tz, 'UTC') ELSE 'UTC' END)
        )::date                                AS day,
        count(*)::bigint                       AS n
    FROM public.reports r
    WHERE r.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 365), 1))
      -- THE GATE: live role + live reach, not the JWT claim alone.
      AND public.ent_is_active_admin()
      AND public.ent_is_member_of(r.clinic_id)
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY 5, 1;
$$;


-- ---------------------------------------------------------------------
-- 6. Account de/activation. 0011's body is reproduced verbatim except for
--    the ONE clinic test, which becomes the ownership rule. Everything
--    else - the live-admin gate, the "not your own account" guard, the
--    audit insert and its ::ent_activity cast - is untouched.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_admin_set_active(
    p_user_id uuid,
    p_active  boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me   public.staff_profiles;
    tgt  public.staff_profiles;
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: administrator role required'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO me  FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    SELECT * INTO tgt FROM public.staff_profiles WHERE id = p_user_id;

    IF tgt.id IS NULL THEN
        RAISE EXCEPTION 'unknown account';
    END IF;
    -- Was: tgt.clinic_id <> me.clinic_id. Now the admin may act on any
    -- clinic he owns, which is what makes him able to manage the doctors
    -- he created. A clinic he does not own still refuses.
    IF NOT public.ent_admin_covers_clinic(tgt.clinic_id) THEN
        RAISE EXCEPTION 'refused: that account belongs to another clinic'
            USING ERRCODE = '42501';
    END IF;
    IF tgt.id = me.id AND p_active = FALSE THEN
        RAISE EXCEPTION 'you cannot deactivate your own account';
    END IF;

    UPDATE public.staff_profiles
       SET is_active = p_active
     WHERE id = tgt.id;

    INSERT INTO public.activity_logs
        (actor_id, actor_role, actor_label, clinic_id, action, detail,
         target_type, target_id)
    VALUES
        (me.id, me.role::text,
         coalesce(nullif(me.full_name,''), me.username::text),
         me.clinic_id,
         (CASE WHEN p_active THEN 'USER_ACTIVATED'
               ELSE 'USER_DEACTIVATED' END)::ent_activity,
         CASE WHEN p_active THEN 'Activated ' ELSE 'Deactivated ' END || tgt.username,
         'staff', tgt.id::text);

    RETURN jsonb_build_object('id', tgt.id, 'is_active', p_active);
END;
$$;


-- ---------------------------------------------------------------------
-- 7. staff_profiles read. Same as 0008 but the `clinic_id =
--    ent_claim_clinic_id()` clause is gone: it pinned an admin to his own
--    clinic row, so the console could never name the staff of a clinic he
--    owns. ent_is_member_of() carries the scoping now, and still refuses
--    every non-admin and every clinic he does not own.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_select_admin_clinic ON public.staff_profiles;
CREATE POLICY profiles_select_admin_clinic ON public.staff_profiles
    FOR SELECT TO authenticated
    USING (
        public.ent_is_active_admin()
        AND public.ent_is_member_of(clinic_id)
    );


-- ---------------------------------------------------------------------
-- 8. Privileges. CREATE OR REPLACE keeps the EXECUTE grants the replaced
--    functions already had; only the NEW function needs one. anon gets
--    nothing - asserted rather than assumed, so a later GRANT cannot
--    quietly reopen the door this whole project was built to close.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ent_admin_covers_clinic(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_admin_covers_clinic(uuid) TO authenticated;

-- clinics.managed_by is written ONLY through the auth-admin Edge Function
-- (service_role), never by a browser: no column UPDATE grant is added, so
-- an authenticated user cannot repoint a clinic at himself.
GRANT SELECT ON public.clinics TO authenticated;
REVOKE ALL ON public.clinics FROM anon, public;


-- ---------------------------------------------------------------------
-- 9. Done. Reload the PostgREST schema cache so the new column, the new
--    function and the re-created policies are visible immediately.
-- ---------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

