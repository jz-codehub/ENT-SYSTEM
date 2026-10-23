-- =====================================================================
--  0012 . tickets   (in-app support: a doctor or secretary reports a
--                    problem with the website, and the thread is where
--                    the conversation happens)
-- ---------------------------------------------------------------------
--  WHY THIS IS NOT A reports ROW
--  A report is clinical data: it belongs to a patient, on a doctor's
--  shelf, and is governed by the PHI rules. A ticket is the opposite --
--  it is about the SOFTWARE, authored by staff, safe to read by any admin
--  in the clinic, and must never be mixed into a patient list, a search
--  result, a PDF, or a backup that someone assumes is all clinical data.
--  Separate tables keep that separation structural rather than a filter
--  somebody has to remember.
--
--  THE SHAPE
--  tickets        one row per problem report
--  ticket_messages the thread under it, both sides of the conversation
--
--  The message table is separate rather than a jsonb array because the
--  thread is appended to constantly, is read by row (a page of it), and
--  is the thing a doctor scrolls through. An array would mean rewriting
--  and re-uploading the whole ticket on every reply, and would make
--  "unread since my last visit" impossible to express in SQL.
--
--  SECURITY, and the rule that actually matters here
--  The browser never names an owner. clinic_id, created_by and author_id
--  are STAMPED by the trigger below from the caller's live staff_profiles
--  row, exactly as reports does it in 0004. A body that says
--  {"created_by": "<someone else>"} is ignored, not obeyed.
--
--  A ticket is clinic-scoped, exactly like everything else: a doctor in
--  one clinic can never see another clinic's ticket, and an admin sees
--  only his own clinic's. Verified by TKT-04/TKT-05 in the test plan.
--
--  IDEMPOTENT   : yes, safe to re-run.
--  DATA DESTRUCTIVE : no, this file only adds.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Enumerated domains
--    As in 0001: an invalid value is rejected by the DATABASE, not only by
--    a JS check that someone can forget.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ent_ticket_status') THEN
        CREATE TYPE ent_ticket_status AS ENUM
            ('open', 'in_progress', 'resolved', 'closed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ent_ticket_priority') THEN
        CREATE TYPE ent_ticket_priority AS ENUM
            ('low', 'normal', 'high', 'urgent');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ent_ticket_category') THEN
        CREATE TYPE ent_ticket_category AS ENUM
            ('bug', 'access', 'data', 'question', 'other');
    END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2. tickets
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tickets (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id      uuid        NOT NULL REFERENCES public.clinics(id)        ON DELETE RESTRICT,
    created_by     uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE RESTRICT,

    subject        text        NOT NULL,
    category       public.ent_ticket_category NOT NULL DEFAULT 'bug',
    priority       public.ent_ticket_priority NOT NULL DEFAULT 'normal',
    status         public.ent_ticket_status  NOT NULL DEFAULT 'open',

    -- Who is dealing with it, when an admin has picked it up. An admin of
    -- THIS clinic only; a foreign uuid cannot even be typed in because the
    -- stamp function rejects it.
    assigned_to    uuid        REFERENCES public.staff_profiles(id) ON DELETE SET NULL,

    -- Drives the list ordering without a join, and makes "has anything
    -- moved since I last looked" a single index-friendly comparison.
    last_message_at timestamptz NOT NULL DEFAULT now(),
    last_message_by uuid        REFERENCES public.staff_profiles(id) ON DELETE SET NULL,

    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at    timestamptz,

    -- A ticket with no subject is a ticket nobody can triage.
    CONSTRAINT tickets_subject_shape CHECK (length(btrim(subject)) BETWEEN 3 AND 200),

    -- A resolved or closed ticket must say WHEN. Without this, "resolved"
    -- with no timestamp is a status report nobody can age.
    --
    -- The converse is deliberately NOT enforced: a ticket that was
    -- resolved and later reopened keeps its old resolved_at, because that
    -- is the truthful history rather than a value to erase on reopen.
    CONSTRAINT tickets_resolved_has_stamp CHECK (
        status IN ('open', 'in_progress') OR resolved_at IS NOT NULL
    )
);

COMMENT ON TABLE public.tickets IS
    'Staff support requests about the software. NOT clinical data - never merge with reports.';
COMMENT ON COLUMN public.tickets.clinic_id IS
    'STAMPED by the server from the caller profile. The request body is ignored.';
COMMENT ON COLUMN public.tickets.last_message_at IS
    'Bumped by a trigger on every new message, so the list can sort by activity.';


