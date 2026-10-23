/* =====================================================================
 *  verify_origin.mjs — "tama ba ang origin na ipapadala ng browser?"
 * ---------------------------------------------------------------------
 *  ISANG command ang sumasagot ng lahat bago ka mag-dashboard:
 *
 *      node verify_origin.mjs
 *
 *  Ginagawa nito (read-only, walang binabago):
 *    1. Binabasa ang gist ng ORIGIN mula sa isang tunay na HTML page
 *       ayon sa iyong Cloudflare URL, para eksakto ang sinusubukan.
 *    2. Nagpapadala ng CORS OPTIONS preflight sa Supabase auth-admin
 *       gamit ang EXACT Origin header (walang trailing slash — ganyan
 *       laging pinapadala ng browser).
 *    3. Nagpapakita kung ang sagot ay ang origin mo (READY) o ABSENT
 *       (kailangan pang i-set ang ENT_ALLOWED_ORIGIN secret), at kung
 *       hindi, ibinibigay ang eksaktong halaga na ilalagay sa dashboard.
 *
 *  Bakit hindi lang `verify_deploy.mjs`? Iyon ay localhost/127.0.0.1 lang
 *  maliban kung may CLI arg. Ito naman ang contradiction-checker para sa
 *  sitwasyon na "gumagana sa localhost, patay sa production".
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

// The production origin. CLI arg wins, then PRODUCTION_URL in .env.local,
// then a fixed default. NEVER add a trailing slash: the browser's Origin
// header never has one, and the comparison in _shared/auth.ts is exact.
const CLI_ORIGIN = process.argv[2] || ''
const PRODUCTION_URL =
  CLI_ORIGIN ||
  (env.PRODUCTION_URL || '').replace(/\/+$/, '') ||
  'https://ent-system.johnzynd.workers.dev'

const BASE = String(env.SUPABASE_URL || '').replace(/\/+$/, '')
const FN = BASE + '/functions/v1/auth-admin'

console.log('\n============ ORIGIN CHECK ============\n')
console.log('  site origin : ' + PRODUCTION_URL)
if (/\s|\/$/.test(PRODUCTION_URL)) {
  console.log('  WARNING: origin may whitespace o trailing slash. Ayusin muna.')
}

const r = await fetch(FN, {
  method: 'OPTIONS',
  headers: {
    Origin: PRODUCTION_URL,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,apikey',
  },
  signal: AbortSignal.timeout(20000),
})
const acao = r.headers.get('access-control-allow-origin')
console.log('  preflight   : HTTP ' + r.status)
console.log('  ACAO        : ' + (acao === null ? 'ABSENT' : acao))
console.log('')
if (r.status === 204 && acao === PRODUCTION_URL) {
  console.log('  READY. Ang browser ay makakatawag sa auth-admin.')
} else {
  const local = (env.ENT_ALLOWED_ORIGIN || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  console.log('  HINDI PA READY. I-set sa dashboard ang buong allowlist:')
  console.log('')
  console.log('    ENT_ALLOWED_ORIGIN=' + [...new Set([...local, PRODUCTION_URL])].join(','))
  console.log('')
  console.log('  Supabase Dashboard -> Project Settings -> Edge Functions -> Secrets.')
  console.log('  Pagkatapos, patakbuhin ulit ito pagkalipas ng ~1 minuto (cold start).')
  console.log('  Kung ABSENT pa rin, i-redeploy ang auth-admin (Verify JWT = OFF).')
}
console.log('')
