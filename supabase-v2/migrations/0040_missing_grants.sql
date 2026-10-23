-- =====================================================================
--  0040 · missing grants  (two tables, five functions)
-- ---------------------------------------------------------------------
--  FOUND BY: scripts/check_function_grants.mjs (new) and
--            scripts/check_grants.mjs, both static and offline.
--
--  The same defect class as 0011 defect 1, in four places. Nothing
--  after 0007 inherits anything: 0007 grants table-by-table and once
--  with GRANT ALL ON ALL FUNCTIONS, both of which reach only the
--  objects that exist AT THAT MOMENT. Every later migration must
--  grant for itself, and four surfaces slipped through:
--
--  1. report_access_requests (0031) — NO grant at all. Its two RLS
--     policies (requests_insert_caller / requests_select_parties) are
--     written for `authenticated`, but a PostgREST request is refused
--     at the PRIVILEGE layer before any policy is consulted:
--       HTTP 403 {"code":"42501","hint":"Grant the required
--                  privileges..."}
--     The browser never hits this table directly today (the four
--     RPCs below do the work SECURITY DEFINER), which is why the
--     gap stayed invisible - but 0031 designed the REST door and a
--     door nobody can open is not a door.
--
--  2. secretary_assignments (0037) — NO grant at all, and this one
--     IS reached directly:
--       · admin.js loadExtraAssignments() reads it with the caller's
--         JWT (secretary_assignments_read_self / _read_admin were
--         written for exactly that), so every read 403'd and the
--         "Also works at" list silently rendered empty.
--       · auth-admin writes it with the SERVICE ROLE (create_user
--         upserts the primary link; set_assignments deletes+upserts
--         the extras), so both writes 403'd: a secretary's extra
--         doctors could never be saved at all.
--
--  3. The four cross-clinic RPCs of 0031/0032 - ent_request_report,
--     ent_handle_access_request, ent_view_incoming_access_requests,
--     ent_view_my_access_requests - were created with EXECUTE only
--     to PUBLIC (the Postgres default that 0007's ALTER DEFAULT
--     PRIVILEGES then revokes for anon, public). function/
--     viewAllAccess.js calls all four via /rpc/... with a user JWT,
--     so the whole "ask the other clinic for access" workflow
--     answered 42501 from the browser.
--
--  4. ent_capability(text) (0010) holds EXECUTE for `authenticated`
--     only, but _shared/auth.ts calls it as admin().rpc() =
--     service_role, on EVERY capabilities check and EVERY photo
--     upload gate. The 403 is caught and turned into the fallback,
--     so the defect was silent: with the flag OFF the fallback
--     (false) matched the truth, and the day an administrator turns
--     Patient photo storage ON the server would have gone on saying
--     OFF - the switch doing nothing. Unlike ent_admin_set_active,
--     this function has NO caller guard (it is a plain STABLE read
--     of system_flags as SECURITY DEFINER), so a service_role grant
--     is the correct repair - the 0011 pattern, applied.
--
--  NOT granted here: ent_reassign_doctor_records to service_role.
--  0035 wrote that guard on purpose ("service_role is NOT
--  special-cased here"): it re-reads the caller with ent_auth_uid()
--  and refuses anyone who is not a live admin, and a service_role
--  JWT has no `sub`, so auth.uid() is NULL - a GRANT cannot fix
--  that. The Edge Function now calls it asUser(me.jwt), the exact
--  pattern set_active uses since 0011; the authenticated grant 0035
--  already issued is all that call needs.
--
--  ent_default_clinic_id() (0002) is the same slip in miniature:
--  a convenience constant that was never granted to anybody. It
--  reads public.clinics only, and it now follows the house rule.
--
--  IDEMPOTENT      : yes. GRANT / REVOKE are no-ops when the state
--                    already matches.
--  DATA DESTRUCTIVE: NO. Privileges only; no row is read or written.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. report_access_requests  (0031's table)
--    SELECT + INSERT match the two policies exactly. No UPDATE, no
--    DELETE: 0031 kept those doors shut on purpose (only
--    ent_handle_access_request may write status), and privileges are
--    the second of its two gates, not a replacement for the first.
-- ---------------------------------------------------------------------
GRANT  SELECT, INSERT ON public.report_access_requests TO authenticated;
GRANT  ALL             ON public.report_access_requests TO service_role;
REVOKE ALL             ON public.report_access_requests FROM anon, public;

-- ---------------------------------------------------------------------
-- 2. secretary_assignments  (0037's junction)
--    SELECT for the two read policies (secretary reads her own rows,
--    an admin of the clinic reads her clinic's); the only writers are
--    auth-admin's service_role upserts - there is no INSERT/UPDATE/
--    DELETE policy, exactly like staff_profiles, so a REST client
--    that somehow held the privilege could still change nothing.
-- ---------------------------------------------------------------------
GRANT  SELECT ON public.secretary_assignments TO authenticated;
GRANT  ALL     ON public.secretary_assignments TO service_role;
REVOKE ALL     ON public.secretary_assignments FROM anon, public;

-- ---------------------------------------------------------------------
-- 3. The four RPCs viewAllAccess.js calls.
-- ---------------------------------------------------------------------
REVOKE ALL     ON FUNCTION public.ent_request_report(uuid, text)              FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_request_report(uuid, text)              TO authenticated;

REVOKE ALL     ON FUNCTION public.ent_handle_access_request(uuid, text, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_handle_access_request(uuid, text, text) TO authenticated;

REVOKE ALL     ON FUNCTION public.ent_view_incoming_access_requests()          FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_view_incoming_access_requests()          TO authenticated;

REVOKE ALL     ON FUNCTION public.ent_view_my_access_requests()                FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_view_my_access_requests()                TO authenticated;

-- ---------------------------------------------------------------------
-- 4. ent_capability - read by BOTH Edge Functions through
--    admin().rpc(); service_role had nothing after 0010's own
--    REVOKE ... FROM anon, public (the 0011 defect-1 shape). The
--    body checks no caller, so the grant changes only WHO may ask
--    the same yes/no question about a flag.
-- ---------------------------------------------------------------------
GRANT  EXECUTE ON FUNCTION public.ent_capability(text) TO service_role;

-- ---------------------------------------------------------------------
-- 5. ent_default_clinic_id - 0002's convenience constant.
-- ---------------------------------------------------------------------
REVOKE ALL     ON FUNCTION public.ent_default_clinic_id() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.ent_default_clinic_id() TO authenticated;

NOTIFY pgrst, 'reload schema';