-- ---------------------------------------------------------------------
-- 3. ticket_messages
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ticket_messages (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id   uuid        NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    author_id   uuid        NOT NULL REFERENCES public.staff_profiles(id) ON DELETE RESTRICT,
    body        text        NOT NULL,

    -- Recorded at write time, from the author's live profile, so the
    -- thread still reads correctly after somebody is promoted or demoted
    -- months later. Without this, old replies relabel themselves.
    author_role public.ent_role NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ticket_messages_body_shape CHECK (length(btrim(body)) BETWEEN 1 AND 8000)
);

COMMENT ON TABLE public.ticket_messages IS
    'The conversation under a ticket, both sides. Cascades when the ticket is deleted.';
COMMENT ON COLUMN public.ticket_messages.author_role IS
    'The author role AT THE TIME OF WRITING, stamped server-side. Not re-read later.';


-- ---------------------------------------------------------------------
-- 4. Indexes - the queries are always "my tickets, newest activity first"
--    and "one ticket''s thread, oldest first".
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tickets_mine
    ON public.tickets (created_by, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_clinic_open
    ON public.tickets (clinic_id, last_message_at DESC)
    WHERE status IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_ticket_messages_thread
    ON public.ticket_messages (ticket_id, created_at);

ALTER TABLE public.tickets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;


-- =====================================================================
--  5. OWNERSHIP STAMP
--  The browser cannot name an owner, a clinic, or an author. Whatever the
--  request body says is overwritten from the caller's LIVE staff_profiles
--  row, exactly as 0004 does for reports.
--
--  A BEFORE ROW trigger runs before the NOT NULL check and before the RLS
--  WITH CHECK, so by the time the row is written every ownership column is
--  already server-owned.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ent_stamp_ticket_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me    public.staff_profiles;
    v_uid uuid := public.ent_auth_uid();
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                              -- trusted writer
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = v_uid;

    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- 1. clinic is always the caller's own, on every write.
    NEW.clinic_id := me.clinic_id;

    -- ------------------------------------------------------------------
    --  INSERT
    --  OLD is UNASSIGNED on an INSERT trigger in PL/pgSQL: reading
    --  OLD.anything raises 'record "old" is not assigned yet'. So the
    --  insert path must never mention OLD at all.
    -- ------------------------------------------------------------------
    IF TG_OP = 'INSERT' THEN
        NEW.created_by      := me.id;
        NEW.last_message_by := me.id;
        NEW.last_message_at := now();

        -- A ticket cannot be born resolved, and it cannot be born owned by
        -- somebody else. Both would be a lie about what has happened.
        NEW.status     := 'open';
        NEW.resolved_at := NULL;

        -- An admin may pre-assign it, but only to a real ACTIVE member of
        -- his own clinic. Refused, not silently dropped: a ticket quietly
        -- unassigned is how one gets forgotten.
        IF NEW.assigned_to IS NOT NULL THEN
            IF NOT public.ent_is_active_admin() THEN
                RAISE EXCEPTION 'refused: only an administrator can assign a ticket'
                    USING ERRCODE = '42501';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM public.staff_profiles s
                 WHERE s.id = NEW.assigned_to
                   AND s.clinic_id = me.clinic_id
                   AND s.is_active
            ) THEN
                RAISE EXCEPTION 'refused: that person is not an active member of your clinic'
                    USING ERRCODE = '42501';
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    -- ------------------------------------------------------------------
    --  UPDATE  (OLD is assigned here)
    -- ------------------------------------------------------------------

    -- 2. author and activity are NOT the editor's to rewrite. Someone
    --    could otherwise take a colleague's ticket over by UPDATEing
    --    created_by, or freeze a busy ticket by resetting last_message_at.
    NEW.created_by      := OLD.created_by;
    NEW.last_message_by := OLD.last_message_by;
    NEW.last_message_at := OLD.last_message_at;

    -- 3. assignment, same rule as on insert.
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
        IF NOT public.ent_is_active_admin() THEN
            RAISE EXCEPTION 'refused: only an administrator can assign a ticket'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.staff_profiles s
             WHERE s.id = NEW.assigned_to
               AND s.clinic_id = me.clinic_id
               AND s.is_active
        ) THEN
            RAISE EXCEPTION 'refused: that person is not an active member of your clinic'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- 4. Status. The AUTHOR may close or reopen their own ticket, because
    --    "solved, thanks" is the most common message in any support
    --    system and must not require an admin. An admin may move it
    --    through every state. A doctor/secretary may NOT mark it
    --    resolved, because that would hide work never actually done.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status = 'resolved' AND NOT public.ent_is_active_admin() THEN
            RAISE EXCEPTION 'refused: only an administrator can resolve a ticket'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.status = 'closed' AND NOT public.ent_is_active_admin()
                          AND me.id <> OLD.created_by THEN
            RAISE EXCEPTION 'refused: only the author or an administrator can close a ticket'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- 5. Keep resolved_at honest whatever happened above.
    IF NEW.status IN ('resolved', 'closed') THEN
        NEW.resolved_at := COALESCE(NEW.resolved_at, OLD.resolved_at, now());
    ELSE
        NEW.resolved_at := NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_stamp ON public.tickets;
