/* =====================================================================
 *  cleanup_probe_accounts.mjs — remove leftover zzprobe* test accounts.
 * ---------------------------------------------------------------------
 *  test_live_functions.mjs creates a throwaway account (zzprobe######)
 *  per run to exercise auth-admin. Its cleanup block only ever DELETED
 *  the staff_profiles row, never the auth.users row, so every run left
 *  a real GoTrue account behind. 9 of them accumulated, 7 of which are
 *  orphans: an auth.users row with no profile, which means they sign in
 *  but resolve to no role at all.
 *
 *  They show up in Admin -> Users as a wall of doctors, which is what
 *  makes the real admins (testadmin, zzbadmin) look like they are the
 *  only two accounts and everything else is a doctor.
 *
 *  Deleting the auth.users row cascades to staff_profiles (ON DELETE
 *  CASCADE, migration 0003), so no profile can survive as an orphan.
 *
 *  SAFETY: it refuses to touch anything that is not named zzprobe* on
 *  the @zztest.invalid domain. The six real synthetic accounts and any
 *  genuine staff account are never matched.
 *
 *  Usage:  node cleanup_probe_accounts.mjs          # report only
 *          node cleanup_probe_accounts.mjs --go     # actually delete
 * ===================================================================== */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const go = process.argv.includes('--go')

const env = {}
for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }

if (!BASE || !SVC) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local).')
  process.exit(1)
}

/* Only ever these two conditions, both required. */
const isProbe = (email) =>
  /^zzprobe\d+@zztest\.invalid$/i.test(String(email || ''))

const raw = await (await fetch(BASE + '/auth/v1/admin/users?per_page=200',
  { headers: H, signal: AbortSignal.timeout(25000) })).json()
const users = Array.isArray(raw) ? raw : (raw.users || [])

const profiles = await (await fetch(BASE + '/rest/v1/staff_profiles?select=id,username,role',
  { headers: H, signal: AbortSignal.timeout(25000) })).json()
const profileOf = new Map(profiles.map(p => [p.id, p]))

const probes = users.filter(u => isProbe(u.email))
const keep = users.filter(u => !isProbe(u.email))

console.log('\n==== PROBE ACCOUNT CLEANUP ====')
console.log('  project : ' + BASE)
console.log('  mode    : ' + (go ? 'DELETE' : 'REPORT ONLY (pass --go to delete)') + '\n')

if (!probes.length) {
  console.log('  Nothing to clean - no zzprobe* accounts found.')
} else {
  console.log('  ' + String(probes.length).padStart(2) + ' probe account(s) will be removed:\n')
  for (const u of probes) {
    const p = profileOf.get(u.id)
    const state = p ? ('profile role=' + p.role) : 'ORPHAN (auth row only, no profile)'
    console.log('    ' + String(u.email).padEnd(30) + state)
  }

  if (go) {
    console.log('')
    let ok = 0, fail = 0
    for (const u of probes) {
      try {
        const r = await fetch(BASE + '/auth/v1/admin/users/' + u.id,
          { method: 'DELETE', headers: H, signal: AbortSignal.timeout(25000) })
        if (r.ok || r.status === 404) { ok++; console.log('    ok   deleted ' + u.email) }
        else { fail++; console.log('    FAIL ' + u.email + '  HTTP ' + r.status) }
      } catch (e) {
        fail++
        console.log('    FAIL ' + u.email + '  ' + e.message)
      }
    }
    console.log('\n  deleted ' + ok + ', failed ' + fail)
    if (fail) process.exitCode = 1
  }
}

console.log('\n  Kept (never touched): ' + keep.length + ' account(s)')
for (const u of keep) {
  const p = profileOf.get(u.id)
  console.log('    ' + String(u.email).padEnd(30) + (p ? 'role=' + p.role : 'NO PROFILE ROW'))
}
console.log()
