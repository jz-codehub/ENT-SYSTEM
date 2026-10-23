/* temp/audit_live5.mjs - READ-ONLY: is the DEPLOYED edge function the fixed
   bundle (has CORS code) or the old one (no CORS code at all)? */
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync(new URL('../supabase-v2/scripts/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')

for (const fn of ['auth-admin', 'patient-photos']) {
  console.log(`\n===== ${fn} =====`)
  const res = await fetch(`${URL0}/functions/v1/${fn}`, {
    method: 'OPTIONS',
    headers: {
      Origin: env.ENT_ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info'
    }
  })
  console.log('  status', res.status)
  res.headers.forEach((v, k) => console.log('   ', k, '=', v))
}
console.log('\ndone.\n')
