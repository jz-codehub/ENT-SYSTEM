import { readFileSync } from 'node:fs'
const d = 'supabase-v2/backup/v2-2026-10-11T23-44-19-717Z'
const clinics = JSON.parse(readFileSync(d + '/clinics.json', 'utf8'))
const staff = JSON.parse(readFileSync(d + '/staff_profiles.json', 'utf8'))
const reports = JSON.parse(readFileSync(d + '/reports.json', 'utf8'))
const auth = JSON.parse(readFileSync(d + '/auth_users.json', 'utf8'))
console.log('=== REPORT clinic distribution ===')
const byC = {}
for (const x of reports) byC[x.clinic_id] = (byC[x.clinic_id] || 0) + 1
for (const [k, v] of Object.entries(byC)) {
  const c = clinics.find(c => c.id === k)
  console.log(v + 'x ' + k.slice(0, 8) + ' ' + (c ? c.name : 'CLINIC-NOT-IN-BACKUP'))
}
console.log('=== REPORT doctor distribution ===')
const byD = {}
for (const x of reports) byD[x.doctor_id] = (byD[x.doctor_id] || 0) + 1
for (const [k, v] of Object.entries(byD)) {
  const s = staff.find(s => s.id === k)
  console.log(v + 'x ' + k.slice(0, 8) + ' ' + (s ? s.username + '/' + s.role : 'STAFF-NOT-IN-BACKUP'))
}
console.log('=== STAFF full clinic mapping ===')
for (const x of staff) {
  const c = clinics.find(c => c.id === x.clinic_id)
  console.log((x.username || '').padEnd(12) + ' ' + (x.role || '').padEnd(10) + ' clinic=' + (x.clinic_id || '').slice(0, 8) + ' ' + (c ? c.name : 'NO-CLINIC'))
}
console.log('=== AUTH without staff ===')
const sids = new Set(staff.map(s => s.id))
for (const u of auth) if (!sids.has(u.id)) console.log('orphan auth: ' + u.id.slice(0, 8) + ' ' + u.email)
console.log('=== STAFF ids vs NEW bokskie ===')
console.log('NEW bokskie staff id: 629596a4-e19a-4777-a26b-f33d7192d4f3')
console.log('OLD bokskie staff id: ' + (staff.find(s => s.username === 'bokskie') || {}).id)
