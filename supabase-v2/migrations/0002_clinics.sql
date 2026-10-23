-- =====================================================================
--  0002 · clinics
-- ---------------------------------------------------------------------
--  The old schema carried clinic_id as a free TEXT that came from
--  localStorage (function/supabaseClient.js -> ent_supabase_config_v1).
--  That meant any browser could pick which clinic it "belonged" to.
--
--  Here a clinic is a real row, clinic_id is a uuid, and the value the
--  server uses is read from staff_profiles — never from the request.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.clinics (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code         text        NOT NULL UNIQUE,
    name         text        NOT NULL,
    address      text        NOT NULL DEFAULT '',
    is_active    boolean     NOT NULL DEFAULT TRUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT clinics_code_shape CHECK (code ~* '^[a-z0-9][a-z0-9_-]{1,31}$')
);

COMMENT ON TABLE public.clinics IS
    'One row per clinic / ENT branch. Tenant boundary for every other table.';

DROP TRIGGER IF EXISTS trg_clinics_touch ON public.clinics;
CREATE TRIGGER trg_clinics_touch
    BEFORE UPDATE ON public.clinics
    FOR EACH ROW EXECUTE FUNCTION public.ent_touch_updated_at();

ALTER TABLE public.clinics ENABLE ROW LEVEL SECURITY;



-- ---------------------------------------------------------------------
-- Seed the clinic that replaces the old hardcoded 'main_clinic'.
-- The uuid is fixed so the test plan can reference it without a lookup.
-- ---------------------------------------------------------------------
INSERT INTO public.clinics (id, code, name)
VALUES ('00000000-0000-4000-8000-00000000c11c', 'main_clinic', 'Main ENT Clinic')
ON CONFLICT (code) DO NOTHING;

-- A second "satellite_clinic" used to be seeded here ONLY so the
-- cross-clinic isolation test (ISO-01) could run. It was synthetic test
-- data and nothing else, so it has been REMOVED - nothing test-related
-- is ever applied to a real database. Re-add it by hand, in a throwaway
-- test project only, if you need to exercise cross-clinic isolation again.


-- ---------------------------------------------------------------------
-- The stable id of the seeded primary clinic, as a convenience constant.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_default_clinic_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT id FROM public.clinics WHERE code = 'main_clinic' LIMIT 1
$$;

NOTIFY pgrst, 'reload schema';
