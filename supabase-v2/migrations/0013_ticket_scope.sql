-- =====================================================================
--  0013 . ticket scope   (WHICH part of the app is broken?)
-- ---------------------------------------------------------------------
--  A ticket reporter is answering the first question an admin has to ask:
--  "where does it hurt?" "the CF4 form will not save" and "the page will
--  not load" are completely different problems, and making someone type
--  that into a free-text subject wastes their time and delays the answer.
--
--  So the form offers four choices and the admin can filter by them:
--
--     nasal | laryngeal | cf4   a specific report form
--     system                         the app itself - sign-in, sync,
--                                     navigation, anything that is not one
--                                     of the three forms
--
--  `system` is the DEFAULT because a wrong guess is cheaper than an empty
--  field, and an empty scope would make the admin's filter lie.
--
--  This is deliberately NOT folded into `category`. Category answers
--  "what KIND of problem is this" (broken / cannot sign in / data looks
--  wrong); scope answers "WHERE". They are independent: a broken CF4 form is
--  category=bug, scope=cf4. Collapsing them would make both questions
--  unanswerable with one dropdown.
--
--  IDEMPOTENT : yes, safe to re-run.
--  DATA DESTRUCTIVE : no. Existing tickets keep working and are backfilled
--  to 'system'.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ent_ticket_scope') THEN
        CREATE TYPE ent_ticket_scope AS ENUM
            ('nasal', 'laryngeal', 'cf4', 'system');
    END IF;
END $$;

COMMENT ON TYPE public.ent_ticket_scope IS
    'Which part of the app a ticket is about: one of the three report forms, or the app itself.';


-- ---------------------------------------------------------------------
-- 1. The column
--    DEFAULT 'system' and NOT NULL, so an old client that does not know
--    about scope still produces a valid row rather than a null the admin's
--    filter cannot handle.
-- ---------------------------------------------------------------------
ALTER TABLE public.tickets
    ADD COLUMN IF NOT EXISTS scope public.ent_ticket_scope NOT NULL DEFAULT 'system';

COMMENT ON COLUMN public.tickets.scope IS
    'Which part of the app: nasal / laryngeal / cf4 / system. Drives the admin filter.';


-- ---------------------------------------------------------------------
-- 2. Privileges - see 0012 section 8.
--    0001 revokes table privileges from anon BY DEFAULT for every future
--    table, and 0007 grants table by table. A column added here inherits
--    the TABLE's grants, so this statement is about being explicit rather
--    than about a missing grant. It is here because the mistake is silent:
--    PostgREST answers a missing privilege with HTTP 403 42501, which reads
--    like a permissions bug rather than "this column was added later".
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON public.tickets TO authenticated;
GRANT ALL            ON public.tickets TO service_role;
REVOKE ALL          ON public.tickets FROM anon, public;


-- ---------------------------------------------------------------------
-- 3. Evidence: the new column is readable, and anon still is not.
-- ---------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
