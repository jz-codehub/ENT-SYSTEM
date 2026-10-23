-- =====================================================================
--  ENT-HNS ENDOSCOPY & CF4 REPORT SYSTEM  —  v2 SCHEMA
--  0001 · extensions, enums, JWT claim helpers, hardened defaults
-- ---------------------------------------------------------------------
--  TARGET PROJECT : the LIVE Supabase project ONLY.
--  NEVER run this against any other database. The old v1 project was
--  deleted on 2026-10-08 - there is no second target any more.
--
--  APPLY ORDER      : 0001 -> 0002 -> 0003 -> 0004 -> 0005 -> 0006
--                     -> 0007 -> 0008 -> 0009 -> 0010 ... -> 0034
--                     FRESH PROJECT: paste the files in THIS folder
--                     one by one, in order.
--  IDEMPOTENT       : yes, safe to re-run.
--  DATA DESTRUCTIVE : no. This file only adds.
--
--  DESIGN INTENT
--    * auth.users is the ONE and ONLY identity store.
--      This schema contains no password_hash, no salt, no session token.
--      Passwords are verified by Supabase Auth, never in browser JS.
--    * role and clinic_id travel inside the Supabase JWT under
--      app_metadata. The browser cannot write app_metadata: only the
--      service role can, and only through the auth-admin Edge Function.
--      That is what makes "a user cannot escalate their own role from
--      DevTools" structurally true rather than a policy we hope holds.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive usernames


-- ---------------------------------------------------------------------
-- 2. Enumerated domains
--    Keeping roles/types as enums means an invalid value is rejected by
--    the database itself, not only by a JS if-statement.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ent_role') THEN
        CREATE TYPE ent_role AS ENUM ('admin', 'doctor', 'secretary');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ent_report_type') THEN
        CREATE TYPE ent_report_type AS ENUM ('cf4', 'nasal', 'laryngeal');
    END IF;
END $$;

-- The audit trail records what kind of write happened, so an auditor can
-- filter without string-matching free text.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ent_activity') THEN
        CREATE TYPE ent_activity AS ENUM (
            'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PASSWORD_CHANGED',
            'PASSWORD_RESET',
            'USER_CREATED', 'USER_UPDATED', 'USER_ROLE_CHANGED',
            'USER_DEACTIVATED', 'USER_ACTIVATED', 'SESSION_REVOKED',
            'SAVE_RECORD', 'DELETE_RECORD', 'OPEN_RECORD',
            'SAVE_DRAFT', 'DELETE_DRAFT',
            'PHOTO_UPLOAD', 'PHOTO_DOWNLOAD', 'PHOTO_DELETE',
            'SETTING_UPDATED', 'ACCESS_DENIED'
        );
    END IF;
END $$;



-- ---------------------------------------------------------------------
-- 3. JWT claim helpers
--    These read the *verified* JWT that PostgREST / Edge Functions put in
--    the request. They touch no tables, so they can be used inside RLS
--    policies with no recursion risk.
-- ---------------------------------------------------------------------

-- The staff_profiles.id of the caller (0003 creates staff_profiles with
-- id = auth.users.id, so auth.uid() and this are the same uuid).
CREATE OR REPLACE FUNCTION public.ent_auth_uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT nullif(
        coalesce(
            nullif(current_setting('request.jwt.claim.sub', true), ''),
            (auth.jwt() ->> 'sub')
        ), '')::uuid
$$;

-- The clinic this caller belongs to, from the signed JWT.
CREATE OR REPLACE FUNCTION public.ent_claim_clinic_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT nullif(
        coalesce(
            nullif(current_setting('request.jwt.claims', true), '')::jsonb
                -> 'app_metadata' ->> 'clinic_id',
            (auth.jwt() -> 'app_metadata' ->> 'clinic_id')
        ), '')::uuid
$$;

-- The caller's role, from the signed JWT.
CREATE OR REPLACE FUNCTION public.ent_claim_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT coalesce(
        nullif(
            coalesce(
                nullif(current_setting('request.jwt.claims', true), '')::jsonb
                    -> 'app_metadata' ->> 'role',
                (auth.jwt() -> 'app_metadata' ->> 'role')
            ), ''), '')
$$;

CREATE OR REPLACE FUNCTION public.ent_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT public.ent_claim_role() = 'admin'
$$;

CREATE OR REPLACE FUNCTION public.ent_is_authenticated()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT public.ent_auth_uid() IS NOT NULL
$$;


-- ---------------------------------------------------------------------
-- 4. updated_at maintenance
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------
-- 5. Harden the default privilege posture for everything created later.
--    The old project handed anon FULL table rights (GRANT ALL ... TO anon)
--    and then relied on USING (true) policies. Here anon gets nothing:
--    an unauthenticated request is refused by the privilege layer before
--    RLS is even consulted. That is what test case AUTH-01 in
--    docs/06-TEST-PLAN.md asserts, and it means a forgotten policy fails
--    CLOSED instead of open.
-- ---------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES     FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES  FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS  FROM anon;

REVOKE ALL ON SCHEMA public FROM anon;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

-- service_role keeps bypassrls on purpose: it is only ever used inside
-- Edge Functions, where it is a platform secret and never in the browser.
NOTIFY pgrst, 'reload schema';

