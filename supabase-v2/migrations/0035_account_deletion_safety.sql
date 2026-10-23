-- =====================================================================
--  0035 · ACCOUNT-DELETION SAFETY  (let an admin delete a doctor who
--         still owns patient records, WITHOUT orphaning or losing any)
-- ---------------------------------------------------------------------
--  THE PROBLEM THIS CLOSES
--
--  An admin may delete an account through auth-admin (deleteUser). That
--  works for a doctor with NO history, but the moment she owns a single
--  patient record the delete is REFUSED, because these FKs are RESTRICT:
--
--      reports.doctor_id         -> staff_profiles(id) ON DELETE RESTRICT
--      reports.created_by        -> staff_profiles(id) ON DELETE RESTRICT
--      report_photos.doctor_id   -> staff_profiles(id) ON DELETE RESTRICT
--      report_photos.uploaded_by -> staff_profiles(id) ON DELETE RESTRICT
--
--  RESTRICT is a deliberate safety choice and it is NOT removed here. A
--  patient record must never be silently destroyed or detached from its
--  clinic. This file adds the OTHER half: a way to remove the account
--  while every record it points at stays intact and inside the clinic.
--
--  THE MODEL, three rules, in priority order
--
--    1. NOTHING IS EVER DELETED OR ORPHANED. Deleting an account moves
--       the SHELF, it does not erase the work.
--    2. doctor_id is REASSIGNED, never nulled. It is NOT NULL, it is
--       half of UNIQUE (clinic_id, doctor_id, record_key), and RLS keys
--       on it. Nulling it would break de-duplication (Postgres treats
--       NULLs as distinct in a unique index) and would leave the record
--       off every shelf. So a departing doctor's records move onto the
--       admin's own shelf - same clinic, real doctor, dedup preserved.
--    3. created_by / uploaded_by are NULLED and the AUTHOR'S NAME
--       SURVIVES. created_by is the frozen "who wrote this" uuid
--       (0004/0018/0028). Its display half, created_by_name, is already
--       a text SNAPSHOT taken at insert time (0028) - the same pattern
--       0025 uses for grant authors. So the live uuid may go to NULL
--       while created_by_name keeps naming the real author. That is why
--       relaxing these two FKs to ON DELETE SET NULL is 0025-shaped, not
--       a hole.
--
--  WHAT THE ADMIN FLOW DOES (auth-admin, wired separately)
--    requireAdmin -> re-auth with the admin's own password ->
--    loadTarget (must be in a clinic this admin covers) ->

-- ---------------------------------------------------------------------
--  1. Relax reports.created_by  ->  ON DELETE SET NULL (column nullable)
-- ---------------------------------------------------------------------
-- created_by_name (0028) is the durable author identity, so nulling the
-- live uuid loses nothing a reader relies on.
DO $$
DECLARE r record;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'reports'
           AND column_name = 'created_by' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE public.reports ALTER COLUMN created_by DROP NOT NULL;
    END IF;

    -- Drop whatever FK currently points reports.created_by at
    -- staff_profiles (0004's inline REFERENCES, auto-named), then re-add
    -- it explicitly so the ON DELETE action is owned by us.
    FOR r IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t    ON t.oid  = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_class rt   ON rt.oid = c.confrelid
         WHERE n.nspname = 'public' AND t.relname = 'reports'
           AND c.contype = 'f' AND rt.relname = 'staff_profiles'
           AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                  WHERE attrelid = 'public.reports'::regclass
                                    AND attname  = 'created_by')]
    LOOP
        EXECUTE format('ALTER TABLE public.reports DROP CONSTRAINT %I', r.conname);
    END LOOP;

    ALTER TABLE public.reports
        ADD CONSTRAINT reports_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES public.staff_profiles(id) ON DELETE SET NULL;
END $$;

COMMENT ON COLUMN public.reports.created_by IS
    'Frozen author uuid (0004/0018). ON DELETE SET NULL since 0035 so removing the author''s account neither blocks the delete nor erases the record; created_by_name (0028) keeps naming the real author.';

--    ent_reassign_doctor_records(target -> admin)  (this file's RPC) ->
--    deleteUser(target). By the time the identity is removed, nothing
--    RESTRICTs against it: the shelf is on the admin, the author uuids
--    are NULL (name kept), tickets handled in 0037.
--
--  IDEMPOTENT      : yes. Guarded / CREATE OR REPLACE / DROP+ADD.
--  DATA DESTRUCTIVE: NO. This file changes constraints and adds an RPC.
--                    It inserts, updates and deletes nothing. The
--                    reassignment is a separate, admin-gated call.
-- =====================================================================

-- ---------------------------------------------------------------------
--  2. Relax report_photos.uploaded_by  ->  ON DELETE SET NULL
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'report_photos'
           AND column_name = 'uploaded_by' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE public.report_photos ALTER COLUMN uploaded_by DROP NOT NULL;
    END IF;

    FOR r IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t    ON t.oid  = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_class rt   ON rt.oid = c.confrelid
         WHERE n.nspname = 'public' AND t.relname = 'report_photos'
           AND c.contype = 'f' AND rt.relname = 'staff_profiles'
           AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                  WHERE attrelid = 'public.report_photos'::regclass
                                    AND attname  = 'uploaded_by')]
    LOOP
        EXECUTE format('ALTER TABLE public.report_photos DROP CONSTRAINT %I', r.conname);
    END LOOP;

    ALTER TABLE public.report_photos
        ADD CONSTRAINT report_photos_uploaded_by_fkey
        FOREIGN KEY (uploaded_by) REFERENCES public.staff_profiles(id) ON DELETE SET NULL;
