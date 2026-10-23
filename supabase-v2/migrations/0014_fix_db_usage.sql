-- =====================================================================
--  0014 . repair admin_db_usage   (it crashed, and it lied)
-- ---------------------------------------------------------------------
--  TWO defects, both found by calling the live function, not by reading
--  it. It returned:
--
--      HTTP 400  {"code":"22003","message":"integer out of range"}
--
--  1. INTEGER OVERFLOW - the function never returned anything at all.
--     The plan limits were bare integer arithmetic:
--
--         'db_limit_bytes',      500 * 1024 * 1024,     =    524,288,000  ok
--         'storage_limit_bytes',   1 * 1024 * 1024 * 1024 =  1,073,741,824  ok
--         'egress_limit_bytes',   5 * 1024 * 1024 * 1024 =  5,368,709,120  OVERFLOWS
--
--     int4 tops out at 2,147,483,647. Postgres evaluates an integer
--     literal expression in int4, so the egress line raised 22003 and the
--     Database usage tab rendered an error instead of numbers. Each limit
--     is now a bigint literal.
--
--  2. THE ROW COUNTS WERE ESTIMATES PRESENTED AS FACTS.
--     `pg_class.reltuples` is the planner's estimate. For a table that has
--     never been ANALYZEd it is simply -1, which the old function turned
--     into 0. Proven against the live project: `reports` holds 9 rows and
--     the panel would have shown 0. The payload also carried 'exact':true,
--     which was false.
--
--     A clinic database is small - single-digit millions of rows at worst -
--     so one exact count(*) per table costs nothing measurable and is
--     actually right. It needs dynamic SQL because the table name is not
--     known until runtime; format('%I') quotes the identifier properly, so
--     this is not string-concatenated SQL.
--
--     reltuples is still reported, under its own key, purely so anyone can
--     compare estimate against reality.
--
--  Nothing else changes: same name, same signature, same JSON keys, so
--  admin.js keeps working. Only the numbers become true.
--
--  IDEMPOTENT : yes.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_db_usage()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_db_bytes      bigint;
    v_tables        jsonb := '[]'::jsonb;
    v_rows          jsonb := '[]'::jsonb;
    v_app_bytes     bigint := 0;
    v_app_rows      bigint := 0;
    v_storage_bytes bigint;
    v_storage_files bigint;
    v_mau           bigint;
    v_auth_users    bigint;
    v_rel           record;
    v_exact         bigint;
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: administrator role required'
            USING ERRCODE = '42501';
    END IF;

    BEGIN
        SELECT pg_database_size(current_database()) INTO v_db_bytes;
    EXCEPTION WHEN OTHERS THEN
        v_db_bytes := NULL;
    END;

    -- Exact counts, one dynamic count(*) per table. Views and partitioned
    -- parents that cannot be scanned directly degrade to NULL rather than
    -- aborting the whole panel.
    FOR v_rel IN
        SELECT c.relname                                 AS relname,
               c.oid                                     AS oid,
               pg_total_relation_size(c.oid)             AS bytes,
               pg_table_size(c.oid)                      AS table_bytes,
               pg_indexes_size(c.oid)                    AS index_bytes,
               greatest(c.reltuples, 0)::bigint          AS est_rows
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'm')
         ORDER BY 3 DESC
    LOOP
        v_exact := NULL;
        BEGIN
            EXECUTE format('SELECT count(*) FROM public.%I', v_rel.relname)
                INTO v_exact;
        EXCEPTION WHEN OTHERS THEN
            v_exact := NULL;          -- RLS blocks it, or it is a parent
        END;

        v_rows := v_rows || jsonb_build_object(
            'name',        v_rel.relname,
            'rows',        coalesce(v_exact, v_rel.est_rows),
            'exact',       v_exact IS NOT NULL,
            'est_rows',    v_rel.est_rows,
            'bytes',       v_rel.bytes,
            'table_bytes', v_rel.table_bytes,
            'index_bytes', v_rel.index_bytes
        );
    END LOOP;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'name',        t ->> 'name',
               'rows',        (t ->> 'rows')::bigint,
               'exact',       coalesce((t ->> 'exact')::boolean, FALSE),
               'est_rows',    (t ->> 'est_rows')::bigint,
               'bytes',       (t ->> 'bytes')::bigint,
               'table_bytes', (t ->> 'table_bytes')::bigint,
               'index_bytes', (t ->> 'index_bytes')::bigint
           ) ORDER BY (t ->> 'bytes')::bigint DESC), '[]'::jsonb)
      INTO v_tables
      FROM jsonb_array_elements(v_rows) t;

    SELECT coalesce(sum((t ->> 'bytes')::bigint), 0),
           coalesce(sum((t ->> 'rows')::bigint),  0)
      INTO v_app_bytes, v_app_rows
      FROM jsonb_array_elements(v_tables) t;
    BEGIN
        SELECT coalesce(sum((o.metadata ->> 'size')::bigint), 0), count(*)
          INTO v_storage_bytes, v_storage_files
          FROM storage.objects o
         WHERE o.bucket_id = 'patient-photos';
    EXCEPTION WHEN OTHERS THEN
        v_storage_bytes := NULL;
        v_storage_files := NULL;
    END;

    BEGIN
        SELECT count(*) INTO v_auth_users FROM auth.users;
        SELECT count(*) INTO v_mau
          FROM auth.users
         WHERE last_sign_in_at >= date_trunc('month', now());
    EXCEPTION WHEN OTHERS THEN
        v_auth_users := NULL;
        v_mau := NULL;
    END;

    -- bigint literals. The bare-arithmetic versions overflowed int4 here.
    RETURN jsonb_build_object(
        'generated_at',        now(),
        'exact',               true,
        'db_bytes',            v_db_bytes,
        'app_bytes',           v_app_bytes,
        'app_rows',            v_app_rows,
        'tables',              v_tables,
        'storage_bytes',       v_storage_bytes,
        'storage_files',       v_storage_files,
        'mau',                 v_mau,
        'auth_users',          v_auth_users,
        'plan',                'free',
        'db_limit_bytes',      524288000::bigint,
        'storage_limit_bytes', 1073741824::bigint,
        'mau_limit',           50000::bigint,
        'egress_limit_bytes',  5368709120::bigint,
        'plan_note', 'Supabase Free plan: 500 MB database, 1 GB file storage, '
                  || '50 000 monthly active users, 5 GB egress. '
                  || 'Free projects pause after 1 week of inactivity (max 2 active projects).'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_db_usage() TO authenticated;

NOTIFY pgrst, 'reload schema';
