-- =====================================================================
--  0047 · BOUNDED PATIENT RECORD LIST + VISIT COUNTS
-- ---------------------------------------------------------------------
--  The browser used to download every visible report (including inline
--  base64 images) just to draw the DB Records cards and count visits.
--  These SECURITY INVOKER functions return a small, paged projection and
--  aggregate only the patients on the current page. RLS on reports remains
--  the access boundary; neither function accepts a clinic or doctor scope.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ent_db_record_page(
    p_report_type public.ent_report_type,
    p_search      text    DEFAULT NULL,
    p_site        text    DEFAULT NULL,
    p_sort        text    DEFAULT 'date',
    p_limit       integer DEFAULT 100,
    p_offset      integer DEFAULT 0
)
RETURNS TABLE (
    id              uuid,
    record_key      text,
    report_type     public.ent_report_type,
    patient_name    text,
    patient_id      text,
    case_number     text,
    procedure_date  date,
    created_by      uuid,
    created_by_name text,
    created_at      timestamptz,
    updated_at      timestamptz,
    doctor_id       uuid,
    is_draft        boolean,
    db_saved        boolean,
    site            text,
    form_data       jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT
        r.id,
        r.record_key,
        r.report_type,
        r.patient_name,
        r.patient_id,
        r.case_number,
        r.procedure_date,
        r.created_by,
        r.created_by_name,
        r.created_at,
        r.updated_at,
        r.doctor_id,
        r.is_draft,
        (r.payload->>'dbSaved') = 'true' AS db_saved,
        r.payload->>'site' AS site,
        CASE
            WHEN jsonb_typeof(r.payload->'formData') = 'object'
                THEN (r.payload->'formData') - ARRAY['images', 'photosFromStorage']
            ELSE NULL
        END AS form_data
      FROM public.reports AS r
     WHERE r.report_type = p_report_type
       AND r.deleted_at IS NULL
       AND (
            r.is_draft IS FALSE
         OR r.is_draft IS NULL
         OR r.payload->>'dbSaved' = 'true'
       )
       AND (
            nullif(btrim(p_site), '') IS NULL
         OR r.payload->>'site' = upper(btrim(p_site))
       )
       AND (
            nullif(btrim(p_search), '') IS NULL
         OR r.patient_name ILIKE '%' || left(btrim(p_search), 200) || '%'
         OR r.patient_id ILIKE '%' || left(btrim(p_search), 200) || '%'
         OR r.case_number ILIKE '%' || left(btrim(p_search), 200) || '%'
         OR r.record_key ILIKE '%' || left(btrim(p_search), 200) || '%'
         OR r.created_by::text ILIKE '%' || left(btrim(p_search), 200) || '%'
         OR r.created_by_name ILIKE '%' || left(btrim(p_search), 200) || '%'
       )
     ORDER BY
        CASE WHEN p_sort = 'name' THEN lower(btrim(r.patient_name)) END ASC NULLS LAST,
        CASE WHEN p_sort = 'name' THEN r.updated_at END DESC,
        CASE WHEN p_sort <> 'name' THEN r.updated_at END DESC,
        r.id DESC
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 100)
    OFFSET least(greatest(coalesce(p_offset, 0), 0), 1000000);
$$;

COMMENT ON FUNCTION public.ent_db_record_page(
    public.ent_report_type, text, text, text, integer, integer
) IS
    '0047: bounded DB Records page inside caller RLS. Returns only card fields and form values needed for progress; inline image payloads and storage-photo metadata are never downloaded by list browsing.';

REVOKE ALL ON FUNCTION public.ent_db_record_page(
    public.ent_report_type, text, text, text, integer, integer
) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_db_record_page(
    public.ent_report_type, text, text, text, integer, integer
) TO authenticated;

CREATE OR REPLACE FUNCTION public.ent_patient_record_stats(p_patient_keys text[])
RETURNS TABLE (stats_key text, records bigint, visits bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    WITH visible AS (
        SELECT
            CASE
                WHEN nullif(btrim(r.patient_id), '') IS NOT NULL
                    THEN 'id:' || lower(regexp_replace(btrim(r.patient_id), '\s+', ' ', 'g'))
                ELSE 'name:' || lower(regexp_replace(btrim(r.patient_name), '\s+', ' ', 'g'))
            END AS stats_key,
            coalesce(r.procedure_date, r.created_at::date) AS visit_day
          FROM public.reports AS r
         WHERE r.deleted_at IS NULL
           AND (
                r.is_draft IS FALSE
             OR r.is_draft IS NULL
             OR r.payload->>'dbSaved' = 'true'
           )
           AND coalesce(array_length(p_patient_keys, 1), 0) > 0
    )
    SELECT v.stats_key,
           count(*)::bigint,
           greatest(count(DISTINCT v.visit_day), 1)::bigint
      FROM visible AS v
     WHERE v.stats_key = ANY(p_patient_keys)
       AND v.stats_key <> 'name:'
     GROUP BY v.stats_key;
$$;

COMMENT ON FUNCTION public.ent_patient_record_stats(text[]) IS
    '0047: exact record and distinct-visit counts for requested patient keys, computed over rows visible to the caller through reports RLS.';

REVOKE ALL ON FUNCTION public.ent_patient_record_stats(text[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_patient_record_stats(text[]) TO authenticated;

DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('ent_db_record_page', 'ent_patient_record_stats')
       AND NOT p.prosecdef;
    IF n <> 2 THEN
        RAISE EXCEPTION '0047 guard failed: expected 2 SECURITY INVOKER functions, found %', n;
    END IF;
    RAISE NOTICE '0047 OK: bounded record listing + RLS-scoped patient statistics created';
END $$;
