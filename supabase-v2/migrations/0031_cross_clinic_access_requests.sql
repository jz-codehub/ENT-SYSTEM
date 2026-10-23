-- =====================================================================
--  0031 · CROSS-CLINIC ACCESS REQUESTS
--  ---------------------------------------------------------------------
--  THE GAP THIS CLOSES.
--
--  0019/0020 shipped the cross-clinic permission system: another clinic
--  can SEE that a patient exists (metadata only) and can be GRANTED the
--  record. What never shipped was the other half of that sentence - the
--  ASK. "Request access" on the View All page recorded the reason in the
--  browser's own sessionStorage, which is one device's local storage: the
--  owning clinic had no way to receive it, and the requester had no way
--  to learn what happened. A request nobody can receive is not a request.
--
--  This file makes the request a real, server-side object:
--
--    · the REQUESTER sends one row (report + reason, stamped as himself);
--    · the OWNING clinic sees it on View All - "Requests to my clinic" -
--      and decides with one click: grant or deny;
--    · the REQUESTER sees the answer on the same page - "My requests" -
--      and the moment a grant exists, ent_view_all_index reports the row
--      can_view = true and the table offers Open instead of Request.
--
--  WHAT DECIDES IS STILL ONLY THE SERVER. The table never grants
--  anything. A request row is a letter, not a permission: approval goes
--  through ent_handle_access_request(), which calls the same
--  ent_may_grant_report_access() predicate that guards 0019's write
--  policy and creates the grant with ent_stamp_grant's own checks
--  running. The client cannot approve its own request, cannot flip
--  status through REST (there is deliberately NO UPDATE policy), and
--  cannot read a reply that is not its own.
--
--  DEPENDS ON: 0019 (report_access_grants, ent_may_grant_report_access,
--  ent_stamp_grant), 0020 (ent_auth_uid use in RPCs, ent_view_all_index
--  style), 0002/0003/0004 (clinics, staff_profiles, reports).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. THE TABLE.
--
--    status is the letter's life cycle and nothing else writes it:
--        pending  -> the owning clinic has not decided
--        approved -> a grant exists (created in the SAME call)
--        denied   -> the owning clinic said no; reason captured
--
--    The partial unique index below means one PENDING request per
--    (report, requester): pressing Request twice is a database error,
--    not two letters in the queue. Once the first one is handled the
--    pair may ask again - a denied request is history, not a lock.
--
--    handled_by_name is a SNAPSHOT, not a lookup, for exactly the reason
--    0025 added it to grants: the answer must still name its author
--    after that author's account is deleted. ON DELETE SET NULL on the
--    id keeps the row when the person leaves.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.report_access_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id       uuid        NOT NULL REFERENCES public.reports(id)         ON DELETE CASCADE,
    requester_id    uuid        NOT NULL REFERENCES public.staff_profiles(id)  ON DELETE CASCADE,
    reason          text        NOT NULL,
    status          text        NOT NULL DEFAULT 'pending',
    handled_by      uuid        REFERENCES public.staff_profiles(id)           ON DELETE SET NULL,
    handled_by_name text        NOT NULL DEFAULT '',
    handled_at      timestamptz,
    deny_reason     text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT requests_status_allowed CHECK (status IN ('pending', 'approved', 'denied')),
    -- A blank reason is not a reason; 500 matches grants.reason_length.
    CONSTRAINT requests_reason_length  CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
    CONSTRAINT requests_deny_length    CHECK (deny_reason IS NULL OR length(deny_reason) <= 500),
    -- An answer without an answerer is not an answer.
    CONSTRAINT requests_handled_sane   CHECK (
        (status = 'pending' AND handled_at IS NULL)
        OR (status <> 'pending' AND handled_at IS NOT NULL)
    )
);

COMMENT ON TABLE public.report_access_requests IS
    'A letter from one clinic to another: "may I open this patient?". It grants nothing by itself. The owning clinic answers it through ent_handle_access_request(), which is the only writer of status - the table has no UPDATE policy on purpose, so REST can never mark its own request approved.';
COMMENT ON COLUMN public.report_access_requests.reason IS
    'Why access is being asked for. Free text, no PHI required, stored in the audit trail with the requester''s name.';
