-- Store each doctor's drawn signature. Doctors manage their own row; an
-- assigned secretary may read it for form preview and printing.
CREATE TABLE IF NOT EXISTS public.doctor_signatures (
    doctor_id          uuid        PRIMARY KEY REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    signature_data_url text        NOT NULL,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT doctor_signatures_png_data_url CHECK (
        length(signature_data_url) <= 150000
        AND signature_data_url ~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$'
    )
);

ALTER TABLE public.doctor_signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.doctor_signatures FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.doctor_signatures TO authenticated;
GRANT ALL ON TABLE public.doctor_signatures TO service_role;

DROP POLICY IF EXISTS doctor_signatures_select_own ON public.doctor_signatures;
DROP POLICY IF EXISTS doctor_signatures_select_assigned ON public.doctor_signatures;
CREATE POLICY doctor_signatures_select_assigned ON public.doctor_signatures
    FOR SELECT TO authenticated
    USING (
        (
            doctor_id = public.ent_auth_uid()
            AND EXISTS (
                SELECT 1
                  FROM public.staff_profiles profile
                 WHERE profile.id = public.doctor_signatures.doctor_id
                   AND profile.role = 'doctor'
                   AND profile.is_active
            )
        )
        OR public.ent_is_my_doctor(doctor_id)
    );

DROP POLICY IF EXISTS doctor_signatures_insert_own ON public.doctor_signatures;
CREATE POLICY doctor_signatures_insert_own ON public.doctor_signatures
    FOR INSERT TO authenticated
    WITH CHECK (
        doctor_id = public.ent_auth_uid()
        AND EXISTS (
            SELECT 1
              FROM public.staff_profiles profile
             WHERE profile.id = public.doctor_signatures.doctor_id
               AND profile.role = 'doctor'
               AND profile.is_active
        )
    );

DROP POLICY IF EXISTS doctor_signatures_update_own ON public.doctor_signatures;
CREATE POLICY doctor_signatures_update_own ON public.doctor_signatures
    FOR UPDATE TO authenticated
    USING (
        doctor_id = public.ent_auth_uid()
        AND EXISTS (
            SELECT 1
              FROM public.staff_profiles profile
             WHERE profile.id = public.doctor_signatures.doctor_id
               AND profile.role = 'doctor'
               AND profile.is_active
        )
    )
    WITH CHECK (
        doctor_id = public.ent_auth_uid()
        AND EXISTS (
            SELECT 1
              FROM public.staff_profiles profile
             WHERE profile.id = public.doctor_signatures.doctor_id
               AND profile.role = 'doctor'
               AND profile.is_active
        )
    );

DROP POLICY IF EXISTS doctor_signatures_delete_own ON public.doctor_signatures;
CREATE POLICY doctor_signatures_delete_own ON public.doctor_signatures
    FOR DELETE TO authenticated
    USING (
        doctor_id = public.ent_auth_uid()
        AND EXISTS (
            SELECT 1
              FROM public.staff_profiles profile
             WHERE profile.id = public.doctor_signatures.doctor_id
               AND profile.role = 'doctor'
               AND profile.is_active
        )
    );

DROP TRIGGER IF EXISTS trg_doctor_signatures_touch ON public.doctor_signatures;
CREATE TRIGGER trg_doctor_signatures_touch
    BEFORE UPDATE ON public.doctor_signatures
    FOR EACH ROW EXECUTE FUNCTION public.ent_touch_updated_at();

COMMENT ON TABLE public.doctor_signatures IS
    'PNG signature owned and managed by an active doctor; readable by that doctor and their assigned active secretary, not a cryptographic signing key.';

NOTIFY pgrst, 'reload schema';
