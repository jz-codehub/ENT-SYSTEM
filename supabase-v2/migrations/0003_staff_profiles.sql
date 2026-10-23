-- =====================================================================
--  0003 · staff_profiles  (roles, clinic membership, the authz core)
-- ---------------------------------------------------------------------
--  REPLACES: clinic_users (which held password_hash + salt + a public
--  REST surface — probe finding: hashes were downloadable by anon).
--
--  auth.users keeps: id, email/username, encrypted password, last_sign_in
--  staff_profiles keeps: everything the app shows and every permission
--                        decision the database makes
--
--  There is no password column here, by design. Test CRED-01 proves it.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.staff_profiles (
    -- Same uuid as the auth.users row; 1:1 by construction.
    id                   uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    clinic_id            uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE RESTRICT,

    -- citext so 'Admin' and 'admin' cannot both exist.
    username             citext      NOT NULL UNIQUE,
    full_name            text        NOT NULL DEFAULT '',

    role                 public.ent_role NOT NULL DEFAULT 'secretary',
    -- A secretary works for exactly one doctor; a doctor/admin has none.
    -- Self-referencing FK means you cannot assign a secretary to a
    -- user who does not exist (the old schema allowed dangling uuids).
    assigned_doctor_id   uuid        REFERENCES public.staff_profiles(id) ON DELETE SET NULL,

    specialty            text        NOT NULL DEFAULT '',
    license_no           text        NOT NULL DEFAULT '',
    email                text        NOT NULL DEFAULT '',
    phone                text        NOT NULL DEFAULT '',

    is_active            boolean     NOT NULL DEFAULT TRUE,
    must_change_password boolean     NOT NULL DEFAULT FALSE,
    last_login_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- A secretary must point at a real doctor; nobody else may.
    CONSTRAINT staff_secretary_requires_doctor CHECK (
        (role = 'secretary' AND assigned_doctor_id IS NOT NULL)
        OR (role <> 'secretary' AND assigned_doctor_id IS NULL)
    ),
    -- A secretary cannot be assigned to herself.
    CONSTRAINT staff_not_self_assigned CHECK (
        assigned_doctor_id IS NULL OR assigned_doctor_id <> id
    ),
    CONSTRAINT staff_username_shape CHECK (username ~* '^[a-z0-9._-]{3,32}$'),
    CONSTRAINT staff_email_shape    CHECK (email = '' OR email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

COMMENT ON TABLE  public.staff_profiles IS
    'Authoritative role + clinic membership. Roles change ONLY via the auth-admin Edge Function.';
COMMENT ON COLUMN public.staff_profiles.assigned_doctor_id IS
    'For secretaries: the doctor whose records she may see. Server-side truth for the old JS doctorFilter().';

CREATE INDEX IF NOT EXISTS idx_staff_clinic      ON public.staff_profiles (clinic_id);
CREATE INDEX IF NOT EXISTS idx_staff_doctor      ON public.staff_profiles (assigned_doctor_id);
CREATE INDEX IF NOT EXISTS idx_staff_role_active ON public.staff_profiles (role, is_active);

DROP TRIGGER IF EXISTS trg_staff_touch ON public.staff_profiles;
CREATE TRIGGER trg_staff_touch
    BEFORE UPDATE ON public.staff_profiles
    FOR EACH ROW EXECUTE FUNCTION public.ent_touch_updated_at();

ALTER TABLE public.staff_profiles ENABLE ROW LEVEL SECURITY;
-- NOTE: deliberately ENABLE-only, no FORCE. FORCE would also bind the
-- table owner, and the SECURITY DEFINER helpers below (and the admin RPCs
-- in 0010_admin_rpcs.sql) are owned by that owner and must be able to read this table to
-- answer "is this caller an active member of clinic X?" Our application
-- only ever connects as anon / authenticated / service_role, never as the
-- table owner, so ENABLE-only is the correct and complete setting here.



-- =====================================================================
--  AUTHORIZATION HELPERS  (the single source of permission truth)
-- ---------------------------------------------------------------------
--  SECURITY DEFINER is required here and is NOT a shortcut: RLS on this
--  table must not recurse into itself while it is being consulted by
--  another table's policy. These functions read a fixed, narrow set of
--  columns, take no user-supplied SQL, and grant EXECUTE to no one
--  except the roles that need them (see 0007_privileges.sql).
--
--  Every question they answer is re-read from the TABLE on each call.
--  That is the whole point: a JWT that still says "secretary" after an
--  admin demoted the account, or a forged app_metadata claim, gets
--  answered by the row — not by the token.
-- =====================================================================

-- The caller's own profile row, live from the table.
CREATE OR REPLACE FUNCTION public.ent_current_profile()
RETURNS public.staff_profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT * FROM public.staff_profiles WHERE id = public.ent_auth_uid()
$$;

-- Active member of THIS clinic? Compares the live row, not the JWT claim.
-- A deactivated account, or one moved to another clinic, fails here even
-- if its old JWT has not expired yet.
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
$$;

-- Is the caller an ACTIVE admin? Live row again, so a revoked admin is
-- refused immediately rather than at token expiry.
CREATE OR REPLACE FUNCTION public.ent_is_active_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.staff_profiles
         WHERE id = public.ent_auth_uid()
           AND role = 'admin'
           AND is_active
    )
$$;

-- Which doctor's records may the caller see?  NULL = every doctor in the
-- clinic (admin). Otherwise exactly one doctor uuid. This is the server
-- side replacement for the JS doctorFilter() in dbRecords/syncEngine.
CREATE OR REPLACE FUNCTION public.ent_visible_doctor_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE p.role
               WHEN 'admin'     THEN NULL
               WHEN 'doctor'    THEN p.id
               WHEN 'secretary' THEN p.assigned_doctor_id
               ELSE NULL
           END
      FROM public.staff_profiles p
     WHERE p.id = public.ent_auth_uid()
       AND p.is_active
$$;

-- Can the caller read/write a row belonging to clinic p_clinic and
-- doctor p_doctor?  This one function is what every report policy calls,
-- so the rule cannot drift between tables.
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
           -- clinic isolation first, always
           AND me.clinic_id = p_clinic
           AND (
                -- admins reach every shelf in their own clinic
                me.role = 'admin'
                -- a doctor reaches his own shelf
             OR (me.role = 'doctor'    AND p_doctor = me.id)
                -- a secretary reaches ONLY her assigned doctor's shelf;
                -- the uuid comes from her row, so it cannot be forged
             OR (me.role = 'secretary' AND p_doctor = me.assigned_doctor_id)
           )
    )
