#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migration = readFileSync(join(ROOT, 'supabase-v2/migrations/0051_global_announcements.sql'), 'utf8')
const notificationsMigration = readFileSync(join(ROOT, 'supabase-v2/migrations/0049_notifications_and_staff_chat.sql'), 'utf8')
const adminHtml = readFileSync(join(ROOT, 'pages/admin.html'), 'utf8')
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8')
const adminJs = readFileSync(join(ROOT, 'function/admin.js'), 'utf8')
const notificationsJs = readFileSync(join(ROOT, 'function/notificationCenter.js'), 'utf8')
const dashboardJs = readFileSync(join(ROOT, 'function/dashboard.js'), 'utf8')
const notificationsCss = readFileSync(join(ROOT, 'style/notifications.css'), 'utf8')
let passed = 0

function check(label, condition) {
    assert.ok(condition, label)
    passed++
    console.log('  PASS  ' + label)
}

const sendFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.ent_send_announcement\(p_title text, p_body text\)[\s\S]*?\n\$\$;/
)
assert.ok(sendFunction, 'announcement RPC exists')
check('announcement RPC checks the caller’s live admin role',
    /public\.ent_is_active_admin\(\)/.test(sendFunction[0]))
check('announcement payload is trimmed and bounded in the database',
    /length\(btrim\(p_title\)\) NOT BETWEEN 1 AND 120/.test(sendFunction[0])
        && /length\(btrim\(p_body\)\) NOT BETWEEN 1 AND 1000/.test(sendFunction[0]))
check('broadcast creates private rows for active profiles only',
    /INSERT INTO public\.app_notifications[\s\S]*?SELECT profile\.id, 'announcement'[\s\S]*?WHERE profile\.is_active/.test(sendFunction[0]))
check('authenticated users can call the RPC but cannot write notification rows directly',
    /REVOKE ALL ON FUNCTION public\.ent_send_announcement\(text, text\) FROM anon, public/.test(migration)
        && /GRANT EXECUTE ON FUNCTION public\.ent_send_announcement\(text, text\) TO authenticated/.test(migration)
        && !/GRANT\s+(?:INSERT|ALL)[\s\S]*?app_notifications/i.test(migration))
const deleteFunction = notificationsMigration.match(
    /CREATE OR REPLACE FUNCTION public\.ent_delete_notification\(p_notification_id uuid\)[\s\S]*?\n\$\$;/
)
check('notification delete RPC is restricted to the active recipient’s own row',
    !!deleteFunction
        && /DELETE FROM public\.app_notifications/.test(deleteFunction[0])
        && /id = p_notification_id[\s\S]*?recipient_id = public\.ent_auth_uid\(\)/.test(deleteFunction[0])
        && /p\.id = public\.ent_auth_uid\(\) AND p\.is_active/.test(deleteFunction[0]))
check('only authenticated users can execute the notification delete RPC',
    /REVOKE ALL ON FUNCTION public\.ent_delete_notification\(uuid\) FROM anon, public/.test(notificationsMigration)
        && /GRANT EXECUTE ON FUNCTION public\.ent_delete_notification\(uuid\) TO authenticated/.test(notificationsMigration))
check('reapplying the combined notifications migration keeps global announcements enabled',
    /'doctor_work_complete', 'announcement'/.test(notificationsMigration))
check('announcement kind and readable message length are supported',
    /'doctor_work_complete', 'announcement'/.test(migration)
        && /CHECK \(length\(body\) <= 1000\)/.test(migration))
check('Admin composer clearly states its global audience and input limits',
    /data-panel="announcements"[\s\S]*?id="panel-announcements"/.test(adminHtml)
        && /id="announcementTitle" maxlength="120"/.test(adminHtml)
        && /id="announcementBody" rows="6" maxlength="1000"/.test(adminHtml)
        && /all active doctors, secretaries, and admins across every clinic/i.test(adminHtml)
        && /rpc\/ent_send_announcement/.test(adminJs))
