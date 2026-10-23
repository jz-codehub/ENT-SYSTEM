-- =====================================================================
--  0025 · the author of a grant must outlive the author's account
-- ---------------------------------------------------------------------
--  NOTE ON THE NAME. The plan called this file "granted_by NOT NULL" and
--  that is NOT what this does, on purpose. NOT NULL on granted_by is the
--  option that conflicts with ON DELETE SET NULL: you cannot have both a
--  column that refuses NULL and a foreign key whose entire job is to
--  write NULL into it when the account is deleted. The decision taken was
--  option (c), and this file is what (c) actually requires.
--
--  THE PROBLEM
--
--  A grant answers a question about authority: "the clinic that owns this
--  patient said yes, and this is who said it". granted_by holds half of
--  that answer, as a live reference:
--
--      granted_by  uuid REFERENCES staff_profiles(id) ON DELETE SET NULL
--
--  ON DELETE SET NULL was chosen deliberately in 0019, over CASCADE, with
--  the right reason: deleting an approver must not silently delete the
--  record that they approved something. That reasoning was correct and it
--  is kept here. But SET NULL only preserves the ROW. The moment the
--  account is deleted the row survives with granted_by = NULL, and the
--  half of the answer that names the author is gone. What is left is
--  "a grant exists" with no author at all - which is exactly the shape of
--  the bug 0024 just closed, and it would reopen itself the first time
--  anyone deleted an account.
--
--  In other words: 0024 stopped the author being lost at WRITE time. This
--  file stops it being lost at DELETE time. Both are needed; neither is
--  sufficient alone.
--
--  THE FIX
--
--  Add a text snapshot of the author's name, taken from the session at the
--  moment of the grant, and keep the live reference beside it:
--
--      granted_by       uuid   REFERENCES staff_profiles(id) ON DELETE SET NULL
--                                nullable - goes to NULL when they leave,
--                                and that is correct: it records that the
--                                account no longer exists
--      granted_by_name  text   NOT NULL - never goes away, because it is
--                                a copy and not a reference
--
--  So the two columns answer two different questions and are allowed to
--  disagree. granted_by answers "does this person still have an account?"
--  and granted_by_name answers "who said yes?". Deleting the account
--  makes the first NULL and leaves the second untouched, and the audit
--  trail survives without anything having to be blocked.
--
--  WHY THE NAME COLUMN IS NOT NULL
--
--  It is the durable half, so leaving it nullable would recreate the same
--  hole one column over. It carries DEFAULT '' so that the trusted
--  service_role writer (migrations, the backup job) is not broken by the
--  constraint - that path has no session and therefore no name to take.
--  An empty name there is an honest gap rather than a false author, which
--  is the distinction that matters when someone reads this table in two
--  years. For every authenticated grant the trigger fills it in, and the
--  trigger refuses rather than writing an empty name.
--
--  WHY THE NAME IS A SNAPSHOT AND NOT A JOIN
--
--  Because staff_profiles.full_name is EDITABLE. Joining to it would mean
--  a typo corrected two years later silently rewrites history, and a
--  renamed account makes a past approval appear to have come from
--  somebody else. An audit record that can be edited after the fact is
--  not an audit record. The copy is the point.
--
--  WHAT IT TOUCHES
--    alters   : report_access_grants - adds granted_by_name, backfills it
--    replaces : ent_stamp_grant (same signature) - stamps the name too
--    creates  : nothing
--    drops    : nothing
--    deletes  : nothing
--
--  No grant is ever removed. The backfill only fills an empty column, so
--  an already-correct name is never rewritten.
--
--  IDEMPOTENT      : yes, safe to re-run.
--  DATA DESTRUCTIVE: no.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. THE COLUMN, THEN THE BACKFILL, IN THAT ORDER.
--
--    ADD COLUMN IF NOT EXISTS first so a re-run is a no-op, then the
--    backfill, then NOT NULL. That order matters: the constraint cannot be
--    added while any row still holds an empty name, and the backfill is
--    what empties them.
--
--    The snapshot is taken as full_name, falling back to username, because
--    a profile with no name is real and would otherwise backfill to ''
--    and then fail the NOT NULL below for a reason that looks like a bug.
-- ---------------------------------------------------------------------
ALTER TABLE public.report_access_grants
    ADD COLUMN IF NOT EXISTS granted_by_name text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.report_access_grants.granted_by IS
    'The approving staff account, as a LIVE reference. ON DELETE SET NULL on purpose: deleting an approver must not delete the record of what they approved. Goes NULL when the account is removed, which correctly records that it no longer exists. Read granted_by_name for WHO - that one survives deletion.';

COMMENT ON COLUMN public.report_access_grants.granted_by_name IS
    'Immutable snapshot of the approver''s full_name, taken from the session when the grant was written. A copy, not a reference, so it survives deletion of the account and cannot be retroactively edited by renaming someone. Empty only for a service_role row written outside any session.';

