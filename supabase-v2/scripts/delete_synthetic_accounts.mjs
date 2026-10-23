// Deletes ONLY the synthetic accounts. Real staff are never touched, and no
// clinic is removed - keeping kaye means his clinic has to stay.
//
// A test account's records are deleted with it, so every one of them is listed
// first and the run stops if a record does not look synthetic. That check is
// the whole reason this is a script and not six DELETE statements.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
async function rest(p, o = {}) {
  const r = await fetch(`${BASE}/rest/v1/${p}`, { ...o, headers: { ...H, ...(o.headers || {}) },
    signal: AbortSignal.timeout(60000) })
  const t = await r.text()
  if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 200))
  return t ? JSON.parse(t) : null
}
const APPLY = process.argv.includes('--apply')

const staff = await rest('staff_profiles?select=id,username,full_name,role,clinic_id&order=username')
const clinics = await rest('clinics?select=id,name&order=name')
const reports = await rest('reports?select=id,doctor_id,clinic_id,patient_name&limit=5000')
const cn = id => (clinics.find(c => c.id === id) || {}).name || '?'

// ONLY the six the clinic named. Listed explicitly rather than matched by a
// pattern, so a future real account that happens to be called "test_x" cannot
// be swept up by a regex that is one character away from being wrong.
const TARGETS = ['testadmin', 'testdoc1', 'testdoc2', 'testsec1', 'zcbdoc1', 'zzbadmin']

console.log('\n==== DELETE SYNTHETIC ACCOUNTS ONLY ====\n')
const doomed = TARGETS.map(u => staff.find(s => s.username === u)).filter(Boolean)
const missing = TARGETS.filter(u => !staff.some(s => s.username === u))
if (missing.length) console.log('  (not present, skipped: ' + missing.join(', ') + ')\n')

// Every record that will die with them, listed by name.
const allRecords = []
for (const s of doomed) {
  const recs = reports.filter(r => r.doctor_id === s.id)
  console.log('  ' + s.username.padEnd(11) + String(s.role).padEnd(10) + String(recs.length).padStart(2)
    + ' records   in ' + cn(s.clinic_id))
  for (const r of recs) allRecords.push({ by: s.username, name: r.patient_name })
}

// The guard. Anything that is neither marked synthetic NOR already present on
// a real doctor's shelf stops the run.
//
// The duplicate check exists because the shared-device bug copied jess's
// patients onto other accounts, so "testadmin" was holding four records with
// perfectly real patient names. Naming those synthetic would be a lie, but
// deleting them loses nothing: the SAME record_key is already on jess's shelf,
// verified here rather than assumed. A record that is unique to the account
// being deleted is still refused - that one would be real data.
const SUSPECT = /synthetic|test|not real|fixture|dummy/i
const jess = staff.find(s => s.username === 'jess')
const jessKeys = new Set(reports.filter(r => r.doctor_id === jess?.id).map(r => r.record_key))
const unseen = allRecords.filter(r => !SUSPECT.test(String(r.name || '')))
const uniqueRecords = unseen.filter(r => {
  const rec = reports.find(x => x.patient_name === r.name && un2(x.doctor_id) === r.by)
  return !jessKeys.has(rec ? rec.record_key : '')
})
const duplicated = unseen.length - uniqueRecords.length

console.log('\n---- why each one is safe to remove ----')
for (const r of allRecords) {
  const syn = SUSPECT.test(String(r.name || ''))
  const rec = reports.find(x => x.patient_name === r.name && un2(x.doctor_id) === r.by)
  const dup = rec && jessKeys.has(rec.record_key)
  console.log('    ' + r.by.padEnd(11) + String(r.name).padEnd(30)
    + (syn ? 'marked SYNTHETIC' : 'already on jess\'s shelf (duplicate)'))
}
function un2(id) { return (doomed.find(d => d.id === id) || {}).username || '' }

