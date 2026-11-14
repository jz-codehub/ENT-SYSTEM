-- =====================================================================
-- 0051 · Admin announcements delivered to every active account
-- ---------------------------------------------------------------------
-- The browser cannot insert app_notifications. This SECURITY DEFINER RPC
-- verifies the live admin profile, then creates one private notification
-- per active staff account so existing RLS, unread counts and read receipts
-- continue to work without exposing one user's notification to another.
-- =====================================================================

ALTER TABLE public.app_notifications
    DROP CONSTRAINT IF EXISTS app_notifications_kind_check;
ALTER TABLE public.app_notifications
    ADD CONSTRAINT app_notifications_kind_check CHECK (kind IN (
        'access_request', 'access_decision', 'chat_message',
        'ticket_new', 'ticket_message', 'ticket_status',
        'doctor_work_complete', 'announcement'
    ));

ALTER TABLE public.app_notifications
    DROP CONSTRAINT IF EXISTS app_notifications_body_check;
ALTER TABLE public.app_notifications
    ADD CONSTRAINT app_notifications_body_check CHECK (length(body) <= 1000);

CREATE OR REPLACE FUNCTION public.ent_send_announcement(p_title text, p_body text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_source_id uuid := gen_random_uuid();
    v_recipient_count integer;
BEGIN
    IF NOT public.ent_is_active_admin() THEN
        RAISE EXCEPTION 'refused: an active admin account is required'
            USING ERRCODE = '42501';
    END IF;

    IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'refused: title must be between 1 and 120 characters'
            USING ERRCODE = '22023';
    END IF;

    IF p_body IS NULL OR length(btrim(p_body)) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'refused: message must be between 1 and 1000 characters'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.app_notifications
        (recipient_id, kind, title, body, source_id)
    SELECT profile.id, 'announcement', btrim(p_title), btrim(p_body), v_source_id
      FROM public.staff_profiles profile
     WHERE profile.is_active;

    GET DIAGNOSTICS v_recipient_count = ROW_COUNT;
    RETURN v_recipient_count;
END;
$$;

COMMENT ON FUNCTION public.ent_send_announcement(text, text) IS
    'Admin-only broadcast. Creates a private announcement notification for every active staff profile and returns the recipient count.';

REVOKE ALL ON FUNCTION public.ent_send_announcement(text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ent_send_announcement(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
