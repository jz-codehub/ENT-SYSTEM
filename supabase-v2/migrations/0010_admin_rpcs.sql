-- =====================================================================
--  0010 · admin RPCs  (Admin console insights, now actually gated)
-- ---------------------------------------------------------------------
--  The old project exposed rpc/admin_record_activity and rpc/admin_db_usage
--  TO ANON. Anyone could read the clinic's whole workload profile and the
--  database / storage / auth internals. Same function names and same
--  output columns are kept — function/admin.js needs no change — but:
--    * anon is revoked
--    * the first thing each one does is re-check the caller's LIVE role
--    * results are filtered to the caller's own clinic
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Record activity, per clinic. Output columns are unchanged so
--    function/admin.js keeps working; uuids come back as text exactly as
--    the old TEXT columns used to.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_record_activity(
    p_days int DEFAULT 365,
    p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
    clinic_id   text,
    doctor_id   text,
    created_by  text,
    report_type text,
    day         date,
    n           bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        coalesce(r.clinic_id::text,   '')      AS clinic_id,
        coalesce(r.doctor_id::text,   '')      AS doctor_id,
        coalesce(r.created_by::text,  '')      AS created_by,
        coalesce(r.report_type::text, 'other') AS report_type,
        date_trunc(
            'day',
            r.created_at AT TIME ZONE
                -- There is no pg_timezone_exists() function; the catalogue
                -- of real zone names is the pg_timezone_names VIEW. An
                -- unknown zone raises inside AT TIME ZONE and would abort
                -- the whole RPC, so an unrecognised or NULL p_tz falls back
                -- to UTC. coalesce() appears in BOTH arms on purpose: the
                -- old draft returned the bare p_tz, which made a NULL
                -- argument propagate straight into AT TIME ZONE.
                (CASE WHEN EXISTS (SELECT 1
                                     FROM pg_catalog.pg_timezone_names tz
                                    WHERE tz.name = coalesce(p_tz, 'UTC'))
                      THEN coalesce(p_tz, 'UTC') ELSE 'UTC' END)
        )::date                                AS day,
        count(*)::bigint                       AS n
    FROM public.reports r
    WHERE r.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 365), 1))
      -- THE GATE: live role + live membership, not the JWT claim alone.
      AND public.ent_is_active_admin()
      AND r.clinic_id = public.ent_claim_clinic_id()
      AND public.ent_is_member_of(r.clinic_id)
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY 5, 1;
$$;


-- ---------------------------------------------------------------------
-- 2. Database + storage usage. Still SECURITY DEFINER because it reads
--    pg_class / storage.objects / auth.users, but admin-only, and a
--    non-admin gets a hard refusal instead of a quiet empty summary.
-- ---------------------------------------------------------------------
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
    v_app_bytes     bigint := 0;
    v_app_rows      bigint := 0;
    v_storage_bytes bigint := 0;
    v_storage_files bigint := 0;
    v_mau           bigint;
    v_auth_users    bigint;
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

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'name',        t.tablename,
               'rows',        t.reltuples,
               'bytes',       t.bytes,
               'table_bytes', t.tbytes,
               'index_bytes', t.ibytes
           ) ORDER BY t.bytes DESC), '[]'::jsonb)
      INTO v_tables
      FROM (
        SELECT c.relname                        AS tablename,
               greatest(c.reltuples, 0)::bigint AS reltuples,
               pg_total_relation_size(c.oid)    AS bytes,
               pg_table_size(c.oid)             AS tbytes,
               pg_indexes_size(c.oid)           AS ibytes
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'm')
      ) t;

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
        'db_limit_bytes',        500 * 1024 * 1024,
        'storage_limit_bytes',     1 * 1024 * 1024 * 1024,
        'mau_limit',           50000,
        'egress_limit_bytes',    5 * 1024 * 1024 * 1024,
        'plan_note', 'Supabase Free plan: 500 MB database, 1 GB file storage, '
                  || '50 000 monthly active users, 5 GB egress. '
                  || 'Free projects pause after 1 week of inactivity (max 2 active projects).'
    );
