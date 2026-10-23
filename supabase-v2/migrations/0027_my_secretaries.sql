-- =====================================================================
--  0027 . let a doctor read the NAMES of their own secretaries
-- ---------------------------------------------------------------------
--  The dashboard's "Your secretaries" card (index.html / dashboard.js)
--  read Auth.readUserCache(), and v2 RETIRED that function on purpose:
--  a full copy of the account table in localStorage is a cached ROLE,
--  which is the stale-claim problem PRIV-04 tests (see the block above
--  readUserCache() in function/auth.js - it now returns [] and must).
--
--  The card was never moved off it. So every doctor, in every clinic,
--  saw the empty wording - "No secretary is linked to you yet" / "Ask
--  the admin to link a secretary to your account" - while the admin
--  panel showed their secretaries assigned and correct. Verified in the
--  2026-10-03 backup: tara (Tara Bautista) carries assigned_doctor_id
--  = jess (Jesus Jardin), and the card still said "none".
--
--  Fetching the rows directly does not work either, and the reason is
--  correct: profiles_select_self (0008) lets a doctor read exactly one
--  staff_profiles row - his own - so
--
--      GET /rest/v1/staff_profiles?...&assigned_doctor_id=eq.<his id>
--      -> HTTP 200, body: []
--
--  200 with an empty array, RLS having filtered every secretary out.
--  Loosening that policy would hand any signed-in account a read path
--  into the staff table to fix one card. Not a trade worth making - the
--  same conclusion 0015 reached for the secretary's side.
--
--  So this is the mirror image of 0015 my_assigned_doctor_name(): a
--  function that takes NO ARGUMENTS. The caller cannot point it at
--  anybody; the secretaries are found by joining auth.uid() against
--  assigned_doctor_id. What it can return is exactly the set the card
--  is allowed to show - secretaries assigned to the signed-in doctor,
--  columns kept to the five the UI renders, nothing about any other
--  staff member and no path to ask for more.
--
--  It answers for a doctor only: a secretary or an admin calling it
--  gets zero rows, because neither has role = 'doctor' on their own
--  row. No is_active gate, matching 0015 - this is a read of names the
--  caller's own team page is built from, not a capability; the write
--  paths check is_active themselves.
--
--  SECURITY DEFINER is what lets the join see both rows. There is no
--  user-supplied SQL and no argument of any kind to smuggle through it.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted.
-- =====================================================================

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
    SELECT s.id,
           s.username::text,
           s.full_name,
           s.role,
           s.assigned_doctor_id,
           s.is_active
      FROM public.staff_profiles me
      JOIN public.staff_profiles s
        ON s.assigned_doctor_id = me.id
     WHERE me.id = public.ent_auth_uid()
       AND me.role = 'doctor'
       AND s.role = 'secretary'
     ORDER BY s.full_name
$$;

REVOKE ALL ON FUNCTION public.my_secretaries() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_secretaries() TO authenticated;

NOTIFY pgrst, 'reload schema';