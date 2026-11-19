-- Clinic-wide suggestions contain only allowlisted clinical form fields.
-- Patient identifiers, HCI details, signatures, and image bytes are excluded.

CREATE TABLE public.ent_clinic_clinical_suggestions (
    report_id uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
    clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
    report_type text NOT NULL CHECK (report_type IN ('cf4', 'nasal', 'laryngeal')),
    field_key text NOT NULL,
    suggestion_value text NOT NULL CHECK (length(suggestion_value) BETWEEN 1 AND 5000),
    normalized_value text GENERATED ALWAYS AS (lower(btrim(suggestion_value))) STORED,
    seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (report_id, field_key, normalized_value)
);

CREATE INDEX ent_clinic_clinical_suggestions_lookup
    ON public.ent_clinic_clinical_suggestions
       (clinic_id, report_type, field_key, seen_at DESC);

ALTER TABLE public.ent_clinic_clinical_suggestions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ent_clinic_clinical_suggestions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ent_clinical_suggestion_values(
    p_report_type text,
    p_payload jsonb
)
RETURNS TABLE (field_key text, suggestion_value text)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
    WITH payload AS (
        SELECT CASE
            WHEN jsonb_typeof(p_payload -> 'formData') = 'object'
                THEN p_payload -> 'formData'
            ELSE '{}'::jsonb
        END AS form_data
    ),
    allowed AS (
        SELECT CASE p_report_type
            WHEN 'cf4' THEN ARRAY[
                'chiefComplaint', 'admittingDiagnosis', 'dischargeDiagnosis',
                'firstCaseRateCode', 'secondCaseRateCode', 'historyPresentIllness',
                'pertinentPastMedicalHistory', 'obGravida', 'obPara', 'obDetails',
                'obLmp', 'painSite', 'symptomOthers', 'referredReason',
                'alteredSensoriumDetail', 'vitalBp', 'vitalHr', 'vitalRr',
                'vitalTemp', 'vitalWeight', 'vitalHeight', 'heentOthers',
                'chestLungsOthers', 'cvsOthers', 'abdomenOthers', 'guOthers',
                'skinExtremitiesOthers', 'neuroExamOthers', 'courseOrder',
                'drugGenericName', 'drugQuantity', 'drugTotalCost'
            ]::text[]
            WHEN 'nasal' THEN ARRAY[
                'durationOfOperation', 'classification', 'rvsCode', 'icd10Code',
                'preOpDiagnosis', 'endoscopyType', 'procedureDescription',
                'indication', 'anesthesiaUsed', 'septum', 'discharge', 'mucosa',
                'it', 'mt', 'mm', 'im', 'omc', 'nasopharynx', 'impression',
                'recommendation'
            ]::text[]
            WHEN 'laryngeal' THEN ARRAY[
                'durationOfOperation', 'classification', 'rvsCode', 'icd10Code',
                'preOpDiagnosis', 'endoscopyType', 'procedureDescription',
                'indication', 'anesthesiaUsed', 'epiglottis', 'vallecula',
                'pyriformSinuses', 'arytenoids', 'falseVocalCords', 'trueVocalCords',
                'vocalCordMobility', 'subglottis', 'impression', 'recommendation'
            ]::text[]
            ELSE ARRAY[]::text[]
        END AS field_keys
    ),
    regular_fields AS (
        SELECT entry.key AS field_key, item.value #>> '{}' AS suggestion_value
          FROM payload
          CROSS JOIN allowed
          CROSS JOIN LATERAL jsonb_each(payload.form_data) AS entry(key, value)
          CROSS JOIN LATERAL jsonb_array_elements(
              CASE
                  WHEN jsonb_typeof(entry.value) = 'array' THEN entry.value
                  ELSE jsonb_build_array(entry.value)
              END
          ) AS item(value)
         WHERE entry.key = ANY (allowed.field_keys)
           AND jsonb_typeof(item.value) = 'string'
    ),
    image_fields AS (
        SELECT image.field_key, image.suggestion_value
          FROM payload
          CROSS JOIN LATERAL jsonb_array_elements(
              CASE
                  WHEN jsonb_typeof(payload.form_data -> 'imageDetails') = 'array'
                      THEN payload.form_data -> 'imageDetails'
                  ELSE '[]'::jsonb
              END
          ) AS detail(value)
          CROSS JOIN LATERAL (
              VALUES
                  ('imageFinding', detail.value ->> 'finding'),
                  ('imageDescription', detail.value ->> 'description')
          ) AS image(field_key, suggestion_value)
         WHERE p_report_type IN ('nasal', 'laryngeal')
    )
    SELECT candidate.field_key, btrim(candidate.suggestion_value)
      FROM (
          SELECT * FROM regular_fields
          UNION ALL
          SELECT * FROM image_fields
      ) AS candidate
     WHERE candidate.suggestion_value IS NOT NULL
       AND length(btrim(candidate.suggestion_value)) BETWEEN 1 AND 5000
$$;

