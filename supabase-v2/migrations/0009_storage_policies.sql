-- =====================================================================
--  0009 · private photo bucket + storage authorization
-- ---------------------------------------------------------------------
--  OBJECT PATH CONVENTION  (built ONLY by the Edge Function, never by
--  the browser):
--      clinics/<clinic_uuid>/reports/<report_uuid>/<uuid>.<ext>
--
--  Two independent reasons a guessed path is useless:
--    1. The bucket is private and there is no public policy at all.
--    2. Access is decided by the report_photos ROW for that exact
--       object_path, joined to the report's clinic/doctor. There is no
--       policy that looks only at the path prefix, so "walking" a path
--       or guessing a uuid resolves to nothing.
--
--  The browser never calls Storage directly. It calls the patient-photos
--  Edge Function, which validates size/MIME/extension/count/ownership,
--  uploads with service_role, and returns either a 60-second signed URL
--  or the bytes. See edge-functions/patient-photos/index.ts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The bucket: private, size-capped, type-restricted.
--    (Re-running this never makes the bucket public.)
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'patient-photos',
    'patient-photos',
    FALSE,
    15728640,                               -- 15 MB per object
    ARRAY['image/jpeg','image/png','image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
   SET public             = FALSE,          -- force private, every run
       file_size_limit    = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ---------------------------------------------------------------------
-- 2. Decode an object name into the facts the policy needs.
--    Anything malformed returns NULL, and NULL means "deny".
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_photo_object_report(name text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT (split_part(name, '/', 4))::uuid
      FROM (SELECT btrim(coalesce(name, '')) AS name) s
     WHERE s.name ~ '^clinics/[0-9a-fA-F-]{36}/reports/[0-9a-fA-F-]{36}/[^/]{1,200}$'
$$;

CREATE OR REPLACE FUNCTION public.ent_photo_object_clinic(name text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT (split_part(name, '/', 2))::uuid
      FROM (SELECT btrim(coalesce(name, '')) AS name) s
     WHERE s.name ~ '^clinics/[0-9a-fA-F-]{36}/reports/[0-9a-fA-F-]{36}/[^/]{1,200}$'
$$;


-- ---------------------------------------------------------------------
-- 3. THE authorization decision for one object.
--    Registered paths only, and the report's own access rule decides.
--    Every hop is an index lookup, so this stays cheap inside a policy.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_access_photo(p_operation text, p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.report_photos p
          JOIN public.reports       r ON r.id = p.report_id
         WHERE p.object_path = btrim(p_object_name)
           AND p.deleted_at IS NULL
           -- the path must agree with the row, so a row cannot be used to
           -- read a different object than the one it describes
           AND r.clinic_id = public.ent_photo_object_clinic(p_object_name)
           AND r.id        = public.ent_photo_object_report(p_object_name)
           -- and the caller must be allowed on that report
           AND public.ent_may_touch_report(r.clinic_id, r.doctor_id)
    )
$$;


-- ---------------------------------------------------------------------
-- 4. Storage policies — NOT applied here, on purpose.
--
--  An earlier draft of this file claimed "postgres owns storage.objects,
--  which is why this is legal from the SQL editor". That is FALSE on a
--  hosted project and cost a failed migration:
--
--      ERROR: 42501: must be owner of table objects
--
--  storage.objects is owned by supabase_storage_admin. The Dashboard SQL
--  editor runs as `postgres`, which is neither that owner nor a member of
--  that role, so ALTER TABLE / CREATE POLICY / DROP POLICY on the storage
--  schema are all refused. Supabase's own docs call the schema read-only
--  and treat Storage as an API-only surface.
--
--  Nothing is lost: this app NEVER lets the browser touch Storage. The
--  patient-photos Edge Function holds the service_role key, and
--  service_role has BYPASSRLS, so it bypasses these policies entirely.
--  They are defence-in-depth for the day someone grants direct Storage
--  access, which is exactly why they are worth applying -- through the
--  one surface that can: Dashboard > Storage > Policies.
--
--  They live in 0009b_storage_policies_dashboard.sql. Run this file first;
--  it completes on its own. See that file for the paste-in steps.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE
      '0009 complete: bucket + helpers done. The 4 storage.objects policies still need applying via Dashboard > Storage > Policies (see 0009b_storage_policies_dashboard.sql).';
END $$;



-- ---------------------------------------------------------------------
-- 5. Privileges for the helpers created in THIS file.
--    Postgres hands a new function EXECUTE to PUBLIC by default, so
--    anything created after 0007 must be tightened here or it silently
--    re-opens the door 0007 just shut. anon must never reach these, not
--    even as a probe.
--    (ent_photo_object_report(uuid) below is only listed defensively in
--     case an earlier draft of this file left an overload behind.)
-- ---------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.ent_photo_object_report(text)',
        'public.ent_photo_object_clinic(text)',
        'public.ent_may_access_photo(text,text)'
    ] LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', f);
        EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO authenticated', f);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
