-- =====================================================================
--  0050 · SUPER SECRETARY - all clinics in one admin-owned network
-- ---------------------------------------------------------------------
--  A Super Secretary remains a secretary for all existing role checks,
--  but receives a server-side flag that expands her doctor assignment to
--  every active doctor in the same admin-owned clinic network.
--
--  This is deliberately NOT a global cross-tenant grant. The secretary's
--  home clinic must have a non-NULL clinics.managed_by owner; target
--  doctors must belong to a clinic with that same owner. Legacy clinics
--  with no owner only match their own clinic. Admin provisioning remains
--  the only way to change the flag.
-- =====================================================================

ALTER TABLE public.staff_profiles
    ADD COLUMN IF NOT EXISTS is_super_secretary boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.staff_profiles.is_super_secretary IS
    'When true for an active secretary, ent_is_my_doctor includes every active doctor in the same non-NULL managed_by clinic network. Never grants access across admin owners.';

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