COMMENT ON COLUMN public.report_access_requests.handled_by_name IS
    'Snapshot of the decider''s display name, so the answer names its author even after that account is deleted (the 0025 rule, one column over).';

-- One PENDING letter per (report, requester). Resolved pairs may ask
-- again later; the index does not cover them because it does not need to.
CREATE UNIQUE INDEX IF NOT EXISTS uq_requests_pending
    ON public.report_access_requests (report_id, requester_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_requests_report ON public.report_access_requests (report_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON public.report_access_requests (requester_id, status, created_at DESC);

ALTER TABLE public.report_access_requests ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- 2. THE REQUEST STAMPS ITSELF - and refuses what should never be asked.
--
--    BEFORE INSERT, so the row that RLS and the constraints finally see
--    already carries the session's staff id as requester_id. The client
--    may send requester_id (it is NOT NULL); the trigger OVERWRITES it
--    with the session's own - a letter can only be written in one hand.
--
--    The refusals are here rather than in the policy because they are
--    sanity checks about the SUBJECT, not about the caller:
--
--      · a draft is unfinished work inside one clinic. It never enters
--        the cross-clinic system (0020 filters it from the index; 0019
--        refuses to grant it) and it must not be requestable either;
--      · a patient already in the caller's clinic needs no letter at
--        all - ent_view_all_index already reports can_view for it, so
--        asking would be a request nobody has to answer;
--      · no active staff profile means no honest author to record.
--
--    No session (service_role, migration, restore): the row passes
--    through untouched, exactly like ent_stamp_grant - there is no
--    session and therefore no honest name to stamp.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_stamp_access_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me     public.staff_profiles;
    rep    public.reports;
    caller uuid := public.ent_auth_uid();
BEGIN
    IF caller IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO me FROM public.staff_profiles WHERE id = caller;
    IF me.id IS NULL OR NOT me.is_active THEN
        RAISE EXCEPTION 'refused: no active staff profile for this session'
            USING ERRCODE = '42501';
    END IF;

    -- The letter is always written by the session's own hand.
    NEW.requester_id := me.id;
    NEW.reason := btrim(NEW.reason);

    -- The subject must exist before anything can be asked about it
    -- (the foreign key would catch this a moment later anyway, but the
    -- refusal text should say what happened rather than FK-violation).
    SELECT * INTO rep FROM public.reports WHERE id = NEW.report_id;
    IF rep.id IS NULL THEN
        RAISE EXCEPTION 'refused: no such record'
            USING ERRCODE = '22023';
    END IF;

    IF rep.is_draft THEN
        RAISE EXCEPTION 'refused: a draft cannot be requested from another clinic'
            USING ERRCODE = '42501';
    END IF;

    IF rep.clinic_id = me.clinic_id THEN
        RAISE EXCEPTION 'refused: that patient already belongs to your clinic'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ent_stamp_access_request() IS
    'BEFORE INSERT: stamps requester_id from the session (overwriting whatever the client sent), trims the reason, and refuses a request about a missing record, a draft, or a patient already in the caller''s clinic. SECURITY DEFINER so the report lookup can cross clinics. It stamps and sanity-checks, it does not authorise - nothing here grants access.';

DROP TRIGGER IF EXISTS trg_stamp_access_request ON public.report_access_requests;
CREATE TRIGGER trg_stamp_access_request
    BEFORE INSERT ON public.report_access_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.ent_stamp_access_request();


-- ---------------------------------------------------------------------
-- 3. REQUEST POLICIES - the whole of what REST may do.
--
--    INSERT   any active staff member, as himself. Whether the subject
--             is askable at all is the trigger's question above.
--    SELECT   the two parties only: the requester reads his own letters,
--             and the OWNING side (ent_may_grant_report_access - the
--             same predicate 0019's write policy uses) reads the letters
--             about its own patients. Nobody else, in particular not the
--             requester's own clinic manager reading someone else's ask.
--
--    UPDATE   NONE. And DELETE: none. This is deliberate and is the
--             load-bearing part of the design: status is written only
--             by ent_handle_access_request() (SECURITY DEFINER), so a
--             client cannot mark its own request approved, cannot flip
--             a denial, and cannot erase the trail. The audit trail
--             does not delete itself either - the same reason grants
--             keep their rows.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS requests_insert_caller ON public.report_access_requests;
CREATE POLICY requests_insert_caller ON public.report_access_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        public.ent_auth_uid() IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM public.staff_profiles p
             WHERE p.id = public.ent_auth_uid() AND p.is_active
        )
    );

DROP POLICY IF EXISTS requests_select_parties ON public.report_access_requests;
CREATE POLICY requests_select_parties ON public.report_access_requests
    FOR SELECT TO authenticated
    USING (
        requester_id = public.ent_auth_uid()
        OR public.ent_may_grant_report_access(report_id)
    );


-- ---------------------------------------------------------------------
-- 4. THE OWNING CLINIC'S INBOX.
--
--    ent_view_incoming_access_requests() answers "who is asking me for
--    what?" - pending letters about reports this caller may grant, with
--    just enough metadata to recognise the patient and the asker. Same
--    column discipline as ent_view_all_index (0020): identity and
--    metadata only, never the payload - deciding a letter must not be a
--    way to read one.
--
--    The owner test is ent_may_grant_report_access() itself, not a
--    re-derived clinic comparison, so the inbox can never show a letter
--    to someone who could not have approved it anyway. The RLS policy
--    agrees; this function is SECURITY DEFINER and therefore enforces
--    the rule on its own rather than leaning on it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_view_incoming_access_requests()
RETURNS TABLE (
    request_id       uuid,
    report_id        uuid,
    patient_name     text,
    case_number      text,
    report_type      text,
    procedure_date   date,
    reason           text,
    requested_at     timestamptz,
    requester_name   text,
    requester_clinic text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        q.id,
        q.report_id,
        r.patient_name,
        r.case_number,
        r.report_type::text,
        r.procedure_date,
        q.reason,
        q.created_at,
        coalesce(nullif(btrim(sp.full_name), ''), btrim(sp.username::text), 'Unknown'),
        coalesce(nullif(btrim(c.name), ''), c.code, 'Unknown clinic')
      FROM public.report_access_requests q
      JOIN public.reports r                  ON r.id = q.report_id
      JOIN public.staff_profiles me          ON me.id = public.ent_auth_uid() AND me.is_active
      LEFT JOIN public.staff_profiles sp     ON sp.id = q.requester_id
      LEFT JOIN public.clinics c             ON c.id  = sp.clinic_id
     WHERE q.status = 'pending'
       AND public.ent_may_grant_report_access(q.report_id)
     ORDER BY q.created_at ASC
     LIMIT 200;
$$;

COMMENT ON FUNCTION public.ent_view_incoming_access_requests() IS
    'Pending cross-clinic access requests about reports the CALLER may grant, with patient and requester metadata only - no payload. The owner test is ent_may_grant_report_access(), so this inbox can never show a letter to someone who could not approve it. Clamped to 200 rows.';


-- ---------------------------------------------------------------------
-- 5. THE REQUESTER'S OUTBOX - "what happened to my ask?"
--
--    Returns every letter this caller wrote, with its status and, for a
--    decided one, who answered it and why. can_view rides along from
--    ent_may_open_report() so the page can show "Open now" on an
--    approved letter without the UI re-deriving permission - the same
--    one-answer rule as ent_view_all_index: if this says true, the
--    record opens; if false, nothing was ever disclosed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_view_my_access_requests()
RETURNS TABLE (
    request_id      uuid,
    report_id       uuid,
    patient_name    text,
    case_number     text,
    report_type     text,
    procedure_date  date,
    reason          text,
    requested_at    timestamptz,
    status          text,
    handled_at      timestamptz,
    handled_by_name text,
    deny_reason     text,
    can_view        boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        q.id,
        q.report_id,
        r.patient_name,
        r.case_number,
        r.report_type::text,
        r.procedure_date,
        q.reason,
        q.created_at,
        q.status,
        q.handled_at,
        nullif(q.handled_by_name, ''),
        q.deny_reason,
        public.ent_may_open_report(q.report_id)
      FROM public.report_access_requests q
      JOIN public.reports r         ON r.id = q.report_id
      JOIN public.staff_profiles me ON me.id = public.ent_auth_uid() AND me.is_active
     WHERE q.requester_id = me.id
     ORDER BY q.created_at DESC
     LIMIT 200;
$$;

-- ---------------------------------------------------------------------
-- 6. THE REQUEST AND DECISION RPCs
--
--    ent_request_report() inserts a pending letter; ent_handle_access_request()
--    is the only writer of status.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_request_report(p_report uuid, p_reason text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    INSERT INTO public.report_access_requests (report_id, requester_id, reason)
    SELECT p_report, public.ent_auth_uid(), btrim(p_reason);
$$;

COMMENT ON FUNCTION public.ent_request_report(uuid, text) IS
    'Inserts a pending cross-clinic access request. The BEFORE INSERT trigger
    ent_stamp_access_request() enforces business rules and stamps requester_id.
    The request starts in status = pending.';

CREATE OR REPLACE FUNCTION public.ent_handle_access_request(p_request_id uuid, p_decision text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_report_id uuid;
    v_requester_id uuid;
    v_requester_name text;
    v_report_clinic_id uuid;
    v_handler_name text;
BEGIN
    -- Resolve the request row
    SELECT q.report_id, q.requester_id, q.handled_by_name
      INTO v_report_id, v_requester_id, v_requester_name
      FROM public.report_access_requests q
     WHERE q.id = p_request_id;

    IF v_report_id IS NULL THEN
        RAISE EXCEPTION 'refused: unknown request' USING ERRCODE = '22023';
    END IF;

    -- The handler must be able to grant access to the report
    IF NOT public.ent_may_grant_report_access(v_report_id) THEN
        RAISE EXCEPTION 'refused: caller cannot grant this report' USING ERRCODE = '42501';
    END IF;

    -- Fetch the report's clinic to know who is receiving access
    SELECT r.clinic_id INTO v_report_clinic_id
    FROM public.reports r
    WHERE r.id = v_report_id;

    v_handler_name := (SELECT COALESCE(sp.full_name, 'Unknown') FROM public.staff_profiles sp WHERE sp.id = public.ent_auth_uid());

    IF v_report_clinic_id IS NULL THEN
        RAISE EXCEPTION 'refused: report not found' USING ERRCODE = '22023';
    END IF;

    IF p_decision = 'grant' THEN
        -- The GRANTEE is the REQUESTER - the person from the other clinic
        -- who asked. ent_stamp_grant() refuses a same-clinic grantee, and
        -- granting to yourself would be a grant that grants nothing.
        INSERT INTO public.report_access_grants (report_id, grantee_id, reason)
        VALUES (v_report_id, v_requester_id, 'Cross-clinic access request approved')
        ON CONFLICT (report_id, grantee_id) DO NOTHING;

        -- Mark the request approved
        UPDATE public.report_access_requests
           SET status       = 'approved',
               handled_by   = public.ent_auth_uid(),
               handled_by_name = v_handler_name,
               handled_at   = now()
         WHERE id = p_request_id;
    ELSIF p_decision = 'deny' THEN
        UPDATE public.report_access_requests
           SET status           = 'denied',
               handled_by       = public.ent_auth_uid(),
               handled_by_name  = v_handler_name,
               handled_at       = now(),
               deny_reason      = btrim(p_reason)
         WHERE id = p_request_id;
    ELSE
        RAISE EXCEPTION 'invalid decision: %' , p_decision USING ERRCODE = '22023';
    END IF;
END;
$$;

COMMENT ON FUNCTION public.ent_handle_access_request(uuid, text, text) IS
    'Only the owning clinic admin (or the report''s own doctor) may grant or
    deny a request. Grant creates a grant via the table''s SECURITY DEFINER
    stamp trigger ent_stamp_grant(); deny records the denial reason and
    freezes the request. The request row is the only writer of status.';

COMMENT ON FUNCTION public.ent_view_my_access_requests() IS
    'The caller''s own access requests with their status, the answerer''s name snapshot and why they were refused - the reply half of the request. can_view comes from ent_may_open_report(), so an approved letter turns into a real Open button without the UI deriving permission. Clamped to 200 rows.';
