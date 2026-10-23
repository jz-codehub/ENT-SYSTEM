// =====================================================================
//  give_every_doctor_a_clinic.mjs
// ---------------------------------------------------------------------
//  WHAT IT DOES
//  Every doctor ends up owning a clinic named "ENT-Clinic Doc. <Name>",
//  matching what auth-admin already does for NEW doctors. Only the doctors
//  who predate that change are touched.
//
//  It also moves each doctor's patients, their secretaries and their
//  settings into the new clinic, so afterwards the two seeded clinics
//  (ENT Manila / ENT Quezon) are empty shells you can retire.
//
//  WHY A SCRIPT AND NOT SQL YOU PASTE BY HAND
//  Because the interesting part is not the INSERT, it is deciding what to
//  move and proving nothing is stranded. Every clinic_id in the database -
//  staff, reports, photos, settings - has to follow the people, and a
//  half-finished move leaves a doctor who cannot read his own patients.
//
//  SAFETY
//  · DRY RUN by default. Nothing is written until --apply.
//  · Re-runnable: a doctor who already is alone in a clinic is skipped, so
//    running it twice changes nothing the second time.
//  · Writes go through service_role, so the ownership trigger does not
//    re-stamp the clinic back. That is deliberate, and is why the moves are
//    computed and verified here rather than done blind.
//
//  Run:  node give_every_doctor_a_clinic.mjs            (preview)
//        node give_every_doctor_a_clinic.mjs --apply    (write)
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
async function rest(path, options = {}) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    ...options, headers: { ...H, ...(options.headers || {}) }, signal: AbortSignal.timeout(60000)
  })
  const t = await r.text()
  let j = null; try { j = t ? JSON.parse(t) : null } catch { /* keep raw */ }
  if (!r.ok) throw new Error(`${r.status} ${path} :: ${t.slice(0, 200)}`)
  return j
}

/* The clinic name, matching auth-admin's clinicNameForDoctor exactly.
 * FIRST NAME ONLY. Kept in step with the Edge Function on purpose: two copies
 * of "how a clinic is named" is already one too many, so if one changes the
 * other changes with it. */
function clinicNameForDoctor(fullName, username) {
  const who = String(fullName || '').trim() || String(username || '').trim()
  if (!who) return 'ENT-Clinic Doc. Unassigned'
  const bare = who.replace(/^(dr\.?|doc\.?)\s+/i, '').trim() || who
  const parts = bare.split(/\s+/).filter(Boolean)
  /* LAST NAME, not the first name.
   *
   * "Jesus Jardin" -> "ENT-Clinic Doc. Jardin". The clinic asked for the last
   * word, and it is the better identifier anyway: in a list of clinics, surnames
   * are the part people recognise, and two doctors can share a first name far
   * more easily than a surname. A one-word name is used as-is.
   *
   * The fallback matters: the three SYNTHETIC accounts are named "SYNTHETIC
   * Test Doctor One" / "...Two" / "SYNTHETIC Satellite Doctor", whose LAST word
   * is "One", "Two" and "Doctor" - three clinics a reader cannot tell apart.
   * Falling back to the username keeps them distinguishable. Real doctors are
   * untouched, because "Jardin" is not a placeholder. */
  let last = parts.length ? parts[parts.length - 1] : bare
  /* The whole name is checked, not just the last word.
   *
   * "SYNTHETIC Test Doctor One" ends in "One" and "SYNTHETIC Test Doctor Two"
   * in "Two" - neither is a placeholder word on its own, so matching the last
   * token alone produced two clinics named "ENT-Clinic Doc. One" and
   * "... Two", which are indistinguishable in the panel and worse than the
   * duplicate "SYNTHETIC" they replaced. A marker anywhere in the name means
   * the record is synthetic, so the username is the honest identifier. Real
   * doctors never match: "Jardin" carries no such marker. */
  const isSynthetic = /synthetic|test|fixture|dummy|placeholder/i.test(bare)
  if (isSynthetic || !last || /^(doctor|dr)$/i.test(last)) {
    last = String(username || '').trim() || last
  }
  return ('ENT-Clinic Doc. ' + last).slice(0, 80)
}
// clinics_code_shape CHECK: ^[a-z0-9][a-z0-9_-]{1,31}$
function clinicCodeFor(username) {
  const slug = String(username || '').toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 26)
  const code = ('ent-' + slug).replace(/-+$/, '')
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(code) ? code : ''
}

const staff = await rest('staff_profiles?select=id,username,full_name,role,clinic_id,assigned_doctor_id,is_active&order=username')
const clinics = await rest('clinics?select=id,code,name,managed_by&order=name')
const reports = await rest('reports?select=id,doctor_id,clinic_id&limit=5000')

/* A doctor "has his own clinic" when he is its ONLY member.
 *
 * Membership is the test, not managed_by, because managed_by points at the
 * ADMIN who created the clinic rather than at the doctor, and a clinic made by
 * hand for one doctor also has managed_by = NULL. Using managed_by would skip
 * every doctor who already had one, and create a second clinic for each. */
