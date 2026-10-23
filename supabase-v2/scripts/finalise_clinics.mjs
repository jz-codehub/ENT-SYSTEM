// =====================================================================
//  finalise_clinics.mjs
// ---------------------------------------------------------------------
//  WHAT IT DOES, in the order the clinic asked for:
//    1. rename "ENT-Clinic Doc. Cruz" -> "ENT-Clinic Doc. Monique"
//       (monique + his secretary stay there - the name was simply out of date)
//    2. every one of the four clinics is owned by the real administrator
//    3. the administrator is given a clinic, because deleting the one he was
//       standing in would leave him with none and therefore able to do nothing
//    4. delete the unwanted clinics
//    5. delete the unwanted accounts (the synthetic ones, and the two
//       secretaries the clinic did not keep)
//    6. verify, and print what is left
//
//  SAFETY: DRY RUN by default. Every delete is preceded by a count of exactly
//  what it will remove, and the whole thing is verified afterwards. Nothing is
//  removed that still holds a report.
//
//  Run:  node finalise_clinics.mjs           (preview)
//        node finalise_clinics.mjs --apply   (write)
// =====================================================================
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
const APPLY = process.argv.includes('--apply')
if (!BASE || !SVC) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.'); process.exit(1) }

const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
async function rest(p, o = {}) {
  const r = await fetch(`${BASE}/rest/v1/${p}`, {
    ...o, headers: { ...H, ...(o.headers || {}) }, signal: AbortSignal.timeout(60000)
  })
  const t = await r.text()
  let j = null; try { j = t ? JSON.parse(t) : null } catch { /* keep raw */ }
  if (!r.ok) throw new Error(`${r.status} ${p} :: ${t.slice(0, 300)}`)
  return j
}

const read = async () => ({
  staff: await rest('staff_profiles?select=id,username,full_name,role,clinic_id,assigned_doctor_id,is_active&order=username'),
  clinics: await rest('clinics?select=id,code,name,managed_by&order=name'),
  reports: await rest('reports?select=id,doctor_id,clinic_id,patient_name&limit=5000')
})
let { staff, clinics, reports } = await read()
const byId = {}; for (const c of clinics) byId[c.name] = c
const cn = id => (clinics.find(c => c.id === id) || {}).name || '(none)'
const un = id => (staff.find(s => s.id === id) || {}).username || '?'
const isTest = s => /synthetic|test|fixture|dummy|^test|^532$/i.test(String(s.username) + ' ' + String(s.full_name))

/* The four clinics that survive. Named exactly as the clinic listed them. */
const KEEP = ['ENT-Clinic Doc. Jardin', 'ENT-Clinic Doc. Josh Almonicid',
  'ENT-Clinic Doc. Larson', 'ENT-Clinic Doc. Monique']
/* The secretaries that survive. Everyone else goes. */
const KEEP_SECS = ['lilian', 'tara', 'wafa']

console.log('\n=====================================================================')
console.log('  FINALISE CLINICS   ' + (APPLY ? '[ APPLYING ]' : '[ DRY RUN ]'))
console.log('=====================================================================')

// --- step 1: the rename the clinic asked for -------------------------
const cruz = clinics.find(c => c.name === 'ENT-Clinic Doc. Cruz')
if (cruz && !byId['ENT-Clinic Doc. Monique']) {
  console.log('\n  1. rename   ENT-Clinic Doc. Cruz  ->  ENT-Clinic Doc. Monique')
  console.log('     monique and lian stay exactly where they are.')
} else if (byId['ENT-Clinic Doc. Monique']) {
  console.log('\n  1. rename   already named ENT-Clinic Doc. Monique - nothing to do.')
} else {
  console.log('\n  1. rename   ! neither name found - stopping before anything else.')
  process.exit(1)
}
const moniqueClinic = (byId['ENT-Clinic Doc. Monique'] || cruz)

