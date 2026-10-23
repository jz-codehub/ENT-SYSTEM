-- =====================================================================
--  0006 · server-side flags + clinic settings
-- ---------------------------------------------------------------------
--  WHY system_flags EXISTS
--  function/photoStore.js turns cloud photos on with
--      localStorage.setItem('entFeaturePhotoStorage', 'on')
--  That is a client-side switch guarding a server-side capability: any
--  user can flip it in DevTools. It is fine as a UI convenience and it
--  is worthless as a control.
--
--  Here the authoritative switch is this table, read by the Edge
--  Function on every request. The localStorage flag may still hide or
--  show a button; it can no longer unlock anything.
--  (Requirement PHASE-4.5 — "never rely on a localStorage feature flag".)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.system_flags (
    flag_key    text        PRIMARY KEY,
    enabled     boolean     NOT NULL DEFAULT FALSE,
    note        text        NOT NULL DEFAULT '',
    updated_by  uuid        REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.system_flags IS
    'Server-side capability switches. The browser may READ these; only they decide what is allowed.';

-- Seeded OFF. Flipping photo storage on is an explicit, logged decision.
INSERT INTO public.system_flags (flag_key, enabled, note) VALUES
    ('photo_storage',      FALSE, 'PHASE 4 — stays OFF until docs/06-TEST-PLAN.md STORAGE-* all pass'),
    ('cloud_reports_read', TRUE,  'Reading shared reports from the cloud'),
    ('cloud_reports_write',TRUE,  'Saving reports to the cloud')
ON CONFLICT (flag_key) DO NOTHING;

ALTER TABLE public.system_flags ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- clinic_shared_data replaced by a typed, per-clinic settings table.
-- The old table existed but the frontend never wrote to it (all settings
-- live in localStorage), so nothing is lost by redesigning it freely.
-- Only whitelisted keys are accepted, so it cannot quietly become a
-- dumping ground for arbitrary client JSON.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clinic_settings (
    clinic_id   uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
    setting_key text        NOT NULL,
    value       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_by  uuid        REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (clinic_id, setting_key),
    CONSTRAINT settings_key_allowed CHECK (setting_key IN (
        'clinicProfile', 'clinicPhysicians', 'clinicRefPhysicians',
        'clinicAsstSurgeons', 'cf4Settings', 'reportDefaults', 'imageLayout'
    )),
    CONSTRAINT settings_value_ceiling CHECK (octet_length(value::text) < 500000)
);

ALTER TABLE public.clinic_settings ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_settings_touch ON public.clinic_settings;
CREATE TRIGGER trg_settings_touch
    BEFORE UPDATE ON public.clinic_settings
    FOR EACH ROW EXECUTE FUNCTION public.ent_touch_updated_at();

-- Stamp editor + clinic from the caller.
CREATE OR REPLACE FUNCTION public.ent_stamp_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me public.staff_profiles;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;
    NEW.clinic_id  := me.clinic_id;
    NEW.updated_by := me.id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_settings_stamp ON public.clinic_settings;
CREATE TRIGGER trg_settings_stamp
    BEFORE INSERT OR UPDATE ON public.clinic_settings
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_settings();

-- Flags are flipped by an admin only, and always leave a trace.
CREATE OR REPLACE FUNCTION public.ent_stamp_flag_editor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    NEW.updated_by := public.ent_auth_uid();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_flags_stamp ON public.system_flags;
CREATE TRIGGER trg_flags_stamp
    BEFORE UPDATE ON public.system_flags
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_flag_editor();

NOTIFY pgrst, 'reload schema';