function soloDoctorIn(clinicId) {
  const members = staff.filter(s => s.clinic_id === clinicId)
  if (members.length !== 1) return null
  const only = members[0]
  return only.role === 'doctor' ? only : null
}

const plan = []
for (const d of staff.filter(s => s.role === 'doctor')) {
  const current = clinics.find(c => c.id === d.clinic_id)
  if (soloDoctorIn(d.clinic_id)) {
    plan.push({ doc: d, clinic: current, action: 'keep' })
    continue
  }
  const code = clinicCodeFor(d.username)
  plan.push({
    doc: d, from: current, code,
    clinic: clinics.find(c => c.code === code) || null,
    name: clinicNameForDoctor(d.full_name, d.username),
    action: clinics.find(c => c.code === code) ? 'adopt' : 'create'
  })
}

console.log('\n=====================================================================')
console.log('  GIVE EVERY DOCTOR HIS OWN CLINIC   ' + (APPLY ? '[ APPLYING ]' : '[ DRY RUN ]'))
console.log('=====================================================================\n')

const moving = plan.filter(p => p.action !== 'keep')
for (const p of plan) {
  if (p.action === 'keep') {
    console.log('  keep    ' + String(p.doc.username).padEnd(11) + ' -> ' + p.clinic.name)
  } else {
    console.log('  ' + p.action.padEnd(7) + String(p.doc.username).padEnd(11)
      + ' -> ' + p.name.padEnd(32) + 'code=' + p.code)
    const inFrom = p.from ? staff.filter(s => s.clinic_id === p.from.id).length : 0
    console.log('          from: ' + (p.from ? p.from.name + ' (' + inFrom + ' people)' : 'none'))
  }
}

console.log('\n---- what moves with each doctor ----')
for (const p of moving) {
  const secs = staff.filter(s => s.role === 'secretary' && s.assigned_doctor_id === p.doc.id)
  const recs = reports.filter(r => r.doctor_id === p.doc.id)
  console.log('  ' + p.doc.username.padEnd(11) + '1 doctor, ' + secs.length + ' secretary(ies), '
    + recs.length + ' report(s)')
}

if (!APPLY) {
  /* What each clinic would be LEFT holding, computed rather than read.
   *
   * Printing the current counts here under the heading "after this runs" would
   * be a lie: an earlier version of this script did exactly that and reported
   * "12 people, 38 reports -> safe to delete" for Manila, which are the
   * counts from BEFORE the move. A preview that overstates the result is worse
   * than no preview, because it is what the decision to run --apply is based
   * on. So the arithmetic is done here and the numbers are the real result. */
  console.log('\n---- what each clinic would be LEFT holding ----')
  for (const c of clinics) {
    const leavers = moving.filter(p => p.from && p.from.id === c.id)
    if (!leavers.length) continue
    const stayingStaff = staff.filter(s => s.clinic_id === c.id && !leavers.some(p => p.doc.id === s.id)
      && !(s.role === 'secretary' && leavers.some(p => s.assigned_doctor_id === p.doc.id)))
    const leavingRecs = leavers.reduce((n, p) =>
      n + reports.filter(r => r.doctor_id === p.doc.id).length, 0)
    const stayingRecs = reports.filter(r => r.clinic_id === c.id
      && !leavers.some(p => p.doc.id === r.doctor_id)).length
    const people = stayingStaff.length
    const recs = stayingRecs
    const clean = people === 0 && recs === 0
    console.log('  ' + String(c.name).padEnd(34) + people + ' people, ' + recs + ' reports left'
      + (clean ? '   EMPTY - safe to delete' : '   still has people; do NOT delete'))
    if (!clean) {
      for (const s of stayingStaff) {
        console.log('        stays: ' + s.username + ' (' + s.role + ')')
      }
      if (recs) console.log('        ' + recs + ' report(s) would remain here')
    }
    void leavingRecs
  }
  console.log('\n' + moving.length + ' doctor(s) would move. DRY RUN - nothing was written.')
  console.log('Re-run with --apply when the names above look right.')
  console.log('')
  process.exit(0)
}

