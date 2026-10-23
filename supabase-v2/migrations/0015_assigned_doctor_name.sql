-- =====================================================================
--  0015 . let a secretary read the NAME of their own doctor
-- ---------------------------------------------------------------------
--  The header chip promises to tell a secretary which doctor they work
--  for. It cannot, and the reason is RLS rather than JavaScript.
--
--  buildSafeUser() hardcoded `assigned_doctor_name: ''`, so the chip fell
--  back to rendering the literal text "Dr. assigned only" for every
--  secretary in the clinic - even when assigned_doctor_id was set and
--  correct. Filling it in from the browser does not work: a secretary's
--  token cannot read another profile row, and that rule is correct.
--
--  Verified against the live project. Signed in as a secretary whose
--  assigned_doctor_id IS populated:
--
--      GET /rest/v1/staff_profiles?...&id=eq.<their doctor>
--      HTTP 200, body: []
--
--  200 with an empty array, because RLS filtered the row out. Loosening
--  the staff_profiles policy so secretaries can read arbitrary profiles
--  would widen access to the entire staff table in order to fix one name.
--  That is not a trade worth making.
--
--  So this is a function that takes NO ARGUMENTS. The caller cannot point
--  it at anybody: the doctor is found by joining auth.uid() against that
--  same row's assigned_doctor_id. The only thing it can ever return is
--  the name of the doctor the signed-in secretary is already assigned to,
--  and only while their own role is secretary. SECURITY DEFINER is what
--  lets the join see both rows; the result is still exactly one name.
--
--  A secretary with no doctor, or anyone who is not a secretary, gets
--  NULL - and the chip then uses wording that stays true either way
--  rather than claiming there is no doctor when there simply was no
--  answer.
--
--  IDEMPOTENT : yes.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.my_assigned_doctor_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT d.full_name
      FROM public.staff_profiles me
      JOIN public.staff_profiles d
        ON d.id = me.assigned_doctor_id
     WHERE me.id = auth.uid()
       AND me.role = 'secretary'
$$;

REVOKE ALL ON FUNCTION public.my_assigned_doctor_name() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_assigned_doctor_name() TO authenticated;

NOTIFY pgrst, 'reload schema';