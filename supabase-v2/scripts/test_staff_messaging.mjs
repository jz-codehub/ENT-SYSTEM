#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const migration = read('supabase-v2/migrations/0049_notifications_and_staff_chat.sql')
const messages = read('function/messagesPage.js')
const messagesCss = read('style/messages.css')
const notifications = read('function/notificationCenter.js')
const dashboard = read('function/dashboard.js')
const serviceWorker = read('sw.js')
const build = read('build-pages.mjs')

const checks = [
    ['one clinic group is uniquely enforced', /uq_staff_clinic_conversation[\s\S]*?ON public\.staff_conversations \(clinic_id\)[\s\S]*?WHERE kind = 'clinic'/],
    ['clinic groups are created for new clinics', /trg_create_clinic_chat[\s\S]*?AFTER INSERT ON public\.clinics/],
    ['active clinic staff are automatically added to their group', /trg_staff_chat_membership[\s\S]*?AFTER INSERT OR UPDATE OF clinic_id, is_active ON public\.staff_profiles/],
    ['conversation membership is required to read messages', /staff_chat_messages_select_member[\s\S]*?FOR SELECT TO authenticated[\s\S]*?staff_conversation_members/],
    ['conversation membership is required to send messages', /staff_chat_messages_insert_member[\s\S]*?FOR INSERT TO authenticated[\s\S]*?staff_conversation_members/],
    ['chat sender identity is stamped from the session', /ent_stamp_chat_message[\s\S]*?NEW\.sender_id := me\.id/],
    ['direct messages can target active staff across clinics', /ent_get_or_create_direct_chat[\s\S]*?both chat participants must be active staff/],
    ['staff directory returns no usernames or contact details', /ent_chat_staff_directory[\s\S]*?RETURNS TABLE \([\s\S]*?user_id uuid,[\s\S]*?full_name text,[\s\S]*?role_name text,[\s\S]*?clinic_name text,[\s\S]*?last_seen_at timestamptz/],
    ['staff directory access is limited to authenticated users', /GRANT EXECUTE ON FUNCTION public\.ent_chat_staff_directory\(text\) TO authenticated/],
    ['access requests notify the owning clinic', /trg_notify_access_request[\s\S]*?AFTER INSERT ON public\.report_access_requests/],
    ['access decisions notify the requester', /trg_notify_access_decision[\s\S]*?AFTER UPDATE OF status ON public\.report_access_requests/],
    ['messages and tickets generate notifications', /trg_notify_chat_message[\s\S]*?trg_notify_ticket_insert[\s\S]*?trg_notify_ticket_message/],
    ['notifications are visible only to their recipient', /app_notifications_select_own[\s\S]*?recipient_id = public\.ent_auth_uid\(\)/],
    ['notifications are not client-writable', /REVOKE ALL ON public\.app_notifications FROM anon, public;[\s\S]*?GRANT SELECT ON public\.app_notifications TO authenticated/],
]

for (const [label, pattern] of checks) {
    assert.match(migration, pattern, label)
    console.log(`  PASS  ${label}`)
}

assert.match(messages, /mountWidget[\s\S]*?entMessagesWidget/, 'messages UI mounts as a floating widget')
assert.match(messagesCss, /\.ent-messages-widget\s*\{[\s\S]*?position:\s*fixed/, 'chat opens in a fixed floating widget')
assert.match(messages, /ent_my_chat_conversations/, 'conversation list uses the server RPC')
assert.match(messages, /ent_chat_staff_directory/, 'directory and presence use the protected server RPC')
assert.match(messages, /await searchStaff\(''\)/, 'all active staff load when the widget opens')
assert.match(messages, /messages-staff-avatar/, 'directory entries have aligned staff avatars')
assert.match(messages, /id="messagesChatsTab"[\s\S]*?data-message-tab="chats"[\s\S]*?id="messagesPeopleTab"[\s\S]*?data-message-tab="people"/, 'chat list and staff directory have separate tabs')
assert.match(messages, /setActiveList[\s\S]*?messagesChatListView'\)\.hidden = people[\s\S]*?staffDirectoryView'\)\.hidden = !people/, 'selecting a tab shows only its matching list')
assert.match(messages, /async function searchStaff\(query, quiet\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    function setActiveList/, 'list switching is available outside the search routine')
assert.match(messages, /activeList === 'people'[\s\S]*?searchStaff\(query\)[\s\S]*?renderConversations\(\)/, 'search filters staff or conversations based on the active tab')
assert.match(messages, /await openConversation\(conversationId\);\s*renderStaff\(directoryRows\)/, 'opening a direct message preserves the staff directory')
assert.match(messages, /staff_chat_messages/, 'messages are read and sent through the protected table')
assert.match(migration, /ent_chat_staff_directory[\s\S]*?nullif\(btrim\(coalesce\(p_query, ''\)\), ''\) IS NULL/, 'directory RPC returns staff when no search term is provided')
assert.match(migration, /ent_chat_staff_directory[\s\S]*?LEFT JOIN public\.clinics c ON c\.id = p\.clinic_id/, 'directory includes active staff without a clinic assignment')
assert.match(migration, /ent_chat_staff_directory[\s\S]*?max\(up\.seen_at\)/, 'directory returns each staff member’s latest heartbeat')
assert.match(messages, /Offline · '\s*\+\s*hours\s*\+\s*' '\s*\+\s*\(hours === 1 \? 'hour' : 'hours'\) \+\s*' ago/, 'offline status shows hours since last presence')
assert.match(messagesCss, /\.messages-staff-presence\.is-online[\s\S]*?\.messages-staff-presence\.is-offline/, 'online and offline statuses have distinct visual treatments')
assert.match(messagesCss, /\.messages-list-tabs[\s\S]*?\.messages-list-tab\.is-active/, 'messenger-style list tabs have a clear active state')
assert.match(messagesCss, /\.messages-list-tab\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?text-transform:\s*none;[\s\S]*?box-shadow:\s*none/, 'Chats and People tabs reset global button styles')
assert.match(messagesCss, /\.messages-staff-avatar-wrap[\s\S]*?\.messages-avatar-presence\.is-online/, 'people rows align avatars and online status markers')
assert.match(messagesCss, /\.messages-compose button\s*\{[\s\S]*?min-width:\s*42px;[\s\S]*?padding:\s*0;[\s\S]*?border-radius:\s*50%/, 'send button overrides oversized global button defaults')
assert.match(messagesCss, /\.messages-compose textarea\s*\{[\s\S]*?margin:\s*0;/, 'composer textarea resets global bottom margin')
assert.match(messagesCss, /\.messages-compose button\s*\{[\s\S]*?align-self:\s*flex-end;/, 'send button aligns to textarea bottom')
assert.match(messagesCss, /@media\s*\(max-width:\s*700px\)[\s\S]*?height:\s*100dvh;[\s\S]*?\.messages-workspace\.has-open-thread \.messages-sidebar\s*\{[\s\S]*?display:\s*none;[\s\S]*?\.messages-workspace\.has-open-thread \.messages-thread\s*\{[\s\S]*?display:\s*flex;/, 'mobile widget fills the viewport and switches between list and conversation')
assert.match(messagesCss, /env\(safe-area-inset-bottom/, 'mobile composer accounts for device safe-area insets')
assert.doesNotMatch(messages, /staffSearchResults'\)\.innerHTML = ''/, 'selecting a staff member does not clear the directory')
var directoryFunction = migration.match(/CREATE OR REPLACE FUNCTION public\.ent_chat_staff_directory[\s\S]*?\$\$;/)
assert.ok(directoryFunction, 'presence directory RPC exists')
assert.doesNotMatch(directoryFunction[0], /LIMIT\s+\d+/, 'directory lists every active staff member')
assert.match(notifications, /ent_mark_notifications_read/, 'notifications support persistent read state')
assert.match(notifications, /postgres_changes/, 'new notifications update through Realtime')
assert.match(dashboard, /EntNotificationCenter\.getItems\(\)/, 'dashboard bell includes persistent notifications')
assert.doesNotMatch(build, /pages\/messages\.html/, 'messaging does not require a separate page')
assert.doesNotMatch(serviceWorker, /pages\/messages\.html/, 'service worker does not precache a separate messages page')
assert.match(serviceWorker, /style\/messages\.css[\s\S]*?function\/messagesPage\.js/, 'widget assets are precached')
assert.match(notifications, /data-messages-toggle/, 'header messages button opens the widget')
assert.match(notifications, /ent:open-messages/, 'message notifications open their conversation in the widget')
assert.match(notifications, /mount\(\);\s*wire\(\);\s*render\(\);\s*await load\(\)/, 'notification bell renders before notification data loads')
assert.match(notifications, /loadState = 'error';\s*render\(\)/, 'notification failures leave the bell available with an error state')
assert.match(notifications, /document\.body\.appendChild\(panelNode\)/, 'notification panel escapes header stacking contexts')
assert.match(notifications, /toggleRect\.left \+ toggleRect\.width \/ 2/, 'notification panel is centered over its bell')
assert.match(notifications, /--ent-notification-panel-max-height/, 'notification panel fits the remaining screen height')
assert.match(dashboard, /document\.body\.appendChild\(notificationPanel\)/, 'dashboard notification panel escapes the clipped header')
assert.match(dashboard, /insidePanel\s*=\s*panel\s*&&\s*panel\.contains\s*&&\s*panel\.contains\(target\)/, 'dashboard panel clicks do not trigger outside dismissal')
assert.match(dashboard, /monthlyAction\.dataset\.monthlyExportAction === 'download'[\s\S]*?exportMonthlyRecords\(monthlyAction\)/, 'dashboard monthly export remains wired after the panel is portaled')
assert.match(read('style/notifications.css'), /\.ent-notification-panel\s*\{[^}]*z-index:\s*2147483000;[^}]*transform:\s*translateX\(-50%\)/, 'notification panel renders in front and centered on its bell')
assert.match(notifications, /event\.composedPath\(\)[\s\S]*?eventPath\.indexOf\(host\)\s*!==\s*-1/, 'bell remains open after rendering replaces its clicked button')
assert.match(read('style/notifications.css'), /\.ent-admin-actions > \.ent-notification-center \.ent-notification-toggle\s*\{[^}]*color:\s*#fff/, 'admin bell has contrast on the blue header')
assert.match(messagesCss, /\.ent-messages-widget \.messages-bubble\.is-mine\s*\{[^}]*background:\s*var\(--primary-color\);[^}]*color:\s*#fff/, 'sent chat bubbles use the system blue')
assert.match(messagesCss, /\.ent-messages-widget \.messages-conversation\.is-active\s*\{[^}]*background:\s*var\(--primary-light\)/, 'selected conversation is easy to identify')
assert.match(messagesCss, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.ent-messages-widget\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100dvh;[\s\S]*?min-height:\s*0;/, 'Messenger remains full-screen and responsive on mobile')
assert.match(messagesCss, /body\.dark-mode \.ent-messages-widget \.messages-bubble\.is-mine/, 'Messenger retains readable outgoing bubbles in dark mode')

console.log(`\n==== STAFF MESSAGING CHECKS PASSED — ${checks.length + 40} passed ====`)
