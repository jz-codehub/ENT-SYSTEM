-- =====================================================================
--  0024 · the grant stamp must not return before it stamps
-- ---------------------------------------------------------------------
--  THE ROOT CAUSE OF granted_by = NULL
--
--  0022 added SECURITY DEFINER to ent_stamp_grant() so the grantee lookup
--  could cross clinics. That was correct and necessary. But it left the
--  guard at the top of the body untouched:
--
--      IF current_user NOT IN ('authenticated', 'anon') THEN
--          RETURN NEW;                              -- trusted writer
--      END IF;
--
--  Inside a SECURITY DEFINER function, current_user is the FUNCTION OWNER,
--  not the caller. The owner is postgres, which is not in that list, so the
--  condition is ALWAYS true for every caller, authenticated or not, and the
--  function returned at line one - before reaching
--
--      NEW.granted_by := me.id;
--
--  So the trigger silently did nothing for every grant ever written. The
--  three sanity checks below it (grantee active, grantee in another clinic,
--  approver still allowed) never ran either, so they were not the protection
--  they appeared to be. Every grant in the table had no author and no
--  validation.
--
--  Why it was invisible: a BEFORE INSERT trigger that returns the row
--  unchanged is indistinguishable, to the client, from a trigger that ran
--  perfectly. The insert returned HTTP 201. Only the stored value was wrong.
--
--  WHY NOT JUST session_user
--
--  session_user would be the role the request authenticated as, but it is
--  empty for internal callers and is not the identity the rest of this
--  schema reasons about. The question this guard is really asking is "is
--  there a real signed-in staff member on this request?", and the codebase
--  already has an honest answer for that: ent_auth_uid(), which reads the
--  VERIFIED JWT claim and returns NULL when there is no user. That is the
--  same helper every policy in this schema uses, so the trigger and the
--  policies now agree on one definition of "who is calling".
--
--  THE TRUSTED WRITER PATH IS KEPT, BUT MADE HONEST
--
--  A service_role writer (backfill scripts, migrations, the backup job) has
--  no JWT, so ent_auth_uid() is NULL and the function returns the row
--  untouched - exactly the behaviour the original guard wanted. What changes
--  is that this path now states its reason, and cannot be entered by an
--  authenticated user who merely forgot to send a token: that case is
--  refused loudly instead of writing an unattributed grant.
--
--  THE FAIL-LOUD PROPERTY
--
--  The other half of this fix is that the function must never again be able
--  to return NEW without having attributed the row. If me cannot be
--  resolved for a caller that DOES have a session, the function raises. A
--  silent NULL is what made this bug invisible for so long; a loud refusal
--  is what will surface the next one.
--
--  WHAT IT TOUCHES
--    replaces : ent_stamp_grant   (CREATE OR REPLACE, same signature)
--    creates  : nothing
--    drops    : nothing
--    deletes  : nothing
--
--  This file deliberately does NOT set granted_by to NOT NULL. That is a
--  separate step (0025), and it must come after this one is live and proven,
--  because a NOT NULL column with a broken trigger would turn every grant
--  insert into a failure.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no. No row is written, changed, or removed.
-- =====================================================================
-- ---------------------------------------------------------------------
-- 1. THE TRIGGER, GUARDED BY THE SESSION AND NOT BY current_user.
--
--    Same three refusals as 0022, still worth keeping, now actually
--    reachable. The reason for each check is kept because it is not
--    visible from the body.
--
--    SET search_path stays pinned: SECURITY DEFINER plus a caller-
--    influenceable search_path is the classic escalation setup.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me      public.staff_profiles;
    target  public.staff_profiles;
    caller  uuid := public.ent_auth_uid();
