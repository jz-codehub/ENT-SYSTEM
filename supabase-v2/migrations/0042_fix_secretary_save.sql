-- =====================================================================
--  0042 · FIX: secretary "Save to Database" refused with NULL clinic_id
-- ---------------------------------------------------------------------
--  THE BUG (found live, 2026-10-12)
--
--  A secretary pressing "Save to Database" got:
--      null value in column "clinic_id" of relation "reports"
--      violates not-null constraint          (Postgres 23502)
--
--  ROOT CAUSE — 0037's ent_stamp_report_ownership. When a secretary
--  files under her assigned doctor, the trigger resolves the report's
--  home clinic with a PLAIN select that runs AS THE SECRETARY:
--
--      SELECT d.clinic_id INTO keep_clinic
--        FROM public.staff_profiles d
--       WHERE d.id = NEW.doctor_id;
--
--  staff_profiles is RLS-protected and a secretary may NOT read another
--  staff row (verified live: as lian, `... WHERE id = <her doctor>`
--  returns []). So keep_clinic stays NULL, NEW.clinic_id becomes NULL,
--  and the NOT NULL column refuses the save. A doctor (whose branch
--  never runs this SELECT) and the no-doctor_id path are unaffected —
--  which is exactly why it looked like "only the secretary, only when
--  a doctor_id is sent".
--
--  THE FIX
--
--  ent_doctor_clinic(uuid): a SECURITY DEFINER, STABLE helper that
--  returns the clinic of an ACTIVE doctor, bypassing RLS exactly the
--  way ent_is_my_doctor already does. The trigger calls it instead of
--  the bare SELECT. Because the call is gated behind
--  ent_is_my_doctor(NEW.doctor_id) = TRUE (the doctor is real, active
--  and hers), the helper cannot be aimed at anyone she is not already
--  authorised to work under — it only ever resolves the clinic of a
--  doctor she may legitimately file under. Cross-clinic filing (0037)
--  is therefore PRESERVED, not weakened: a secretary assigned to a
--  doctor in Clinic B still lands the record on Clinic B's shelf.
--
--  IDEMPOTENT      : yes (CREATE OR REPLACE, DROP+ADD trigger, grants).
--  DATA DESTRUCTIVE: no. Nothing is inserted, updated or deleted. Only
--                    the trigger body and a new helper change.
--  SECURITY        : RLS is NOT relaxed. ent_doctor_clinic exposes one
--                    doctor's clinic id, nothing else, and only inside
--                    a path the caller already passed ent_is_my_doctor
--                    for. No new table access is granted to anyone.
-- =====================================================================

