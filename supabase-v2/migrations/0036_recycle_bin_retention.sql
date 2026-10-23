-- =====================================================================
--  0036 · RECYCLE-BIN RETENTION  (empty the bin, in bulk, admin-only)
-- ---------------------------------------------------------------------
--  WHAT THIS IS
--
--  Soft delete (0026) hides a record and parks it in the recycle bin;
--  "Delete forever" (0026's reports_delete_admin, surfaced in the Admin
--  Console) erases ONE already-deleted row at a time. What was missing
--  is a bulk, retention-based empty: an admin tool that erases every
--  record that has been sitting in the bin past a cutoff, so the bin
--  cannot grow without bound and old, superseded deletions do not linger
--  forever.
--
--  TWO DELIBERATE LIMITS
--
--    1. LIVE ROWS ARE UNTOUCHABLE. This function may only ever erase a
--       row that is ALREADY soft-deleted (deleted_at IS NOT NULL). It
--       cannot reach a live patient record no matter what arguments are
--       passed - the same rule 0026's hard-delete policy enforces, and
--       the reason this is safe to expose to an admin at all.
--    2. A DEFAULT CUTOFF, NOT A "DELETE EVERYTHING" SWITCH. p_before
--       defaults to 90 days ago. Passing an explicit cutoff is allowed
--       (an admin cleaning the whole bin today passes now()), but there
--       is no argument that means "including rows deleted one second
--       ago" unless the caller literally asks for it by name - a bulk
--       erase is never the silent default.
--
--  STORAGE BYTES ARE NOT FREED HERE. This runs in Postgres and can drop
--  the reports row (which CASCADEs report_photos metadata), but the
--  actual objects in the private Storage bucket live outside SQL. The
--  admin flow must call the patient-photos 'purge_report' action for
--  each row to release those bytes - see function/admin.js. This RPC
--  returns the ids it erased so the caller knows exactly which reports
--  still need their objects removed.
--
--  GUARD: active admin only (ent_is_active_admin). A non-admin gets an
--  exception, never another clinic's rows. Scope is the caller's OWN
--  clinic (ent_claim_clinic_id()), exactly like the 0026 hard delete.
--
--  IDEMPOTENT      : yes, CREATE OR REPLACE.
--  DATA DESTRUCTIVE: YES, BY DESIGN - but only over rows already in the
--                    bin and only past the cutoff. That is the entire
--                    purpose; the limits above are what keep it narrow.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ent_purge_recycle_bin(
    p_before timestamptz DEFAULT (now() - interval '90 days'),
    p_limit  integer        DEFAULT 500
)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me public.staff_profiles%ROWTYPE;
BEGIN
    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();

    IF me.id IS NULL OR NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: only an active administrator may empty the recycle bin'
            USING ERRCODE = '42501';
    END IF;

    -- Bound the batch so one call cannot lock the table for an age on a
    -- clinic that deleted thousands of rows. The caller re-invokes until
    -- it returns fewer than p_limit rows.
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
        p_limit := 500;
    END IF;

    RETURN QUERY
    WITH doomed AS (
        SELECT r.id
          FROM public.reports r
         WHERE r.deleted_at IS NOT NULL
           AND r.deleted_at <= p_before
           AND r.clinic_id = public.ent_claim_clinic_id()
         ORDER BY r.deleted_at ASC
         LIMIT p_limit
    ),
    gone AS (
        DELETE FROM public.reports x
         USING doomed d
         WHERE x.id = d.id
        RETURNING x.id
    )
    SELECT g.id FROM gone g;
END $$;

COMMENT ON FUNCTION public.ent_purge_recycle_bin(timestamptz, integer) IS
    'Admin-only bulk erase of ALREADY soft-deleted reports older than a cutoff (default 90 days), own clinic only, bounded batch. Live rows can never be reached. Returns the erased ids so the caller can free their Storage objects via patient-photos.';

REVOKE ALL ON FUNCTION public.ent_purge_recycle_bin(timestamptz, integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_purge_recycle_bin(timestamptz, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
