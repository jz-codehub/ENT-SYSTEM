CREATE TABLE IF NOT EXISTS public.ent_admin_active_clinics (
    user_id    uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    session_id text        NOT NULL,
    clinic_id  uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
    doctor_id  uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, session_id)
);

ALTER TABLE public.ent_admin_active_clinics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ent_admin_active_clinics FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ent_admin_active_clinic_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT active.clinic_id
      FROM public.ent_admin_active_clinics active
      JOIN public.staff_profiles me
        ON me.id = active.user_id
       AND me.id = public.ent_auth_uid()
       AND me.is_active
       AND me.role = 'admin'
      JOIN public.clinics clinic
        ON clinic.id = active.clinic_id
       AND clinic.is_active
      JOIN public.staff_profiles doctor
        ON doctor.id = active.doctor_id
       AND doctor.clinic_id = active.clinic_id
       AND doctor.role = 'doctor'
       AND doctor.is_active
     WHERE active.session_id = auth.jwt() ->> 'session_id'
       AND public.ent_admin_covers_clinic(active.clinic_id)
     LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.ent_admin_active_doctor_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT active.doctor_id
      FROM public.ent_admin_active_clinics active
     WHERE active.session_id = auth.jwt() ->> 'session_id'
       AND active.user_id = public.ent_auth_uid()
       AND active.clinic_id = public.ent_admin_active_clinic_id()
     LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.ent_admin_available_doctors()
RETURNS TABLE (
    doctor_id uuid,
    doctor_name text,
    clinic_id uuid,
    clinic_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT doctor.id, doctor.full_name, clinic.id, clinic.name
      FROM public.staff_profiles me
      JOIN public.staff_profiles doctor
        ON doctor.role = 'doctor'
       AND doctor.is_active
      JOIN public.clinics clinic
        ON clinic.id = doctor.clinic_id
       AND clinic.is_active
     WHERE me.id = public.ent_auth_uid()
       AND me.role = 'admin'
       AND me.is_active
       AND public.ent_admin_covers_clinic(clinic.id)
     ORDER BY clinic.name, doctor.full_name, doctor.id
$$;

CREATE OR REPLACE FUNCTION public.ent_set_admin_active_clinic(p_doctor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    session_key text;
    target_clinic uuid;
BEGIN
    session_key := nullif(auth.jwt() ->> 'session_id', '');
    IF session_key IS NULL THEN
        RAISE EXCEPTION 'refused: this session has no authenticated session id'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: an active administrator is required'
            USING ERRCODE = '42501';
    END IF;

    SELECT doctor.clinic_id
      INTO target_clinic
      FROM public.staff_profiles doctor
      JOIN public.clinics clinic
        ON clinic.id = doctor.clinic_id
       AND clinic.is_active
     WHERE doctor.id = p_doctor
       AND doctor.role = 'doctor'
       AND doctor.is_active
       AND public.ent_admin_covers_clinic(doctor.clinic_id);

    IF target_clinic IS NULL THEN
        RAISE EXCEPTION 'refused: the selected doctor is outside your active clinics'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(public.ent_auth_uid()::text), hashtext(session_key));
    INSERT INTO public.ent_admin_active_clinics (user_id, session_id, clinic_id, doctor_id, updated_at)
    VALUES (public.ent_auth_uid(), session_key, target_clinic, p_doctor, now())
    ON CONFLICT (user_id, session_id)
    DO UPDATE SET clinic_id = EXCLUDED.clinic_id,
                  doctor_id = EXCLUDED.doctor_id,
                  updated_at = EXCLUDED.updated_at;

    RETURN target_clinic;
END
$$;

CREATE OR REPLACE FUNCTION public.ent_ensure_admin_active_clinic(p_doctor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    session_key text;
    active_clinic uuid;
BEGIN
    session_key := nullif(auth.jwt() ->> 'session_id', '');
    IF session_key IS NULL OR NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: an active authenticated administrator session is required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.staff_profiles doctor
         WHERE doctor.id = p_doctor
           AND doctor.role = 'doctor'
           AND doctor.is_active
           AND public.ent_admin_covers_clinic(doctor.clinic_id)
    ) THEN
        RAISE EXCEPTION 'refused: the selected doctor is outside your active clinics'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(public.ent_auth_uid()::text), hashtext(session_key));
    active_clinic := public.ent_admin_active_clinic_id();
    IF active_clinic IS NULL THEN
        RETURN public.ent_set_admin_active_clinic(p_doctor);
    END IF;
    RETURN active_clinic;
