/* =====================================================================
 *  diagnose_delete.mjs - why is deleting a patient still refused?
 * ---------------------------------------------------------------------
 *  READ-ONLY. Signs in as real clinic accounts and asks the database
 *  questions. It writes nothing: no row is inserted, updated or deleted.
 *
 *  The bug being chased is a 403 on soft delete:
 *
 *      "new row violates row-level security policy for table reports"
 *
 *  which means an UPDATE's WITH CHECK refused the row AFTER deleted_at was
 *  stamped onto it. 0030 added a policy for that. If it is STILL refused,
 *  one of these is true, and all three look identical from the browser:
 *
 *    1. the policy never got created. 0030's guard raises BEFORE the
 *       commit, so if any check in it failed the whole file rolled back -
 *       including the CREATE POLICY.
 *    2. the policy exists but ent_may_soft_delete() answers FALSE for this
 *       row: the caller is not the author of her own draft, not the row's
 *       doctor, and not an active admin of the owning clinic.
 *    3. the policy exists and the function says TRUE, yet the write still
 *       fails - meaning something ELSE in the stack refuses it.
 *
 *  Only the database can tell these apart, so this asks it directly.
 *
 *  Usage:  node supabase-v2/scripts/diagnose_delete.mjs
 * ===================================================================== */
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
const ANON = env.SUPABASE_ANON_KEY

// A doctor's own row is the case that MUST be allowed; the other two are
// here so a refusal can be told apart from "this account was never
// entitled to delete that row".
const ACCOUNTS = [
    ['testdoc1', 'TEST_EMAIL', 'TEST_PASSWORD', 'a doctor - owns his shelf'],
    ['testadmin', 'LIVE_TESTADMIN', 'LIVE_TESTADMIN_PW', 'an admin of its own clinic'],
    ['testsec1', 'LIVE_TESTSEC1', 'LIVE_TESTSEC1_PW', 'a secretary - only her own drafts']
]

async function signIn(email, password) {
    const r = await fetch(BASE + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(20000)
    })
    const j = await r.json()
    return { token: j.access_token || '', error: j.error_description || j.msg || r.status }
}

async function api(path, token) {
    const res = await fetch(BASE + '/rest/v1/' + path, {
        headers: { apikey: ANON, Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(20000)
    })
    const text = await res.text()
    try { return { status: res.status, body: JSON.parse(text) } }
    catch { return { status: res.status, body: text } }
}

// ent_may_soft_delete is SECURITY DEFINER and returns boolean, so PostgREST
// exposes it as an RPC. Calling it as the signed-in user answers the only
// question that matters: would this policy let this person delete this row?
async function maySoftDelete(token, row) {
    const r = await fetch(BASE + '/rest/v1/rpc/ent_may_soft_delete', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_clinic: null, p_doctor: row.doctor_id, p_id: row.id }),
        signal: AbortSignal.timeout(20000)
    })
    const text = await r.text()
    try { return { status: r.status, value: JSON.parse(text) } }
    catch { return { status: r.status, value: text } }
}

console.log('\n==== WHY IS DELETE STILL REFUSED? ====\n')
console.log('  Read-only. Nothing is written.\n')


for (const [name, ek, pk, why] of ACCOUNTS) {
    if (!env[ek] || !env[pk]) {
        console.log('  ' + name.padEnd(11) + 'skipped - no ' + ek + ' in .env.local')
        continue
    }
    console.log('  ---------- ' + name + '  (' + why + ') ----------')

    const { token, error } = await signIn(env[ek], env[pk])
    if (!token) { console.log('    SIGN-IN REFUSED: ' + error + '\n'); continue }

    const me = await api('staff_profiles?select=id,role,is_active&limit=1', token)
    const meRow = Array.isArray(me.body) ? me.body[0] : null
    if (!meRow) { console.log('    cannot read own profile (HTTP ' + me.status + ')\n'); continue }
    console.log('    role=' + meRow.role + '  active=' + meRow.is_active)

    // Whatever comes back here is LIVE: reports_select_owner hides every row
    // that already has deleted_at, so this is exactly the set the delete
    // button acts on.
    const rows = await api(
        'reports?select=id,is_draft,doctor_id,created_by,patient_name'
        + '&deleted_at=is.null&limit=6', token)
    const list = Array.isArray(rows.body) ? rows.body : []
    if (!list.length) {
        console.log('    no live rows visible to this account - nothing to test')
        console.log('')
        continue
    }
    console.log('    ' + list.length + ' live row(s) visible\n')

    for (const row of list) {
        const mine =
            row.created_by === meRow.id ? 'AUTHOR of it'
            : row.doctor_id === meRow.id ? 'the OWN DOCTOR'
            : 'NEITHER'
        console.log('      row ' + String(row.id).slice(0, 8)
            + '  ' + (row.is_draft ? 'draft    ' : 'FINISHED ')
            + '  you are: ' + mine.padEnd(13)
            + '  ' + String(row.patient_name || '(unnamed)').slice(0, 20))

        const v = await maySoftDelete(token, row)
        const allowed = v.value === true ? 'YES -> the policy WOULD allow this'
            : v.value === false ? 'no  -> the policy correctly refuses this account'
            : 'HTTP ' + v.status + ' ' + JSON.stringify(v.value)
        console.log('        ent_may_soft_delete = ' + allowed)
    }
    console.log('')
}

console.log('  ======================================================================')
console.log('  HOW TO READ THIS')
console.log('')
console.log('  1. "no" for EVERY row of EVERY account')
console.log('     The policy is not in force, and 0030 most likely did not COMMIT.')
console.log('     Its guard block RAISEs before the commit, and a failed guard rolls')
console.log('     the CREATE POLICY back with it. Check in the SQL editor:')
console.log('')
console.log("         select policyname, cmd from pg_policies")
console.log("         where tablename = 'reports' and policyname like 'reports_update%';")
console.log('')
console.log('     Expect TWO rows: reports_update_owner (0026) and')
console.log('     reports_update_own_doctor (0030). ONE row means 0030 rolled back.')
console.log('')
console.log('  2. "YES" for the doctor on his own row, yet the app still fails')
console.log('     The policy is fine and something ELSE refuses the write. Tell me')
console.log('     and I will chase the layer above RLS.')
console.log('')
console.log('  3. "no" only where you expected it')
console.log('     The policy works as designed and that account was never allowed to')
console.log('     delete that row. That is the 0029 rule: an author may remove her')
console.log('     own UNFINISHED draft, the row doctor may remove anything on his')
console.log('     shelf, an active admin may remove any row in his OWN clinic.')
console.log('     Nobody else, and a clinic manager is never included.')
console.log('  ======================================================================')
console.log('')
