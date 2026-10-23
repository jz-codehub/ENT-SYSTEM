-- =====================================================================
--  0028 · reports.created_by_name — the saver's NAME, not their uuid
-- ---------------------------------------------------------------------
--  THE BUG THIS FIXES
--
--  DB Records showed this on every card:
--
--      Saved by 94978594-afad-4c81-9e4e-8bc8b13966e3
--
--  with the avatar circle holding "9" - the first CHARACTER of the uuid.
--  reports.created_by is a server-stamped uuid (0004/0018), and the
--  browser cannot turn it into a name:
--
--    · readUserCache() is a retired no-op (v2 removed the per-browser
--      account table; a cached ROLE is the PRIV-04 stale-claim problem),
--    · a direct staff_profiles read is refused by RLS - profiles_select_self
--      (0008) returns exactly one row, the caller's own.
--
--  So the name must ride on the report row itself, stamped server-side
--  at the same instant as the id from the same live profile row. That is
--  the pattern this schema already uses elsewhere: tickets stamp
--  author_role beside author_id, grants stamp granted_by_name beside
--  granted_by_id (0023). A viewer who may read the report may read its
--  author's name - no new read surface, no RLS change, no RPC.
--
--  WHAT THIS FILE DOES
--    1. adds reports.created_by_name (empty default),
--    2. stamps it inside ent_stamp_report_ownership - the SAME trigger
--       that stamps created_by, INSERT gets the caller's name, UPDATE
--       keeps the author's name frozen exactly like the author's id,
--    3. backfills existing rows once, from staff_profiles.
--
--  THE TRIGGER BODY IS 0018 VERBATIM PLUS THE NAME STAMP. It has to be:
--  0020 asserts against that body (old.clinic_id / old.doctor_id pinned,
--  cross-clinic gated on ent_has_report_grant(old.id), no
--  ent_admin_covers_clinic in executable text). Those checks are all
--  satisfied - this file changes nothing about ownership.
--
--  IDEMPOTENT      : yes, safe to re-run (column IF NOT EXISTS,
--                    CREATE OR REPLACE, backfill only fills empties).
--  DATA DESTRUCTIVE: no. The backfill writes ONE value into ONE new
--                    column on rows where it is still empty. Nothing is
--                    inserted or deleted; no existing column changes.
-- =====================================================================

ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS created_by_name text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.reports.created_by_name IS
    'Display name of created_by, stamped by ent_stamp_report_ownership from the caller''s live profile at insert time and never rewritten. The browser cannot resolve a uuid to a name (RLS on staff_profiles returns only the caller''s own row), so without this column every "Saved by" chip would print the raw uuid.';