END
$$;

CREATE OR REPLACE FUNCTION public.ent_clear_admin_active_clinic()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: an active administrator is required'
            USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.ent_admin_active_clinics
     WHERE user_id = public.ent_auth_uid()
       AND session_id = nullif(auth.jwt() ->> 'session_id', '');
END
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
        WHEN public.ent_is_active_admin()
         AND EXISTS (
                SELECT 1
                  FROM public.ent_admin_active_clinics active
                 WHERE active.user_id = public.ent_auth_uid()
                   AND active.session_id = auth.jwt() ->> 'session_id'
            )
            THEN p_clinic IS NOT NULL
             AND p_clinic = public.ent_admin_active_clinic_id()
        ELSE true
    END
$$;

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
           AND (
                (
                    me.role = 'admin'
                    AND public.ent_admin_active_clinic_id() IS NOT NULL
                    AND p_clinic = public.ent_admin_active_clinic_id()
                    AND public.ent_admin_covers_clinic(p_clinic)
                )
                OR (
                    me.clinic_id = p_clinic
                    AND (
                        me.role = 'admin'
                     OR (me.role = 'doctor' AND p_doctor = me.id)
                     OR (me.role = 'secretary' AND p_doctor = me.assigned_doctor_id)
                    )
                )
           )
    )
$$;

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
                (
                    me.role = 'admin'
                    AND (
                        me.clinic_id = p_clinic
                        OR (
                            p_clinic = public.ent_admin_active_clinic_id()
                            AND public.ent_admin_covers_clinic(p_clinic)
                        )
                    )
                )
                OR (
                    me.clinic_id = p_clinic
                    AND (
                        (me.role = 'doctor' AND p_doctor = me.id)
                     OR (me.role = 'secretary' AND p_doctor = me.assigned_doctor_id)
                    )
                )
                OR (
                    p_report IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                          FROM public.report_access_grants g
                          JOIN public.reports rr ON rr.id = g.report_id
                          JOIN public.staff_profiles target ON target.id = g.grantee_id
                         WHERE g.report_id = p_report
                           AND g.grantee_id = me.id
                           AND target.is_active
                           AND rr.is_draft = false
                           AND (g.expires_at IS NULL OR g.expires_at > now())
                    )
                )
           )
    )
$$;