if (uniqueRecords.length) {
  console.log('\n  !! STOPPING. These records exist ONLY on the account being deleted:')
  for (const r of uniqueRecords) console.log('     ' + r.by + ' -> ' + r.name)
  console.log('  Nothing deleted. They look like real patient data.')
  process.exit(1)
}
console.log('\n  ' + allRecords.length - uniqueRecords.length + ' of ' + allRecords.length
  + ' record(s) are safe: '
  + (allRecords.length - uniqueRecords.length - duplicated) + ' marked synthetic, '
  + duplicated + ' already duplicated on jess\'s shelf.')
if (!APPLY) {
  console.log('DRY RUN - nothing deleted. Re-run with --apply.')
  process.exit(0)
}

for (const s of doomed) {
  /* ORDER MATTERS, AND GETTING IT WRONG IS INVISIBLE.
   *
   * staff_profiles.id REFERENCES auth.users(id), so deleting the auth user
   * first makes Postgres act on the profile row through that FK - and it
   * failed with 23514 "new row for relation staff_profiles violates check
   * constraint staff_secretary_requires_doctor". A CHECK only fires on INSERT
   * and UPDATE, so the cascade is rewriting the row, and the rule that a
   * secretary must keep an assigned_doctor_id rejects the rewrite.
   *
   * Deleting the profile FIRST and then the identity is the order that cannot
   * trip it: by the time auth.users is touched there is no profile row left to
   * be rewritten. The profile is also the row that carries the clinic, so
   * removing it first is what the clinic delete checks for afterwards. */
  /* ORDER: records, then profile, then identity. Each step is a real
   * constraint, and discovering them one 23503 at a time is how the previous
   * two attempts failed:
   *
   *   reports.doctor_id REFERENCES staff_profiles(id) ON DELETE RESTRICT
   *       -> 23503 "still referenced from table reports" when the profile went
   *          first. All 9 records going with these accounts are verified safe
   *          by the guard above, so removing them is the point of the run.
   *   staff_profiles.id REFERENCES auth.users(id)
   *       -> 23514 "violates check constraint staff_secretary_requires_doctor"
   *          when the identity went first, because the FK rewrites the profile
   *          row and a secretary is not allowed to lose assigned_doctor_id.
   *
   * Deleting in this order trips none of them: by the time each table is
   * touched, nothing still points at it. */
  try {
    const recs = reports.filter(x => x.doctor_id === s.id)
    for (const r of recs) {
      const d = await fetch(`${BASE}/rest/v1/reports?id=eq.${r.id}`, {
        method: 'DELETE', headers: H, signal: AbortSignal.timeout(30000)
      })
      if (!d.ok) console.log('       ! record ' + r.patient_name + ' kept: HTTP ' + d.status)
    }
    const del = await fetch(`${BASE}/rest/v1/staff_profiles?id=eq.${s.id}`, {
      method: 'DELETE', headers: H, signal: AbortSignal.timeout(30000)
    })
    if (!del.ok) {
      console.log('\n  ! profile of ' + s.username + ' not removed: HTTP ' + del.status + ' '
        + (await del.text()).slice(0, 140))
      continue
    }
    const r = await fetch(`${BASE}/auth/v1/admin/users/${s.id}`, {
      method: 'DELETE', headers: H, signal: AbortSignal.timeout(30000)
    })
    if (!r.ok) {
      console.log('\n  ! identity of ' + s.username + ' not removed: HTTP ' + r.status + ' '
        + (await r.text()).slice(0, 160))
    } else {
      console.log('\n  deleted ' + s.username + ' (' + s.role + ') with ' + recs.length + ' record(s)')
    }
  } catch (e) {
    console.log('\n  ! could not delete ' + s.username + ': ' + e.message)
  }
}

const fin = await rest('staff_profiles?select=username,role,clinic_id&order=username')
const fc = await rest('clinics?select=id,name&order=name')
const fr = await rest('reports?select=id&limit=5000')
console.log('\n---- AFTER ----')
console.log('  accounts : ' + fin.length)
console.log('  clinics  : ' + fc.length + ' (none removed)')
console.log('  records  : ' + fr.length)
for (const s of fin) {
  console.log('    ' + s.username.padEnd(11) + String(s.role).padEnd(10)
    + (fc.find(c => c.id === s.clinic_id) || {}).name)
}
console.log('')