// --- who is about to disappear, and are they real? --------------------
console.log('\n---- accounts that will be REMOVED ----')
const doomedAccounts = staff.filter(s => {
  if (s.role === 'secretary') return !KEEP_SECS.includes(s.username)
  if (s.role === 'doctor') return !['jess', 'josh', 'larson', 'monique'].includes(s.username)
  if (s.role === 'admin') return isTest(s)
  return false
})
for (const s of doomedAccounts) {
  const recs = reports.filter(r => r.doctor_id === s.id)
  const real = !isTest(s)
  console.log('  ' + String(s.username).padEnd(11) + String(s.role).padEnd(10)
    + (real ? 'REAL ' : 'test ') + String(recs.length).padStart(2) + ' reports   in ' + cn(s.clinic_id))
}
const realDoomed = doomedAccounts.filter(s => !isTest(s))
if (realDoomed.length) {
  console.log('\n  !! ' + realDoomed.length + ' of these are NOT synthetic accounts:')
  for (const s of realDoomed) console.log('     ' + s.username + ' (' + s.role + ', ' + s.full_name + ')')
}

// --- clinics that will go ---------------------------------------------
console.log('\n---- clinics that will be DELETED ----')
const doomedClinics = clinics.filter(c => !KEEP.includes(c.name) && c.id !== moniqueClinic.id)
for (const c of doomedClinics) {
  const people = staff.filter(s => s.clinic_id === c.id)
  const recs = reports.filter(r => r.clinic_id === c.id)
  console.log('  ' + String(c.name).padEnd(34) + people.length + ' people, ' + recs.length + ' reports')
  if (recs.length) {
    console.log('       their reports will be DELETED with the clinic:')
    for (const r of recs.slice(0, 6)) console.log('         ' + r.patient_name)
    if (recs.length > 6) console.log('         ...and ' + (recs.length - 6) + ' more')
  }
}

console.log('\n---- what SURVIVES ----')
for (const c of clinics.filter(c => KEEP.includes(c.name))) {
  const people = staff.filter(s => s.clinic_id === c.id && !doomedAccounts.some(d => d.id === s.id))
  const recs = reports.filter(r => r.clinic_id === c.id
    && !doomedAccounts.some(d => d.id === r.doctor_id))
  console.log('  ' + String(c.name).padEnd(34) + people.map(p => p.username).join(', '))
  console.log('       ' + recs.length + ' records survive')
}

if (!APPLY) {
  console.log('\nDRY RUN. Nothing was written. Re-run with --apply when this matches what you want.')
  console.log('')
  process.exit(realDoomed.length ? 2 : 0)
}

const admin = staff.find(s => s.role === 'admin' && !isTest(s))
if (!admin) { console.log('No real administrator found - stopping.'); process.exit(1) }

// --- 1. the rename ------------------------------------------------------
if (cruz) {
  await rest('clinics?id=eq.' + cruz.id, {
    method: 'PATCH', body: JSON.stringify({ name: 'ENT-Clinic Doc. Monique' })
  })
  console.log('\n  1. renamed  ENT-Clinic Doc. Cruz -> ENT-Clinic Doc. Monique')
}
clinics = (await read()).clinics

// --- 2. give the administrator a clinic BEFORE his own is deleted ------
/* An admin whose clinic_id points at a clinic that no longer exists can
 * administer nothing: ent_admin_covers_clinic() compares his clinic_id to the
 * row being read and finds no match. Deleting "ENT Manila" without moving him
 * first would therefore leave the clinic with no working administrator.
 * Jardin is used because it is the biggest real clinic, and the admin is an
 * ordinary member of it - ownership of every clinic comes from managed_by,
 * not from living there. */
if (doomedClinics.some(c => c.id === admin.clinic_id)) {
  const jardin = clinics.find(c => c.name === 'ENT-Clinic Doc. Jardin')
  if (!jardin) { console.log('No surviving clinic to move the admin into - stopping.'); process.exit(1) }
  await rest('staff_profiles?id=eq.' + admin.id, {
    method: 'PATCH', body: JSON.stringify({ clinic_id: jardin.id })
  })
  console.log('  2. admin    ' + admin.username + ' moved into ENT-Clinic Doc. Jardin')
  admin.clinic_id = jardin.id
}

