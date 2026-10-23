/* =====================================================================
   verify_deploy.mjs  -  "is this actually serving?"
   ---------------------------------------------------------------------
   Why this exists.

   Every other check in this folder runs from Node. Node never performs a
   CORS preflight, so the suite can report the Edge Functions as perfectly
   healthy while a browser cannot reach them at all.

   That is not hypothetical. auth-admin answered POST with 200 and its
   list, while its OPTIONS returned 500 - so every real browser dropped the
   request, the staff list never loaded, and the ticket panel called live
   colleagues "Removed account". Every test passed the whole time.

   So this checks the preflight, the origins, and the database, in one
   place, and prints a single verdict with the next thing to do.

     node verify_deploy.mjs
     node verify_deploy.mjs https://yourname.github.io     # check that origin too
   ===================================================================== */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

function loadEnv() {
  const env = {}
  try {
    for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch (e) {
    console.error('  .env.local not found in supabase-v2/scripts/')
  }
  return env
}

const env = loadEnv()
const BASE = String(env.SUPABASE_URL || '').replace(/\/+$/, '')
const ANON = env.SUPABASE_ANON_KEY

let failures = 0
const say = (s) => console.log(s)

function ok(label, detail) { say('  PASS  ' + label.padEnd(46) + (detail || '')) }
function bad(label, detail) { failures++; say('  FAIL  ' + label.padEnd(46) + (detail || '')) }

function check(cond, label, detail, fix) {
  if (cond) ok(label, detail)
  else bad(label, (detail || '') + (fix ? '   -> ' + fix : ''))
}

console.log('\n============ DEPLOY VERIFICATION ============\n')

if (!BASE || !ANON) {
  console.error('  SUPABASE_URL / SUPABASE_ANON_KEY missing from .env.local')
  process.exit(1)
}
say('  project: ' + BASE.replace('https://', ''))

/* ---- 1. the browser's view: preflight per origin ------------------ */
const origins = ['http://localhost:5500', 'http://127.0.0.1:5500', ...process.argv.slice(2)]

say('\n  -- CORS preflight (what a browser does first) --')
const preflight = {}
for (const origin of origins) {
  const r = await fetch(BASE + '/functions/v1/auth-admin', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,apikey',
      apikey: ANON,
    },
  })
  const allow = r.headers.get('access-control-allow-origin')
  preflight[origin] = { status: r.status, allow }
  check(r.status === 204, 'preflight ' + origin, 'HTTP ' + r.status,
    r.status === 500 ? 'the deployed bundle is stale - redeploy dist/auth-admin.bundle.ts'
      : 'unexpected status')
  check(!!allow, 'origin allowed ' + origin, allow || 'no Access-Control-Allow-Origin',
    'supabase secrets set ENT_ALLOWED_ORIGIN=<your origins>')
}

/* ---- 2. a real signed-in call ------------------------------------- */
say('\n  -- signed-in call --')
let token = null
if (env.LIVE_TESTADMIN && env.LIVE_TESTADMIN_PW) {
  const r = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.LIVE_TESTADMIN, password: env.LIVE_TESTADMIN_PW }),
  })
  const j = await r.json().catch(() => ({}))
  token = j.access_token || null
  check(!!token, 'admin can sign in', token ? 'ok' : 'failed',
    'set LIVE_TESTADMIN / LIVE_TESTADMIN_PW in .env.local')
} else {
  say('  SKIP  admin sign-in            (no LIVE_TESTADMIN in .env.local)')
}

if (token) {
  const H = { apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }

  const r = await fetch(BASE + '/functions/v1/auth-admin', {
    method: 'POST', headers: H, body: JSON.stringify({ action: 'list' }),
  })
  const j = await r.json().catch(() => ({}))
  const n = Array.isArray(j.users) ? j.users.length : 0
  check(r.status === 200 && n > 0, 'auth-admin returns the staff list',
    r.status === 200 ? n + ' users' : 'HTTP ' + r.status,
    r.status === 500 ? 'check SUPABASE_SERVICE_ROLE_KEY is set as an Edge Function secret' : '')

  for (const [name, rpc] of [
    ['admin_db_usage (0014)', 'admin_db_usage'],
    ['my_assigned_doctor_name (0015)', 'my_assigned_doctor_name'],
    ['my_secretaries (0027)', 'my_secretaries'],
  ]) {
    const rr = await fetch(BASE + '/rest/v1/rpc/' + rpc, { method: 'POST', headers: H, body: '{}' })
    check(rr.status === 200, name, 'HTTP ' + rr.status,
      'run that migration in the SQL Editor')
  }
}

/* ---- 3. verdict --------------------------------------------------- */
console.log('\n  --------------------------------------------')
if (failures === 0) {
  say('   ALL DEPLOY CHECKS PASSED')
  say('   The app will work from every origin listed above.')
} else {
  say('   ' + failures + ' PROBLEM(S) FOUND')
  say('   Fix the FAIL lines above, then run this again.')
}
console.log('  --------------------------------------------\n')

process.exitCode = failures ? 1 : 0