-- Keep restorable, data-only report versions for 90 days.
-- Photo binaries and photo references are deliberately excluded; restoring a
-- version preserves the report's currently attached photos.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_available_extensions
         WHERE name = 'pg_cron'
    ) THEN
        RAISE EXCEPTION 'pg_cron is unavailable. Enable Supabase Cron before applying report version history.';
    END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE IF NOT EXISTS public.report_versions (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id       uuid        NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
    report_type     public.ent_report_type NOT NULL,
    patient_name    text        NOT NULL DEFAULT '',
    patient_id      text        NOT NULL DEFAULT '',
    case_number     text        NOT NULL DEFAULT '',
    procedure_date  date,
    file_name       text        NOT NULL DEFAULT '',
    payload         jsonb       NOT NULL,
    actor_id        uuid        REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
    actor_label     text        NOT NULL DEFAULT 'Clinic staff',
    captured_at     timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
    CONSTRAINT report_versions_payload_size CHECK (octet_length(payload::text) < 20000000)
);

CREATE INDEX IF NOT EXISTS idx_report_versions_report_captured
    ON public.report_versions (report_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_versions_expiry
    ON public.report_versions (expires_at);

ALTER TABLE public.report_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.report_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.report_versions TO authenticated;
GRANT ALL ON TABLE public.report_versions TO service_role;

DROP POLICY IF EXISTS report_versions_select_report_access ON public.report_versions;
CREATE POLICY report_versions_select_report_access ON public.report_versions
    FOR SELECT TO authenticated
    USING (
        expires_at > now()
        AND EXISTS (
            SELECT 1
              FROM public.reports report
             WHERE report.id = public.report_versions.report_id
        )
    );

CREATE OR REPLACE FUNCTION public.ent_report_history_payload(p_payload jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN jsonb_typeof(p_payload -> 'formData') = 'object' THEN
            jsonb_set(
                p_payload
                    - 'dbSaved'
                    - 'savedToDbAt'
                    - 'images'
                    - 'photos'
                    - 'photo_paths'
                    - 'photoPaths',
                '{formData}',
                (p_payload -> 'formData')
                    - 'images'
                    - 'photos'
                    - 'photosFromStorage'
                    - 'photo_paths'
                    - 'photoPaths',
                true
            )
        ELSE
            p_payload
                - 'dbSaved'
                - 'savedToDbAt'
                - 'images'
                - 'photos'
                - 'photo_paths'
                - 'photoPaths'
    END
$$;

REVOKE ALL ON FUNCTION public.ent_report_history_payload(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ent_capture_report_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor_id uuid := public.ent_auth_uid();
    v_actor_label text := 'Clinic staff';
BEGIN
    IF OLD.is_draft
       OR jsonb_typeof(OLD.payload -> 'formData') IS DISTINCT FROM 'object' THEN
        RETURN NEW;
    END IF;

    IF OLD.report_type IS NOT DISTINCT FROM NEW.report_type
       AND OLD.patient_name IS NOT DISTINCT FROM NEW.patient_name
       AND OLD.patient_id IS NOT DISTINCT FROM NEW.patient_id
       AND OLD.case_number IS NOT DISTINCT FROM NEW.case_number
       AND OLD.procedure_date IS NOT DISTINCT FROM NEW.procedure_date
       AND OLD.file_name IS NOT DISTINCT FROM NEW.file_name
       AND public.ent_report_history_payload(OLD.payload)
           IS NOT DISTINCT FROM public.ent_report_history_payload(NEW.payload) THEN
        RETURN NEW;
    END IF;

    SELECT coalesce(
               nullif(btrim(profile.full_name), ''),
               nullif(btrim(profile.username), ''),
               'Clinic staff'
           )
      INTO v_actor_label
      FROM public.staff_profiles profile
     WHERE profile.id = v_actor_id;

    INSERT INTO public.report_versions (
        report_id,
        report_type,
        patient_name,
        patient_id,
        case_number,
        procedure_date,
        file_name,
        payload,
        actor_id,
        actor_label
    )
    VALUES (
        OLD.id,
        OLD.report_type,
        OLD.patient_name,
        OLD.patient_id,
        OLD.case_number,
        OLD.procedure_date,
        OLD.file_name,
        public.ent_report_history_payload(OLD.payload),
        v_actor_id,
        coalesce(v_actor_label, 'Clinic staff')
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ent_capture_report_version() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reports_capture_version ON public.reports;
CREATE TRIGGER trg_reports_capture_version
    BEFORE UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.ent_capture_report_version();

CREATE OR REPLACE FUNCTION public.ent_restore_report_version(p_version_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_version public.report_versions%ROWTYPE;
    v_current public.reports%ROWTYPE;
    v_payload jsonb;
    v_current_images jsonb := '[]'::jsonb;
BEGIN
    IF public.ent_auth_uid() IS NULL THEN
        RAISE EXCEPTION 'An authenticated staff account is required.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_version
      FROM public.report_versions
     WHERE id = p_version_id
       AND expires_at > now();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This report version is unavailable or has expired.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_current
      FROM public.reports
     WHERE id = v_version.report_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This report is unavailable or you do not have access.' USING ERRCODE = '42501';
    END IF;

    v_payload := v_version.payload;
    IF jsonb_typeof(v_current.payload -> 'formData' -> 'images') = 'array' THEN
        v_current_images := v_current.payload -> 'formData' -> 'images';
    END IF;
    IF jsonb_typeof(v_payload -> 'formData') = 'object' THEN
        v_payload := jsonb_set(
            v_payload,
            '{formData}',
            jsonb_set(v_payload -> 'formData', '{images}', v_current_images, true),
            true
        );
    END IF;
    v_payload := v_payload || jsonb_build_object(
        'dbSaved', true,
        'savedToDbAt', now()::text
    );

    UPDATE public.reports
       SET report_type = v_version.report_type,
           patient_name = v_version.patient_name,
           patient_id = v_version.patient_id,
           case_number = v_version.case_number,
           procedure_date = v_version.procedure_date,
           file_name = v_version.file_name,
           payload = v_payload
     WHERE id = v_current.id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'The report could not be restored; confirm you still have edit access.' USING ERRCODE = '42501';
    END IF;

    RETURN jsonb_build_object('ok', true, 'report_id', v_current.id);
END;
$$;

REVOKE ALL ON FUNCTION public.ent_restore_report_version(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ent_restore_report_version(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ent_purge_expired_report_versions()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted bigint;
BEGIN
    DELETE FROM public.report_versions
     WHERE expires_at <= now();
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.ent_purge_expired_report_versions() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
    v_job_id bigint;
BEGIN
    FOR v_job_id IN
        SELECT jobid
          FROM cron.job
         WHERE jobname = 'ent-report-version-retention'
    LOOP
        PERFORM cron.unschedule(v_job_id);
    END LOOP;

    PERFORM cron.schedule(
        'ent-report-version-retention',
        '17 3 * * *',
        'SELECT public.ent_purge_expired_report_versions()'
    );
END;
$$;

COMMENT ON TABLE public.report_versions IS
    'Data-only report versions retained for 90 days; current photo attachments are never copied or changed by restore.';