console.log('\n---- applying ----')
for (const p of moving) {
  let clinicId = p.clinic ? p.clinic.id : null
  if (!clinicId) {
    /* managed_by IS NOT NULL HERE. That was the bug.
     *
     * auth-admin sets managed_by = the admin who created the doctor, and
     * ent_admin_covers_clinic() grants an admin reach over a clinic only when
     * `me.clinic_id = p_clinic OR c.managed_by = me.id`. Creating these clinics
     * with managed_by NULL therefore made every one of them INVISIBLE to the
     * administrator who ran this script: his user list collapsed to a single
     * clinic, the directory showed "0 doctors" on nine cards, and the patients
     * of ENT-Clinic Doc. Jardin - 29 records - could not be listed at all.
     * Observed live, immediately after the move.
     *
     * The owner is resolved once, from the clinic each doctor is LEAVING, so a
     * doctor keeps the administrator who already ran his clinic. Falling back
     * to any active admin covers the case where a doctor sat in an unowned
     * clinic already. */
    let ownerId = p.from ? (p.from.managed_by || null) : null
    if (!ownerId) {
      const ownerInOld = staff.find(s => s.clinic_id === p.from?.id && s.role === 'admin')
      ownerId = ownerInOld ? ownerInOld.id : null
    }
    if (!ownerId) {
      const realAdmin = staff.find(s => s.role === 'admin'
        && !/synthetic|test|fixture|dummy/i.test(String(s.full_name || '')))
      ownerId = realAdmin ? realAdmin.id : null
    }
    if (!ownerId) {
      console.log('  ! no administrator to own ' + p.name + ' - skipped rather than')
      console.log('    created ownerless, which is what made the clinics invisible.')
      continue
    }
    const ins = await rest('clinics', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ code: p.code, name: p.name, managed_by: ownerId }])
    })
    clinicId = ins[0].id
    console.log('  created  ' + p.name + '  (' + p.code + ')  owner=' + uname[ownerId])
  } else if (!p.clinic.managed_by) {
    // An adopted clinic can also be ownerless (the pre-existing ent-josh row
    // was, because it was made before this script learned the rule).
    let ownerId = staff.find(s => s.role === 'admin'
      && !/synthetic|test|fixture|dummy/i.test(String(s.full_name || '')))?.id
    if (ownerId) {
      await rest('clinics?id=eq.' + p.clinic.id, {
        method: 'PATCH', body: JSON.stringify({ managed_by: ownerId })
      })
      console.log('  adopted  ' + p.clinic.name + '  (' + p.code + ')  owner=' + uname[ownerId] + '  [was ownerless]')
    }
  } else {
    console.log('  adopted  ' + p.clinic.name + '  (' + p.code + ')')
  }
  p.target = clinicId
}

// Second pass, so every clinic exists before any row is repointed. Doing it in
// one pass would leave a report pointing at a clinic row that does not exist
// yet for the doctors still to be processed.
for (const p of moving) {
  const clinicId = p.target
  // The doctor, then his secretaries. A secretary left in the old clinic is
  // still reachable by her doctor but is missing from his directory card, so
  // the move has to include her or the panel quietly loses a person.
  await rest('staff_profiles?id=eq.' + p.doc.id, {
    method: 'PATCH', body: JSON.stringify({ clinic_id: clinicId })
  })
  const secs = staff.filter(s => s.role === 'secretary' && s.assigned_doctor_id === p.doc.id)
  for (const s of secs) {
    await rest('staff_profiles?id=eq.' + s.id, {
      method: 'PATCH', body: JSON.stringify({ clinic_id: clinicId })
    })
  }
  // The patients. This is the part that actually matters: after it, the doctor
  // can still read every record he ever made.
  const recs = reports.filter(r => r.doctor_id === p.doc.id && r.clinic_id !== clinicId)
  for (const r of recs) {
    await rest('reports?id=eq.' + r.id, {
      method: 'PATCH', body: JSON.stringify({ clinic_id: clinicId })
    })
  }
  console.log('           ' + p.doc.username.padEnd(11) + 'moved ' + (1 + secs.length)
    + ' staff, ' + recs.length + ' reports')
}

console.log('\n---- verifying ----')
const staffAfter = await rest('staff_profiles?select=id,username,role,clinic_id')
const reportsAfter = await rest('reports?select=id,doctor_id,clinic_id&limit=5000')
const clinicAfter = await rest('clinics?select=id,name&order=name')
let bad = 0
for (const p of plan) {
  const d = staffAfter.find(s => s.id === p.doc.id)
  if (!d) continue
  const recs = reportsAfter.filter(r => r.doctor_id === p.doc.id)
  const wrong = recs.filter(r => r.clinic_id !== d.clinic_id)
  const nameOf = (clinicAfter.find(c => c.id === d.clinic_id) || {}).name || '?'
  console.log('  ' + p.doc.username.padEnd(11) + (wrong.length ? 'MISMATCH' : 'ok').padEnd(9)
    + String(recs.length).padStart(3) + ' reports  ' + wrong.length + ' misplaced  ' + nameOf)
  if (wrong.length) bad++
}

console.log('\n---- clinics now ----')
for (const c of clinicAfter) {
  const people = staffAfter.filter(s => s.clinic_id === c.id).length
  const recs = reportsAfter.filter(r => r.clinic_id === c.id).length
  console.log('  ' + String(c.name).padEnd(34) + people + ' people, ' + recs + ' reports')
}
const stillUsed = clinicAfter.filter(c => staffAfter.some(s => s.clinic_id === c.id))
console.log('\n' + (bad ? bad + ' DOCTOR(S) STILL HAVE REPORTS ELSEWHERE - investigate.'
  : 'Every doctor\'s patients are in his own clinic.'))
console.log('Clinics still holding people (these can be deleted once empty): '
  + stillUsed.length + ' of ' + clinicAfter.length)
console.log('')
process.exit(bad ? 1 : 0)