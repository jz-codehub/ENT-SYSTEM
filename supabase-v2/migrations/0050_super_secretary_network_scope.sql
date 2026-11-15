-- =====================================================================
--  0050 - SUPER SECRETARY selected doctors and active clinics
-- ---------------------------------------------------------------------
--  A Super Secretary remains a secretary for all existing role checks.
--  Her primary and explicitly selected doctors determine access; the
--  active-clinic context still prevents cross-clinic data access.
--  Existing network access is backfilled once at the end of this file.
-- =====================================================================

ALTER TABLE public.staff_profiles
    ADD COLUMN IF NOT EXISTS is_super_secretary boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.staff_profiles.is_super_secretary IS
    'When true for an active secretary, allows clinic switching among her primary and explicitly assigned active doctors.';

-- This is the single live permission predicate used by record, photo,
-- write, delete, recycle-bin and filing policies. The role and flag are
-- re-read from staff_profiles for every request; JWT/UI claims cannot
-- grant the capability.
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
           AND (
                me.assigned_doctor_id = p_doctor
             OR sa.doctor_id IS NOT NULL
             OR (
                    me.is_super_secretary
                AND EXISTS (
                        SELECT 1
                          FROM public.staff_profiles d
                          JOIN public.clinics doctor_clinic
                            ON doctor_clinic.id = d.clinic_id
                          JOIN public.clinics home_clinic
                            ON home_clinic.id = me.clinic_id
                         WHERE d.id = p_doctor
                           AND (
                                doctor_clinic.id = home_clinic.id
                             OR (
                                    home_clinic.managed_by IS NOT NULL
                                AND doctor_clinic.managed_by = home_clinic.managed_by
                             )
                           )
                    )
                )
           )
           AND EXISTS (
               SELECT 1
                 FROM public.staff_profiles d
                WHERE d.id = p_doctor
                  AND d.role = 'doctor'
                  AND d.is_active
           )
    )
$$;

COMMENT ON FUNCTION public.ent_is_my_doctor(uuid) IS
    'True for an active secretary on her primary doctor, an explicit secretary_assignments doctor, or (when is_super_secretary is true) any active doctor in her home clinic''s same non-NULL managed_by network. Never crosses admin owners.';

-- The clinic picker and all-doctors dashboard use the same permission
-- predicate as the data policies. It also picks up future doctors in the
-- network without requiring another assignment write.
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
       AND public.ent_is_my_doctor(d.id)
      LEFT JOIN public.clinics c ON c.id = d.clinic_id
     WHERE me.id = public.ent_auth_uid()
       AND me.role = 'secretary'
     ORDER BY is_primary DESC, d.full_name
$$;

COMMENT ON FUNCTION public.my_assigned_doctors() IS
    'Active doctors the signed-in secretary may work under, resolved by ent_is_my_doctor. For a Super Secretary this is every active doctor in the same admin-owned clinic network, including future doctors.';

-- A doctor should see the Super Secretary on the existing team card even
-- when the relationship is network-wide rather than a junction row.
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
          OR (
                s.is_super_secretary
            AND EXISTS (
                    SELECT 1
                      FROM public.clinics doctor_clinic
                      JOIN public.clinics home_clinic
                        ON home_clinic.id = s.clinic_id
                     WHERE doctor_clinic.id = me.clinic_id
                       AND (
                            doctor_clinic.id = home_clinic.id
                         OR (
                                home_clinic.managed_by IS NOT NULL
                            AND doctor_clinic.managed_by = home_clinic.managed_by
                         )
                       )
                )
          )
       )
     WHERE me.id = public.ent_auth_uid()
       AND me.role = 'doctor'
     ORDER BY s.full_name
$$;

COMMENT ON FUNCTION public.my_secretaries() IS
    'Secretaries assigned to the signed-in doctor directly, through secretary_assignments, or through Super Secretary access within the same admin-owned clinic network.';

-- CREATE OR REPLACE preserves the existing EXECUTE grants. The column has
-- no authenticated UPDATE grant; auth-admin (service_role) is its writer.
NOTIFY pgrst, 'reload schema';

ALTER TABLE public.staff_profiles
    ADD COLUMN IF NOT EXISTS admin_mfa_required boolean NOT NULL DEFAULT false;

ALTER TYPE public.ent_activity ADD VALUE IF NOT EXISTS 'ADMIN_MFA_ENABLED';

CREATE OR REPLACE FUNCTION public.ent_is_active_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.staff_profiles profile
         WHERE profile.id = public.ent_auth_uid()
           AND profile.role = 'admin'
           AND profile.is_active
           AND (
                NOT profile.admin_mfa_required
             OR auth.jwt() ->> 'aal' = 'aal2'
           )
    )
$$;