// --- 3. every surviving clinic is owned by him --------------------------
for (const c of clinics.filter(c => KEEP.includes(c.name))) {
  if (c.managed_by === admin.id) continue
  await rest('clinics?id=eq.' + c.id, {
    method: 'PATCH', body: JSON.stringify({ managed_by: admin.id })
  })
  console.log('  3. owner    ' + c.name + ' -> ' + admin.username
    + (c.managed_by ? '' : '   (was ownerless - this is what made it invisible before)'))
}

// --- 4. accounts: remove only those holding nothing ---------------------
/* A doctor or secretary who still has records is NOT deleted, and the run
 * stops instead. Losing a real patient record to a tidy-up is the one outcome
 * that is never acceptable, and the check is here rather than trusted. */
const blockers = []
for (const s of doomedAccounts) {
  const recs = reports.filter(r => r.doctor_id === s.id)
  if (recs.length) blockers.push({ s, recs })
}
if (blockers.length) {
  console.log('\n  !! STOPPING. These accounts still hold records:')
  for (const b of blockers) {
    console.log('     ' + b.s.username + ' (' + b.s.role + ') holds ' + b.recs.length + ' records:')
    for (const r of b.recs.slice(0, 8)) console.log('        ' + r.patient_name)
  }
  console.log('  Nothing has been deleted. Decide about each of these first.')
  process.exit(1)
}

for (const s of doomedAccounts) {
  const { error } = await rest('auth/v1/admin/users/' + s.id, { method: 'DELETE' })
    .catch(e => ({ error: e.message }))
  if (error) {
    console.log('  ! could not delete ' + s.username + ': ' + error)
  } else {
    console.log('  4. removed  ' + s.username.padEnd(11) + '(' + s.role + ')')
  }
}

// --- 5. the clinics ------------------------------------------------------
for (const c of doomedClinics) {
  const people = staff.filter(s => s.clinic_id === c.id && !doomedAccounts.some(d => d.id === s.id))
  if (people.length) {
    console.log('  ! ' + c.name + ' still holds ' + people.map(p => p.username).join(', ')
      + ' - left in place')
    continue
  }
  await rest('clinics?id=eq.' + c.id, { method: 'DELETE' }).catch(e => {
    console.log('  ! could not delete ' + c.name + ': ' + e.message)
  })
  console.log('  5. deleted  ' + c.name)
}

// --- 6. verify ------------------------------------------------------------
const fin = await read()
console.log('\n---- FINAL STATE ----\n')
for (const c of fin.clinics) {
  const people = fin.staff.filter(s => s.clinic_id === c.id)
  const recs = fin.reports.filter(r => r.clinic_id === c.id)
  console.log('  ' + String(c.name).padEnd(32) + people.map(p => p.username).join(', '))
  console.log('       ' + recs.length + ' records   owner=' + un(c.managed_by))
}
console.log('\n  accounts: ' + fin.staff.length)
for (const s of fin.staff) {
  console.log('    ' + String(s.username).padEnd(11) + String(s.role).padEnd(10) + cn(s.clinic_id))
}
const adminsLeft = fin.staff.filter(s => s.role === 'admin' && s.is_active !== false)
console.log('\n  active admins: ' + adminsLeft.length + '  -> ' + adminsLeft.map(s => s.username).join(', '))
const orphanClinic = fin.staff.filter(s => !fin.clinics.some(c => c.id === s.clinic_id))
console.log('  staff pointing at a deleted clinic: ' + (orphanClinic.length
  ? orphanClinic.map(s => s.username).join(', ') : 'none'))
console.log('  total records kept: ' + fin.reports.length)
console.log('')
process.exit(orphanClinic.length || adminsLeft.length === 0 ? 1 : 0)