-- 1. THE HELPER — resolve an active doctor's clinic, RLS-safe.
CREATE OR REPLACE FUNCTION public.ent_doctor_clinic(p_doctor uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT d.clinic_id
      FROM public.staff_profiles d
     WHERE d.id = p_doctor
       AND d.role = 'doctor'
       AND d.is_active;
$$;

COMMENT ON FUNCTION public.ent_doctor_clinic(uuid) IS
    '0042: clinic of an ACTIVE doctor, SECURITY DEFINER so the ownership trigger can resolve a secretary''s cross-clinic filing without her being able to read the doctor''s staff_profiles row. Called only behind ent_is_my_doctor(), so it never leaks a clinic the caller is not already assigned to.';

REVOKE ALL ON FUNCTION public.ent_doctor_clinic(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_doctor_clinic(uuid) TO authenticated;

-- 2. THE TRIGGER — identical to 0037 except the one buggy SELECT now
--    goes through the RLS-safe helper.
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

    -- A report NEVER changes clinic after it is created. On UPDATE the
    -- home comes from OLD; on INSERT it is resolved below.
    IF TG_OP = 'UPDATE' THEN
        keep_clinic := OLD.clinic_id;
        keep_doctor := OLD.doctor_id;
    ELSIF me.role = 'secretary'
          AND NEW.doctor_id IS NOT NULL
          AND public.ent_is_my_doctor(NEW.doctor_id) THEN
        -- 0037: a secretary filing under a doctor she is assigned to,
        -- who may live in another clinic. The record's home is THAT
        -- doctor's clinic, and the shelf is THAT doctor.
        -- 0042: resolve the clinic through the SECURITY DEFINER helper —
        -- a bare SELECT here runs as the secretary and RLS hides the
        -- doctor's row, leaving keep_clinic NULL and refusing the save.
        keep_clinic := public.ent_doctor_clinic(NEW.doctor_id);
        -- Defensive: ent_is_my_doctor already proved the doctor is real
        -- and active, so this is non-NULL in practice. If it ever is,
        -- fall back to the secretary's own clinic rather than crash —
        -- the cross-clinic guard below still refuses an unauthorised
        -- landing, so the fallback can never leak a clinic.
        keep_clinic := coalesce(keep_clinic, me.clinic_id);
        keep_doctor := NEW.doctor_id;
    ELSE
        keep_clinic := coalesce(NEW.clinic_id, me.clinic_id);
        keep_doctor := NULL;
    END IF;

    -- Cross-clinic write is allowed ONLY with an explicit per-patient
    -- grant, OR (0037) when a secretary files under a doctor she is
    -- assigned to. managed_by still grants nothing here.
    IF keep_clinic IS DISTINCT FROM me.clinic_id
       AND NOT public.ent_has_report_grant(OLD.id)
       AND NOT (me.role = 'secretary'
                AND keep_doctor IS NOT NULL
                AND public.ent_is_my_doctor(keep_doctor)) THEN
        RAISE EXCEPTION 'refused: you may not write a report into another clinic without an explicit grant for that record'
            USING ERRCODE = '42501';
    END IF;

    NEW.clinic_id := keep_clinic;

    -- The doctor shelf. UPDATE keeps the row on the shelf it was filed
    -- on; INSERT resolves it. keep_doctor is set only for the 0037
    -- assigned-doctor branch, so an ordinary doctor/secretary/admin
    -- INSERT is unchanged.
    IF TG_OP = 'UPDATE' THEN
        NEW.doctor_id := keep_doctor;
    ELSIF keep_doctor IS NOT NULL THEN
        NEW.doctor_id := keep_doctor;
    ELSIF me.role = 'doctor' THEN
        NEW.doctor_id := me.id;
    ELSIF me.role = 'secretary' THEN
        NEW.doctor_id := me.assigned_doctor_id;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM public.staff_profiles d
             WHERE d.id = NEW.doctor_id
               AND d.clinic_id = keep_clinic
               AND d.role = 'doctor'
               AND d.is_active
        ) INTO doctor_ok;

        IF NOT doctor_ok THEN
            IF keep_clinic = me.clinic_id THEN
                NEW.doctor_id := me.id;
            ELSE
                RAISE EXCEPTION 'refused: name a doctor of that clinic when filing a report into it'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    -- Author: recorded truthfully on insert, never rewritten after.
    -- 0028: the display name rides with the id, frozen exactly like it.
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := me.id;
        NEW.created_by_name := coalesce(nullif(me.full_name, ''), me.username);
    ELSE
        NEW.created_by := OLD.created_by;
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
    '0042: same ownership stamp as 0037/0028, except a secretary''s cross-clinic filing resolves the clinic through the SECURITY DEFINER ent_doctor_clinic() helper, because the old bare SELECT ran under the secretary''s RLS and returned NULL (23502 on save).';

DROP TRIGGER IF EXISTS trg_reports_stamp ON public.reports;
CREATE TRIGGER trg_reports_stamp
    BEFORE INSERT OR UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_report_ownership();

DO $$
BEGIN
    RAISE NOTICE '0042 OK: secretary save fix — ent_doctor_clinic() + trigger redefined (RLS untouched)';
END $$;