CREATE OR REPLACE FUNCTION public.ent_admin_set_active(
    p_user_id uuid,
    p_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me public.staff_profiles;
    target public.staff_profiles;
    has_other_admin boolean;
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: administrator role required'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO me
      FROM public.staff_profiles
     WHERE id = public.ent_auth_uid();
    SELECT * INTO target
      FROM public.staff_profiles
     WHERE id = p_user_id
     FOR UPDATE;

    IF target.id IS NULL THEN
        RAISE EXCEPTION 'unknown account';
    END IF;
    IF NOT public.ent_admin_covers_clinic(target.clinic_id) THEN
        RAISE EXCEPTION 'refused: that account belongs to another clinic'
            USING ERRCODE = '42501';
    END IF;
    IF target.id = me.id AND NOT p_active THEN
        RAISE EXCEPTION 'you cannot deactivate your own account';
    END IF;

    IF NOT p_active AND target.role = 'admin' AND target.is_active THEN
        PERFORM pg_advisory_xact_lock(hashtext('ent-last-active-admin'));
        SELECT EXISTS (
            SELECT 1
              FROM public.staff_profiles other_admin
             WHERE other_admin.role = 'admin'
               AND other_admin.is_active
               AND other_admin.id <> target.id
        ) INTO has_other_admin;
        IF NOT has_other_admin THEN
            RAISE EXCEPTION 'cannot deactivate the last active administrator';
        END IF;
    END IF;

    UPDATE public.staff_profiles
       SET is_active = p_active,
           admin_mfa_required = CASE
               WHEN target.role = 'admin' THEN true
               ELSE admin_mfa_required
           END
     WHERE id = target.id;

    INSERT INTO public.activity_logs
        (actor_id, actor_role, actor_label, clinic_id, action, detail,
         target_type, target_id)
    VALUES
        (me.id, me.role::text,
         coalesce(nullif(me.full_name, ''), me.username::text),
         me.clinic_id,
         (CASE WHEN p_active THEN 'USER_ACTIVATED'
               ELSE 'USER_DEACTIVATED' END)::ent_activity,
         CASE WHEN p_active THEN 'Activated ' ELSE 'Deactivated ' END || target.username,
         'staff', target.id::text);

    RETURN jsonb_build_object('id', target.id, 'is_active', p_active);
END;
$$;

CREATE OR REPLACE FUNCTION public.ent_guard_last_active_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF OLD.role = 'admin'
       AND OLD.is_active
       AND (NEW.role <> 'admin' OR NOT NEW.is_active) THEN
        PERFORM pg_advisory_xact_lock(hashtext('ent-last-active-admin'));
        IF NOT EXISTS (
            SELECT 1
              FROM public.staff_profiles other_admin
             WHERE other_admin.role = 'admin'
               AND other_admin.is_active
               AND other_admin.id <> OLD.id
        ) THEN
            RAISE EXCEPTION 'cannot demote or deactivate the last active administrator';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_last_active_admin ON public.staff_profiles;
CREATE TRIGGER trg_guard_last_active_admin
    BEFORE UPDATE OF role, is_active ON public.staff_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.ent_guard_last_active_admin();

REVOKE ALL ON FUNCTION public.ent_guard_last_active_admin() FROM anon, public;

CREATE OR REPLACE FUNCTION public.ent_admin_set_secretary_assignments(
    p_secretary_id uuid,
    p_doctor_ids uuid[]
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    secretary public.staff_profiles;
    doctor_id uuid;
    clean_ids uuid[];
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: administrator role required'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO secretary
      FROM public.staff_profiles profile
     WHERE profile.id = p_secretary_id
       AND profile.role = 'secretary'
        AND profile.is_active
     FOR UPDATE;

    IF secretary.id IS NULL THEN
        RAISE EXCEPTION 'unknown secretary account';
    END IF;
    IF NOT public.ent_admin_covers_clinic(secretary.clinic_id) THEN
        RAISE EXCEPTION 'refused: that secretary belongs to another clinic'
            USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(array_agg(requested.doctor_id ORDER BY requested.doctor_id), ARRAY[]::uuid[])
      INTO clean_ids
      FROM (
            SELECT DISTINCT input.doctor_id
              FROM unnest(coalesce(p_doctor_ids, ARRAY[]::uuid[])) AS input(doctor_id)
             WHERE input.doctor_id IS NOT NULL
      ) requested;

    IF secretary.id = ANY(clean_ids) THEN
        RAISE EXCEPTION 'a secretary cannot be assigned to herself'
            USING ERRCODE = '22023';
    END IF;

    FOREACH doctor_id IN ARRAY clean_ids LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM public.staff_profiles doctor
             WHERE doctor.id = doctor_id
               AND doctor.role = 'doctor'
               AND doctor.is_active
               AND public.ent_admin_covers_clinic(doctor.clinic_id)
        ) THEN
            RAISE EXCEPTION 'one of the doctors is inactive, invalid, or outside your clinics'
                USING ERRCODE = '42501';
        END IF;
    END LOOP;

    DELETE FROM public.secretary_assignments
     WHERE secretary_id = secretary.id;

    INSERT INTO public.secretary_assignments (secretary_id, doctor_id)
    SELECT secretary.id, doctor_id
      FROM unnest(clean_ids) AS assigned(doctor_id);

    RETURN clean_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.ent_admin_set_secretary_assignments(uuid, uuid[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_admin_set_secretary_assignments(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.ent_admin_set_secretary_assignments(uuid, uuid[]) IS
    'Atomically replaces a secretary''s additional doctors after checking live admin authority and clinic ownership.';

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
    doctor_scope text;
    picker_src   text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO doctor_scope
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_is_my_doctor(uuid)');
    SELECT pg_get_functiondef(oid) INTO picker_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.my_assigned_doctors()');

    IF doctor_scope IS NULL
       OR doctor_scope NOT ILIKE '%is_super_secretary%'
       OR doctor_scope NOT ILIKE '%managed_by%'
       OR doctor_scope NOT ILIKE '%me.role = ''secretary''%' THEN
        RAISE EXCEPTION '0050 guard failed: Super Secretary access is missing its role or admin-network scope.';
    END IF;
    IF picker_src IS NULL
       OR picker_src NOT ILIKE '%ent_is_my_doctor(d.id)%' THEN
        RAISE EXCEPTION '0050 guard failed: the picker is not using the authoritative doctor-scope predicate.';
    END IF;
END
$$;


-- =====================================================================
--  0051 · SUPER SECRETARY - one active clinic at a time
-- ---------------------------------------------------------------------
--  The clinic picker is a view context, not a transfer. Bind the selected
--  clinic to the authenticated Supabase session and enforce it at every
--  report read/write boundary. The picker directory remains network-wide
--  so the secretary can still switch clinics.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.ent_super_secretary_active_clinics (
    user_id    uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    session_id text        NOT NULL,
    clinic_id  uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, session_id)
);

ALTER TABLE public.ent_super_secretary_active_clinics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ent_super_secretary_active_clinics FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ent_is_active_super_secretary()
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
           AND me.role = 'secretary'
           AND me.is_super_secretary
    )
$$;

CREATE OR REPLACE FUNCTION public.ent_super_secretary_network_doctor(p_doctor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.staff_profiles me
          JOIN public.clinics home_clinic ON home_clinic.id = me.clinic_id
          JOIN public.staff_profiles d
            ON d.id = p_doctor
           AND d.role = 'doctor'
           AND d.is_active
          JOIN public.clinics doctor_clinic
            ON doctor_clinic.id = d.clinic_id
         WHERE me.id = public.ent_auth_uid()
           AND me.is_active
           AND me.role = 'secretary'
           AND me.is_super_secretary
           AND home_clinic.is_active
           AND doctor_clinic.is_active
           AND (
                doctor_clinic.id = home_clinic.id
             OR (
                    home_clinic.managed_by IS NOT NULL
                AND doctor_clinic.managed_by = home_clinic.managed_by
             )
           )
    )
$$;

CREATE OR REPLACE FUNCTION public.ent_active_super_secretary_clinic_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT active.clinic_id
      FROM public.ent_super_secretary_active_clinics active
      JOIN public.staff_profiles me
        ON me.id = active.user_id
       AND me.id = public.ent_auth_uid()
       AND me.is_active
       AND me.role = 'secretary'
       AND me.is_super_secretary
      JOIN public.clinics home_clinic
        ON home_clinic.id = me.clinic_id
       AND home_clinic.is_active
      JOIN public.clinics active_clinic
        ON active_clinic.id = active.clinic_id
       AND active_clinic.is_active
     WHERE active.session_id = auth.jwt() ->> 'session_id'
       AND (
            active_clinic.id = home_clinic.id
         OR (
                home_clinic.managed_by IS NOT NULL
            AND active_clinic.managed_by = home_clinic.managed_by
         )
       )
       AND EXISTS (
            SELECT 1
              FROM public.staff_profiles d
             WHERE d.clinic_id = active.clinic_id
               AND d.role = 'doctor'
               AND d.is_active
       )
     LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.ent_super_secretary_context_matches(p_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE
        WHEN public.ent_is_active_super_secretary()
            THEN p_clinic IS NOT NULL
             AND p_clinic = public.ent_active_super_secretary_clinic_id()
        ELSE true
    END
$$;

CREATE OR REPLACE FUNCTION public.ent_set_active_clinic(p_doctor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_clinic uuid;
    session_key   text;
BEGIN
    session_key := nullif(auth.jwt() ->> 'session_id', '');
    IF session_key IS NULL THEN
        RAISE EXCEPTION 'refused: this session has no authenticated session id'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.ent_is_active_super_secretary() THEN
        RAISE EXCEPTION 'refused: only an active Super Secretary may change clinic context'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.ent_super_secretary_network_doctor(p_doctor) THEN
        RAISE EXCEPTION 'refused: the selected doctor is outside your managed clinic network'
            USING ERRCODE = '42501';
    END IF;

    SELECT d.clinic_id
      INTO target_clinic
      FROM public.staff_profiles d
     WHERE d.id = p_doctor;

    PERFORM pg_advisory_xact_lock(hashtext(public.ent_auth_uid()::text), hashtext(session_key));
    INSERT INTO public.ent_super_secretary_active_clinics (user_id, session_id, clinic_id, updated_at)
    VALUES (public.ent_auth_uid(), session_key, target_clinic, now())
    ON CONFLICT (user_id, session_id)
    DO UPDATE SET clinic_id = EXCLUDED.clinic_id,
                  updated_at = EXCLUDED.updated_at;

    RETURN target_clinic;
END
$$;

CREATE OR REPLACE FUNCTION public.ent_ensure_active_clinic(p_doctor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_clinic uuid;
    session_key text;
BEGIN
    session_key := nullif(auth.jwt() ->> 'session_id', '');
    IF session_key IS NULL OR NOT public.ent_is_active_super_secretary() THEN
        RAISE EXCEPTION 'refused: an active authenticated Super Secretary session is required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.ent_super_secretary_network_doctor(p_doctor) THEN
        RAISE EXCEPTION 'refused: the selected doctor is outside your managed clinic network'
            USING ERRCODE = '42501';
    END IF;

    SELECT d.clinic_id
      INTO target_clinic
      FROM public.staff_profiles d
     WHERE d.id = p_doctor;

    PERFORM pg_advisory_xact_lock(hashtext(public.ent_auth_uid()::text), hashtext(session_key));
    IF public.ent_active_super_secretary_clinic_id() IS NULL THEN
        INSERT INTO public.ent_super_secretary_active_clinics (user_id, session_id, clinic_id, updated_at)
        VALUES (public.ent_auth_uid(), session_key, target_clinic, now())
        ON CONFLICT (user_id, session_id)
        DO UPDATE SET clinic_id = EXCLUDED.clinic_id,
                      updated_at = EXCLUDED.updated_at;
    END IF;

    RETURN public.ent_active_super_secretary_clinic_id();
END
$$;

COMMENT ON TABLE public.ent_super_secretary_active_clinics IS
    'Server-owned active-clinic context keyed by authenticated user and Supabase session. Clients can change it only through ent_set_active_clinic().';
COMMENT ON FUNCTION public.ent_super_secretary_context_matches(uuid) IS
    'For an active Super Secretary, true only when the row belongs to the validated active clinic for this Supabase session; unchanged for other roles.';
COMMENT ON FUNCTION public.ent_set_active_clinic(uuid) IS
    'Validates a selected doctor against the caller''s managed network and stores that doctor''s clinic as this session''s active context.';
COMMENT ON FUNCTION public.ent_ensure_active_clinic(uuid) IS
    'Initializes a missing or invalid session context without overriding a valid clinic already selected in another tab.';

-- This predicate is the sole secretary read/write scope. A Super Secretary
-- must be assigned to the active clinic; ordinary secretaries retain their
-- primary and explicit junction assignments.
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
          JOIN public.staff_profiles d
            ON d.id = p_doctor
           AND d.role = 'doctor'
           AND d.is_active
         WHERE me.id = public.ent_auth_uid()
           AND me.is_active
           AND me.role = 'secretary'
           AND p_doctor IS NOT NULL
           AND (
                (
                    me.is_super_secretary
                AND d.clinic_id = public.ent_active_super_secretary_clinic_id()
                AND public.ent_super_secretary_network_doctor(d.id)
                )
             OR (
                    NOT me.is_super_secretary
                AND (
                       me.assigned_doctor_id = p_doctor
                    OR EXISTS (
                           SELECT 1
                             FROM public.secretary_assignments sa
                            WHERE sa.secretary_id = me.id
                              AND sa.doctor_id = p_doctor
                       )
                )
                )
           )
    )
$$;

-- Keep the switcher network-wide even though record access is now clinic-wide
-- and active-clinic-only.
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
            (
                me.is_super_secretary
            AND public.ent_super_secretary_network_doctor(d.id)
            )
         OR (
                NOT me.is_super_secretary
            AND public.ent_is_my_doctor(d.id)
            )
       )
      LEFT JOIN public.clinics c ON c.id = d.clinic_id
     WHERE me.id = public.ent_auth_uid()
       AND me.is_active
       AND me.role = 'secretary'
     ORDER BY is_primary DESC, d.full_name
$$;

COMMENT ON FUNCTION public.ent_is_my_doctor(uuid) IS
    'True for an active secretary''s primary/junction doctors, or for a Super Secretary''s active clinic doctors within her managed network. A Super Secretary cannot read another network clinic until switching context.';
COMMENT ON FUNCTION public.my_assigned_doctors() IS
    'Returns all doctors the secretary may choose from. For a Super Secretary this remains the full managed network, but report data is restricted to the active clinic.';

REVOKE ALL ON FUNCTION public.ent_is_active_super_secretary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ent_super_secretary_network_doctor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ent_active_super_secretary_clinic_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ent_super_secretary_context_matches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ent_super_secretary_context_matches(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.ent_set_active_clinic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ent_set_active_clinic(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.ent_ensure_active_clinic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ent_ensure_active_clinic(uuid) TO authenticated;

-- Protect every direct report/photo path, including author/grant/home-clinic
-- policy arms that would otherwise bypass the selected clinic.
DROP POLICY IF EXISTS reports_select_owner ON public.reports;
CREATE POLICY reports_select_owner ON public.reports
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
    AND public.ent_super_secretary_context_matches(clinic_id)
    AND (
            public.ent_may_read_own_clinic(clinic_id, doctor_id)
         OR public.ent_has_report_grant(id)
         OR created_by = public.ent_auth_uid()
         OR public.ent_is_my_doctor(doctor_id)
        )
    );

DROP POLICY IF EXISTS reports_insert_owner ON public.reports;
CREATE POLICY reports_insert_owner ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_super_secretary_context_matches(clinic_id)
    AND deleted_at IS NULL
    AND created_by = public.ent_auth_uid()
    AND (
            public.ent_may_edit_report(clinic_id, doctor_id)
         OR public.ent_is_my_doctor(doctor_id)
        )
    );

DROP POLICY IF EXISTS reports_update_owner ON public.reports;
CREATE POLICY reports_update_owner ON public.reports
    FOR UPDATE TO authenticated
    USING (
        public.ent_super_secretary_context_matches(clinic_id)
    AND (
            (deleted_at IS NULL
             AND public.ent_may_edit_report(clinic_id, doctor_id, id))
         OR (deleted_at IS NULL
             AND public.ent_is_my_doctor(doctor_id))
         OR (deleted_at IS NOT NULL
             AND public.ent_is_active_admin()
             AND clinic_id = public.ent_claim_clinic_id())
        )
    )
    WITH CHECK (
        public.ent_super_secretary_context_matches(clinic_id)
    AND (
            (deleted_at IS NULL
             AND public.ent_may_edit_report(clinic_id, doctor_id, id))
         OR (deleted_at IS NULL
             AND public.ent_is_my_doctor(doctor_id))
         OR (deleted_at IS NOT NULL
             AND public.ent_is_active_admin()
             AND clinic_id = public.ent_claim_clinic_id())
        )
    );

DROP POLICY IF EXISTS photos_select_owner ON public.report_photos;
CREATE POLICY photos_select_owner ON public.report_photos
    FOR SELECT TO authenticated
    USING (
        public.ent_super_secretary_context_matches(clinic_id)
    AND EXISTS (
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

DROP POLICY IF EXISTS photos_insert_owner ON public.report_photos;
CREATE POLICY photos_insert_owner ON public.report_photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_super_secretary_context_matches(clinic_id)
    AND (
            public.ent_may_edit_report(clinic_id, doctor_id, report_id)
         OR public.ent_is_my_doctor(doctor_id)
        )
    AND uploaded_by = public.ent_auth_uid()
    );

DROP POLICY IF EXISTS photos_update_owner ON public.report_photos;
CREATE POLICY photos_update_owner ON public.report_photos
    FOR UPDATE TO authenticated
    USING (
        public.ent_super_secretary_context_matches(clinic_id)
    AND (
            public.ent_may_edit_report(clinic_id, doctor_id, report_id)
         OR public.ent_is_my_doctor(doctor_id)
        )
    )
    WITH CHECK (
        public.ent_super_secretary_context_matches(clinic_id)
    AND (
            public.ent_may_edit_report(clinic_id, doctor_id, report_id)
         OR public.ent_is_my_doctor(doctor_id)
        )
    );

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

    IF NOT public.ent_super_secretary_context_matches(r.clinic_id)
       OR NOT (
            public.ent_may_edit_report(r.clinic_id, r.doctor_id, r.id)
         OR public.ent_is_my_doctor(r.doctor_id)
       ) THEN
        RAISE EXCEPTION 'refused: you may not attach a photo to that report'
            USING ERRCODE = '42501';
    END IF;

    NEW.clinic_id := r.clinic_id;
    NEW.doctor_id := r.doctor_id;
    RETURN NEW;
END
$$;

-- SECURITY DEFINER readers must apply the same clinic context themselves.
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
           AND public.ent_super_secretary_context_matches(r.clinic_id)
           AND (
                public.ent_may_read_own_clinic(r.clinic_id, r.doctor_id)
             OR public.ent_has_report_grant(p_report)
             OR public.ent_is_my_doctor(r.doctor_id)
           )
    )
$$;

COMMENT ON FUNCTION public.ent_may_open_report(uuid) IS
    'Authoritative full-record gate: own clinic, live grant, or assigned doctor, with the active-clinic guard applied to Super Secretaries.';

CREATE OR REPLACE FUNCTION public.ent_view_all_index(
    p_search text DEFAULT NULL,
    p_limit integer DEFAULT 100,
    p_offset integer DEFAULT 0
)
RETURNS TABLE (
    report_id uuid,
    clinic_id uuid,
    clinic_name text,
    doctor_name text,
    patient_name text,
    case_number text,
    report_type text,
    procedure_date date,
    created_at timestamptz,
    can_view boolean,
    can_edit boolean,
    can_delete boolean
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
    SELECT r.id,
           r.clinic_id,
           coalesce(nullif(btrim(c.name), ''), c.code),
           coalesce(nullif(btrim(sp.full_name), ''), btrim(sp.username::text), 'Unknown'),
           r.patient_name,
           r.case_number,
           r.report_type::text,
           r.procedure_date,
           r.created_at,
           public.ent_may_open_report(r.id),
           public.ent_may_edit_report(r.clinic_id, r.doctor_id, r.id),
           (me.role = 'admin' AND me.clinic_id = r.clinic_id)
      FROM public.reports r
      JOIN me ON true
      LEFT JOIN public.clinics c ON c.id = r.clinic_id
      LEFT JOIN public.staff_profiles sp ON sp.id = r.doctor_id
     WHERE r.is_draft = false
       AND public.ent_super_secretary_context_matches(r.clinic_id)
       AND (
              p_search IS NULL
           OR btrim(p_search) = ''
           OR r.patient_name ILIKE '%' || p_search || '%'
           OR r.case_number ILIKE '%' || p_search || '%'
           OR coalesce(nullif(btrim(c.name), ''), c.code, '') ILIKE '%' || p_search || '%'
       )
     ORDER BY r.created_at DESC
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
    OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

COMMENT ON FUNCTION public.ent_view_all_index(text, integer, integer) IS
    'Final-record metadata index. Super Secretaries receive rows from their active clinic only; other roles retain the existing visibility rules.';

-- Access-request lists are also SECURITY DEFINER and contain patient names.
CREATE OR REPLACE FUNCTION public.ent_view_my_access_requests()
RETURNS TABLE (
    request_id uuid,
    report_id uuid,
    patient_name text,
    case_number text,
    report_type text,
    procedure_date date,
    reason text,
    requested_at timestamptz,
    status text,
    handled_at timestamptz,
    handled_by_name text,
    deny_reason text,
    can_view boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT q.id,
           q.report_id,
           r.patient_name,
           r.case_number,
           r.report_type::text,
           r.procedure_date,
           q.reason,
           q.created_at,
           q.status,
           q.handled_at,
           nullif(q.handled_by_name, ''),
           q.deny_reason,
           public.ent_may_open_report(q.report_id)
      FROM public.report_access_requests q
      JOIN public.reports r ON r.id = q.report_id
      JOIN public.staff_profiles me
        ON me.id = public.ent_auth_uid()
       AND me.is_active
     WHERE q.requester_id = me.id
       AND public.ent_super_secretary_context_matches(r.clinic_id)
     ORDER BY q.created_at DESC
     LIMIT 200
$$;

REVOKE ALL ON FUNCTION public.ent_may_open_report(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_may_open_report(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.ent_view_all_index(text, integer, integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_view_all_index(text, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.ent_view_my_access_requests() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_view_my_access_requests() TO authenticated;

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
    fn_src text;
    policy_src text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_is_my_doctor(uuid)');
    IF fn_src IS NULL
       OR fn_src NOT ILIKE '%ent_active_super_secretary_clinic_id%'
       OR fn_src NOT ILIKE '%ent_super_secretary_network_doctor%' THEN
        RAISE EXCEPTION '0051 guard failed: Super Secretary doctor scope is not active-clinic-bound.';
    END IF;

    SELECT qual INTO policy_src
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'reports'
       AND policyname = 'reports_select_owner';
    IF policy_src IS NULL
       OR policy_src NOT ILIKE '%ent_super_secretary_context_matches%'
       OR policy_src NOT ILIKE '%ent_is_my_doctor%' THEN
        RAISE EXCEPTION '0051 guard failed: report reads are not restricted to the active clinic.';
    END IF;

    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_view_all_index(text,integer,integer)');
    IF fn_src IS NULL
       OR fn_src NOT ILIKE '%ent_super_secretary_context_matches%' THEN
        RAISE EXCEPTION '0051 guard failed: View All bypasses the active clinic context.';
    END IF;

    RAISE NOTICE '0051 OK: Super Secretary records and patient metadata are restricted to the active managed clinic.';
END
$$;

-- =====================================================================
-- 0050 · Per-recipient staff chat delivery and read receipts
-- ---------------------------------------------------------------------
-- A conversation's last_read_at is useful for unread counts, but cannot
-- tell the sender which individual messages were delivered or seen.
-- This section is safe to re-run when updating an existing 0050 install.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.staff_chat_message_receipts (
    message_id   uuid NOT NULL REFERENCES public.staff_chat_messages(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    delivered_at timestamptz,
    read_at      timestamptz,
    PRIMARY KEY (message_id, user_id),
    CHECK (read_at IS NULL OR delivered_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_staff_chat_message_receipts_user_pending
    ON public.staff_chat_message_receipts (user_id, message_id)
    WHERE delivered_at IS NULL OR read_at IS NULL;

ALTER TABLE public.staff_chat_message_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_chat_message_receipts FROM anon, public, authenticated;
GRANT ALL ON public.staff_chat_message_receipts TO service_role;

INSERT INTO public.staff_chat_message_receipts (message_id, user_id, delivered_at, read_at)
SELECT message.id,
       member.user_id,
       CASE WHEN message.created_at <= member.last_read_at THEN member.last_read_at END,
       CASE WHEN message.created_at <= member.last_read_at THEN member.last_read_at END
  FROM public.staff_chat_messages message
  JOIN public.staff_conversation_members member
    ON member.conversation_id = message.conversation_id
   AND member.user_id <> message.sender_id
   AND member.joined_at <= message.created_at
ON CONFLICT (message_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ent_create_staff_chat_message_receipts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.staff_chat_message_receipts (message_id, user_id)
    SELECT NEW.id, member.user_id
      FROM public.staff_conversation_members member
      JOIN public.staff_profiles profile
        ON profile.id = member.user_id AND profile.is_active
     WHERE member.conversation_id = NEW.conversation_id
       AND member.user_id <> NEW.sender_id
    ON CONFLICT (message_id, user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_staff_chat_message_receipts
    ON public.staff_chat_messages;
CREATE TRIGGER trg_create_staff_chat_message_receipts
    AFTER INSERT ON public.staff_chat_messages
    FOR EACH ROW EXECUTE FUNCTION public.ent_create_staff_chat_message_receipts();

CREATE OR REPLACE FUNCTION public.ent_mark_chats_delivered()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user uuid := public.ent_auth_uid();
    v_count integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_profiles profile
         WHERE profile.id = v_user AND profile.is_active
    ) THEN
        RAISE EXCEPTION 'refused: active staff account required'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.staff_chat_message_receipts receipt
       SET delivered_at = now()
      FROM public.staff_chat_messages message
     WHERE message.id = receipt.message_id
       AND receipt.user_id = v_user
       AND receipt.delivered_at IS NULL
       AND message.sender_id IS DISTINCT FROM v_user
       AND EXISTS (
           SELECT 1 FROM public.staff_conversation_members member
            WHERE member.conversation_id = message.conversation_id
              AND member.user_id = v_user
       );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.ent_my_chat_message_receipts(p_conversation_id uuid)
RETURNS TABLE (
    message_id uuid,
    delivered_count bigint,
    read_count bigint,
    recipient_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM public.staff_conversation_members member
          JOIN public.staff_profiles profile
            ON profile.id = member.user_id AND profile.is_active
         WHERE member.conversation_id = p_conversation_id
           AND member.user_id = public.ent_auth_uid()
    ) THEN
        RAISE EXCEPTION 'refused: conversation is unavailable'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT message.id,
           count(receipt.user_id) FILTER (WHERE receipt.delivered_at IS NOT NULL),
           count(receipt.user_id) FILTER (WHERE receipt.read_at IS NOT NULL),
           count(receipt.user_id)
      FROM public.staff_chat_messages message
      LEFT JOIN public.staff_chat_message_receipts receipt
        ON receipt.message_id = message.id
     WHERE message.conversation_id = p_conversation_id
       AND message.sender_id = public.ent_auth_uid()
     GROUP BY message.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ent_mark_chat_read(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user uuid := public.ent_auth_uid();
    v_now timestamptz := now();
BEGIN
    UPDATE public.staff_conversation_members
       SET last_read_at = v_now
     WHERE conversation_id = p_conversation_id
       AND user_id = v_user
       AND EXISTS (
           SELECT 1 FROM public.staff_profiles profile
            WHERE profile.id = v_user AND profile.is_active
       );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'refused: conversation is unavailable'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.staff_chat_message_receipts receipt
       SET delivered_at = coalesce(receipt.delivered_at, v_now),
           read_at = coalesce(receipt.read_at, v_now)
      FROM public.staff_chat_messages message
     WHERE message.id = receipt.message_id
       AND message.conversation_id = p_conversation_id
       AND message.sender_id IS DISTINCT FROM v_user
       AND receipt.user_id = v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.ent_create_staff_chat_message_receipts() FROM anon, public, authenticated;
GRANT EXECUTE ON FUNCTION public.ent_create_staff_chat_message_receipts() TO service_role;
REVOKE ALL ON FUNCTION public.ent_mark_chats_delivered() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_mark_chats_delivered() TO authenticated;
REVOKE ALL ON FUNCTION public.ent_my_chat_message_receipts(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_my_chat_message_receipts(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.ent_mark_chat_read(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_mark_chat_read(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- 0050 - SUPER SECRETARY explicit doctor assignments
-- ---------------------------------------------------------------------
-- Keep the active-clinic context above, but limit the secretary to her
-- primary doctor and the doctors selected by an admin. Existing network
-- access is backfilled once so it is not unexpectedly removed.
-- =====================================================================

INSERT INTO public.secretary_assignments (secretary_id, doctor_id)
SELECT secretary.id, doctor.id
  FROM public.staff_profiles secretary
  JOIN public.clinics home_clinic ON home_clinic.id = secretary.clinic_id
  JOIN public.staff_profiles doctor
    ON doctor.role = 'doctor'
   AND doctor.is_active
  JOIN public.clinics doctor_clinic ON doctor_clinic.id = doctor.clinic_id
 WHERE secretary.role = 'secretary'
   AND secretary.is_super_secretary
   AND home_clinic.is_active
   AND doctor_clinic.is_active
   AND (
        doctor_clinic.id = home_clinic.id
     OR (
            home_clinic.managed_by IS NOT NULL
        AND doctor_clinic.managed_by = home_clinic.managed_by
     )
   )
ON CONFLICT (secretary_id, doctor_id) DO NOTHING;

-- Retain the function name for the existing clinic-switching RPCs, but
-- make it mean "an explicitly assigned doctor", never "any network doctor".
CREATE OR REPLACE FUNCTION public.ent_super_secretary_network_doctor(p_doctor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.staff_profiles me
          JOIN public.clinics home_clinic
            ON home_clinic.id = me.clinic_id
           AND home_clinic.is_active
          JOIN public.staff_profiles doctor
            ON doctor.id = p_doctor
           AND doctor.role = 'doctor'
           AND doctor.is_active
          JOIN public.clinics doctor_clinic
            ON doctor_clinic.id = doctor.clinic_id
           AND doctor_clinic.is_active
         WHERE me.id = public.ent_auth_uid()
           AND me.is_active
           AND me.role = 'secretary'
           AND me.is_super_secretary
           AND p_doctor IS NOT NULL
           AND (
                me.assigned_doctor_id = doctor.id
             OR EXISTS (
                    SELECT 1
                      FROM public.secretary_assignments assignment
                     WHERE assignment.secretary_id = me.id
                       AND assignment.doctor_id = doctor.id
                )
           )
    )
$$;

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
          JOIN public.staff_profiles doctor
            ON doctor.id = p_doctor
           AND doctor.role = 'doctor'
           AND doctor.is_active
         WHERE me.id = public.ent_auth_uid()
           AND me.is_active
           AND me.role = 'secretary'
           AND p_doctor IS NOT NULL
           AND (
                me.assigned_doctor_id = doctor.id
             OR EXISTS (
                    SELECT 1
                      FROM public.secretary_assignments assignment
                     WHERE assignment.secretary_id = me.id
                       AND assignment.doctor_id = doctor.id
                )
           )
           AND (
                NOT me.is_super_secretary
             OR (
                    doctor.clinic_id = public.ent_active_super_secretary_clinic_id()
                AND public.ent_super_secretary_network_doctor(doctor.id)
                )
           )
    )
$$;

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
    SELECT DISTINCT secretary.id,
           secretary.username::text,
           secretary.full_name,
           secretary.role,
           secretary.assigned_doctor_id,
           secretary.is_active
      FROM public.staff_profiles doctor
      JOIN public.staff_profiles secretary
        ON secretary.role = 'secretary'
       AND (
            secretary.assigned_doctor_id = doctor.id
         OR EXISTS (
                SELECT 1
                  FROM public.secretary_assignments assignment
                 WHERE assignment.secretary_id = secretary.id
                   AND assignment.doctor_id = doctor.id
            )
       )
     WHERE doctor.id = public.ent_auth_uid()
       AND doctor.role = 'doctor'
     ORDER BY secretary.full_name
$$;

COMMENT ON FUNCTION public.ent_is_my_doctor(uuid) IS
    'An active secretary may work only under her primary doctor or an explicit secretary_assignments row. Super Secretaries keep the active-clinic boundary and may switch only among those assigned doctors.';
COMMENT ON FUNCTION public.ent_super_secretary_network_doctor(uuid) IS
    'Compatibility helper for Super Secretary clinic switching; validates only the primary or explicitly assigned active doctors.';
COMMENT ON FUNCTION public.my_assigned_doctors() IS
    'Active primary and explicitly assigned doctors only. Super Secretaries may switch clinics only among this selected set.';
COMMENT ON FUNCTION public.my_secretaries() IS
    'Secretaries assigned directly or through secretary_assignments; Super Secretary status no longer implies access to every doctor in a managed network.';

-- The clinic-wide metadata index must not reveal other doctors' patient
-- details to a Super Secretary who has not been assigned to those doctors.
CREATE OR REPLACE FUNCTION public.ent_view_all_index(
    p_search text DEFAULT NULL,
    p_limit integer DEFAULT 100,
    p_offset integer DEFAULT 0
)
RETURNS TABLE (
    report_id uuid,
    clinic_id uuid,
    clinic_name text,
    doctor_name text,
    patient_name text,
    case_number text,
    report_type text,
    procedure_date date,
    created_at timestamptz,
    can_view boolean,
    can_edit boolean,
    can_delete boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH me AS (
        SELECT profile.id, profile.clinic_id, profile.role
          FROM public.staff_profiles profile
         WHERE profile.id = public.ent_auth_uid()
           AND profile.is_active
    )
    SELECT report.id,
           report.clinic_id,
           coalesce(nullif(btrim(clinic.name), ''), clinic.code),
           coalesce(nullif(btrim(doctor.full_name), ''), btrim(doctor.username::text), 'Unknown'),
           report.patient_name,
           report.case_number,
           report.report_type::text,
           report.procedure_date,
           report.created_at,
           public.ent_may_open_report(report.id),
           public.ent_may_edit_report(report.clinic_id, report.doctor_id, report.id),
           (me.role = 'admin' AND me.clinic_id = report.clinic_id)
      FROM public.reports report
      JOIN me ON true
      LEFT JOIN public.clinics clinic ON clinic.id = report.clinic_id
      LEFT JOIN public.staff_profiles doctor ON doctor.id = report.doctor_id
     WHERE report.is_draft = false
       AND public.ent_super_secretary_context_matches(report.clinic_id)
       AND (
            NOT public.ent_is_active_super_secretary()
         OR public.ent_is_my_doctor(report.doctor_id)
       )
       AND (
              p_search IS NULL
           OR btrim(p_search) = ''
           OR report.patient_name ILIKE '%' || p_search || '%'
           OR report.case_number ILIKE '%' || p_search || '%'
           OR coalesce(nullif(btrim(clinic.name), ''), clinic.code, '') ILIKE '%' || p_search || '%'
       )
     ORDER BY report.created_at DESC
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
    OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

COMMENT ON FUNCTION public.ent_view_all_index(text, integer, integer) IS
    'Final-record metadata index. Super Secretaries receive rows only for explicitly assigned doctors in the active clinic; other roles retain the existing visibility rules.';

REVOKE ALL ON FUNCTION public.ent_view_all_index(text, integer, integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_view_all_index(text, integer, integer) TO authenticated;

-- Keep completion alerts consistent with the selected doctor list.
CREATE OR REPLACE FUNCTION public.ent_notify_doctor_work_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    actor public.staff_profiles;
BEGIN
    IF NEW.is_draft
       OR NEW.doctor_id IS DISTINCT FROM public.ent_auth_uid()
       OR public.ent_doctor_work_percent(NEW.report_type, NEW.payload) <> 100 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NOT OLD.is_draft
       AND OLD.report_type = NEW.report_type
       AND public.ent_doctor_work_percent(OLD.report_type, OLD.payload) = 100 THEN
        RETURN NEW;
    END IF;

    SELECT * INTO actor
      FROM public.staff_profiles
     WHERE id = public.ent_auth_uid()
       AND is_active
       AND role = 'doctor';

    IF actor.id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.app_notifications
        (recipient_id, kind, title, body, target_url, source_id)
    SELECT secretary.id,
           'doctor_work_complete',
           'Doctor work completed',
           coalesce(nullif(btrim(actor.full_name), ''), actor.username::text, 'Your doctor')
               || ' completed the doctor work for a '
               || CASE NEW.report_type
                      WHEN 'cf4' THEN 'CF4'
                      WHEN 'nasal' THEN 'Nasal'
                      WHEN 'laryngeal' THEN 'Laryngeal'
                  END
               || ' report (100%). Open DB Records to review.',
           'pages/viewAll.html',
           NEW.id
      FROM public.staff_profiles secretary
     WHERE secretary.role = 'secretary'
       AND secretary.is_active
       AND (
            secretary.assigned_doctor_id = actor.id
         OR EXISTS (
                SELECT 1
                  FROM public.secretary_assignments assignment
                 WHERE assignment.secretary_id = secretary.id
                   AND assignment.doctor_id = actor.id
            )
       )
    ON CONFLICT (recipient_id, source_id)
        WHERE kind = 'doctor_work_complete'
        DO NOTHING;

    RETURN NEW;
END;
$$;

DO $$
DECLARE
    doctor_scope text;
    switch_scope text;
    index_scope text;
BEGIN
    SELECT pg_get_functiondef(oid) INTO doctor_scope
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_is_my_doctor(uuid)');
    SELECT pg_get_functiondef(oid) INTO switch_scope
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_super_secretary_network_doctor(uuid)');
    SELECT pg_get_functiondef(oid) INTO index_scope
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_view_all_index(text,integer,integer)');

    IF doctor_scope IS NULL
       OR doctor_scope NOT ILIKE '%secretary_assignments%'
       OR doctor_scope NOT ILIKE '%ent_active_super_secretary_clinic_id%'
       OR doctor_scope ILIKE '%managed_by%' THEN
        RAISE EXCEPTION '0050 guard failed: doctor access is not limited to explicit assignments and active clinic.';
    END IF;
    IF switch_scope IS NULL
       OR switch_scope NOT ILIKE '%secretary_assignments%'
       OR switch_scope ILIKE '%managed_by%' THEN
        RAISE EXCEPTION '0050 guard failed: clinic switching still includes unassigned network doctors.';
    END IF;
    IF index_scope IS NULL
       OR index_scope NOT ILIKE '%ent_is_my_doctor%'
       OR index_scope NOT ILIKE '%ent_is_active_super_secretary%' THEN
        RAISE EXCEPTION '0050 guard failed: View All metadata is not filtered to assigned Super Secretary doctors.';
    END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
