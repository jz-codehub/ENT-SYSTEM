-- Clinic-scoped Doctor work totals and matching patient/date status rows.
-- Safe to reapply after the original 0055 counts migration.

CREATE INDEX IF NOT EXISTS idx_reports_clinic_doctor_work_counts
    ON public.reports (clinic_id, procedure_date)
    WHERE deleted_at IS NULL
      AND report_type IN ('cf4', 'nasal', 'laryngeal');

CREATE OR REPLACE FUNCTION public.ent_clinic_doctor_work_status(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    me public.staff_profiles%ROWTYPE;
    target_doctor public.staff_profiles%ROWTYPE;
    result jsonb;
BEGIN
    IF p_doctor_id IS NULL THEN
        RAISE EXCEPTION 'An active clinic doctor is required.' USING ERRCODE = '22023';
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
            RAISE EXCEPTION 'Doctors may request status only for their own clinic.' USING ERRCODE = '42501';
        END IF;
    ELSIF me.role = 'secretary' THEN
        IF NOT public.ent_is_my_doctor(target_doctor.id) THEN
            RAISE EXCEPTION 'Secretary is not assigned to this doctor in the active clinic.' USING ERRCODE = '42501';
        END IF;
    ELSIF me.role = 'admin' THEN
        IF NOT public.ent_admin_covers_clinic(target_doctor.clinic_id)
           OR public.ent_admin_active_clinic_id() IS DISTINCT FROM target_doctor.clinic_id
           OR public.ent_admin_active_doctor_id() IS DISTINCT FROM target_doctor.id THEN
            RAISE EXCEPTION 'Administrator clinic context does not cover this doctor.' USING ERRCODE = '42501';
        END IF;
    ELSE
        RAISE EXCEPTION 'This account cannot request clinic doctor-work status.' USING ERRCODE = '42501';
    END IF;

    WITH eligible_reports AS (
        SELECT
            report.id AS report_id,
            report.record_key,
            report.doctor_id,
            report.patient_name,
            report.case_number,
            report.report_type::text AS report_type,
            coalesce(
                report.procedure_date,
                timezone('Asia/Manila', report.created_at)::date
            ) AS visit_date,
            coalesce(report.updated_at, report.created_at) AS updated_at,
            public.ent_doctor_work_percent(report.report_type, report.payload) AS doctor_work_percent,
            public.ent_doctor_work_percent(report.report_type, report.payload) = 100 AS is_complete,
            CASE
                WHEN nullif(btrim(report.patient_id), '') IS NOT NULL
                    THEN 'id:' || lower(regexp_replace(btrim(report.patient_id), '\s+', ' ', 'g'))
                WHEN nullif(btrim(report.patient_name), '') IS NOT NULL
                    THEN 'name:' || lower(regexp_replace(btrim(report.patient_name), '\s+', ' ', 'g'))
                WHEN nullif(btrim(report.case_number), '') IS NOT NULL
                    THEN 'case:' || lower(regexp_replace(btrim(report.case_number), '\s+', ' ', 'g'))
                ELSE 'row:' || report.id::text
            END AS patient_key
          FROM public.reports AS report
         WHERE report.clinic_id = target_doctor.clinic_id
           AND report.deleted_at IS NULL
           AND report.report_type IN ('cf4', 'nasal', 'laryngeal')
           AND jsonb_typeof(report.payload -> 'formData') = 'object'
           AND report.is_draft IS FALSE
    ),
    patient_dates AS (
        SELECT
            patient_key,
            visit_date,
            coalesce(max(nullif(btrim(patient_name), '')), max(nullif(btrim(case_number), '')), 'Unnamed patient') AS patient_name,
            max(nullif(btrim(case_number), '')) AS case_number,
            bool_and(is_complete) AS is_complete,
            min(doctor_work_percent) AS doctor_work_percent,
            array_agg(DISTINCT report_type ORDER BY report_type) AS report_types,
            (array_agg(record_key ORDER BY updated_at DESC, report_id DESC)
                FILTER (WHERE doctor_id = target_doctor.id))[1] AS record_key,
            (array_agg(report_type ORDER BY updated_at DESC, report_id DESC)
                FILTER (WHERE doctor_id = target_doctor.id))[1] AS action_report_type,
            max(updated_at) AS updated_at
          FROM eligible_reports
         GROUP BY patient_key, visit_date
    ),
    summary AS (
        SELECT
            count(*) FILTER (WHERE is_complete)::bigint AS completed_count,
            count(*) FILTER (WHERE NOT is_complete)::bigint AS incomplete_count,
            coalesce(
                jsonb_agg(
                    jsonb_build_object(
                        'patient_name', patient_name,
                        'case_number', case_number,
                        'visit_date', visit_date,
                        'report_types', report_types,
                        'is_complete', is_complete,
                        'doctor_work_percent', doctor_work_percent,
                        'record_key', record_key,
                        'action_report_type', action_report_type,
                        'updated_at', updated_at
                    )
                    ORDER BY visit_date DESC, lower(patient_name), patient_key
                ),
                '[]'::jsonb
            ) AS records
          FROM patient_dates
    )
    SELECT jsonb_build_object(
        'completed_count', completed_count,
        'incomplete_count', incomplete_count,
        'total_count', completed_count + incomplete_count,
        'records', records
    )
      INTO result
      FROM summary;

    RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.ent_clinic_doctor_work_status(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ent_clinic_doctor_work_status(uuid)
    TO authenticated;

COMMENT ON FUNCTION public.ent_clinic_doctor_work_status(uuid) IS
    'Returns final saved active-clinic patient/date doctor-work status rows and matching totals. Excludes shared drafts, form payload, and patient IDs; only the selected doctor''s own report key is included for opening an authorized record.';

CREATE OR REPLACE FUNCTION public.ent_clinic_doctor_work_counts(p_doctor_id uuid)
RETURNS TABLE (completed_count bigint, incomplete_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT (status.result ->> 'completed_count')::bigint,
           (status.result ->> 'incomplete_count')::bigint
      FROM (
          SELECT public.ent_clinic_doctor_work_status(p_doctor_id) AS result
      ) AS status
$$;

REVOKE ALL ON FUNCTION public.ent_clinic_doctor_work_counts(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ent_clinic_doctor_work_counts(uuid)
    TO authenticated;
COMMENT ON FUNCTION public.ent_clinic_doctor_work_counts(uuid) IS
    'Returns final-saved-only active-clinic totals from the same patient/date grouping as ent_clinic_doctor_work_status.';

DO $$
DECLARE
    fn_source text;
BEGIN
    SELECT pg_get_functiondef('public.ent_clinic_doctor_work_status(uuid)'::regprocedure)
      INTO fn_source;

    IF fn_source IS NULL
       OR fn_source NOT ILIKE '%SECURITY DEFINER%'
       OR fn_source NOT ILIKE '%ent_is_my_doctor%'
       OR fn_source NOT ILIKE '%ent_admin_active_clinic_id%'
       OR fn_source NOT ILIKE '%report.clinic_id = target_doctor.clinic_id%'
       OR fn_source NOT ILIKE '%GROUP BY patient_key, visit_date%'
       OR fn_source NOT ILIKE '%bool_and(is_complete)%'
       OR fn_source NOT ILIKE '%ent_doctor_work_percent(report.report_type, report.payload)%'
       OR fn_source NOT ILIKE '%report.is_draft IS FALSE%'
       OR fn_source ILIKE '%draftShared%'
       OR fn_source NOT ILIKE '%WHERE doctor_id = target_doctor.id%'
       OR fn_source ILIKE '%report.payload AS%'
       OR has_function_privilege('anon', 'public.ent_clinic_doctor_work_status(uuid)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.ent_clinic_doctor_work_status(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Clinic doctor-work status scope/grant self-check failed.';
    END IF;

    IF pg_get_functiondef('public.ent_clinic_doctor_work_counts(uuid)'::regprocedure)
           NOT ILIKE '%ent_clinic_doctor_work_status(p_doctor_id)%'
       OR has_function_privilege('anon', 'public.ent_clinic_doctor_work_counts(uuid)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.ent_clinic_doctor_work_counts(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Clinic doctor-work count wrapper self-check failed.';
    END IF;

    RAISE NOTICE '0055 verified: final-only clinic status rows and totals share one patient-date grouping.';
END
$$;
