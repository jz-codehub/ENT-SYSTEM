-- =====================================================================
--  0005 · audit trail + presence  (replaces activity_logs + user_sessions)
-- ---------------------------------------------------------------------
--  user_sessions is GONE. It stored its own bearer token in a table that
--  anyone holding the anon key could read (probe: 200 + token column),
--  which is a full account-taking primitive. Supabase Auth owns sessions
--  now; nothing in this schema can ever hold a credential again.
--
--  user_presence keeps the Admin "ACTIVE NOW" tile working with a plain
--  heartbeat row that contains no secret whatsoever.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ACTIVITY LOG — append-only
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id    uuid          REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
    -- The role AT THE TIME of the event, kept as text on purpose: an
    -- audit row must not change when the person's role later changes.
    actor_role  text          NOT NULL DEFAULT '',
    actor_label text          NOT NULL DEFAULT '',
    clinic_id   uuid          REFERENCES public.clinics(id)        ON DELETE SET NULL,
    action      public.ent_activity NOT NULL,
    detail      text          NOT NULL DEFAULT '',
    target_type text          NOT NULL DEFAULT '',
    target_id   text          NOT NULL DEFAULT '',
    created_at  timestamptz   NOT NULL DEFAULT now(),

    -- The audit trail must never carry patient-identifying text: it is
    -- read by every admin in the clinic. Report rows are referenced by
    -- id, never by patient name.
    CONSTRAINT audit_no_patient_name CHECK (detail !~* '"patient_name"\s*:'),
    CONSTRAINT audit_detail_length   CHECK (length(detail) <= 2000)
);

COMMENT ON TABLE  public.activity_logs IS 'Append-only audit trail. No UPDATE, no DELETE, by policy AND by trigger.';
COMMENT ON COLUMN public.activity_logs.detail IS 'Must not contain PHI. Reference reports by id.';

CREATE INDEX IF NOT EXISTS idx_audit_time    ON public.activity_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON public.activity_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_clinic  ON public.activity_logs (clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON public.activity_logs (clinic_id, action, created_at DESC);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Belt and braces: RLS already refuses UPDATE/DELETE by having no policy
-- for them; this trigger makes it unmissable in the error message.
CREATE OR REPLACE FUNCTION public.ent_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'refused: the audit trail is append-only'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_append_only ON public.activity_logs;
CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON public.activity_logs
    FOR EACH ROW EXECUTE FUNCTION public.ent_audit_append_only();


-- ---------------------------------------------------------------------
-- 2. PRESENCE — powers Admin -> Overview "active now"
--    (user_id, device_label) is the key, so a heartbeat is a cheap upsert
--    and a shared device shows one row per person, not thousands.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_presence (
    user_id      uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
    device_label text        NOT NULL DEFAULT 'this device',
    clinic_id    uuid        NOT NULL REFERENCES public.clinics(id)        ON DELETE CASCADE,
    role_at_seen text        NOT NULL DEFAULT '',
    seen_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, device_label)
);

COMMENT ON TABLE public.user_presence IS
    'Heartbeat rows. Anyone seen in the last 5 minutes counts as active. Contains no credential.';

CREATE INDEX IF NOT EXISTS idx_presence_seen ON public.user_presence (clinic_id, seen_at DESC);

ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;

-- Presence is stamped from the caller's own profile too, so a client
-- cannot post itself into another clinic's "active now" list.
CREATE OR REPLACE FUNCTION public.ent_stamp_presence()
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

    NEW.user_id      := me.id;
    NEW.clinic_id    := me.clinic_id;
    NEW.role_at_seen := me.role::text;
    NEW.seen_at      := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_presence_stamp ON public.user_presence;
CREATE TRIGGER trg_presence_stamp
    BEFORE INSERT OR UPDATE ON public.user_presence
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_presence();



-- ---------------------------------------------------------------------
-- 3. Audit rows are stamped with WHO wrote them, from the session.
--    The client cannot claim to be somebody else in the audit trail,
--    because actor_id / actor_role / clinic_id are overwritten here.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_audit()
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
    IF me.id IS NULL THEN
        RAISE EXCEPTION 'refused: anonymous writes to the audit trail are not allowed'
            USING ERRCODE = '42501';
    END IF;

    NEW.actor_id   := me.id;
    NEW.actor_role := me.role::text;
    NEW.clinic_id  := me.clinic_id;
    IF NEW.actor_label = '' THEN
        NEW.actor_label := coalesce(nullif(me.full_name, ''), me.username::text);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_stamp ON public.activity_logs;
CREATE TRIGGER trg_audit_stamp
    BEFORE INSERT ON public.activity_logs
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_audit();

NOTIFY pgrst, 'reload schema';
