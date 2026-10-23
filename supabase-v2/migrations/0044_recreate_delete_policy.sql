-- =====================================================================
--  0044 · BULLETPROOF: re-create reports_update_own_doctor, nothing else
-- ---------------------------------------------------------------------
--  The delete 403 persists even after 0043. The arithmetic is settled:
--    · ordinary UPDATE                -> 200
--    · soft-delete (deleted_at)       -> 403, for doctor AND secretary
--    · ent_may_soft_delete() directly -> true
--  With two permissive UPDATE policies that OR together, the ONLY way a
--  soft-delete can still 403 while the predicate is true is that the
--  policy which carries that predicate - reports_update_own_doctor - is
--  not in force on this database. 0043 tried to (re)create it, but 0043
--  ALSO rewrote ent_deleted_reports() and ran a self-guard; if anything
--  in that file errored, the whole file rolled back - policy included.
--
--  This file does ONE thing and ONLY one thing: DROP + CREATE that single
--  policy. No function rewrite, no DO guard, nothing that can fail and
--  take the policy down with it. Idempotent, additive, RLS-safe: it ORs
--  with reports_update_owner and grants no hard delete.
--
--  IDEMPOTENT      : yes.
--  DATA DESTRUCTIVE: no.
--  SECURITY        : unchanged. Same predicate 0030/0039 already ship.
-- =====================================================================

DROP POLICY IF EXISTS reports_update_own_doctor ON public.reports;
CREATE POLICY reports_update_own_doctor ON public.reports
    FOR UPDATE TO authenticated
    USING     ( public.ent_may_soft_delete(clinic_id, doctor_id, id) )
    WITH CHECK( public.ent_may_soft_delete(clinic_id, doctor_id, id) );

COMMENT ON POLICY reports_update_own_doctor ON public.reports IS
    '0030/0039/0044: the additive UPDATE arm that lets the author of her own unfinished draft, the row''s own doctor, an active admin of the owning clinic, or a secretary on any doctor she is assigned to MARK A ROW DELETED (and restore it). ORs with reports_update_owner; grants no hard delete.';

-- Prove it landed, in the SAME statement run, so you see it immediately.
SELECT policyname, cmd, permissive
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'reports' AND cmd = 'UPDATE'
 ORDER BY policyname;