check('notification cards use readable hierarchy and responsive message text',
    /\.ent-notification-body\s*\{\s*white-space:\s*pre-wrap;/.test(notificationsCss)
        && /\.ent-notification-item\s*\{[\s\S]*?font-size:\s*\.88rem;[\s\S]*?line-height:\s*1\.6;/.test(notificationsCss)
        && /width:\s*min\(560px,\s*calc\(100vw - 24px\)\)/.test(notificationsCss)
        && /Math\.min\(560,\s*Math\.max\(0,\s*window\.innerWidth - 24\)\)/.test(notificationsJs)
        && /ent-notification-heading-copy/.test(notificationsJs))
check('each notification has a separate accessible delete action',
    /data-notification-delete=/.test(notificationsJs)
        && /role="alertdialog"[\s\S]*?aria-modal="true"/.test(notificationsJs)
        && /entNotificationDeleteDescription/.test(notificationsJs)
        && !/window\.confirm/.test(notificationsJs)
        && /\.ent-notification-delete-modal\s*\{/.test(notificationsCss)
        && /notificationCenter\.js\?v=v9-shared-notification-design/.test(adminHtml)
        && /notifications\.css\?v=v11-shared-notification-design/.test(adminHtml)
        && /notificationCenter\.js\?v=v9-shared-notification-design/.test(indexHtml)
        && /notifications\.css\?v=v11-shared-notification-design/.test(indexHtml))

const profile = {
    id: '11111111-1111-4111-8111-111111111111',
}
const unsafeNotification = {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'announcement',
    title: '<img src=x onerror=alert(1)>',
    body: '<script>alert(1)</script>\nNew schedule starts Monday.',
    target_url: '',
    created_at: '2026-01-02T03:04:00.000Z',
    read_at: null,
}
const apiCalls = []
const documentListeners = {}
const bodyChildren = []
let markedRead = false
let deletedNotification = false

function makeElement(id) {
    return {
        id: id || '',
        className: '',
        hidden: false,
        parentNode: null,
        parentElement: null,
        dataset: {},
        listeners: {},
        firstElementChild: null,
        _innerHTML: '',
        set innerHTML(value) {
            this._innerHTML = value
            const child = makeElement('generated-panel')
            child._innerHTML = value
            this.firstElementChild = child
            if (this.id === 'entNotificationDeleteModal') {
                const control = (selector) => ({
                    disabled: false,
                    hidden: false,
                    textContent: '',
                    closest(candidate) { return candidate === selector ? this : null },
                    focus() {},
                })
                this.modalControls = {}
                ;[
                    ['[data-notification-delete-title]', 'title'],
                    ['[data-notification-delete-error]', 'error'],
                    ['[data-notification-delete-cancel]', 'cancel'],
                    ['[data-notification-delete-confirm]', 'confirm'],
                    ['[role="alertdialog"]', 'dialog'],
                ].forEach(([selector, key]) => {
                    this.modalControls[selector] = control(selector)
                })
            }
        },
        get innerHTML() { return this._innerHTML },
        addEventListener(type, fn) {
            (this.listeners[type] || (this.listeners[type] = [])).push(fn)
        },
        setAttribute() {},
        querySelector(selector) {
            return this.modalControls && this.modalControls[selector] || null
        },
        querySelectorAll(selector) {
            return this.id === 'entNotificationDeleteModal' && selector === 'button:not(:disabled)'
                ? [this.modalControls['[data-notification-delete-cancel]'],
                    this.modalControls['[data-notification-delete-confirm]']].filter((button) => !button.disabled)
                : []
        },
        contains() { return false },
        getBoundingClientRect() { return { left: 0, width: 0, bottom: 0 } },
        removeChild(child) {
            const index = bodyChildren.indexOf(child)
            if (index >= 0) bodyChildren.splice(index, 1)
            child.parentNode = null
        },
        appendChild(child) {
            child.parentNode = this
            bodyChildren.push(child)
            return child
        },
    }
}

const headerParent = {
    querySelector() { return null },
    insertBefore() {},
}
const headerSlot = makeElement('headerUserSlot')
headerSlot.parentElement = headerParent
const document = {
    readyState: 'complete',
    hidden: false,
    body: makeElement('body'),
    getElementById(id) { return id === 'headerUserSlot' ? headerSlot : null },
    querySelector() { return null },
    createElement() { return makeElement('created') },
    addEventListener(type, fn) {
        (documentListeners[type] || (documentListeners[type] = [])).push(fn)
    },
    dispatchEvent() {},
}
const window = {
    document,
    URLSearchParams,
    innerWidth: 1280,
    innerHeight: 800,
    navigator: { onLine: true },
    console,
    location: { href: '' },
    setInterval() { return 1 },
    addEventListener() {},
    CustomEvent: class CustomEvent {
        constructor(type, options) { this.type = type; this.detail = options && options.detail }
    },
    EntAuth: {
        guard: async () => ({ user: profile }),
        escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, function (char) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
            })
        },
        pageUrl: (page) => page,
    },
    EntSupabase: {
        async apiRequest(endpoint, options) {
            let body = null
            try { body = options && options.body ? JSON.parse(options.body) : null } catch (e) {}
            apiCalls.push({ endpoint, body })
            if (endpoint.indexOf('/app_notifications?') === 0) {
                if (deletedNotification) return []
                if (endpoint.indexOf('read_at=is.null') !== -1) return markedRead ? [] : [unsafeNotification]
                return [Object.assign({}, unsafeNotification, { read_at: markedRead ? '2026-01-02T04:00:00.000Z' : null })]
            }
            if (endpoint.indexOf('/rpc/ent_unread_notification_count') === 0) return markedRead || deletedNotification ? 0 : 1
            if (endpoint.indexOf('/rpc/ent_mark_notifications_read') === 0) {
                markedRead = true
                return null
            }
            if (endpoint.indexOf('/rpc/ent_delete_notification') === 0) {
                deletedNotification = true
                return true
            }
            throw new Error('Unexpected notification API request: ' + endpoint)
        },
        getClient() {
            const channel = {
                on() { return this },
                subscribe() { return this },
            }
            return { channel() { return channel } }
        },
    },
}
window.window = window
window.globalThis = window
vm.createContext(window)
vm.runInContext(notificationsJs, window, { filename: 'notificationCenter.js' })
await new Promise((resolve) => setTimeout(resolve, 10))