CREATE OR REPLACE FUNCTION public.ent_stamp_report_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me          public.staff_profiles;
    keep_clinic uuid;
    keep_doctor uuid;
    doctor_ok   boolean;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                              -- trusted writer
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();

    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- A report NEVER changes clinic after it is created.
    --
    -- On INSERT the clinic comes from the row (the writers deliberately
    -- omit it from the body, so coalesce falls back to the caller's own);
    -- on UPDATE it comes from OLD, which is the whole point - the body is
    -- not allowed to nominate a new home.
    IF TG_OP = 'UPDATE' THEN
        keep_clinic := OLD.clinic_id;
        keep_doctor := OLD.doctor_id;
    ELSE
        keep_clinic := coalesce(NEW.clinic_id, me.clinic_id);
        keep_doctor := NULL;
    END IF;

    -- A report NEVER changes clinic after it is created, and the only way
    -- to WRITE into a clinic other than your own is an explicit per-patient
    -- grant.
    --
    -- Same-clinic behaviour is deliberately untouched: for every role the
    -- branch below is never taken, because keep_clinic = me.clinic_id
    -- already. A doctor, a secretary and an admin of their own clinic reach
    -- this function exactly as they did before this line existed.
    --
    -- CROSS-CLINIC (keep_clinic <> me.clinic_id) is allowed ONLY when the
    -- caller holds a live, unexpired grant for THIS report id
    -- (ent_has_report_grant, which itself requires is_draft = false). There
    -- is deliberately NO ent_admin_covers_clinic() arm here: managing a
    -- clinic's staff and settings is not authority over its patients'
    -- records, and 0019 draws that line. A managed_by manager with no grant
    -- is refused exactly like any other unrelated caller - loudly, not by a
    -- silent relocation.
    --
    -- Note the two invariants this preserves together: a grant widens WHO
    -- may write, and never WHERE the row lives - keep_clinic/keep_doctor
    -- were taken from OLD above and are not touched on this branch, so an
    -- approved cross-clinic edit changes CONTENT only.
    IF keep_clinic IS DISTINCT FROM me.clinic_id
       AND NOT public.ent_has_report_grant(OLD.id) THEN
        RAISE EXCEPTION 'refused: you may not write a report into another clinic without an explicit grant for that record'
            USING ERRCODE = '42501';
    END IF;

    NEW.clinic_id := keep_clinic;

    -- The doctor shelf. UPDATE keeps the row on the shelf it was filed on.
    IF TG_OP = 'UPDATE' THEN
        NEW.doctor_id := keep_doctor;
    ELSIF me.role = 'doctor' THEN
        NEW.doctor_id := me.id;
    ELSIF me.role = 'secretary' THEN
        NEW.doctor_id := me.assigned_doctor_id;
    ELSE
        -- An admin may file a report under a real doctor of THIS clinic -
        -- which, since 0016, need not be his own.
        SELECT EXISTS (
            SELECT 1 FROM public.staff_profiles d
             WHERE d.id = NEW.doctor_id
               AND d.clinic_id = keep_clinic
               AND d.role = 'doctor'
               AND d.is_active
        ) INTO doctor_ok;

        IF NOT doctor_ok THEN
            IF keep_clinic = me.clinic_id THEN
                -- 0004's fallback, unchanged: his own shelf, inside his own
                -- clinic, is always a valid answer.
                NEW.doctor_id := me.id;
            ELSE
                -- Filing into a clinic he manages but naming no doctor of it
                -- would otherwise fall back to his own id, producing a row
                -- whose doctor lives in a different clinic than the report.
                RAISE EXCEPTION 'refused: name a doctor of that clinic when filing a report into it'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    -- Author: recorded truthfully on insert, never rewritten after.
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := me.id;
        -- 0028: the author's DISPLAY NAME rides along with the id, stamped
        -- at the same instant from the same live profile row. The browser
        -- cannot turn a uuid into a name (profiles_select_self gives it
        -- only its own row), so without this every "Saved by" chip in DB
        -- Records printed the raw uuid instead.
        NEW.created_by_name := coalesce(nullif(me.full_name, ''), me.username);
    ELSE
        NEW.created_by := OLD.created_by;
        -- The name belongs to the AUTHOR, not to whoever edits later, so
        -- it is frozen exactly like the id. An empty OLD (a row predating
        -- 0028 that somehow missed the backfill) stays empty rather than
        -- letting an editor type somebody else's name into it.
        NEW.created_by_name := OLD.created_by_name;
    END IF;

    -- A report that is not a draft is stamped as saved.
    IF NOT NEW.is_draft AND NEW.saved_at IS NULL THEN
        NEW.saved_at := now();
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ent_stamp_report_ownership() IS
    'Server-stamps the author (id AND display name, 0028) and pins clinic_id + doctor_id. A report never changes clinic or doctor after creation, so an admin editing a record in a clinic he manages (0016) can correct it without relocating it out of that clinic and off that doctor''s shelf.';

-- ---------------------------------------------------------------------
--  BACKFILL. One statement, as the migration runner (table owner, so RLS
--  does not apply): every existing row gets the name its author had.
--  Only rows still empty are touched, so re-running is a no-op.
--
--  coalesce(nullif(full_name,''), username) matches the trigger exactly,
--  so a pre-0028 row and a post-0028 row read the same way forever.
-- ---------------------------------------------------------------------
UPDATE public.reports r
   SET created_by_name = coalesce(nullif(s.full_name, ''), s.username)
  FROM public.staff_profiles s
 WHERE s.id = r.created_by
   AND r.created_by_name = '';

-- The column is new to the PostgREST cache; without this the first
-- select asking for created_by_name answers 400 for a few seconds.
NOTIFY pgrst, 'reload schema';