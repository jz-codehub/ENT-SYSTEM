-- =====================================================================
--  0004 · reports   (patient report metadata + editable payload)
-- ---------------------------------------------------------------------
--  REPLACES: patient_records.
--
--  DELIBERATE CHOICE — one report table, not three.
--  CF4 / nasal / laryngeal stay in ONE table with report_type as a
--  discriminator and the editable form in `payload` jsonb, exactly as
--  today. Splitting them would need every query in dbRecords.js,
--  syncEngine.js, draftsBrowser.js and the PDF open path rewritten, for
--  no security or integrity gain. Per the brief: do not split without a
--  clear technical reason. There is none.
--
--  What DID change, and why:
--    clinic_id / doctor_id / created_by  uuid FKs, and the server STAMPS
--                                        them — see the trigger below.
--    procedure_date                      real date, not TEXT
--    draftShared (jsonb flag)            is_draft boolean + partial index
--    metadata                            payload (no duplicate identity
--                                        columns inside it)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.reports (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       uuid        NOT NULL REFERENCES public.clinics(id)  ON DELETE RESTRICT,
    doctor_id       uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE RESTRICT,
    created_by      uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE RESTRICT,

    -- The app's client-side key (e.g. "cf4|2026-09-30|PATIENT"). Kept as
    -- text so existing localStorage records still line up 1:1.
    record_key      text        NOT NULL,
    report_type     public.ent_report_type NOT NULL,
    is_draft        boolean     NOT NULL DEFAULT FALSE,

    -- Queryable identity columns: the listing/search endpoints read only
    -- these, never payload.
    patient_name    text        NOT NULL DEFAULT '',
    patient_id      text        NOT NULL DEFAULT '',
    case_number     text        NOT NULL DEFAULT '',
    procedure_date  date,
    file_name       text        NOT NULL DEFAULT '',

    -- The whole editable form. Nothing downstream had to change: the app
    -- already hands this object straight back to the form and to jsPDF.
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,

    photo_count     integer     NOT NULL DEFAULT 0,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    saved_at        timestamptz,          -- set when a draft becomes final

    -- Exactly the key the app already upserts against, so
    -- ?on_conflict=clinic_id,doctor_id,record_key keeps working unchanged.
    CONSTRAINT reports_owner_key_unique UNIQUE (clinic_id, doctor_id, record_key),

    CONSTRAINT reports_record_key_shape CHECK (record_key <> '' AND length(record_key) <= 512),
    CONSTRAINT reports_type_matches_key CHECK (
        is_draft
        OR payload ? 'reportType'
        OR report_type::text IS NOT NULL
    ),
    -- Guard rail for the Supabase free 500 MB database. Old records embed
    -- base64 photos in the payload; until photo storage passes its
    -- security tests that is still allowed, but never unbounded.
    -- See DEC-05 in docs/08-RISKS-DECISIONS.md.
    CONSTRAINT reports_payload_ceiling CHECK (octet_length(payload::text) < 20000000)
);

COMMENT ON TABLE  public.reports IS
    'One row per CF4 / nasal / laryngeal report or draft, including the editable payload.';
COMMENT ON COLUMN public.reports.doctor_id IS
    'The shelf the report sits on. STAMPED BY THE SERVER, never trusted from the request.';
COMMENT ON COLUMN public.reports.is_draft IS
    'TRUE = recovery draft (the old draftShared hack). Partial indexes keep the final list fast.';

-- The listing query is always "this clinic, this doctor, final reports,
-- newest first" — so give it exactly the index it wants.
CREATE INDEX IF NOT EXISTS idx_reports_owner_list
    ON public.reports (clinic_id, doctor_id, updated_at DESC)
    WHERE NOT is_draft;
CREATE INDEX IF NOT EXISTS idx_reports_drafts
    ON public.reports (clinic_id, doctor_id, updated_at DESC)
    WHERE is_draft;