END;
$$;


-- ---------------------------------------------------------------------
-- 3. Server-side capability read.  This is what replaces the
--    localStorage 'entFeaturePhotoStorage' flag as the thing the app
--    ASKS about. The browser may still cache it for one page load, but
--    the Edge Function asks the same question again on every request, so
--    a user who flips localStorage cannot unlock anything.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_capability(p_flag_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT coalesce(
        (SELECT enabled FROM public.system_flags WHERE flag_key = p_flag_key),
        FALSE                                  -- unknown flag = OFF, fail closed
    )
$$;

-- Flipping a flag is an admin action that always leaves an audit trace.
CREATE OR REPLACE FUNCTION public.ent_set_flag(
    p_flag_key text,
    p_enabled  boolean,
    p_note     text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me public.staff_profiles;
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: administrator role required'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();

    UPDATE public.system_flags
       SET enabled    = p_enabled,
           note       = CASE WHEN p_note = '' THEN note ELSE p_note END,
           updated_by = me.id,
           updated_at = now()
     WHERE flag_key = p_flag_key;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown flag: %', p_flag_key;
    END IF;

    INSERT INTO public.activity_logs
        (actor_id, actor_role, actor_label, clinic_id, action, detail)
    VALUES
        (me.id, me.role::text,
         coalesce(nullif(me.full_name,''), me.username::text),
         me.clinic_id, 'SETTING_UPDATED',
         'flag ' || p_flag_key || ' := ' || p_enabled::text);

    RETURN jsonb_build_object('flag_key', p_flag_key, 'enabled', p_enabled);
END;
$$;


-- ---------------------------------------------------------------------
-- 4. Admin de/activation through an RPC instead of a raw table PATCH.
--    Same effect the old admin screen had, but the guard trigger can no
--    longer be bypassed and every change is logged.
--    is_active = FALSE stops the account on the next request (the helpers
--    re-read the table) and auth-admin additionally ends live sessions.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_admin_set_active(
    p_user_id uuid,
    p_active  boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me   public.staff_profiles;
    tgt  public.staff_profiles;
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: administrator role required'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO me  FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    SELECT * INTO tgt FROM public.staff_profiles WHERE id = p_user_id;

    IF tgt.id IS NULL THEN
        RAISE EXCEPTION 'unknown account';
    END IF;
    IF tgt.clinic_id <> me.clinic_id THEN
        RAISE EXCEPTION 'refused: that account belongs to another clinic'
            USING ERRCODE = '42501';
    END IF;
    IF tgt.id = me.id AND p_active = FALSE THEN
        RAISE EXCEPTION 'you cannot deactivate your own account';
    END IF;

    UPDATE public.staff_profiles
       SET is_active = p_active
     WHERE id = tgt.id;

    INSERT INTO public.activity_logs
        (actor_id, actor_role, actor_label, clinic_id, action, detail,
         target_type, target_id)
    VALUES
        (me.id, me.role::text,
         coalesce(nullif(me.full_name,''), me.username::text),
         me.clinic_id,
         CASE WHEN p_active THEN 'USER_ACTIVATED' ELSE 'USER_DEACTIVATED' END,
         CASE WHEN p_active THEN 'Activated ' ELSE 'Deactivated ' END || tgt.username,
         'staff', tgt.id::text);

    RETURN jsonb_build_object('id', tgt.id, 'is_active', p_active);
END;
$$;


-- ---------------------------------------------------------------------
-- 5. Privilege sweep for everything created in this file.
--    VERIFY AFTER APPLY — must return 0 rows:
--      SELECT routine_name FROM information_schema.routines
--       WHERE routine_schema = 'public'
--         AND has_function_privilege('anon',
--               (quote_ident(specific_schema)||'.'||quote_ident(routine_name))::regprocedure,
--               'EXECUTE');
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, public;

GRANT EXECUTE ON FUNCTION public.admin_record_activity(int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_db_usage()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_capability(text)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_set_flag(text, boolean, text)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.ent_admin_set_active(uuid, boolean)   TO authenticated;

NOTIFY pgrst, 'reload schema';
