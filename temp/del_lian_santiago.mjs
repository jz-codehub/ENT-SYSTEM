import fs from 'node:fs'
const env = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const BASE = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
async function call(p, o = {}) {
  const r = await fetch(BASE + p, { ...o, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(o.headers || {}) } })
  const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch {}
  return { s: r.status, j, t: t.slice(0, 200) }
}
// 1. who is lian-Santiago?
const prof = await call('/rest/v1/staff_profiles?username=eq.lian&select=id,username,full_name,role')
console.log('LIAN ROW:', prof.s, JSON.stringify(prof.j))
const id = prof.j?.[0]?.id
if (!id) { console.log('no lian row — nothing to delete'); process.exit(0) }
// 2. clear any secretary_assignments first (FK safety)
const del1 = await call('/rest/v1/secretary_assignments?secretary_id=eq.' + id, { method: 'DELETE' })
console.log('assignments cleared:', del1.s)
// 3. delete the auth user (staff_profiles cascades)
const del2 = await call('/auth/v1/admin/users/' + id, { method: 'DELETE' })
console.log('auth delete:', del2.s, del2.t)
// 4. verify
const v = await call('/rest/v1/staff_profiles?username=eq.lian&select=id')
console.log('verify gone:', v.s, JSON.stringify(v.j))