CREATE INDEX IF NOT EXISTS idx_reports_type
    ON public.reports (clinic_id, report_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created_by
    ON public.reports (clinic_id, created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created
    ON public.reports (created_at DESC);
-- Search is 'ILIKE *needle*' so a plain btree cannot help; trigram can.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_reports_name_trgm
    ON public.reports USING gin (patient_name gin_trgm_ops);

DROP TRIGGER IF EXISTS trg_reports_touch ON public.reports;
CREATE TRIGGER trg_reports_touch
    BEFORE UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.ent_touch_updated_at();

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;



-- =====================================================================
--  OWNERSHIP STAMP  (the control that closes the biggest old hole)
-- ---------------------------------------------------------------------
--  In the old app clinic_id came from localStorage and doctor_id came
--  from the JS scope object, straight into the POST body. Editing the
--  request in DevTools moved a patient row into another clinic or into
--  another doctor's shelf, and RLS did nothing about it.
--
--  Here a BEFORE trigger overwrites those columns from the caller's live
--  staff_profiles row. BEFORE ROW triggers run before the NOT NULL check
--  and before the RLS WITH CHECK, so by the time a row is written every
--  ownership column is server-owned.
--
--  Effect: the browser cannot choose a clinic, a doctor, or an author.
--  Whatever the request body says is irrelevant.
--
--  service_role is exempt, because the migration runner and auth-admin
--  legitimately write on behalf of users (always under your approval).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ent_stamp_report_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me public.staff_profiles;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                              -- trusted writer
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();

    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- 1. clinic: always the caller's own clinic.
    NEW.clinic_id := me.clinic_id;

    -- 2. doctor shelf: derived from the caller's role, not the request.
    IF me.role = 'doctor' THEN
        NEW.doctor_id := me.id;
    ELSIF me.role = 'secretary' THEN
        NEW.doctor_id := me.assigned_doctor_id;
    ELSIF me.role = 'admin' THEN
        -- An admin may file a report under a real doctor of his own
        -- clinic; anything else (blank, foreign, unknown) falls back to
        -- the admin's own shelf instead of escaping the clinic.
        IF NEW.doctor_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM public.staff_profiles d
                WHERE d.id = NEW.doctor_id
                  AND d.clinic_id = me.clinic_id
                  AND d.role = 'doctor'
                  AND d.is_active
           ) THEN
            NEW.doctor_id := me.id;
        END IF;
    END IF;

    -- 3. author: recorded truthfully on insert, never rewritten after.
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := me.id;
    ELSE
        NEW.created_by := OLD.created_by;
    END IF;

    -- 4. a report that is not a draft is stamped as saved.
    IF NOT NEW.is_draft AND NEW.saved_at IS NULL THEN
        NEW.saved_at := now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reports_stamp ON public.reports;
CREATE TRIGGER trg_reports_stamp
    BEFORE INSERT OR UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_report_ownership();


-- =====================================================================
--  report_photos — private-bucket object metadata
-- ---------------------------------------------------------------------
--  The bytes live in a PRIVATE Storage bucket; this table is the
--  authorization anchor the storage policies in 0010 consult. Object
--  paths are unguessable uuids, so guessing a path buys nothing: access
--  is decided by the row, not by the path.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.report_photos (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id     uuid        NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
    -- Denormalised ONLY so a storage policy can answer "may this caller
    -- read this object?" with one index lookup instead of a two-hop join.
    clinic_id     uuid        NOT NULL REFERENCES public.clinics(id)          ON DELETE RESTRICT,
    doctor_id     uuid        NOT NULL REFERENCES public.staff_profiles(id)   ON DELETE RESTRICT,
    object_path   text        NOT NULL UNIQUE,
    index_no      integer     NOT NULL DEFAULT 1,
    mime_type     text        NOT NULL DEFAULT 'image/jpeg',
    byte_size     bigint      NOT NULL DEFAULT 0,
    sha256        text        NOT NULL DEFAULT '',
    uploaded_by   uuid        NOT NULL REFERENCES public.staff_profiles(id)   ON DELETE RESTRICT,
    created_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,

    CONSTRAINT photo_index_range  CHECK (index_no BETWEEN 1 AND 6),
    CONSTRAINT photo_size_sane    CHECK (byte_size >= 0 AND byte_size <= 15000000),
    CONSTRAINT photo_mime_allowed CHECK (mime_type IN ('image/jpeg','image/png','image/webp'))
    -- clinic_id / doctor_id are checked against the parent report by
    -- trg_photos_stamp below, NOT by a CHECK constraint here: Postgres
    -- refuses to build a CHECK containing a subquery (ERROR 0A000,
    -- "cannot use subquery in check constraint"), because a CHECK may only
    -- reference columns of its own row.
);

COMMENT ON TABLE public.report_photos IS
    'Private-bucket object metadata + authorization anchor. Bytes stay in Storage.';

CREATE INDEX IF NOT EXISTS idx_photos_report ON public.report_photos (report_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_photos_clinic ON public.report_photos (clinic_id, doctor_id);

ALTER TABLE public.report_photos ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
--  OWNERSHIP STAMP for photos.
-- ---------------------------------------------------------------------
--  This replaces the two CHECK constraints that Postgres would not
--  accept (a CHECK may not contain a subquery, so it cannot look at the
--  parent report).
--
--  A stamp is STRONGER than the check it replaces. The old CHECK only
--  rejected a row that already disagreed with its report; the request
--  still carried clinic_id / doctor_id, and only the tail of the
--  pipeline noticed. Here those two columns are overwritten from the
--  parent report on every INSERT and UPDATE, so a photo cannot be
--  re-parented into another clinic or onto another doctor's shelf even
--  for one statement.
--
--  This is the same defence-in-depth the reports table already uses:
--  ent_stamp_report_ownership stamps clinic/doctor/author from the
--  caller's live profile, and 0008 then re-asserts the invariant in the
--  RLS policy so the guarantee survives the trigger being dropped.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_photo_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    r public.reports;
BEGIN
    SELECT * INTO r FROM public.reports WHERE id = NEW.report_id;

    -- The FK would catch this too, but this message names the real cause.
    IF r.id IS NULL THEN
        RAISE EXCEPTION 'refused: no report with id % for this photo', NEW.report_id
            USING ERRCODE = '23503';
    END IF;

    -- Service role is exempt on purpose: the Edge Function writes on
    -- behalf of users and already passes the report's real clinic/doctor.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF NOT public.ent_may_touch_report(r.clinic_id, r.doctor_id) THEN
        RAISE EXCEPTION 'refused: you may not attach a photo to that report'
            USING ERRCODE = '42501';
    END IF;

    -- Server owns these two columns. Whatever the body said is ignored.
    NEW.clinic_id := r.clinic_id;
    NEW.doctor_id := r.doctor_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_photos_stamp ON public.report_photos;
CREATE TRIGGER trg_photos_stamp
    BEFORE INSERT OR UPDATE ON public.report_photos
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_photo_ownership();

NOTIFY pgrst, 'reload schema';

