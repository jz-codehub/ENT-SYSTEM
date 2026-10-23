-- =====================================================================
--  0032 · CLINIC-WIDE REQUEST APPROVAL
--  ---------------------------------------------------------------------
--  THE GAP THIS CLOSES.
--
--  0031's request flow inherited 0019/0021's gate: only an active ADMIN
--  of the owning clinic, or the report's own doctor, may grant. Every
--  other member of that same clinic was refused at approve time with:
--
--      refused: caller cannot grant this report      (SQLSTATE 42501)
--
--  ...and could not even SEE the pending letter, because the inbox view
--  (ent_view_incoming_access_requests) and the RLS select policy on
--  report_access_requests both call that same predicate. A request
--  therefore waited on two or three specific people; unless one of them
--  happened to be the one logged in, the letter sat unanswered.
--
--  THE RULE, RESTATED.
--
--  What 0019 protects is the TENANT boundary, not the job title. Any
--  ACTIVE member of the clinic that OWNS the report - doctor, secretary
--  or admin - may now see, approve and remove access for it, because
--  they all belong to the clinic whose data is being shared. Still
--  refused, exactly as before:
--
--    · a member of ANOTHER clinic (clinic_id inequality);
--    · a manager of a clinic he does not own (managed_by changes nothing);
--    · drafts (r.is_draft = false);
--    · a same-clinic grantee (ent_stamp_grant) - a clinic can never hand
--      itself a grant, so the requester must stay outside;
--    · deactivated accounts (me.is_active = false).
--
--  WHY ONE REPLACE COVERS EVERYTHING.
--
--  ent_may_grant_report_access() is the single source behind the inbox
--  view, both RLS policies on report_access_requests, the
--  ent_handle_access_request guard, ent_stamp_grant's trigger check and
--  the grants INSERT/UPDATE policies. ent_may_revoke_grant() (0023) is
--  the delete policy's twin. Replacing BOTH here widens every path
--  together; nothing re-derives the old admin-only rule, and grant and
--  revoke stay symmetric inside the owning clinic.
--
--  DEPENDS ON: 0019, 0021, 0023, 0031.
--  RUN ORDER:  0031 first, then this file. The two COMMENT statements
--              that restate 0031's wording sit in DO guards at the end,
--              so this file also applies cleanly on its own.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. WHO MAY GRANT - widened from "admin or own doctor" to "any active
--    member of the owning clinic, or the own doctor". The draft refusal
--    and the single clinic_id tenant test are unchanged.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_grant_report_access(p_report uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.reports r
          JOIN public.staff_profiles me
            ON me.id = public.ent_auth_uid()
         WHERE r.id = p_report
           AND me.is_active
                -- DRAFTS ARE NOT GRANTABLE, kept verbatim from 0021:
                -- unfinished work belongs to one clinic and no permission
                -- over it may exist before the record is final.
           AND r.is_draft = false
           AND (
                -- 1. ANY ACTIVE MEMBER of the clinic that OWNS the report.
                --    The tenant test is still exactly this equality - no
                --    managed_by widening, no borrowed read predicate - and
                --    now no role restriction either: a request letter is
                --    answered by the CLINIC, not by a job title.
                me.clinic_id = r.clinic_id
                -- 2. the clinician who owns the record himself, even when
                --    his profile sits under another clinic.
             OR ( me.role = 'doctor' AND r.doctor_id = me.id )
           )
    )
$$;

COMMENT ON FUNCTION public.ent_may_grant_report_access(uuid) IS
    'True when the caller may approve, revoke or re-point an access grant for this report: any ACTIVE member of the clinic that OWNS the report - any role, admin/doctor/secretary - or the report''s own doctor. Never a member of another clinic, and managed_by changes nothing: a cross-clinic or self-signed grant would defeat the purpose of the whole table. Returns FALSE for any draft, so a grant over unfinished work can never be created at all.';

REVOKE ALL ON FUNCTION public.ent_may_grant_report_access(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_grant_report_access(uuid) TO authenticated;


-- ---------------------------------------------------------------------
-- 2. WHO MAY REVOKE - the delete policy's twin (0023), widened with the
--    same reasoning so grant and revoke answer one question. The grantee
--    arm is still absent: a member of ANOTHER clinic never matches
--    me.clinic_id = r.clinic_id, so nobody can delete the access handed
--    to him, and ent_may_revoke_grant still never mentions grantee_id
--    (0023's assertion on that point stays true).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ent_may_revoke_grant(p_report uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.reports r
          JOIN public.staff_profiles me
            ON me.id = public.ent_auth_uid()
         WHERE r.id = p_report
           AND me.is_active
           AND (
                me.clinic_id = r.clinic_id
             OR ( me.role = 'doctor' AND r.doctor_id = me.id )
           )
    )
$$;

COMMENT ON FUNCTION public.ent_may_revoke_grant(uuid) IS
    'True when the caller may REMOVE a grant for this report: any ACTIVE member of the clinic that owns it (any role), or the report''s own doctor. Never the grantee, and never a member of another clinic - managed_by changes nothing. Widened together with ent_may_grant_report_access in 0032 so grant and revoke stay symmetric inside the owning clinic.';

REVOKE ALL ON FUNCTION public.ent_may_revoke_grant(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_may_revoke_grant(uuid) TO authenticated;


-- ---------------------------------------------------------------------
-- 3. THE COMMENTS 0031 WROTE UNDER THE OLD RULE.
--
--    They still say "only the owning clinic admin", which is no longer
--    true and would send the next reader off to re-implement the old
--    gate. Guarded with to_regprocedure: COMMENT has no IF EXISTS, and
--    one missing function would otherwise roll this whole script back.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF to_regprocedure('public.ent_view_incoming_access_requests()') IS NOT NULL THEN
        EXECUTE 'COMMENT ON FUNCTION public.ent_view_incoming_access_requests() IS '
             || quote_literal('Pending cross-clinic access requests about reports the CALLER may grant - any active member of the owning clinic - with patient and requester metadata only. The owner test is ent_may_grant_report_access(); a member of another clinic can never see one. Clamped to 200 rows.');
    END IF;

    IF to_regprocedure('public.ent_handle_access_request(uuid, text, text)') IS NOT NULL THEN
        EXECUTE 'COMMENT ON FUNCTION public.ent_handle_access_request(uuid, text, text) IS '
             || quote_literal('Any active member of the OWNING clinic may grant or deny a request - the owner test is ent_may_grant_report_access(), widened in 0032 to the whole clinic. Grant creates the grant row in the SAME call through ent_stamp_grant, which still refuses a same-clinic grantee; deny records the reason and freezes the request. The request row is the only writer of status.');
    END IF;
END $$;