END $$;

-- ---------------------------------------------------------------------
--  3. THE REASSIGNMENT RPC  (the whole point of this file)
-- ---------------------------------------------------------------------
--  Moves every record a departing doctor OWNS (doctor_id) onto another
--  doctor of the SAME clinic, so her account can be deleted without the
--  RESTRICT FKs refusing and without orphaning a single patient row.
--
--  GUARDS, all three must hold or it raises and changes nothing:
--    a. the caller is an ACTIVE admin (ent_is_active_admin);
--    b. p_from and p_to are in the SAME clinic - a reassignment may
--       never move a record across a clinic boundary (that is the hole
--       the ownership stamp exists to close);
--    c. p_to is a real, ACTIVE DOCTOR (not a secretary, not the target
--       itself, not inactive).
--
--  WHAT IT TOUCHES
--    · reports.doctor_id         reassigned (the shelf moves)
--    · report_photos.doctor_id   reassigned (kept beside the report)
--  created_by / uploaded_by are deliberately NOT touched: they are the
--  frozen author and are handled by the SET NULL FK when the identity
--  is finally deleted, with created_by_name preserving the name.
--
--  SECURITY DEFINER because a normal admin cannot UPDATE another row's
--  doctor_id (0018 pins it on the doctor), and this is the one, audited,
--  admin-only path that legitimately moves a whole shelf at once.
--  service_role is NOT special-cased here on purpose: this is a human
--  admin action, so even a trusted writer must pass the same guards.
--
--  DATA DESTRUCTIVE: NO. It rewrites doctor_id only. No row is deleted;
--  the payload, photos, dates and author name are all preserved.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_reassign_doctor_records(
    p_from uuid,
    p_to   uuid
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me         public.staff_profiles%ROWTYPE;
    from_row   public.staff_profiles%ROWTYPE;
    to_row     public.staff_profiles%ROWTYPE;
    moved      integer;
BEGIN
    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();

    -- (a) caller must be a live admin.
    IF me.id IS NULL OR NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: only an active administrator may reassign records'
            USING ERRCODE = '42501';
    END IF;

    IF p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN
        RAISE EXCEPTION 'refused: name two different accounts to reassign between';
    END IF;

    SELECT * INTO from_row FROM public.staff_profiles WHERE id = p_from;
    SELECT * INTO to_row   FROM public.staff_profiles WHERE id = p_to;

    IF from_row.id IS NULL OR to_row.id IS NULL THEN
        RAISE EXCEPTION 'refused: both the departing and the receiving account must exist';
    END IF;

    -- (b) same clinic, always. A reassignment crosses no clinic line.
    IF from_row.clinic_id <> to_row.clinic_id THEN
        RAISE EXCEPTION 'refused: cannot move records between two different clinics';
    END IF;

    -- The admin must actually cover that clinic, exactly like every
    -- other admin-only write (0016/0032). Being a live admin is not by
    -- itself a licence to touch another clinic's shelf.
    IF NOT public.ent_admin_covers_clinic(from_row.clinic_id) THEN
        RAISE EXCEPTION 'refused: that clinic is not one you administer';
    END IF;

    -- (c) the receiver is a real, active doctor.
    IF to_row.role <> 'doctor' OR NOT to_row.is_active THEN
        RAISE EXCEPTION 'refused: records may only be reassigned to an active doctor';
    END IF;

    UPDATE public.reports
       SET doctor_id = p_to
     WHERE doctor_id = p_from
       AND clinic_id = from_row.clinic_id;
    GET DIAGNOSTICS moved = ROW_COUNT;

    -- Keep the photo rows beside their report. The clinic filter is a
    -- belt-and-braces restatement of (b): photos never leave the clinic.
    UPDATE public.report_photos
       SET doctor_id = p_to
     WHERE doctor_id = p_from
       AND clinic_id = from_row.clinic_id;

    RETURN moved;
END $$;

COMMENT ON FUNCTION public.ent_reassign_doctor_records(uuid, uuid) IS
    'Admin-only: move every report (and its photos) owned by one doctor onto another doctor of the SAME clinic, so the first account can be deleted without orphaning records. Guards: active admin, same clinic, receiver is an active doctor. Rewrites doctor_id only; no row is deleted.';

REVOKE ALL ON FUNCTION public.ent_reassign_doctor_records(uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_reassign_doctor_records(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

