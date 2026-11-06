-- =====================================================================
--  0046 · rename the main clinic and doctor Jess
-- ---------------------------------------------------------------------
--  The existing main_clinic belongs to Doc Jess Jardin. Keep its stable
--  code/id (and therefore every existing report and permission boundary),
--  while correcting the clinic and doctor display names.
--
--  IDEMPOTENT       : yes.
--  DATA DESTRUCTIVE : no. Only display names are updated.
-- =====================================================================

UPDATE public.clinics
   SET name = 'Doc Jess',
       address = ''
 WHERE code = 'main_clinic'
   AND (name IS DISTINCT FROM 'Doc Jess' OR address IS DISTINCT FROM '');

UPDATE public.staff_profiles
   SET full_name = 'Doc Jess Jardin'
 WHERE clinic_id = (
       SELECT id FROM public.clinics WHERE code = 'main_clinic'
   )
   AND username = 'jess'
   AND role = 'doctor'
   AND full_name IS DISTINCT FROM 'Doc Jess Jardin';

NOTIFY pgrst, 'reload schema';
