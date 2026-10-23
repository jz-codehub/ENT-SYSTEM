/* temp/audit_live6.mjs - READ-ONLY final CORS verification.
   1. an ALLOWED origin must get ACAO on OPTIONS AND on a real POST
   2. a FOREIGN origin must get NO ACAO (the allowlist must refuse)
   3. the real admin call shape (POST with session-less service ping) works */
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync(new URL('../supabase-v2/scripts/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')
const H = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
const ALLOWED = env.ENT_ALLOWED_ORIGIN
const FOREIGN = 'https://evil.example.com'

for (const fn of ['auth-admin', 'patient-photos']) {
  console.log(`\n===== ${fn} =====`)
  for (const [label, origin] of [['ALLOWED', ALLOWED], ['FOREIGN ', FOREIGN]]) {
    const opt = await fetch(`${URL0}/functions/v1/${fn}`, {
      method: 'OPTIONS', headers: {
        Origin: origin, 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info'
      }
    })
    const acao = opt.headers.get('access-control-allow-origin')
    console.log(`  ${label} OPTIONS -> ${opt.status}  ACAO=${acao === null ? 'ABSENT (refused - correct)' : acao}`)

    const post = await fetch(`${URL0}/functions/v1/${fn}`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({})
    })
    const pacao = post.headers.get('access-control-allow-origin')
    console.log(`  ${label} POST    -> ${post.status}  ACAO=${pacao === null ? 'ABSENT (refused - correct)' : pacao}`)
    if (label === 'ALLOWED') console.log(`            body: ${(await post.text()).slice(0, 160)}`)
  }
}
console.log('\ndone.\n')
