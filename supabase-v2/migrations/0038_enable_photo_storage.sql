-- =====================================================================
--  0038_enable_photo_storage.sql
--  ---------------------------------------------------------------------
--  THE SINGLE HIGHEST-LEVERAGE FREE-PLAN SWITCH.
--
--  While `photo_storage` is FALSE (the 0006 default), every endoscopy photo
--  is stored INLINE in reports.payload as base64. Base64 is ~33% larger than
--  the original, so a 700 KB photo occupies ~930 KB of DATABASE per copy,
--  and a typical 3-photo report is ~2.8 MB of the 500 MB database. That is
--  ~180 reports before the free-plan database fills - weeks, not years.
--
--  When this flag is TRUE, photos go to the PRIVATE `patient-photos` bucket
--  (created in 0009, 1 GB file storage) and reports.payload holds only the
--  small report_photos metadata (~a few KB). The database then grows at the
--  rate of TEXT records, not images - hundreds of thousands of records fit,
--  and the file-storage quota (1 GB ~ 1,400 photos at 700 KB) becomes the
--  generous, separate budget. This one flip is what turns the free plan from
--  "months" into "years".
--
--  WHY THIS IS A SEPARATE, OPT-IN FILE (not folded into the chain)
--
--  0006 seeds the flag FALSE on purpose and the README keeps it off until
--  docs/06-TEST-PLAN.md STORAGE-* all pass. Those tests verify the private
--  bucket, the patient-photos proxy and the RLS - i.e. that photos cannot be
--  read without the owning clinic's grant. Flip the flag only after those pass
--  on a throwaway project, never on a database holding real patient photos
--  before the storage path is proven. This file exists so the flip is one
--  paste instead of a hunt for the UPDATE, and so it is documented and
--  reversible in git.
--
--  WHAT CHANGES FOR THE USER: nothing visible. photoStore.js probes
--  ent_capability() (which reads this flag) on each save and routes bytes to
--  the bucket automatically. Existing inline photos are NOT migrated by this
--  file - they stay where they are; only NEW saves use the bucket. On a FRESH
--  deploy there are no existing photos, so every photo lands in the bucket
--  from day one.
--
--  TO REVERT: run the commented line at the bottom (flag back to FALSE); new
--  saves return to inline. Already-bucketed photos keep working because the
--  read path checks the report_photos rows, not the flag.
--
--  DEPENDS ON: 0006 (system_flags), 0009 (bucket + policies), the
--  patient-photos Edge Function deployed, and STORAGE-* tests passed.
-- =====================================================================

UPDATE public.system_flags
   SET enabled = TRUE,
       note    = 'PHASE 4 — enabled: photos live in the private patient-photos '
             || 'bucket (0038), not inline in reports.payload. Keeps the 500 MB '
             || 'database free of base64 so the free plan lasts years.'
 WHERE flag_key = 'photo_storage';

-- A guard, so a database that somehow has no such flag fails loudly here
-- rather than silently staying on the inline path that fills the disk.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.system_flags
         WHERE flag_key = 'photo_storage' AND enabled = TRUE
    ) THEN
        RAISE EXCEPTION 'refused: photo_storage could not be enabled. Apply 0006 first.';
    END IF;
END $$;

-- TO REVERT (uncomment):
-- UPDATE public.system_flags SET enabled = FALSE WHERE flag_key = 'photo_storage';

NOTIFY pgrst, 'reload schema';
