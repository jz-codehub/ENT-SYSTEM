-- READ-ONLY diagnostic (no \echo — plain SQL for the SQL Editor).
-- Paste ALL of this, Run, then SEND ME THE WHOLE OUTPUT.

SELECT '=== 1. UPDATE policy with_check / using ===' AS section;
SELECT policyname, qual AS using_expr, with_check AS check_expr
  FROM pg_policies
 WHERE schemaname='public' AND tablename='reports' AND cmd='UPDATE'
 ORDER BY policyname;

SELECT '=== 2. ent_may_edit_report signature ===' AS section;
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='ent_may_edit_report';

SELECT '=== 3. SIMULATE soft-delete as doctor jess, then roll back ===' AS section;
DO $$
DECLARE r record;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"856dc35f-a3f3-41d6-b7cd-57da8c3763c6","role":"authenticated"}', true);
  SELECT id INTO r FROM public.reports
   WHERE deleted_at IS NULL AND is_draft ORDER BY created_at DESC LIMIT 1;
  RAISE NOTICE 'probe row = %', r.id;
  BEGIN
    UPDATE public.reports SET deleted_at=now(), deleted_reason='diag' WHERE id=r.id;
    RAISE NOTICE 'UPDATE SUCCEEDED';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'UPDATE FAILED: % / %', SQLSTATE, SQLERRM;
  END;
  RESET ROLE;
END $$;
