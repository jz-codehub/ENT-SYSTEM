import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const FN = env.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/auth-admin'
const ORIGIN = env.ENT_ALLOWED_ORIGIN || 'http://localhost:5500'
console.log('\n==== IS THE FIX LIVE YET? ====\n')
const r = await fetch(FN, { method: 'OPTIONS', headers: {
  Origin: ORIGIN,
  'Access-Control-Request-Method': 'POST',
  'Access-Control-Request-Headers': 'authorization,content-type,apikey',
}, signal: AbortSignal.timeout(15000) })
const acao = r.headers.get('access-control-allow-origin')
console.log('  preflight status : HTTP ' + r.status)
console.log('  ACAO            : ' + (acao === null ? 'ABSENT' : acao))
console.log('')
if (r.status === 204 && acao === ORIGIN) {
  console.log('  READY. The browser can call the function. Open:')
  console.log('    http://localhost:5500/pages/login.html')
} else {
  console.log('  NOT DEPLOYED YET. The old bundle is still live, so the browser')
  console.log('  will keep getting "Failed to fetch" no matter what else you fix.')
  console.log('')
  console.log('  Do this, in the Supabase dashboard:')
  console.log('    Edge Functions -> auth-admin -> Edit -> delete all -> paste')
  console.log('    supabase-v2/dist/auth-admin.bundle.ts -> Deploy')
  console.log('    (Verify JWT must stay OFF)')
  console.log('    Do the same for patient-photos.')
  console.log('')
  console.log('  Then re-run this script; it should print READY.')
}
console.log('')
