#!/usr/bin/env node
/* =====================================================================
 *  smoke_test.mjs — "is the v2 backend actually up there, and is it
 *  answering the way the code says it should?"
 *
 *  Run this right after deploying the two functions, BEFORE wiring the
 *  frontend. It needs no browser and no frontend code.
 *
 *      node smoke_test.mjs
 *      node smoke_test.mjs --email testdoc1@zztest.invalid --password 'Zz!...'
 *
 *  What each check proves is written next to it. A FAIL here means the
 *  problem is in the deployment (secrets, Verify JWT, a missing migration),
 *  not in the SQL logic — fix it before spending time on 06-TEST-PLAN.md.
 * =================================================================== */
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : null
}

function loadEnv(file) {
  const path = join(HERE, file)
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = { ...loadEnv('.env.local'), ...process.env }
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const ANON = env.SUPABASE_ANON_KEY || ''
const EMAIL = arg('--email') || env.TEST_EMAIL || ''
const PASSWORD = arg('--password') || env.TEST_PASSWORD || ''

if (!BASE || !ANON) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required.')
  console.error('Create supabase-v2/scripts/.env.local with SUPABASE_URL and SUPABASE_ANON_KEY pointing at the NEW project, then run again.')
  process.exit(1)
}

let passed = 0, failed = 0, skipped = 0
function check(id, ok, what, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${what}`)
  if (detail) console.log(`         ${String(detail).slice(0, 160)}`)
  ok ? passed++ : failed++
}
function skip(id, what, why) {
  console.log(`  --    ${id.padEnd(6)} ${what}  (${why})`)
  skipped++
}

async function post(fnName, body, token) {
  const res = await fetch(`${BASE}/functions/v1/${fnName}`, {
    method: 'POST',
    // The anon key is deliberate: a smoke test must not need the service key,
    // and CRED-03 asserts nothing but these two values reaches a browser.
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token || ANON}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* plain text */ }
  return { status: res.status, json, text }
}

/* ------------------------------------------------------------------- */
async function main() {
  console.log(`\n==== V2 SMOKE TEST ====  ${BASE}\n`)

  /* 1 · deployed at all, and is it the v2 code? --------------------- */
  for (const svc of ['auth-admin', 'patient-photos']) {
    const r = await post(svc, { action: 'health' })
    const ok = r.status === 200 && r.json?.ok === true && r.json?.schema === 'v2'
    check('SMK-1', ok, `${svc} responds to health and reports schema v2`,
      `HTTP ${r.status} ${r.text}`)
  }

  /* 2 · Verify JWT = OFF, and the function does the rejecting ------- */
  /*  The anon key is itself a valid JWT. If Supabase's own JWT check
   *  were ON, the gateway would answer 401 with ITS body and the
   *  function would never run. Getting our own JSON back is the proof
   *  that requireUser() — not the platform — made the decision.      */
  {
    const r = await post('auth-admin', { action: 'capabilities' })
    const ours = /Authentication required/.test(r.text || '')
    check('SMK-2', r.status === 401 && ours,
      'unauthenticated capabilities refused BY THE FUNCTION (Verify JWT = OFF)',
      ours ? `HTTP ${r.status} ${r.text}`
        : `HTTP ${r.status} ${r.text} — if that body is not our JSON, set Verify JWT OFF for this function: Dashboard → Edge Functions`)
  }

  /* 3 · a real sign-in, then the flags a client is allowed to see --- */
  if (!EMAIL || !PASSWORD) {
    skip('SMK-3', 'password sign-in returns a token',
      'pass --email and --password from create_test_accounts.mjs output')
    skip('SMK-4', 'capabilities reflects system_flags', 'needs a session')
  } else {
    const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    const body = await res.json().catch(() => ({}))
    if (res.status !== 200 || !body.access_token) {
      check('SMK-3', false, 'password sign-in returns an access token',
        `HTTP ${res.status} ${JSON.stringify(body)}`)
      skip('SMK-4', 'capabilities reflect system_flags', 'no session')
    } else {
      check('SMK-3', true, 'password sign-in returns an access token',
        `token_type=${body.token_type} expires_in=${body.expires_in}`)

      /*  Fresh test accounts carry must_change_password = true, so the
       *  expected answer is 403 PASSWORD_CHANGE_REQUIRED — that is a
       *  PASS: the gate in _shared/auth.ts fired. After the password is
       *  changed it must become 200 with photo_storage false.         */
      const c = await post('auth-admin', { action: 'capabilities' }, body.access_token)
      const changeRequired = c.status === 403 && c.json?.code === 'PASSWORD_CHANGE_REQUIRED'
      const caps = c.status === 200 && c.json?.ok === true ? c.json?.capabilities : null
      check('SMK-4', Boolean(caps) || changeRequired,
        'capabilities answers for a signed-in staff account',
        changeRequired
          ? 'HTTP 403 PASSWORD_CHANGE_REQUIRED — expected for a fresh account; change the password to get 200'
          : `HTTP ${c.status} ${c.text}`)
      if (caps) {
        console.log(`         photo_storage=${caps.photo_storage}` +
          ` cloud_reports_read=${caps.cloud_reports_read}` +
          ` cloud_reports_write=${caps.cloud_reports_write}`)
        if (caps.photo_storage !== false) {
          console.log('         NOTE: photo_storage is ON. Keep it OFF until every STORAGE-* test passes.')
        }
      }
    }
  }

  console.log(`\n==== ${failed ? `${failed} FAILED` : 'SMOKE PASSED'} — ${passed} passed, ${failed} failed, ${skipped} skipped ====`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\nrequest failed:', err.message)
  console.error('Is the URL right, and is the project awake? (free projects pause after inactivity)')
  process.exit(1)
})