-- Backfill, for rows written before this column existed. Only rows whose
-- name is still empty are touched, so a correct value is never rewritten.
UPDATE public.report_access_grants g
   SET granted_by_name = COALESCE(
           (SELECT NULLIF(btrim(s.full_name), '') FROM public.staff_profiles s WHERE s.id = g.granted_by),
           (SELECT s.username                FROM public.staff_profiles s WHERE s.id = g.granted_by),
           '')
 WHERE g.granted_by_name = ''
   AND g.granted_by IS NOT NULL;

-- A row with neither a live reference nor a name cannot be attributed by
-- anyone, now or later. 0024 closed the door that let these in, so this
-- should always be zero - but it is reported loudly rather than filled
-- with a guess, because inventing an author is worse than an honest gap.
DO $$
DECLARE
    orphans integer;
BEGIN
    SELECT count(*) INTO orphans
      FROM public.report_access_grants
     WHERE granted_by_name = ''
       AND granted_by IS NULL;

    IF orphans > 0 THEN
        RAISE WARNING
            '0025: % grant row(s) have no author name and no live reference. These predate the 0024 fix and need a human decision - this file will not invent one.', orphans;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. THE TRIGGER, WHICH NOW STAMPS THE NAME ALONGSIDE THE ID.
--
--    Byte-for-byte the 0024 body, with one line added at the end and one
--    refusal added before it. Everything 0024 fixed is deliberately left
--    intact - the caller still comes from ent_auth_uid(), never from
--    current_user - so that re-running 0024 after this file still passes
--    0024's own assertions instead of silently reintroducing the bug.
--
--    The name is taken from the SAME resolved profile as the id, so the two
--    columns can never describe different people. It is never read from
--    NEW: a client that sent its own granted_by_name has it overwritten
--    here, exactly as granted_by already was.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me      public.staff_profiles;
    target  public.staff_profiles;
    caller  uuid := public.ent_auth_uid();
    author  text;
BEGIN
    -- Unchanged from 0024: the guard asks the SESSION, not current_user,
    -- which inside SECURITY DEFINER is the owner and would let every
    -- caller return before anything is stamped.
    --
    -- No JWT means a trusted server-side writer (service_role, migration,
    -- backup). The row passes through untouched, so granted_by_name keeps
    -- its '' default. That is an acknowledged gap, not an oversight: this
    -- path has no session and therefore no honest name to write.
    IF caller IS NULL THEN
        RETURN NEW;
    END IF;

    -- Unchanged from 0024: a caller WITH a session must be a real, active
    -- staff member.
    SELECT * INTO me FROM public.staff_profiles WHERE id = caller;
    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- Unchanged from 0024: SECURITY DEFINER is what lets this lookup cross
    -- clinics, and approver and grantee are in different clinics by
    -- definition - that is what a grant IS.
    SELECT * INTO target FROM public.staff_profiles WHERE id = NEW.grantee_id;
    IF target.id IS NULL OR NOT target.is_active THEN
        RAISE EXCEPTION 'refused: the grantee is not an active staff member'
            USING ERRCODE = '42501';
    END IF;

    -- Unchanged from 0024: a same-clinic grantee needs no grant at all.
    IF target.clinic_id = me.clinic_id THEN
        RAISE EXCEPTION 'refused: that person is in your own clinic and needs no grant'
            USING ERRCODE = '42501';
    END IF;

    -- Unchanged from 0024: the granter must still be allowed on the patient
    -- at write time, not merely when the grant was created.
    IF NOT public.ent_may_grant_report_access(NEW.report_id) THEN
        RAISE EXCEPTION 'refused: you may not grant access to that report'
            USING ERRCODE = '42501';
    END IF;

    -- 0025: resolve the author's name BEFORE stamping anything, so a
    -- profile with no usable name is refused rather than written as an
    -- empty author. The fallback to username is deliberate - a profile
    -- without a full_name is still a real, identifiable person, and
    -- storing their username is an honest record where '' is not.
    author := COALESCE(NULLIF(btrim(me.full_name), ''), NULLIF(btrim(me.username), ''));
    IF author IS NULL THEN
        RAISE EXCEPTION 'refused: your staff profile has no name, so this grant could not be attributed'
            USING ERRCODE = '42501';
    END IF;

    -- Reached only now, exactly as in 0024.
    --
    -- NOT ALIGNED, DELIBERATELY. Do not "tidy" the spacing on these three
    -- lines. Both this file's assertions and 0024's match the literal text
    -- 'new.granted_by := me.id', with single spaces, because that is how
    -- the statement is written here. Aligning the := signs replaces those
    -- spaces with several, the ILIKE no longer matches, and the file
    -- refuses to apply itself for a reason that looks nothing like the
    -- cause. The formatting is load-bearing.
    NEW.granted_by := me.id;
    NEW.granted_by_name := left(author, 200);
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ent_stamp_grant() IS
    'Stamps granted_by, granted_by_name and created_at from the session, and refuses a grant whose grantee does not exist, is deactivated, is in the approver''s own clinic, or whose approver is no longer allowed. SECURITY DEFINER so the grantee lookup can cross clinics: grants_insert_owner has already made the approval decision before this runs, and the trigger exists to stamp and sanity-check, not to authorise. 0025 added the name snapshot, which is why the author survives deletion of their account.';