$$;

-- =====================================================================
--  PRIVILEGE-ESCALATION GUARD
-- ---------------------------------------------------------------------
--  Even if a future policy is written wrongly, a browser-originated
--  request cannot move a role, a clinic, a doctor assignment, or an
--  account's active flag. Those columns change only from a trusted
--  database role (service_role inside auth-admin, or you in the SQL
--  editor). This is requirement PHASE-2.7 enforced as data, not hope.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ent_guard_staff_privileges()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_caller text := current_user;
BEGIN
    -- Trusted roles may do anything.
    IF v_caller NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF NEW.role                 IS DISTINCT FROM OLD.role
       OR NEW.clinic_id         IS DISTINCT FROM OLD.clinic_id
       OR NEW.assigned_doctor_id IS DISTINCT FROM OLD.assigned_doctor_id
       OR NEW.username          IS DISTINCT FROM OLD.username
       OR NEW.is_active         IS DISTINCT FROM OLD.is_active
       OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password
    THEN
        RAISE EXCEPTION
            'refused: role/clinic/assignment/username/active changes are admin-only'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_guard ON public.staff_profiles;
CREATE TRIGGER trg_staff_guard
    BEFORE UPDATE ON public.staff_profiles
    FOR EACH ROW EXECUTE FUNCTION public.ent_guard_staff_privileges();

-- Nobody at all may INSERT a profile from the browser: an account is
-- created by auth-admin (service_role), which owns both the auth.users row
-- and this row. A BEFORE trigger makes that rule absolute.
CREATE OR REPLACE FUNCTION public.ent_guard_staff_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'refused: accounts are created by an administrator only'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_guard_insert ON public.staff_profiles;
CREATE TRIGGER trg_staff_guard_insert
    BEFORE INSERT ON public.staff_profiles
    FOR EACH ROW EXECUTE FUNCTION public.ent_guard_staff_insert();


-- =====================================================================
--  JWT app_metadata SYNC
-- ---------------------------------------------------------------------
--  role + clinic_id live in auth.users.raw_app_meta_data so they appear
--  in the signed JWT and can short-circuit cheap policy checks. Only
--  trusted roles may run this, and only for the row being written.
--  NOTE: the authoritative decision still re-reads staff_profiles (see
--  the helpers above); this is a cache, never the source of truth.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ent_sync_auth_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_meta jsonb;
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    v_meta := jsonb_build_object(
        'clinic_id', NEW.clinic_id,
        'role',      NEW.role::text
    );

    UPDATE auth.users
       SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || v_meta
     WHERE id = NEW.id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_sync_meta ON public.staff_profiles;
CREATE TRIGGER trg_staff_sync_meta
    AFTER INSERT OR UPDATE OF role, clinic_id ON public.staff_profiles
    FOR EACH ROW EXECUTE FUNCTION public.ent_sync_auth_metadata();

NOTIFY pgrst, 'reload schema';


