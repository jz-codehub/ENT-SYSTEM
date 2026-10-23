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
  return { s: r.status, j, t: t.slice(0, 300) }
}
// 1. find lilian
const prof = await call('/rest/v1/staff_profiles?username=eq.lilian&select=id,username,full_name,role,assigned_doctor_id,is_active')
console.log('LILIAN:', prof.s, JSON.stringify(prof.j))
const row = prof.j?.[0]
if (!row) { console.log('no lilian row!'); process.exit(1) }
// 2. rename to lian + full name Lilian Tapongot (username unique now that Santiago is gone)
const upd = await call('/rest/v1/staff_profiles?id=eq.' + row.id, {
  method: 'PATCH', headers: { Prefer: 'return=representation' },
  body: JSON.stringify({ username: 'lian', full_name: 'Lilian Tapongot' }),
})
console.log('rename:', upd.s, JSON.stringify(upd.j)?.slice(0, 300))
// 3. auth: email lilian@ -> lian@ + password lian123
const au = await call('/auth/v1/admin/users/' + row.id, {
  method: 'PUT', body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123', email_confirm: true, user_metadata: { username: 'lian', full_name: 'Lilian Tapongot' } }),
})
console.log('auth:', au.s, au.t)
// 4. reports check — hers (created_by her id), doctor jess
const rep = await call('/rest/v1/reports?created_by=eq.' + row.id + '&select=id&limit=1')
console.log('her reports sample:', rep.s, rep.t.slice(0, 120))
const docs = await call('/rest/v1/staff_profiles?id=eq.' + row.assigned_doctor_id + '&select=username,full_name')
console.log('assigned doctor:', docs.s, JSON.stringify(docs.j))
