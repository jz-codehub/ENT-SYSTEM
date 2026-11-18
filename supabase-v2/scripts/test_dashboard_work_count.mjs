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

const waitingReports = [
    { report_type: 'cf4', record_key: 'cf4-1', isFinalized: true, doctorWorkPercent: 50, created_by: 'doctor-1' },
    { report_type: 'nasal', record_key: 'nasal-1', isFinalized: true, doctorWorkPercent: 25, created_by: 'secretary-1' },
    { report_type: 'laryngeal', record_key: 'laryngeal-1', isFinalized: true, doctorWorkPercent: 75, created_by: 'secretary-1' },
    { report_type: 'nasal', record_key: 'nasal-done', isFinalized: true, doctorWorkPercent: 100, created_by: 'secretary-1' },
    { report_type: 'other', record_key: 'unknown', isFinalized: true, doctorWorkPercent: null, created_by: 'secretary-1' }
]

function makeQueueLists(rows, user) {
    const factory = new Function(
        'queueRows', 'me', 'isMine',
        extractFn('isDoctorWorkComplete') + '\n' + extractFn('queueLists') + '\nreturn queueLists;'
    )
    return factory(rows, user, row => row.created_by === user.id)()
}

const doctorLists = makeQueueLists(waitingReports, { role: 'doctor', id: 'doctor-1' })
assert.equal(doctorLists.review.length, 3, 'doctor count includes incomplete CF4, Nasal, and Laryngeal reports')
assert.equal(doctorLists.saved.length, 1, 'fully completed report is not counted as waiting')

const secretaryLists = makeQueueLists(waitingReports, { role: 'secretary', id: 'secretary-1' })
assert.equal(secretaryLists.review.length, 2, 'secretary sees assigned doctor work for her own reports')

const uniqueQueueRecords = new Function(extractFn('uniqueQueueRecords') + '\nreturn uniqueQueueRecords;')()
assert.equal(uniqueQueueRecords([
    { report_type: 'cf4', record_key: 'same' },
    { report_type: 'cf4', record_key: 'same' },
    { report_type: 'nasal', record_key: 'same' },
    { report_type: 'nasal', record_key: '' }
]).length, 3, 'duplicate report keys count once while different report types stay separate')

for (const page of ['nasalEndoscopy.html', 'laryngealEndoscopy.html']) {
    const html = readFileSync(resolve(root, 'pages', page), 'utf8')
    assert.match(html, /id="cameraFileInput"[^>]*capture="environment"/, `${page} exposes the native rear-camera input`)
}
assert.match(formScript, /display-mode: standalone[\s\S]*?cameraFileInput\.click\(\)/,
    'installed PWA opens native camera capture instead of requesting getUserMedia')
assert.match(styles, /input\[type="file"\]\[hidden\]\s*\{\s*display:\s*none\s*!important;/,
    'hidden camera input stays invisible despite the generic file-input styling')

console.log('==== DASHBOARD WORK COUNT & PWA CAMERA CHECKS PASSED — 8 passed ====')