REVOKE ALL ON FUNCTION public.ent_clinical_suggestion_values(text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ent_refresh_clinical_suggestions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.ent_clinic_clinical_suggestions WHERE report_id = OLD.id;
        RETURN OLD;
    END IF;

    DELETE FROM public.ent_clinic_clinical_suggestions WHERE report_id = NEW.id;

    IF NEW.deleted_at IS NOT NULL OR NEW.is_draft OR NEW.report_type::text NOT IN ('cf4', 'nasal', 'laryngeal') THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.ent_clinic_clinical_suggestions (
        report_id, clinic_id, report_type, field_key, suggestion_value
    )
    SELECT NEW.id, NEW.clinic_id, NEW.report_type::text, extracted.field_key,
           btrim(extracted.suggestion_value)
      FROM public.ent_clinical_suggestion_values(NEW.report_type::text, NEW.payload) AS extracted
     WHERE extracted.suggestion_value IS NOT NULL
       AND length(btrim(extracted.suggestion_value)) BETWEEN 1 AND 5000
        AND (
            nullif(btrim(NEW.patient_name), '') IS NULL
            OR position(lower(btrim(NEW.patient_name)) IN lower(extracted.suggestion_value)) = 0
        )
        AND (
            nullif(btrim(NEW.patient_id), '') IS NULL
            OR position(lower(btrim(NEW.patient_id)) IN lower(extracted.suggestion_value)) = 0
        )
        AND (
            nullif(btrim(NEW.case_number), '') IS NULL
            OR position(lower(btrim(NEW.case_number)) IN lower(extracted.suggestion_value)) = 0
        )
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.ent_refresh_clinical_suggestions() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_reports_refresh_clinical_suggestions
AFTER INSERT OR UPDATE OR DELETE
ON public.reports
FOR EACH ROW
EXECUTE FUNCTION public.ent_refresh_clinical_suggestions();

INSERT INTO public.ent_clinic_clinical_suggestions (
    report_id, clinic_id, report_type, field_key, suggestion_value, seen_at
)
SELECT report.id, report.clinic_id, report.report_type::text, extracted.field_key,
       btrim(extracted.suggestion_value), coalesce(report.saved_at, report.updated_at, now())
  FROM public.reports AS report
  CROSS JOIN LATERAL public.ent_clinical_suggestion_values(
      report.report_type::text, report.payload
  ) AS extracted
 WHERE report.deleted_at IS NULL
   AND NOT report.is_draft
   AND report.report_type::text IN ('cf4', 'nasal', 'laryngeal')
   AND length(btrim(extracted.suggestion_value)) BETWEEN 1 AND 5000
   AND (
       nullif(btrim(report.patient_name), '') IS NULL
       OR position(lower(btrim(report.patient_name)) IN lower(extracted.suggestion_value)) = 0
   )
   AND (
       nullif(btrim(report.patient_id), '') IS NULL
       OR position(lower(btrim(report.patient_id)) IN lower(extracted.suggestion_value)) = 0
   )
   AND (
       nullif(btrim(report.case_number), '') IS NULL
       OR position(lower(btrim(report.case_number)) IN lower(extracted.suggestion_value)) = 0
   )
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.ent_clinic_clinical_suggestions(
    p_report_type text,
    p_doctor_id uuid
)
RETURNS TABLE (field_key text, suggestion_value text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    me public.staff_profiles%ROWTYPE;
    target_doctor public.staff_profiles%ROWTYPE;
BEGIN
    IF p_report_type IS NULL
       OR p_report_type NOT IN ('cf4', 'nasal', 'laryngeal')
       OR p_doctor_id IS NULL THEN
        RAISE EXCEPTION 'Invalid clinic suggestion request.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO me
      FROM public.staff_profiles
     WHERE id = public.ent_auth_uid()
       AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active staff account required.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO target_doctor
      FROM public.staff_profiles
     WHERE id = p_doctor_id
       AND role = 'doctor'
       AND is_active
       AND clinic_id IS NOT NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active clinic doctor required.' USING ERRCODE = '42501';
    END IF;

    IF me.role = 'doctor' THEN
        IF me.id <> target_doctor.id THEN
            RAISE EXCEPTION 'Doctors may request suggestions only for their own clinic.' USING ERRCODE = '42501';
        END IF;
    ELSIF me.role = 'secretary' THEN
        IF NOT public.ent_is_my_doctor(target_doctor.id) THEN
            RAISE EXCEPTION 'Secretary is not assigned to this doctor in the active clinic.' USING ERRCODE = '42501';
        END IF;
    ELSIF me.role = 'admin' THEN
        IF NOT public.ent_admin_covers_clinic(target_doctor.clinic_id)
           OR (
               public.ent_admin_active_clinic_id() IS NULL
               AND target_doctor.clinic_id IS DISTINCT FROM me.clinic_id
           )
           OR (
               public.ent_admin_active_clinic_id() IS NOT NULL
               AND public.ent_admin_active_clinic_id() <> target_doctor.clinic_id
           )
           OR (
               public.ent_admin_active_doctor_id() IS NOT NULL
               AND public.ent_admin_active_doctor_id() <> target_doctor.id
           ) THEN
            RAISE EXCEPTION 'Administrator clinic context does not cover this doctor.' USING ERRCODE = '42501';
        END IF;
    ELSE
        RAISE EXCEPTION 'This account cannot request clinic suggestions.' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT suggestion.field_key,
           (array_agg(suggestion.suggestion_value
               ORDER BY suggestion.seen_at DESC, suggestion.report_id DESC))[1]
      FROM public.ent_clinic_clinical_suggestions AS suggestion
     WHERE suggestion.clinic_id = target_doctor.clinic_id
       AND suggestion.report_type = p_report_type
     GROUP BY suggestion.field_key, suggestion.normalized_value
     ORDER BY suggestion.field_key, max(suggestion.seen_at) DESC,
              min(suggestion.normalized_value);
END
$$;

REVOKE ALL ON FUNCTION public.ent_clinic_clinical_suggestions(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ent_clinic_clinical_suggestions(text, uuid) TO authenticated;

COMMENT ON FUNCTION public.ent_clinic_clinical_suggestions(text, uuid) IS
    'Returns only allowlisted clinical suggestions for the selected doctor''s clinic after validating the caller''s live role, assignment, and active clinic context.';
