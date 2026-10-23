-- =====================================================================
--  0017 · draft semantics + photo-count integrity
-- ---------------------------------------------------------------------
--  WHY
--  Phase A of the photo/authorization review. Two defects, both found by
--  reading the data rather than the code:
--
--  1. `is_draft` defaulted to FALSE, so a reports row was a FINISHED record
--     unless somebody said otherwise. Two writers (syncEngine.js and the
--     draftsBrowser.js manual-share path) omit the column, and there are
--     three writers in total. The result, observed live:
--         is_draft = false, saved_at = STAMPED, photo_count = 0
--     on rows that were only ever an automatic background sync. The BEFORE
--     trigger (0004 ent_stamp_report_ownership) stamps saved_at whenever
--     `NOT NEW.is_draft`, so a never-saved draft looked finalized, landed in
--     the finished-reports partial index, and was counted by the dashboard.
--
--     The default now says TRUE: a row is a draft until a writer explicitly
--     finalizes it. Every existing writer now sends the column, so the
--     default is only a safety net for a writer that has not been updated
--     yet — and it fails in the safe direction.
--
--  2. `photo_count` was maintained by exactly one of three writers. When a
--     row was created by a writer that omitted it, Postgres filled in
--     `DEFAULT 0`, and — because absent columns are not updated on conflict
--     — nothing ever repaired it. Confirmed live: 2 rows carrying 2 real
--     JPEGs each, both reporting photo_count = 0.
--
--  WHAT THIS FILE DOES NOT DO
--    · It does not backfill or touch any existing row. The two stale rows
--      stay exactly as they are until a data correction is approved
--      separately. Every statement here is schema-only.
--    · It does not change photo upload, storage, or the draft->final
--      lifecycle. That is Phase B/C.
--    · It does not touch the photo_storage flag.
--
--  IDEMPOTENT     : yes, safe to re-run.
--  DATA DESTRUCTIVE: no. No row is inserted, updated, or deleted.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. A new reports row is a DRAFT unless a writer says otherwise.
--    ALTER COLUMN SET DEFAULT only affects FUTURE inserts; no existing
--    row is rewritten, which is why this needs no backfill.
-- ---------------------------------------------------------------------
ALTER TABLE public.reports ALTER COLUMN is_draft SET DEFAULT TRUE;

COMMENT ON COLUMN public.reports.is_draft IS
    'TRUE = still being worked on. DEFAULT TRUE: a row is a draft until a writer explicitly finalizes it. Historical rows are untouched.';

-- ---------------------------------------------------------------------
-- 2. One live photo per slot.
--
--    SAFE WITH THE EXISTING SOFT-DELETE DESIGN: the predicate is
--    `deleted_at IS NULL`, so a soft-deleted row leaves the index and its
--    index_no becomes reusable. The Edge Function soft-deletes first
--    (patient-photos `remove` action) and removes the bytes afterwards, so
--    a deleted row never has to coexist with a live one at the same slot.
--
--    WHY IT IS PARTIAL, NOT A FULL UNIQUE: a plain
--    UNIQUE (report_id, index_no) would permanently burn the slot, because
--    the soft-deleted row would still occupy it and a re-upload at the same
--    position would then be refused forever.
--
--    WHY IT MATTERS: object paths are built from crypto.randomUUID()
--    (_shared/auth.ts buildObjectPath), and the upload action only appends.
--    Without this index a re-save creates a SECOND live row for the same
--    slot and the old object is orphaned forever — silently, because
--    photo_count is then overwritten with the newest batch's size.
--
--    CONSEQUENCE TO BE AWARE OF: the upload path is append-only, so once
--    photo_storage is switched on, a re-save of a report that already has
--    photos will now FAIL LOUDLY on this index instead of silently
--    duplicating. That is the intended trade (a visible error beats silent
--    data corruption) and it is exactly the gap Phase C closes with a
--    reconciling replace. photo_storage is OFF, so no upload path can run
--    today.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    dupes bigint;
BEGIN
    -- Fail loudly rather than half-applying if live data already violates it.
    SELECT count(*) INTO dupes FROM (
        SELECT report_id, index_no
          FROM public.report_photos
         WHERE deleted_at IS NULL
         GROUP BY report_id, index_no
        HAVING count(*) > 1
    ) collided;
    IF dupes > 0 THEN
        RAISE EXCEPTION
            'refused: % live report_photos slot(s) already collide on (report_id, index_no). Resolve them before re-running 0017.', dupes;
    END IF;

    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_report_photos_live_slot '
            'ON public.report_photos (report_id, index_no) WHERE deleted_at IS NULL';
END $$;

COMMENT ON INDEX public.uq_report_photos_live_slot IS
    'At most one LIVE photo per (report, slot). Partial on deleted_at IS NULL so a soft-deleted photo frees its slot for re-upload.';


-- ---------------------------------------------------------------------
-- 3. photo_count is a denormalised cache, so say so where it is declared.
--    It is NOT authoritative: the truth is the number of live rows in
--    report_photos for that report. This comment records that the column
--    must never be trusted as the only source, and that the app is
--    expected to send it explicitly on every write.
-- ---------------------------------------------------------------------
COMMENT ON COLUMN public.reports.photo_count IS
    'Denormalised count of the report''s photos. Truth = live report_photos rows. Every writer must send it explicitly; a row created without it takes the DEFAULT 0 and nothing repairs that automatically.';


-- ---------------------------------------------------------------------
-- 4. Still no anon anywhere. Asserted rather than assumed, so a later
--    "just GRANT it" cannot quietly undo the closed door.
-- ---------------------------------------------------------------------
DO $$
DECLARE anon_grants int;
BEGIN
    SELECT count(*) INTO anon_grants
      FROM information_schema.role_table_grants
     WHERE grantee = 'anon'
       AND table_schema = 'public';
    IF anon_grants > 0 THEN
        RAISE EXCEPTION 'refused: anon still holds % grant(s) in public.', anon_grants;
    END IF;
END $$;


NOTIFY pgrst, 'reload schema';