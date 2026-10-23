/* temp/audit_live4.mjs - READ-ONLY: which v2 objects are actually missing? */
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync(new URL('../supabase-v2/scripts/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }

console.log('\n===== staff_profiles columns =====')
{
  const res = await fetch(`${URL0}/rest/v1/staff_profiles?select=*&limit=1`, { headers: H })
  const j = await res.json()
  console.log(' ', Array.isArray(j) && j[0] ? Object.keys(j[0]).join(', ') : JSON.stringify(j).slice(0, 300))
}
console.log('\n===== does doctor_clinics exist? =====')
for (const t of ['doctor_clinics', 'secretary_assignments', 'report_access_grants', 'report_access_requests', 'tickets', 'ticket_messages', 'user_presence', 'clinic_settings']) {
  const res = await fetch(`${URL0}/rest/v1/${t}?select=*&limit=1`, { headers: H })
  console.log(`  ${t.padEnd(24)} HTTP ${res.status} ${res.ok ? '' : (await res.text()).slice(0, 90)}`)
}
console.log('\n===== clinic_settings rows (any) =====')
{
  const res = await fetch(`${URL0}/rest/v1/clinic_settings?select=*&limit=5`, { headers: H })
  console.log(' ', JSON.stringify(await res.json()).slice(0, 400))
}
console.log('\n===== tickets / access requests / presence counts =====')
for (const t of ['tickets', 'ticket_messages', 'report_access_requests', 'report_access_grants', 'user_presence']) {
  const res = await fetch(`${URL0}/rest/v1/${t}?select=id`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact' } })
  console.log(`  ${t.padEnd(26)}: ${(res.headers.get('content-range') || 'n/a')}`)
}
console.log('\ndone.\n')
