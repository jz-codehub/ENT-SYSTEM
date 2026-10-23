/* The preflight fails while the real POST carries the correct ACAO. That
 * is the signature of Supabase's own JWT gate, not of our CORS code: with
 * "Verify JWT" left ON, the platform answers (or rejects) the preflight
 * itself, before the function body ever runs. A browser never gets an
 * Access-Control-Allow-Origin header back, so it refuses to send the real
 * request at all â€” and reports "Failed to fetch".
 *
 * Node skips the preflight entirely, which is why every other check here
 * reported the function as healthy.
 *
 * Read-only. Confirms the cause, and prints the fix.
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
const FN = BASE + '/functions/v1/auth-admin'
const ORIGIN = env.ENT_ALLOWED_ORIGIN || 'http://localhost:5500'

const token = (await (await fetch(BASE + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.LIVE_TESTADMIN, password: env.LIVE_TESTADMIN_PW }),
  signal: AbortSignal.timeout(15000),
})).json()).access_token

console.log('\n==== IS THE GATEWAY (Verify JWT) KILLING THE PREFLIGHT? ====\n')

async function preflight(label, extraHeaders) {
  try {
    const r = await fetch(FN, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,apikey',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15000),
    })
    const acao = r.headers.get('access-control-allow-origin')
    console.log('  ' + label.padEnd(34) + 'HTTP ' + String(r.status).padEnd(5) +
      'ACAO=' + (acao === null ? 'ABSENT  <-- browser blocks' : acao))
    return { status: r.status, acao: acao }
  } catch (e) {
    console.log('  ' + label.padEnd(34) + 'NETWORK ERROR: ' + e.message)
    return { status: 0, acao: null }
  }
}

const bare = await preflight('preflight, no Authorization', {})
const withJwt = await preflight('preflight, WITH a valid JWT', { Authorization: 'Bearer ' + token })

// And what the browser's preflight never carries: apikey only.
const withKey = await preflight('preflight, apikey only', { apikey: ANON })

console.log('')
const gatewayBlocking = bare.status === 401 || bare.status === 403 ||
  (withJwt.acao !== null && bare.acao === null)
if (gatewayBlocking) {
  console.log('  DIAGNOSIS: the platform is rejecting the preflight before the')
  console.log('  function runs. A preflight cannot carry a user JWT, so this is')
  console.log('  Supabase\'s "Verify JWT" gate, which must be OFF for these')
  console.log('  functions â€” they do their own auth via requireUser()/requireAdmin().')
  console.log('')
  console.log('  FIX (both functions):')
  console.log('    supabase functions deploy auth-admin --no-verify-jwt')
  console.log('    supabase functions deploy patient-photos --no-verify-jwt')
  console.log('')
  console.log('  Or in the dashboard: Edge Functions -> auth-admin -> Settings ->')
  console.log('  "Verify JWT" -> OFF.')
} else {
  console.log('  The preflight is answered but carries no ACAO. Our cors() only')
  console.log('  sets the header for an allowlisted origin, so ENT_ALLOWED_ORIGIN')
  console.log('  on the deployed function probably does not contain: ' + ORIGIN)
  console.log('')
  console.log('  FIX: supabase secrets set ENT_ALLOWED_ORIGIN=' + ORIGIN)
}
console.log('')

