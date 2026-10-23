-- =====================================================================
--  0022 · the grant trigger must see the grantee it is stamping
-- ---------------------------------------------------------------------
--  THE BUG
--
--  ent_stamp_grant() validates the row it is about to write:
--
--      SELECT * INTO target FROM public.staff_profiles WHERE id = NEW.grantee_id;
--      IF target.id IS NULL OR NOT target.is_active THEN
--          RAISE EXCEPTION 'refused: the grantee is not an active staff member';
--
--  That SELECT runs as the CALLING role, not as the function owner, because
--  ent_stamp_grant was created without SECURITY DEFINER, so row level
--  security applies to it. An admin can only read the staff_profiles rows of
--  their OWN clinic (profiles_select_admin_clinic), so the moment the
--  approver and the grantee are in different clinics - which is the only
--  situation a grant exists for - the lookup returns no row, target.id is
--  NULL, and the trigger refuses.
--
--  Observed live, and it is not subtle: approving a cross-clinic grant
--  returned HTTP 403 for every attempt, while the same run proved that the
--  admin of the OTHER clinic was correctly refused with the same status. The
--  guard meant to stop a bad grant was firing on every good one.
--
--  It also explains why the two neighbouring checks never ran. The "is the
--  grantee in your own clinic" and "is the approver still allowed" tests
--  both sit after this one, so nothing past the first IF was reachable.
--
--  WHY THE FIX IS THIS WORD AND NOT A LOOSER LOOKUP
--
--  Adding SECURITY DEFINER makes the trigger's reads bypass RLS. That sounds
--  like it widens something, and the reasoning matters:
--
--    · The trigger is only reached by an INSERT into report_access_grants,
--      and grants_insert_owner already requires
--      ent_may_grant_report_access(report_id). By the time this function
--      runs, the caller is an active admin of the owning clinic or the
--      report's own doctor. The approval decision has already been made.
--    · So the trigger is not a gate. It is a stamp: it fills in granted_by and
--      created_at, and it rejects rows that are internally impossible - a
--      grantee who does not exist, is deactivated, or sits in the approver's
--      own clinic and therefore needs no grant at all.
--    · Those checks REQUIRE the grantee's real row, including clinic_id,
--      which is exactly what RLS was hiding.
--
--  The trigger was written to answer a question RLS cannot answer for it, and
--  the honest fix is to let it ask. The alternative - loosening the policies so
--  any staff member could read every staff_profiles row - would hand the whole
--  staff directory of every clinic to every signed-in user, which is a far
--  larger disclosure than the one being fixed here.
--
--  WHAT IT TOUCHES
--    replaces : ent_stamp_grant   (CREATE OR REPLACE, same signature, same body
--                                  plus SECURITY DEFINER)
--    creates  : nothing
--    drops    : nothing
--    writes   : nothing
--
--  report_access_grants, its rows, reports and every other table are
--  untouched. The body is identical apart from the two words SECURITY
--  DEFINER, so no behaviour changes other than the lookup being allowed to
--  find the row it is checking.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. THE TRIGGER, WITH SECURITY DEFINER.
--
--    The three refusals are unchanged and all of them are worth keeping:
--
--      · the grantee must exist and be active - a grant to a deactivated
--        account is a row that grants nothing and confuses an audit;
--      · the grantee must be in ANOTHER clinic - someone in the approver's
--        own clinic is already covered by the base rule, so the row would
--        be meaningless;
--      · the approver must still be allowed on the patient at write time -
--        a revoked admin must not be able to leave a trail of standing
--        permissions behind.
--
--    SET search_path stays pinned to public. SECURITY DEFINER combined with
--    a search_path the caller can influence is the classic escalation
--    setup, so the one line that hardens it is kept exactly as it was.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me     public.staff_profiles;
    target public.staff_profiles;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                              -- trusted writer
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- 0022: this lookup is the whole reason the function is SECURITY
    -- DEFINER. The approver and the grantee sit in different clinics by
    -- definition - that is what a grant IS - and an admin may only read the
    -- staff_profiles rows of their own clinic, so under the caller's
    -- privileges this returned nothing and every grant was refused.
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

    NEW.granted_by := me.id;
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ent_stamp_grant() IS
    'Stamps granted_by and created_at from the session, and refuses a grant whose grantee does not exist, is deactivated, is in the approver''s own clinic, or whose approver is no longer allowed. SECURITY DEFINER so the grantee lookup can cross clinics: grants_insert_owner has already made the approval decision before this runs, and the trigger exists to stamp and sanity-check, not to authorise.';


-- ---------------------------------------------------------------------
-- 2. THE ASSERTION
--
--    Fails unless the function is SECURITY DEFINER. Without this the file
--    would apply cleanly and the bug would simply stay, looking like a
--    permissions problem rather than a missing clause - which is exactly how
--    it presented the first time.
-- ---------------------------------------------------------------------
DO $$
DECLARE is_def boolean;
BEGIN
    SELECT p.prosecdef INTO is_def
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.ent_stamp_grant()');

    IF is_def IS NULL THEN
        RAISE EXCEPTION 'refused: ent_stamp_grant is missing. Apply 0019 first.';
    END IF;

    IF NOT is_def THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant is not SECURITY DEFINER, so the grantee lookup is subject to RLS and every cross-clinic grant will be refused.';
    END IF;
END $$;

-- 0021 re-asserts the draft guard on the approval function this trigger
-- calls; nothing here changes that rule.
NOTIFY pgrst, 'reload schema';

