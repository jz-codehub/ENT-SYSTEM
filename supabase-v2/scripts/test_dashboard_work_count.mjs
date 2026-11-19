#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dashboard = readFileSync(resolve(root, 'function/dashboard.js'), 'utf8')
const formScript = readFileSync(resolve(root, 'function/index.js'), 'utf8')
const styles = readFileSync(resolve(root, 'style/index.css'), 'utf8')

function extractFn(name) {
    const match = dashboard.match(new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{'))
    assert.ok(match, `could not find ${name} in dashboard.js`)
    const start = match.index
    let depth = 0
    for (let i = dashboard.indexOf('{', start); i < dashboard.length; i++) {
        if (dashboard[i] === '{') depth++
        else if (dashboard[i] === '}' && --depth === 0) return dashboard.slice(start, i + 1)
    }
    throw new Error(`unbalanced braces in ${name}`)
}

const clinicStatusRows = [
    { report_type: 'cf4', record_key: '', isFinalized: false, doctorWorkPercent: 50, clinicWideStatus: true },
    { report_type: 'nasal', record_key: '', isFinalized: false, doctorWorkPercent: 25, clinicWideStatus: true },
    { report_type: 'laryngeal', record_key: '', isFinalized: false, doctorWorkPercent: 75, clinicWideStatus: true },
    { report_type: 'nasal', record_key: '', isFinalized: true, doctorWorkPercent: 100, clinicWideStatus: true },
]

function makeQueueLists(rows, user) {
    const factory = new Function(
        'queueRows', 'me', 'isMine',
        extractFn('isDoctorWorkComplete') + '\n'
            + extractFn('isDoctorWorkIncomplete') + '\n'
            + extractFn('queueLists') + '\nreturn queueLists;'
    )
    return factory(rows, user, row => row.created_by === user.id)()
}

const doctorLists = makeQueueLists(clinicStatusRows, { role: 'doctor', id: 'doctor-1' })
assert.equal(doctorLists.review.length, 3, 'clinic status includes incomplete CF4, Nasal, and Laryngeal patient/date rows')
assert.equal(doctorLists.saved.length, 1, '100% doctor work is classified as completed')

const secretaryLists = makeQueueLists(clinicStatusRows, { role: 'secretary', id: 'secretary-1' })
assert.equal(secretaryLists.review.length, 3, 'secretary sees the same active-clinic status rows')
assert.equal(secretaryLists.saved.length, 1, 'secretary completed count matches the clinic-wide status rows')

const normalizeStatus = new Function(extractFn('normalizeClinicWorkStatus') + '\nreturn normalizeClinicWorkStatus;')()
const normalized = normalizeStatus({
    completed_count: 1, incomplete_count: 1, total_count: 2,
    records: [
        { patient_name: 'Finished', visit_date: '2026-10-05', report_types: ['cf4'], is_complete: true, doctor_work_percent: 100 },
        { patient_name: 'Waiting', visit_date: '2026-10-06', report_types: ['nasal'], is_complete: false, doctor_work_percent: 93 },
    ]
})
assert.equal(normalized.records.length, normalized.total, 'visible patient/date rows equal the aggregate denominator')
assert.throws(() => normalizeStatus({
    completed_count: 1, incomplete_count: 0, total_count: 1, records: []
}), /do not match/, 'mismatched totals fail closed instead of showing inconsistent counts')

for (const page of ['nasalEndoscopy.html', 'laryngealEndoscopy.html']) {
    const html = readFileSync(resolve(root, 'pages', page), 'utf8')
    assert.match(html, /id="cameraFileInput"[^>]*capture="environment"/, `${page} exposes the native rear-camera input`)
}
assert.match(formScript, /display-mode: standalone[\s\S]*?cameraFileInput\.click\(\)/,
    'installed PWA opens native camera capture instead of requesting getUserMedia')
assert.match(styles, /input\[type="file"\]\[hidden\]\s*\{\s*display:\s*none\s*!important;/,
    'hidden camera input stays invisible despite the generic file-input styling')

console.log('==== DASHBOARD WORK COUNT & PWA CAMERA CHECKS PASSED — 10 passed ====')