const panel = bodyChildren.find((node) => node.id === 'generated-panel')
assert.ok(panel, 'notification panel rendered')
check('announcement content is escaped and shown as a non-navigating card',
    panel.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;')
        && panel.innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;')
        && panel.innerHTML.includes('is-announcement is-unread')
        && panel.innerHTML.includes('class="ent-notification-mark-read"')
        && panel.innerHTML.includes('data-notification-delete="' + unsafeNotification.id + '"')
        && panel.innerHTML.includes('aria-label="Delete &lt;img src=x onerror=alert(1)&gt; from your notifications"')
        && !panel.innerHTML.includes('href="reportProblem.html"'))
check('notification cards include kind, timestamp, and all-clinic context',
    panel.innerHTML.includes('Clinic-wide announcement')
        && panel.innerHTML.includes('Unread')
        && panel.innerHTML.includes('<time datetime="2026-01-02T03:04:00.000Z">')
        && panel.innerHTML.includes('Clinic-wide news, account updates, and messages')
        && panel.innerHTML.includes('Mark all as read'))
const dashboardItem = window.EntNotificationCenter.renderItem(unsafeNotification)
check('dashboard reuses the same escaped notification card without adding admin delete actions',
    /EntNotificationCenter\.renderItem\(n\)/.test(dashboardJs)
        && dashboardItem.includes('class="ent-notification-item is-static is-announcement is-unread"')
        && dashboardItem.includes('Clinic-wide announcement')
        && dashboardItem.includes('&lt;script&gt;alert(1)&lt;/script&gt;')
        && dashboardItem.includes('class="ent-notification-state is-unread"')
        && !dashboardItem.includes('data-notification-delete'))

const click = (documentListeners.click || [])[0]
assert.equal(typeof click, 'function', 'notification click handler installed')
const markButton = {
    getAttribute(name) { return name === 'href' ? null : null },
    closest(selector) {
        return selector === '[data-notification-id]' ? this : null
    },
    dataset: { notificationId: unsafeNotification.id },
}
await click({
    target: markButton,
    preventDefault() {},
    composedPath() { return [markButton] },
})
await new Promise((resolve) => setTimeout(resolve, 10))
const markCall = apiCalls.find((call) => call.endpoint.indexOf('/rpc/ent_mark_notifications_read') === 0)
check('announcement read status is saved through the existing per-user RPC',
    !!markCall && markCall.body.p_notification_id === unsafeNotification.id && markedRead)

const deleteButton = {
    getAttribute(name) {
        if (name === 'data-notification-delete') return unsafeNotification.id
        if (name === 'data-notification-title') return unsafeNotification.title
        return null
    },
    closest(selector) {
        return selector === '[data-notification-delete]' ? this : null
    },
}
await click({
    target: deleteButton,
    preventDefault() {},
    stopPropagation() {},
    composedPath() { return [deleteButton] },
})
await new Promise((resolve) => setTimeout(resolve, 10))
const deleteModal = bodyChildren.find((node) => node.id === 'entNotificationDeleteModal')
check('delete action opens a branded accessible modal with the correct notification title',
    !!deleteModal
        && !deleteModal.hidden
        && deleteModal.modalControls['[data-notification-delete-title]'].textContent === unsafeNotification.title)

const modalClick = deleteModal.listeners.click[0]
const cancelDelete = deleteModal.modalControls['[data-notification-delete-cancel]']
const cancelEvent = {
    target: cancelDelete,
    preventDefault() {},
    composedPath() { return [cancelDelete, deleteModal] },
}
await modalClick(cancelEvent)
await click(cancelEvent)
check('canceling notification deletion leaves the row in the user’s inbox',
    !apiCalls.some((call) => call.endpoint.indexOf('/rpc/ent_delete_notification') === 0)
        && window.EntNotificationCenter.getItems().some((row) => row.id === unsafeNotification.id)
        && deleteModal.hidden)

await click({
    target: deleteButton,
    preventDefault() {},
    stopPropagation() {},
    composedPath() { return [deleteButton] },
})
const confirmDelete = deleteModal.modalControls['[data-notification-delete-confirm]']
await modalClick({
    target: confirmDelete,
    preventDefault() {},
    composedPath() { return [confirmDelete, deleteModal] },
})
await new Promise((resolve) => setTimeout(resolve, 10))
const deleteCall = apiCalls.find((call) => call.endpoint.indexOf('/rpc/ent_delete_notification') === 0)
check('confirmed deletion sends only the selected notification ID and removes its local card',
    !!deleteCall
        && deleteCall.body.p_notification_id === unsafeNotification.id
        && window.EntNotificationCenter.getItems().every((row) => row.id !== unsafeNotification.id))

console.log(`\n==== ANNOUNCEMENT CHECKS PASSED — ${passed} passed ====`)