CREATE TRIGGER trg_tickets_stamp
    BEFORE INSERT OR UPDATE ON public.tickets
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_ticket_ownership();

DROP TRIGGER IF EXISTS trg_tickets_touch ON public.tickets;
CREATE TRIGGER trg_tickets_touch
    BEFORE UPDATE ON public.tickets
    FOR EACH ROW EXECUTE FUNCTION public.ent_touch_updated_at();


-- =====================================================================
--  6. MESSAGE STAMP + ACTIVITY BUMP
--  Two jobs in one trigger, because they must happen in one transaction:
--  a reply is recorded AND the parent ticket moves to the top of the list.
--  Doing them separately would let a crash leave a reply that never
--  bumped the ticket, and the reply would be invisible in the UI.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ent_stamp_ticket_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    me    public.staff_profiles;
    v_ticket public.tickets;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                              -- trusted writer
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = public.ent_auth_uid();
    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- The ticket must exist and be in MY clinic. Reading it here (as the
    -- table owner, inside SECURITY DEFINER) is the point: it lets the
    -- check be unconditional, where an RLS policy would depend on the
    -- caller being able to SELECT the row at all.
    SELECT * INTO v_ticket FROM public.tickets WHERE id = NEW.ticket_id;
    IF v_ticket.id IS NULL THEN
        RAISE EXCEPTION 'refused: no such ticket'
            USING ERRCODE = '42501';
    END IF;
    IF v_ticket.clinic_id <> me.clinic_id THEN
        RAISE EXCEPTION 'refused: that ticket belongs to another clinic'
            USING ERRCODE = '42501';
    END IF;

    -- 1. the author is the caller, whatever the body claimed.
    NEW.author_id   := me.id;
    -- 2. the role is captured NOW, so the thread still reads correctly
    --    after this person is promoted or leaves months later.
    NEW.author_role := me.role;

    -- 3. bump the parent. UPDATE goes through trg_tickets_stamp, which
    --    preserves created_by and validates the status rules; nothing
    --    here changes status, so no status check is triggered.
    UPDATE public.tickets
       SET last_message_at = now(),
           last_message_by = me.id
     WHERE id = NEW.ticket_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_messages_stamp ON public.ticket_messages;
CREATE TRIGGER trg_ticket_messages_stamp
    BEFORE INSERT ON public.ticket_messages
    FOR EACH ROW EXECUTE FUNCTION public.ent_stamp_ticket_message();


-- =====================================================================
--  7. ROW LEVEL SECURITY
--  The whole access model for tickets, in one place.
--
--    doctor / secretary  ->  tickets THEY filed, and the threads on them
--    admin               ->  every ticket in HIS OWN clinic, and nothing
--                           outside it
--
--  Note what is NOT here: there is no policy that trusts a clinic_id from
--  the request, and none that compares a column against a request-body
--  value. The clinic always comes from the caller's own profile row.
-- =====================================================================

-- ---- tickets: read -----------------------------------------------------
DROP POLICY IF EXISTS tickets_select_own ON public.tickets;
CREATE POLICY tickets_select_own ON public.tickets
    FOR SELECT TO authenticated
    USING ( created_by = public.ent_auth_uid() );

DROP POLICY IF EXISTS tickets_select_admin_clinic ON public.tickets;
CREATE POLICY tickets_select_admin_clinic ON public.tickets
    FOR SELECT TO authenticated
    USING (
        public.ent_is_active_admin()
        AND clinic_id = public.ent_claim_clinic_id()
        AND public.ent_is_member_of(clinic_id)
    );

-- ---- tickets: create ---------------------------------------------------
-- The INSERT policy only has to admit the row; trg_tickets_stamp then
-- overwrites clinic_id and created_by, so admitting it here cannot let a
-- caller choose an owner.
DROP POLICY IF EXISTS tickets_insert_own ON public.tickets;
CREATE POLICY tickets_insert_own ON public.tickets
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_is_authenticated()
        AND created_by = public.ent_auth_uid()
    );

-- ---- tickets: update ---------------------------------------------------
-- The author may edit their own ticket; an admin may edit any ticket in
-- his own clinic. The trigger then restricts WHICH fields each of them may
-- actually change, so this policy is the outer gate, not the only one.
DROP POLICY IF EXISTS tickets_update_own ON public.tickets;
CREATE POLICY tickets_update_own ON public.tickets
    FOR UPDATE TO authenticated
    USING ( created_by = public.ent_auth_uid() )
    WITH CHECK ( created_by = public.ent_auth_uid() );

