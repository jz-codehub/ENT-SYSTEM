// READ-ONLY pre-deploy check: is everything actually in place?
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
const ANON = env.SUPABASE_ANON_KEY
const H = { apikey: SVC, Authorization: `Bearer ${SVC}` }

let fail = 0
const ok = (n, c, d) => { console.log((c ? '  PASS  ' : '  WAIT  ') + n.padEnd(46) + (d || '')); if (!c) fail++ }

console.log('\n==== PRE-DEPLOY GATE ====\n')

// 1. 0026 applied?
const col = await fetch(`${BASE}/rest/v1/reports?select=deleted_at&limit=1`, { headers: H })
ok('0026 applied (reports.deleted_at)', col.status === 200,
  col.status === 200 ? 'column exists' : 'NOT applied yet')

// 1b. 0028 applied? The DB Records card and the queue print
//     created_by_name; without the column every select asking for it
//     400s and both fall back to the old (nameless) behaviour.
const col28 = await fetch(`${BASE}/rest/v1/reports?select=created_by_name&limit=1`, { headers: H })
ok('0028 applied (reports.created_by_name)', col28.status === 200,
  col28.status === 200 ? 'column exists' : 'NOT applied yet')

const spec = await (await fetch(`${BASE}/rest/v1/`, { headers: H })).json().catch(() => ({}))
const rpcs = Object.keys(spec.paths || {})
ok('ent_deleted_reports() exists', rpcs.includes('/rpc/ent_deleted_reports'))
ok('my_secretaries() exists (0027)', rpcs.includes('/rpc/my_secretaries'))

// 2. Edge Functions live?
for (const fn of ['auth-admin', 'patient-photos']) {
  const h = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'health' })
  })
  const b = await h.json().catch(() => ({}))
  ok(fn + ' responds', h.status === 200 && b.ok === true,
    'HTTP ' + h.status + ' schema=' + b.schema)
}

// 3. the DELETE action is in the LIVE function, not just the local bundle
const unauth = await fetch(`${BASE}/functions/v1/auth-admin`, {
  method: 'POST',
  headers: { apikey: ANON, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete', id: 'x', password: 'y' })
})
const ub = await unauth.json().catch(() => ({}))
ok('live function refuses an unauthenticated delete',
  unauth.status === 401 || /Authentication required/i.test(ub.error || ''),
  'HTTP ' + unauth.status)

// 4. data intact
// clinic_id and username must be SELECTED, not just id and role. Without them
// the orphan check below compared undefined against real ids and reported every
// single person as stranded - a check that fails loudly about nothing is worse
// than no check, because it trains you to ignore it.
const rep = await (await fetch(`${BASE}/rest/v1/reports?select=id&limit=5000`, { headers: H })).json()
const st = await (await fetch(`${BASE}/rest/v1/staff_profiles?select=id,username,role,clinic_id,is_active`, { headers: H })).json()
const cl = await (await fetch(`${BASE}/rest/v1/clinics?select=id,name,managed_by`, { headers: H })).json()
ok('reports intact', Array.isArray(rep) && rep.length >= 30, (rep || []).length + ' rows')
ok('staff intact', Array.isArray(st) && st.length >= 14, (st || []).length + ' rows')
if (!Array.isArray(cl)) ok('clinics readable', false, JSON.stringify(cl).slice(0, 120))
// Compare with String() on both sides. An earlier version compared the raw
// values and reported 14 orphans, all named "," - the ids came back with
// different shapes from the two queries, so every join failed. It read as a
// catastrophic data problem and it was nothing of the kind.
const ids = new Set((cl || []).map(c => String(c.id)))
const orphan = (st || []).filter(s => !ids.has(String(s.clinic_id)))
ok('no staff points at a missing clinic', orphan.length === 0,
  orphan.length ? orphan.map(s => s.username + ' -> ' + s.clinic_id).join(', ') : 'all ' + st.length + ' resolve')
const admin = (st || []).find(s => s.role === 'admin' && s.is_active !== false)
ok('an active admin exists', !!admin, admin ? 'yes' : 'NONE - locked out')

console.log('\n' + (fail ? '==== ' + fail + ' ITEM(S) NOT READY ====' : '==== READY TO DEPLOY ====') + '\n')
process.exit(fail ? 1 : 0)