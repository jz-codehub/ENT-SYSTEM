/* temp/probe_worker.mjs - READ-ONLY check for workers.dev origin + live site */
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync(new URL('../supabase-v2/scripts/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')
const ORIGIN = 'https://ent-system.johnzynd.workers.dev'
console.log('origin under test:', ORIGIN)
for (const f of ['auth-admin', 'patient-photos']) {
  const r = await fetch(`${URL0}/functions/v1/${f}`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info' }
  })
  console.log(`${f} OPTIONS status=${r.status} ACAO=${r.headers.get('access-control-allow-origin')}`)
}
for (const p of ['/', '/pages/login.html', '/sw.js']) {
  try {
    const r = await fetch(ORIGIN + p)
    const t = await r.text()
    const cache = p === '/sw.js' ? (t.match(/const CACHE_NAME\s*=\s*['"]([^'"]+)['"]/) || [])[1] : undefined
    console.log(`${p} -> ${r.status} len=${t.length}${cache ? ' CACHE=' + cache : ''}`)
  } catch (e) { console.log(`${p} FAILED: ${e.message}`) }
}
console.log('done.')
