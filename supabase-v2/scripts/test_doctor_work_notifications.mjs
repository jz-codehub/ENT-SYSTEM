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
const notificationTrigger = migration.match(
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
    ['Super Secretaries receive notifications within their clinic network', /secretary\.is_super_secretary[\s\S]*?doctor_clinic\.id = secretary_clinic\.id[\s\S]*?doctor_clinic\.managed_by = secretary_clinic\.managed_by/],
    ['notifications are idempotent per report and recipient', /ON CONFLICT \(recipient_id, source_id\)[\s\S]*?WHERE kind = 'doctor_work_complete'[\s\S]*?DO NOTHING/],
    ['notifications contain no patient-identifying details', /Open DB Records to review/],
    ['notification opens the records list', /'pages\/viewAll\.html'/],
]

for (const [label, pattern] of checks) {
    assert.match(migration, pattern, label)
    console.log(`  PASS  ${label}`)
}

assert.doesNotMatch(
    notificationTrigger[0],
    /patient_(?:name|id)|case_number/,
    'notification does not expose patient identifiers'
)

console.log(`\n==== DOCTOR WORK NOTIFICATION CHECKS PASSED — ${checks.length + 1} passed ====`)
