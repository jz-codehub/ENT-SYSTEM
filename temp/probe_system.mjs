/* temp/probe_system.mjs - READ-ONLY health probe of the LIVE v2 project.
   Nothing is written. Uses the BROWSER-SAFE anon key from supabaseClient.js,
   exactly like a signed-out browser would. */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../function/supabaseClient.js', import.meta.url), 'utf8')
const REF = /PROJECT_REF\s*=\s*'([^']+)'/.exec(src)[1]
const ANON = /ANON_KEY\s*=\s*'([^']+)'/.exec(src)[1]
const BASE = `https://${REF}.supabase.co`
console.log(`project: ${REF}`)

const H = { apikey: ANON, Authorization: `Bearer ${ANON}` }

async function hit(label, url, headers = H, method = 'GET') {
  try {
    const res = await fetch(url, { method, headers })
    const text = await res.text()
    console.log(`\n[${label}] ${method} ${url.replace(BASE, '')} -> HTTP ${res.status}`)
    console.log('   ACAO:', res.headers.get('access-control-allow-origin') || 'ABSENT')
    console.log('   body :', text.slice(0, 400).replace(/\s+/g, ' '))
  } catch (e) {
    console.log(`\n[${label}] FETCH ERROR: ${e.message}`)
  }
}

await hit('rest root (OpenAPI)', `${BASE}/rest/v1/`)
await hit('reports as anon (RLS must REFUSE)', `${BASE}/rest/v1/reports?select=id&limit=1`)
await hit('staff_profiles as anon (must REFUSE)', `${BASE}/rest/v1/staff_profiles?select=id&limit=1`)
await hit('auth health', `${BASE}/auth/v1/health`)
await hit('auth-admin OPTIONS (CORS preflight)', `${BASE}/functions/v1/auth-admin`, {
  Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST',
  'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info'
}, 'OPTIONS')
await hit('patient-photos OPTIONS (CORS preflight)', `${BASE}/functions/v1/patient-photos`, {
  Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST',
  'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info'
}, 'OPTIONS')

/* Does PostgREST accept a chained json select (payload->formData->>key)?
   RLS refuses anon either way, but a MALFORMED select is rejected by the
   PARSER before RLS, so the status code still answers the question. */
await hit('chained json select', `${BASE}/rest/v1/reports?select=id,payload->formData->>preOpDiagnosis&limit=1`)
await hit('single json select', `${BASE}/rest/v1/reports?select=id,payload->>dbSaved&limit=1`)
await hit('garbage column', `${BASE}/rest/v1/reports?select=id,zzz_not_a_column&limit=1`)
