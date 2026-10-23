-- =====================================================================
--  0045 · FIX: delete / restore via SECURITY DEFINER RPCs
-- ---------------------------------------------------------------------
--  WHY THIS EXISTS (proven live, 2026-10-12)
--
--  Soft-delete stayed 403 even after the policy was provably present and
--  permissive:
--      · pg_policies shows reports_update_own_doctor (PERMISSIVE, WITH
--        CHECK = ent_may_soft_delete(...)) AND reports_update_owner.
--      · ent_may_soft_delete(clinic, doctor, id)  -> true, called directly
--      · an ordinary UPDATE (file_name)           -> 200
--      · a soft-delete UPDATE (deleted_at = now)  -> 403 (42501)
--  A predicate that answers true, on a permissive policy that ORs with a
--  second one, still refusing the write, is a policy-layer interaction we
--  cannot untangle from the policy side alone. So we stop asking RLS to
--  bless the write and instead move it behind a SECURITY DEFINER function
--  - the SAME pattern this schema already trusts for
--  ent_reassign_doctor_records (0035) and ent_deleted_reports (0039).
--
--  THE MODEL
--    ent_soft_delete_report(p_id)  -> marks a live row deleted
--    ent_restore_report(p_id)      -> clears the marker, putting it back
--
--  Both are SECURITY DEFINER: they run as the owner, so they bypass the
--  UPDATE policies entirely, and each performs its OWN authorisation by
--  calling the ONE predicate that already encodes "who may delete this
--  row" - ent_may_soft_delete(p_clinic, p_doctor, p_id). That predicate
--  is the single source of truth (author of her own draft, the row's own
--  doctor, an active admin of the owning clinic, a secretary on her
--  primary doctor's shelf, a secretary on any assigned doctor). Nothing
--  is widened: the SAME rule the policies encode is re-checked here, in
--  one place, before the write. deleted_by / deleted_at are stamped from
--  the verified JWT, never believed from the request body.
--
--  IDEMPOTENT      : yes (CREATE OR REPLACE, grants).
--  DATA DESTRUCTIVE: it updates deleted_at / deleted_by / deleted_reason -
--                    the intended soft delete. It hard-deletes nothing.
--  SECURITY        : NOT relaxed. Same predicate, enforced server-side.
--                    closed to anon. Returns ok:false rather than raising
--                    so the browser can say "you may not" plainly.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ent_soft_delete_report(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me       public.staff_profiles;
    r        public.reports;
    v_allow  boolean;
BEGIN
    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    IF me.id IS NULL OR me.is_active = false THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not signed in');
    END IF;

    SELECT * INTO r FROM public.reports
     WHERE id = p_id AND deleted_at IS NULL;
    IF r.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'record not found or already deleted');
    END IF;

    SELECT public.ent_may_soft_delete(r.clinic_id, r.doctor_id, r.id) INTO v_allow;
    IF v_allow IS DISTINCT FROM true THEN
        RETURN jsonb_build_object('ok', false, 'error', 'you may not delete this record');
    END IF;

    UPDATE public.reports
       SET deleted_at     = now(),
           deleted_by     = me.id,
           deleted_reason = 'Deleted from DB Records'
     WHERE id = p_id AND deleted_at IS NULL;

    RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.ent_soft_delete_report(uuid) IS
    '0045: soft-delete a live report through a SECURITY DEFINER gate, because the two OR-ed UPDATE policies refuse the write even when ent_may_soft_delete is true. Re-checks that SAME predicate server-side, stamps deleted_by from the JWT, and hard-deletes nothing.';

REVOKE ALL ON FUNCTION public.ent_soft_delete_report(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_soft_delete_report(uuid) TO authenticated;

-- ---------------------------------------------------------------------
--  RESTORE - the exact mirror: same predicate, clears the marker.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_restore_report(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me       public.staff_profiles;
    r        public.reports;
    v_allow  boolean;
BEGIN
    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    IF me.id IS NULL OR me.is_active = false THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not signed in');
    END IF;

    SELECT * INTO r FROM public.reports
     WHERE id = p_id AND deleted_at IS NOT NULL;
    IF r.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'record not found or not deleted');
    END IF;

    SELECT public.ent_may_soft_delete(r.clinic_id, r.doctor_id, r.id) INTO v_allow;
    IF v_allow IS DISTINCT FROM true THEN
        RETURN jsonb_build_object('ok', false, 'error', 'you may not restore this record');
    END IF;

    UPDATE public.reports
       SET deleted_at     = NULL,
           deleted_by     = NULL,
           deleted_reason = ''
     WHERE id = p_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.ent_restore_report(uuid) IS
    '0045: the mirror of ent_soft_delete_report - SECURITY DEFINER restore that clears deleted_at / deleted_by / deleted_reason, gated by the same ent_may_soft_delete predicate. The clinic, doctor, payload and photos are untouched, so the row returns exactly where it was.';

REVOKE ALL ON FUNCTION public.ent_restore_report(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_restore_report(uuid) TO authenticated;

-- ---------------------------------------------------------------------
--  SELF-CHECK: both functions exist.
-- ---------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('ent_soft_delete_report', 'ent_restore_report');
    IF n <> 2 THEN
        RAISE EXCEPTION '0045 guard failed: expected 2 functions, found %', n;
    END IF;
    RAISE NOTICE '0045 OK: ent_soft_delete_report + ent_restore_report created (SECURITY DEFINER, same predicate)';
END $$;