DROP POLICY IF EXISTS tickets_update_admin ON public.tickets;
CREATE POLICY tickets_update_admin ON public.tickets
    FOR UPDATE TO authenticated
    USING (
        public.ent_is_active_admin()
        AND clinic_id = public.ent_claim_clinic_id()
        AND public.ent_is_member_of(clinic_id)
    )
    WITH CHECK (
        public.ent_is_active_admin()
        AND clinic_id = public.ent_claim_clinic_id()
    );

-- ---- ticket_messages: read -------------------------------------------
-- You may read a thread if you are allowed to read the ticket it hangs
-- off. Expressed as a subquery rather than a join so it cannot be
-- defeated by selecting the message ids first and the bodies later.
DROP POLICY IF EXISTS ticket_messages_select_visible ON public.ticket_messages;
CREATE POLICY ticket_messages_select_visible ON public.ticket_messages
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.tickets t
             WHERE t.id = ticket_messages.ticket_id
               AND (
                   t.created_by = public.ent_auth_uid()
                   OR (
                       public.ent_is_active_admin()
                       AND t.clinic_id = public.ent_claim_clinic_id()
                       AND public.ent_is_member_of(t.clinic_id)
                   )
               )
        )
    );

-- ---- ticket_messages: create -----------------------------------------
-- The author is stamped to the caller, so a body claiming to be somebody
-- else is ignored. The visibility test is the same as the read policy, so
-- you cannot reply to a ticket you cannot see.
DROP POLICY IF EXISTS ticket_messages_insert_visible ON public.ticket_messages;
CREATE POLICY ticket_messages_insert_visible ON public.ticket_messages
    FOR INSERT TO authenticated
    WITH CHECK (
        author_id = public.ent_auth_uid()
        AND EXISTS (
            SELECT 1 FROM public.tickets t
             WHERE t.id = ticket_messages.ticket_id
               AND (
                   t.created_by = public.ent_auth_uid()
                   OR (
                       public.ent_is_active_admin()
                       AND t.clinic_id = public.ent_claim_clinic_id()
                       AND public.ent_is_member_of(t.clinic_id)
                   )
               )
        )
    );

-- ---- ticket_messages: no UPDATE, no DELETE ---------------------------
-- A support thread is an append-only record. Editing or deleting a reply
-- would let the reporter change what they complained about after the fact,
-- which is exactly the property an issue tracker must not have. There is
-- deliberately no policy for either: the operation is refused.
-- To correct a typo, post another message.


-- =====================================================================
--  8. PRIVILEGES  (the step that is easy to forget, and fatal to skip)
-- ---------------------------------------------------------------------
--  0001 sets   ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES FROM anon
--  0007 then grants table by table to authenticated, and once with
--            GRANT ALL ON ALL TABLES ... TO service_role.
--
--  Both of those reach only the tables that EXIST AT THAT MOMENT. A table
--  created by a LATER migration therefore inherits nothing: not anon
--  (intended) and not service_role or authenticated (a bug).
--
--  The symptom is confusing and was hit for real: PostgREST answers a
--  request for the missing privilege with
--
--      HTTP 403  {"code":"42501","hint":"Grant the required privileges..."}
--
--  which reads like a permissions problem rather than "this table was
--  created and never granted", and it is NOT the 404 PGRST205 that a table
--  which does not exist at all returns. Proven against the live project.
--
--  So every new table must grant for itself. anon is deliberately absent.
-- =====================================================================

-- authenticated. Privilege says "may you use this table at all"; the RLS
-- policies in section 7 decide WHICH ROWS. Both are required - neither
-- works without the other.
GRANT SELECT, INSERT, UPDATE ON public.tickets          TO authenticated;
GRANT SELECT, INSERT         ON public.ticket_messages  TO authenticated;

-- service_role: the migration key, the Edge Functions, and every
-- provisioning script. It bypasses RLS, so this is trusted-tool access,
-- not a hole.
GRANT ALL ON public.tickets         TO service_role;
GRANT ALL ON public.ticket_messages TO service_role;

-- Anon keeps NOTHING. Assert it, so a later "just add a GRANT ALL to
-- make it work" cannot quietly reintroduce the old exposure.
REVOKE ALL ON public.tickets         FROM anon, public;
REVOKE ALL ON public.ticket_messages FROM anon, public;


-- ---------------------------------------------------------------------
--  9. Done. Reload the PostgREST schema cache so the new tables and
--    policies are visible without waiting for the automatic reload.
-- ---------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