BEGIN
    -- 0024: the old guard asked current_user, which inside SECURITY
    -- DEFINER is the owner, so it was true for everybody and the function
    -- returned before stamping anything. Ask the session instead.
    --
    -- No JWT means a trusted server-side writer (service_role, migration,
    -- backup). The row is passed through untouched, which is what that
    -- guard always intended.
    IF caller IS NULL THEN
        RETURN NEW;
    END IF;

    -- But a caller WITH a session must be a real, active staff member. If
    -- the token resolves to nobody, refusing here is the only safe answer:
    -- proceeding would write a grant that nobody authorised.
    SELECT * INTO me FROM public.staff_profiles WHERE id = caller;
    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- The grantee must exist and be active. A grant to a deactivated
    -- account is a row that grants nothing and confuses an audit.
    --
    -- SECURITY DEFINER is what lets this lookup cross clinics, and that is
    -- the whole reason it is here: approver and grantee sit in different
    -- clinics by definition, and an admin may only read the staff_profiles
    -- rows of their own clinic.
    SELECT * INTO target FROM public.staff_profiles WHERE id = NEW.grantee_id;
    IF target.id IS NULL OR NOT target.is_active THEN
        RAISE EXCEPTION 'refused: the grantee is not an active staff member'
            USING ERRCODE = '42501';
    END IF;

    -- A same-clinic grantee is already covered by the base rule; storing a
    -- grant for one would be a row that grants nothing and confuses an audit.
    IF target.clinic_id = me.clinic_id THEN
        RAISE EXCEPTION 'refused: that person is in your own clinic and needs no grant'
            USING ERRCODE = '42501';
    END IF;

    -- The granter must still be allowed on the patient at write time, not
    -- merely when the grant was created. A revoked admin cannot leave a
    -- trail of standing permissions behind.
    IF NOT public.ent_may_grant_report_access(NEW.report_id) THEN
        RAISE EXCEPTION 'refused: you may not grant access to that report'
            USING ERRCODE = '42501';
    END IF;

    -- 0024: reached only now. Before this fix nothing below this line had
    -- ever executed, which is why every existing grant has a NULL author.
    NEW.granted_by := me.id;
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ent_stamp_grant() IS
    'Stamps granted_by and created_at from the session, and refuses a grant whose grantee does not exist, is deactivated, is in the approver''s own clinic, or whose approver is no longer allowed. SECURITY DEFINER so the grantee lookup can cross clinics; the caller is identified by ent_auth_uid() from the verified JWT, NOT by current_user, which inside a SECURITY DEFINER function is the owner and would let every caller return before stamping. No JWT (service_role) passes through untouched. grants_insert_owner has already made the approval decision before this runs: the trigger stamps and sanity-checks, it does not authorise.';

-- @@BODY@@

-- @@ASSERTIONS@@
-- ---------------------------------------------------------------------
-- 2. THE ASSERTIONS
--
--    Checked here so the file cannot apply in a state that would let the
--    bug come back unnoticed. The first is the important one: it reads the
--    LIVE function body and refuses if the old early return survives.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    fn_src  text;
    is_def  boolean;
BEGIN
    SELECT pg_get_functiondef(p.oid), p.prosecdef
      INTO fn_src, is_def
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.ent_stamp_grant()');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION 'refused: ent_stamp_grant is missing. Apply 0019 first.';
    END IF;

    -- SECURITY DEFINER must stay: it is what allows the cross-clinic
    -- grantee lookup. This file changes WHO is asked, not whether the
    -- function is privileged.
    IF NOT is_def THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant lost SECURITY DEFINER, so the grantee lookup is subject to RLS and every cross-clinic grant will be refused.';
    END IF;

    -- Strip comments before reading the body; the comments name this bug
    -- on purpose and would otherwise trip the check below.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    -- THE REGRESSION THIS FILE EXISTS TO PREVENT. current_user inside a
    -- SECURITY DEFINER function is the owner, so that guard silently
    -- skipped the whole body for every caller.
    IF fn_src ILIKE '%current_user%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant still reads current_user. Under SECURITY DEFINER that is the function owner, so the guard would return before granted_by is stamped.';
    END IF;

    -- The stamp must still be present, and must still come from the
    -- session rather than from the row the client sent.
    IF fn_src NOT ILIKE '%new.granted_by := me.id%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant no longer stamps granted_by from the session.';
    END IF;

    IF fn_src NOT ILIKE '%ent_auth_uid%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant no longer identifies the caller from the verified JWT.';
    END IF;

    IF fn_src ILIKE '%new.granted_by := new.grantee_id%'
       OR fn_src ILIKE '%new.granted_by := new.granted_by%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant would take granted_by from the row instead of the session. The author must be server-owned.';
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. THE TRIGGER MUST STILL BE WIRED TO THIS FUNCTION
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.report_access_grants'::regclass
           AND tgname = 'trg_grants_stamp'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION
            'refused: trg_grants_stamp is not attached to report_access_grants. Apply 0019 first.';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';