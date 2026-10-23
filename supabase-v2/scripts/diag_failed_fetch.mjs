/* Why does the browser say "Failed to fetch" when admin.js posts to
 * auth-admin? That message is produced by the BROWSER, not the server, and
 * it means the request never produced a readable response at all --
 * connection refused, DNS failure, or a CORS rejection. The server never
 * even got to answer.
 *
 * The Edge Function enforces an Origin allowlist, so this walks the
 * realistic origins the app is served from and shows which ones the
 * browser would silently refuse. Read-only except for one throwaway
 * account, which is deleted at the end.
 */
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
const SVC = env.SUPABASE_SERVICE_ROLE_KEY
const AH = { apikey: ANON, 'Content-Type': 'application/json' }
const SH = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }
const FN = BASE + '/functions/v1/auth-admin'

const ORIGINS = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://localhost:5501',
  'https://localhost',
  'null',
]

console.log('\n==== WHY "Failed to fetch"? ====\n')
console.log('  ENT_ALLOWED_ORIGIN in .env.local : ' + (env.ENT_ALLOWED_ORIGIN || '(unset)'))
console.log('  function url                     : ' + FN + '\n')

/* ---- 1. is the function deployed at all? ------------------------- */
try {
  const h = await fetch(FN, {
    method: 'POST',
    headers: { ...AH, Origin: 'http://localhost:5500' },
    body: JSON.stringify({ action: 'health' }),
    signal: AbortSignal.timeout(15000),
  })
  const hj = await h.json().catch(() => ({}))
  console.log('  [1] deployed?  HTTP ' + h.status + '  ' + JSON.stringify(hj).slice(0, 90))
  if (h.status === 404) {
    console.log('      -> NOT DEPLOYED. Run: supabase functions deploy auth-admin')
  }
} catch (e) {
  console.log('  [1] deployed?  NETWORK ERROR: ' + e.message)
  console.log('      -> The whole function host is unreachable from here.')
  process.exit(1)
}

/* ---- 2. the CORS preflight, per origin ---------------------------- */
console.log('\n  [2] CORS preflight per origin (what the browser checks first):\n')
const verdicts = new Map()
for (const origin of ORIGINS) {
  let verdict, detail
  try {
    const r = await fetch(FN, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,apikey',
      },
      signal: AbortSignal.timeout(12000),
    })
    const acao = r.headers.get('access-control-allow-origin')
    verdict = acao ? 'ALLOWED' : 'BLOCKED'
    detail = 'acao=' + (acao === null ? 'absent' : acao)
  } catch (e) {
    verdict = 'ERROR'
    detail = e.message
  }
  verdicts.set(origin, verdict)
  console.log('    ' + verdict.padEnd(8) + origin.padEnd(28) + detail)
}

/* ---- 3. the real create call, from each origin -------------------- */
console.log('\n  [3] the actual create call, from each origin:\n')
const token = (await (await fetch(BASE + '/auth/v1/token?grant_type=password', {
  method: 'POST', headers: AH,
  body: JSON.stringify({ email: env.LIVE_TESTADMIN, password: env.LIVE_TESTADMIN_PW }),
  signal: AbortSignal.timeout(15000),
})).json()).access_token
if (!token) { console.log('  cannot sign in as testadmin; stopping.'); process.exit(1) }

const stamp = Date.now().toString().slice(-6)
const createdIds = []
for (const origin of ORIGINS) {
  const username = 'zzcors' + stamp + Math.random().toString(36).slice(2, 5)
  let verdict, detail
  try {
    const r = await fetch(FN, {
      method: 'POST',
      headers: { ...AH, Origin: origin, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: 'create', username, full_name: 'CORS PROBE', role: 'doctor', password: 'Zz!corsprobe1' }),
      signal: AbortSignal.timeout(15000),
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.ok) {
      verdict = 'CREATED'
      detail = 'id=' + j.id
      createdIds.push(j.id)
    } else if (r.status === 403 || /origin|forbidden/i.test(j.error || '')) {
      verdict = 'REFUSED'
      detail = 'HTTP ' + r.status + ' ' + (j.error || '')
    } else {
      verdict = 'ERROR'
      detail = 'HTTP ' + r.status + ' ' + (j.error || j.msg || '').slice(0, 50)
    }
  } catch (e) {
    verdict = 'NETWORK FAIL'
    detail = e.message + '   <-- the browser would show "Failed to fetch"'
  }
  console.log('    ' + verdict.padEnd(13) + origin.padEnd(28) + detail)
}

if (createdIds.length) {
  for (const id of createdIds) {
    await fetch(BASE + '/auth/v1/admin/users/' + id, { method: 'DELETE', headers: SH })
  }
  console.log('\n  cleaned up ' + createdIds.length + ' probe account(s)')
}
console.log('')