-- ---------------------------------------------------------------------
-- 3. THE ASSERTIONS
--
--    Four properties, checked against the LIVE catalogue so the file
--    cannot apply in a state that leaves the hole open:
--
--      a) granted_by is STILL NULLABLE. This is the whole point. If
--         anything ever sets it NOT NULL, account deletion starts
--         failing and the schema has quietly chosen option (a).
--      b) granted_by_name exists and is NOT NULL.
--      c) the trigger stamps it, and takes it from the session.
--      d) the foreign key is still ON DELETE SET NULL, not CASCADE.
--         CASCADE would delete the grant row when the author leaves,
--         which is the outcome this whole file exists to prevent.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    fn_src   text;
    col_nullable text;
    fk_del   text;
BEGIN
    -- (a) granted_by must remain nullable.
    SELECT is_nullable INTO col_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'report_access_grants'
       AND column_name = 'granted_by';

    IF col_nullable IS NULL THEN
        RAISE EXCEPTION 'refused: report_access_grants.granted_by is missing. Apply 0019 first.';
    END IF;

    IF col_nullable <> 'YES' THEN
        RAISE EXCEPTION
            'refused: granted_by is NOT NULL, which conflicts with ON DELETE SET NULL. Deleting an approver would start failing instead of preserving their grants. 0025 keeps this column nullable and adds granted_by_name alongside it.';
    END IF;

    -- (b) the name column must exist and be NOT NULL.
    SELECT is_nullable INTO col_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'report_access_grants'
       AND column_name = 'granted_by_name';

    IF col_nullable IS NULL THEN
        RAISE EXCEPTION 'refused: granted_by_name was not created.';
    END IF;

    IF col_nullable <> 'NO' THEN
        RAISE EXCEPTION
            'refused: granted_by_name is still nullable, so a grant can be written with no surviving author. That is the same hole this file closes, one column over.';
    END IF;

    -- (d) the FK must still be SET NULL, never CASCADE.
    SELECT confdeltype INTO fk_del
      FROM pg_constraint
     WHERE conrelid = 'public.report_access_grants'::regclass
       AND contype  = 'f'
       AND conkey   = ARRAY[
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public.report_access_grants'::regclass
                 AND attname  = 'granted_by')];

    IF fk_del IS NULL THEN
        RAISE EXCEPTION 'refused: the granted_by foreign key is missing. Apply 0019 first.';
    END IF;

    IF fk_del <> 'n' THEN
        RAISE EXCEPTION
            'refused: the granted_by foreign key is not ON DELETE SET NULL. Deleting an approver would destroy the record of what they approved, which is precisely the failure 0025 exists to prevent.';
    END IF;

    -- (c) the trigger must stamp the name from the session.
    SELECT pg_get_functiondef(oid) INTO fn_src
      FROM pg_proc
     WHERE oid = to_regprocedure('public.ent_stamp_grant()');

    IF fn_src IS NULL THEN
        RAISE EXCEPTION 'refused: ent_stamp_grant is missing. Apply 0019 first.';
    END IF;

    -- Strip comments; this function's comments name what it must not do.
    fn_src := regexp_replace(fn_src, chr(45) || chr(45) || '[^\n]*', '', 'g');

    IF fn_src NOT ILIKE '%new.granted_by_name :=%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant does not stamp granted_by_name, so the column stays empty and the author still disappears with the account.';
    END IF;

    -- The name must come from the resolved profile, never from the row.
    -- A client-supplied author is the same forgery as a client-supplied id.
    IF fn_src ILIKE '%new.granted_by_name := new.%'
       OR fn_src ILIKE '%new.granted_by_name := new.granted_by_name%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant would take granted_by_name from the row instead of the session. The author must be server-owned.';
    END IF;

    -- 0024's fix must still be intact. This file replaces the same
    -- function, so it is also the one place the 0024 regression could
    -- come back through - and it would come back silently.
    IF fn_src ILIKE '%current_user%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant reads current_user. Under SECURITY DEFINER that is the function owner, so the guard would return before anything is stamped.';
    END IF;

    IF fn_src NOT ILIKE '%new.granted_by := me.id%'
       OR fn_src NOT ILIKE '%ent_auth_uid%' THEN
        RAISE EXCEPTION
            'refused: ent_stamp_grant no longer identifies the caller from the verified JWT. Apply 0024 first.';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';

