import { readFileSync } from 'node:fs'
const d = 'supabase-v2/backup/v2-2026-10-11T23-44-19-717Z'
const r = JSON.parse(readFileSync(d + '/reports.json', 'utf8')).filter(x => !x.is_draft && !x.deleted_at)
let emptyBoth = 0, hasPid = 0, hasCase = 0
for (const x of r) {
  const p = (x.patient_id || '').trim(), c = (x.case_number || '').trim()
  if (!p && !c) emptyBoth++
  if (p) hasPid++
  if (!p && c) hasCase++
}
console.log('finals live: ' + r.length + ' emptyBoth=' + emptyBoth + ' hasPid=' + hasPid + ' hasCaseOnly=' + hasCase)
const k = x => [(x.patient_id || '').trim().toLowerCase(), (x.case_number || '').trim().toLowerCase(), (x.report_type || ''), (x.procedure_date || '').slice(0, 10), (x.doctor_id || '')].join('|')
const m = {}
for (const x of r) {
  const p = (x.patient_id || '').trim(), c = (x.case_number || '').trim()
  if (p || c) { const kk = k(x); m[kk] = (m[kk] || 0) + 1 }
}
const dups = Object.entries(m).filter(([kk, v]) => v > 1)
console.log('0041-relevant dup groups: ' + dups.length)
for (const [kk, v] of dups.slice(0, 10)) console.log(v + 'x ' + kk)
