-- =====================================================================
--  0011 · repair ent_admin_set_active  (admin de/activation, HTTP 400)
-- ---------------------------------------------------------------------
--  FOUND BY: test_live_functions.mjs F8/F8b, against the deployed project.
--      POST /functions/v1/auth-admin {"action":"set_active",...}
--      -> HTTP 400 {"ok":false,"error":"permission denied for function ent_admin_set_active"}
--
--  Two independent defects. The Edge Function is CORRECT and is NOT
--  changed by this migration; both faults are in 0010's SQL.
--
--  -- Defect 1: EXECUTE was never granted to service_role -----------
--  index.ts calls admin().rpc('ent_admin_set_active', ...), and admin()
--  is a service_role client. But 0010 grants EXECUTE only TO
--  authenticated, and the preceding REVOKE ... FROM anon, public leaves
--  service_role with nothing. Proven directly against the live database:
--      POST /rest/v1/rpc/ent_admin_set_active   (service_role key)
--      -> 403 {"code":"42501","message":"permission denied for function
--              ent_admin_set_active"}
--  The call never entered the function body, so no admin could ever
--  deactivate an account. function/admin.js toggleActive() has been
--  calling this action and could only ever have shown an error.
--
--  -- Defect 2: the audit INSERT never type-checked -----------------
--  activity_logs.action is the enum ent_activity, but the INSERT passed
--  a bare CASE, whose result type is text. Postgres will not coerce
--  text -> enum implicitly, so the statement aborts at plan time:
--      -> 400 {"code":"42804","message":"column \"action\" is of type
--              ent_activity but expression is of type text"}
--  Latent behind defect 1: granting alone would NOT have fixed it, and
--  every single activation would still have failed at runtime.
--
--  SCOPE: repairs those two statements only. No table, column, policy,
--  role or Edge Function is altered.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. GRANT EXECUTE to service_role.
--
--    Why this is safe and not a privilege escalation: the function is
--    SECURITY DEFINER, so the only thing the GRANT changes is WHO MAY
--    INVOKE it -- not what it is able to do. Every caller that reaches
--    the body is still stopped at the top by
--
--      IF NOT public.ent_is_active_admin() THEN RAISE EXCEPTION ...
--
--    which re-reads the LIVE staff_profiles row for public.ent_auth_uid().
--    Under a service_role request auth.uid() IS NULL, so ent_auth_uid()
--    returns NULL, no row matches, and ent_is_active_admin() is FALSE ->
--    the function raises and the Edge Function turns that into HTTP 400.
--    In other words service_role can never use this grant to bypass the
--    admin check; the very first statement refuses it. Granting to
--    service_role is what lets the FUNCTION run its own check at all --
--    today it cannot even get that far.
--
--    anon and public stay revoked (0010 section 5). authenticated keeps
--    its existing grant. No browser-reachable role gains anything new.
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.ent_admin_set_active(uuid, boolean) TO service_role;
-- ---------------------------------------------------------------------
-- 2. Re-create the function with the CASE cast to ent_activity.
--
--    The whole body is reproduced verbatim from 0010 apart from the
--    single ::ent_activity cast, so CREATE OR REPLACE cannot silently
--    change any other behaviour of a function that is about to become
--    reachable for the first time.
--
--    The cast goes on the CASE only:
--        (CASE WHEN p_active THEN 'USER_ACTIVATED'
--              ELSE 'USER_DEACTIVATED' END)::ent_activity
--    Both literals are members of the ent_activity enum (0001), so the
--    cast is total -- it cannot fail at runtime. The detail column is
--    text and is left alone; only `action` is an enum.
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
         (CASE WHEN p_active THEN 'USER_ACTIVATED'
               ELSE 'USER_DEACTIVATED' END)::ent_activity,
         CASE WHEN p_active THEN 'Activated ' ELSE 'Deactivated ' END || tgt.username,
         'staff', tgt.id::text);

    RETURN jsonb_build_object('id', tgt.id, 'is_active', p_active);
END;
$$;

-- Reload PostgREST's function cache so the new GRANT is visible without
-- waiting for the automatic schema reload. Same call 0010 ends with.
NOTIFY pgrst, 'reload schema';