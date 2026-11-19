#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migration = readFileSync(
    resolve(root, 'supabase-v2/migrations/0049_notifications_and_staff_chat.sql'),
    'utf8'
)
const notificationRenderer = readFileSync(
    resolve(root, 'function/notificationCenter.js'),
    'utf8'
)
const notificationStyles = readFileSync(
    resolve(root, 'style/notifications.css'),
    'utf8'
)
const assignmentsMigration = readFileSync(
    resolve(root, 'supabase-v2/migrations/0050_super_secretary_network_scope.sql'),
    'utf8'
)
const notificationTrigger = assignmentsMigration.match(
    /CREATE OR REPLACE FUNCTION public\.ent_notify_doctor_work_completion\(\)[\s\S]*?\n\$\$;/
)
assert.ok(notificationTrigger, 'doctor work completion trigger function exists')

const checks = [
    ['notification kind is allowed', /'doctor_work_complete'/],
    ['percentage helper covers all three report types', /WHEN 'cf4' THEN ARRAY[\s\S]*?WHEN 'nasal' THEN ARRAY[\s\S]*?WHEN 'laryngeal' THEN ARRAY/],
    ['CF4 template text does not count as completed work', /upper\(btrim\(entries\.value #>> '\{\}'\)\) <>[\s\S]*?THE PATIENT UNDERWENT/],
    ['percentage helper self-checks full and incomplete forms', /doctor work completion percentage self-check failed[\s\S]*?doctor work incomplete-field self-check failed/],
    ['drafts and non-owner writes do not trigger alerts', /IF NEW\.is_draft[\s\S]*?NEW\.doctor_id IS DISTINCT FROM public\.ent_auth_uid\(\)/],
    ['only a newly completed report triggers an alert', /OLD\.report_type = NEW\.report_type[\s\S]*?ent_doctor_work_percent\(OLD\.report_type, OLD\.payload\) = 100/],
    ['only the active doctor can trigger the notification', /WHERE id = public\.ent_auth_uid\(\)[\s\S]*?AND is_active[\s\S]*?AND role = 'doctor'/],
    ['assigned secretaries are notification recipients', /secretary\.assigned_doctor_id = actor\.id[\s\S]*?secretary_assignments assignment[\s\S]*?assignment\.doctor_id = actor\.id/],
    ['Super Secretaries receive notifications only for explicitly assigned doctors', /secretary_assignments assignment[\s\S]*?assignment\.secretary_id = secretary\.id[\s\S]*?assignment\.doctor_id = actor\.id/],
    ['notifications are idempotent per report and recipient', /ON CONFLICT \(recipient_id, source_id\)[\s\S]*?WHERE kind = 'doctor_work_complete'[\s\S]*?DO NOTHING/],
    ['notifications contain no patient-identifying details in their stored body', /Open DB Records to review/],
    ['notification opens the records list', /'pages\/viewAll\.html'/],
]

for (const [label, pattern] of checks) {
    const source = label.startsWith('Super Secretaries')
        ? notificationTrigger && notificationTrigger[0]
        : migration
    assert.match(source, pattern, label)
    console.log(`  PASS  ${label}`)
}

assert.doesNotMatch(
    notificationTrigger[0],
    /patient_(?:name|id)|case_number/,
    'notification does not expose patient identifiers'
)

assert.match(
    notificationRenderer,
    /row\.kind === 'doctor_work_complete'[\s\S]*?ent-notification-complete-check/,
    'completed Doctor work notifications render the check icon'
)
assert.match(
    notificationStyles,
    /\.ent-notification-complete-check[\s\S]*?background:\s*#16a34a/,
    'the completion check icon is green'
)
assert.equal(
    (notificationRenderer.match(/source_id,created_at,read_at/g) || []).length,
    2,
    'both notification queries include the report source id for scoped patient-name lookup'
)
assert.match(
    notificationRenderer,
    /query\.set\('select', 'id,patient_name'\)[\s\S]*?query\.set\('id', 'in\.\(' \+ reportIds\.join\(','\) \+ '\)'\)/,
    'patient names are requested as the only report detail'
)
assert.match(
    notificationRenderer,
    /source_id[\s\S]*?reports\?' \+ query\.toString\(\)/,
    'patient-name lookup uses the report endpoint and current user RLS'
)
assert.match(
    notificationRenderer,
    /ent-notification-patient[\s\S]*?esc\(patientName\)/,
    'the full patient name is HTML-escaped before highlighted display'
)
assert.match(
    notificationStyles,
    /\.ent-notification-item \.ent-notification-patient strong[\s\S]*?background:\s*#fef3c7/,
    'patient name has a visible highlight'
)

console.log(`\n==== DOCTOR WORK NOTIFICATION CHECKS PASSED — ${checks.length + 7} passed ====`)