CREATE OR REPLACE FUNCTION public.ent_stamp_report_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me public.staff_profiles;
    keep_clinic uuid;
    keep_doctor uuid;
    doctor_ok boolean;
    existing_target boolean;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    SELECT * INTO me
      FROM public.staff_profiles
     WHERE id = public.ent_auth_uid();

    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        keep_clinic := OLD.clinic_id;
        keep_doctor := OLD.doctor_id;
    ELSIF me.role = 'secretary'
          AND NEW.doctor_id IS NOT NULL
          AND public.ent_is_my_doctor(NEW.doctor_id) THEN
        keep_clinic := coalesce(public.ent_doctor_clinic(NEW.doctor_id), me.clinic_id);
        keep_doctor := NEW.doctor_id;
    ELSE
        keep_clinic := coalesce(NEW.clinic_id, me.clinic_id);
        keep_doctor := NULL;
    END IF;

    IF keep_clinic IS DISTINCT FROM me.clinic_id
       AND NOT (
            me.role = 'admin'
            AND keep_clinic = public.ent_admin_active_clinic_id()
            AND public.ent_admin_covers_clinic(keep_clinic)
       )
       AND NOT public.ent_has_report_grant(OLD.id)
       AND NOT (
            me.role = 'secretary'
            AND keep_doctor IS NOT NULL
            AND public.ent_is_my_doctor(keep_doctor)
       ) THEN
        RAISE EXCEPTION 'refused: you may not write a report into another clinic without an active clinic context or explicit grant'
            USING ERRCODE = '42501';
    END IF;

    NEW.clinic_id := keep_clinic;

    IF TG_OP = 'INSERT'
       AND me.role = 'admin'
       AND keep_clinic = public.ent_admin_active_clinic_id()
       AND NEW.doctor_id IS DISTINCT FROM public.ent_admin_active_doctor_id() THEN
        SELECT EXISTS (
            SELECT 1
              FROM public.reports existing
             WHERE existing.clinic_id = keep_clinic
               AND existing.doctor_id = NEW.doctor_id
               AND existing.record_key = NEW.record_key
               AND existing.deleted_at IS NULL
        ) INTO existing_target;
        IF NOT existing_target THEN
            RAISE EXCEPTION 'refused: file new reports under the doctor selected for this clinic'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        NEW.doctor_id := keep_doctor;
    ELSIF keep_doctor IS NOT NULL THEN
        NEW.doctor_id := keep_doctor;
    ELSIF me.role = 'doctor' THEN
        NEW.doctor_id := me.id;
    ELSIF me.role = 'secretary' THEN
        NEW.doctor_id := me.assigned_doctor_id;
    ELSE
        doctor_ok := coalesce(
            public.ent_doctor_clinic(NEW.doctor_id) = keep_clinic,
            false
        );

        IF NOT doctor_ok THEN
            IF keep_clinic = me.clinic_id THEN
                NEW.doctor_id := me.id;
            ELSE
                RAISE EXCEPTION 'refused: name an active doctor of the selected clinic when filing a report'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.created_by := me.id;
        NEW.created_by_name := coalesce(nullif(me.full_name, ''), me.username);
    ELSE
        NEW.created_by := OLD.created_by;
        NEW.created_by_name := OLD.created_by_name;
    END IF;

    IF NOT NEW.is_draft AND NEW.saved_at IS NULL THEN
        NEW.saved_at := now();
    END IF;

    RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.ent_admin_active_clinic_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ent_admin_active_doctor_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ent_admin_available_doctors() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ent_set_admin_active_clinic(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ent_ensure_admin_active_clinic(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ent_clear_admin_active_clinic() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ent_admin_available_doctors() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_set_admin_active_clinic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_ensure_admin_active_clinic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_clear_admin_active_clinic() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_super_secretary_context_matches(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_may_read_own_clinic(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_may_edit_report(uuid, uuid, uuid) TO authenticated;

COMMENT ON TABLE public.ent_admin_active_clinics IS
    'Server-owned clinic and doctor context keyed to an authenticated admin and Supabase session. The client can set it only through a live ownership-checked RPC.';
COMMENT ON FUNCTION public.ent_admin_active_clinic_id() IS
    'Returns the admin clinic selected for this authenticated session only while the live admin, managed clinic, and selected active doctor remain valid.';
COMMENT ON FUNCTION public.ent_admin_available_doctors() IS
    'Lists active doctors in active clinics the current live admin owns; it does not accept a client-supplied clinic scope.';
COMMENT ON FUNCTION public.ent_set_admin_active_clinic(uuid) IS
    'Sets this session''s clinic context only after live admin ownership and active doctor membership checks.';
COMMENT ON FUNCTION public.ent_super_secretary_context_matches(uuid) IS
    'Enforces the selected clinic for active Super Secretaries and admins with an active session context; other users retain their existing policy behavior.';
COMMENT ON FUNCTION public.ent_may_read_own_clinic(uuid, uuid) IS
    'Allows an admin to read the selected active clinic only when the live admin owns it; otherwise preserves existing own-clinic and role rules.';
COMMENT ON FUNCTION public.ent_may_edit_report(uuid, uuid, uuid) IS
    'Allows an admin to edit the selected clinic only when the live admin owns it; preserves own-clinic and explicit-grant rules for all roles.';
