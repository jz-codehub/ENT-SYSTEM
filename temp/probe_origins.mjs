/* temp/probe_origins.mjs - READ-ONLY. Which origins does the DEPLOYED
   allowlist currently accept? Sends an OPTIONS preflight per candidate and
   reports the Access-Control-Allow-Origin answer. Nothing is written. */
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync(new URL('../supabase-v2/scripts/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')

const CANDIDATES = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://jz-codehub.github.io',
  'https://jz-codehub.github.io/ENT-SYSTEM',
  'https://ent-system.pages.dev',
  'https://entsystem.pages.dev',
  'https://ent-system.vercel.app',
  'https://ent-records.pages.dev',
  'https://entendoscopy.pages.dev',
  'https://ent-system.netlify.app',
]

console.log(`local .env.local ENT_ALLOWED_ORIGIN = ${env.ENT_ALLOWED_ORIGIN}`)
console.log('')
for (const origin of CANDIDATES) {
  const res = await fetch(`${URL0}/functions/v1/auth-admin`, {
    method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info'
    }
  })
  const acao = res.headers.get('access-control-allow-origin')
  console.log(`  ${acao ? 'ACCEPTED' : 'refused '}  ${origin.padEnd(42)} ACAO=${acao === null ? 'ABSENT' : acao}`)
}
console.log('\ndone.\n')
