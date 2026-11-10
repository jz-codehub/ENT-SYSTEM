-- =====================================================================
--  0048 · EXACT DASHBOARD COUNTS WITHOUT DOWNLOADING REPORT ROWS
-- ---------------------------------------------------------------------
--  The dashboard still loads a bounded recent-record window for its
--  patient list and follow-up card. These RLS-invoker aggregates provide
--  exact counts for the dashboard's period tiles and chart days without
--  sending thousands of report rows to the browser.
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_reports_dashboard_counts
    ON public.reports (created_at DESC)
    WHERE is_draft IS FALSE AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.ent_dashboard_summary(
    p_windows      jsonb,
    p_doctor_id    uuid    DEFAULT NULL,
    p_scope_all    boolean DEFAULT false,
    p_username     text    DEFAULT NULL
)
RETURNS TABLE (
    bucket_key     text,
    reports        bigint,
    patient_count  bigint,
    endo_count     bigint,
    cf4_count      bigint,
    nasal_reports  bigint,
    laryngeal_reports bigint,
    cf4_reports    bigint,
    other_reports  bigint,
    mine           bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    requested_start timestamptz;
    requested_end   timestamptz;
BEGIN
    IF jsonb_typeof(p_windows) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_windows) < 1
       OR jsonb_array_length(p_windows) > 64 THEN
        RAISE EXCEPTION 'Dashboard summary requires between 1 and 64 time windows.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_to_recordset(p_windows)
               AS w(bucket_key text, starts_at timestamptz, ends_at timestamptz)
         WHERE w.bucket_key IS NULL
            OR w.bucket_key !~ '^(today|yesterday|week|lastWeek|weekFull|month|prevMonth|year|[0-9]{4}-[0-9]{2}-[0-9]{2})$'
            OR w.starts_at IS NULL
            OR w.ends_at IS NULL
            OR w.starts_at >= w.ends_at
            OR w.ends_at - w.starts_at > interval '367 days'
    ) THEN
        RAISE EXCEPTION 'Dashboard summary contains an invalid time window.';
    END IF;

    SELECT min(w.starts_at), max(w.ends_at)
      INTO requested_start, requested_end
      FROM jsonb_to_recordset(p_windows)
           AS w(bucket_key text, starts_at timestamptz, ends_at timestamptz);
    IF requested_end - requested_start > interval '367 days' THEN
        RAISE EXCEPTION 'Dashboard summary time range exceeds 367 days.';
    END IF;

    RETURN QUERY
    WITH windows AS (
        SELECT w.bucket_key, w.starts_at, w.ends_at
          FROM jsonb_to_recordset(p_windows)
               AS w(bucket_key text, starts_at timestamptz, ends_at timestamptz)
         WHERE w.bucket_key IS NOT NULL
           AND w.starts_at IS NOT NULL
           AND w.ends_at IS NOT NULL
           AND w.starts_at < w.ends_at
           AND w.ends_at - w.starts_at <= interval '367 days'
    ),
    bounds AS (
        SELECT min(starts_at) AS starts_at, max(ends_at) AS ends_at
          FROM windows
    ),
    visible AS (
        SELECT
            r.created_at,
            r.report_type::text AS report_type,
            r.created_by::text AS created_by,
            CASE
                WHEN nullif(btrim(r.patient_id), '') IS NOT NULL
                    THEN 'id:' || lower(regexp_replace(btrim(r.patient_id), '\s+', ' ', 'g'))
                WHEN nullif(btrim(r.patient_name), '') IS NOT NULL
                    THEN 'nm:' || lower(regexp_replace(btrim(r.patient_name), '\s+', ' ', 'g'))
                WHEN nullif(btrim(r.file_name), '') IS NOT NULL
                    THEN 'fl:' || lower(btrim(r.file_name))
                ELSE 'row:' || coalesce(r.created_at::text, '')
            END || '|d:' || coalesce(
                to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
                r.procedure_date::text,
                'nodate'
            ) AS patient_key
          FROM public.reports AS r
          CROSS JOIN bounds AS b
         WHERE b.starts_at IS NOT NULL
           AND r.created_at >= b.starts_at
           AND r.created_at < b.ends_at
           AND r.is_draft IS FALSE
           AND r.deleted_at IS NULL
           AND (
                coalesce(p_scope_all, false)
             OR p_doctor_id IS NULL
             OR r.doctor_id IS NULL
             OR r.doctor_id = p_doctor_id
           )
    )
    SELECT
        w.bucket_key,
        count(v.created_at)::bigint,
        count(DISTINCT v.patient_key)::bigint,
        count(DISTINCT v.patient_key)
            FILTER (WHERE v.report_type IN ('nasal', 'laryngeal'))::bigint,
        count(DISTINCT v.patient_key)
            FILTER (WHERE v.report_type = 'cf4')::bigint,
        count(*) FILTER (WHERE v.report_type = 'nasal')::bigint,
        count(*) FILTER (WHERE v.report_type = 'laryngeal')::bigint,
        count(*) FILTER (WHERE v.report_type = 'cf4')::bigint,
        count(*) FILTER (
            WHERE v.report_type IS NOT NULL
              AND v.report_type NOT IN ('nasal', 'laryngeal', 'cf4')
        )::bigint,
        count(*) FILTER (
            WHERE lower(v.created_by) = lower(coalesce(p_username, ''))
        )::bigint
      FROM windows AS w
      LEFT JOIN visible AS v
        ON v.created_at >= w.starts_at
       AND v.created_at < w.ends_at
     GROUP BY w.bucket_key, w.starts_at, w.ends_at
     ORDER BY w.starts_at, w.bucket_key;
END
$$;

COMMENT ON FUNCTION public.ent_dashboard_summary(jsonb, uuid, boolean, text) IS
    '0048: small RLS-scoped report and distinct-patient aggregates for bounded dashboard windows; report rows remain in the database.';

REVOKE ALL ON FUNCTION public.ent_dashboard_summary(jsonb, uuid, boolean, text)
    FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_dashboard_summary(jsonb, uuid, boolean, text)
    TO authenticated;

DO $$
DECLARE is_invoker boolean;
BEGIN
    SELECT NOT p.prosecdef INTO is_invoker
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ent_dashboard_summary'
       AND pg_get_function_identity_arguments(p.oid)
           = 'p_windows jsonb, p_doctor_id uuid, p_scope_all boolean, p_username text';
    IF is_invoker IS DISTINCT FROM true THEN
        RAISE EXCEPTION '0048 guard failed: dashboard summary must be SECURITY INVOKER.';
    END IF;
    RAISE NOTICE '0048 OK: exact dashboard aggregates created under caller RLS';
END
$$;
