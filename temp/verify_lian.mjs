import fs from 'node:fs'
const env = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const BASE = env.SUPABASE_URL, ANON = env.SUPABASE_ANON_KEY
const r = await fetch(BASE + '/auth/v1/token?grant_type=password', {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123' }),
})
console.log('lian login:', r.status, (await r.text()).slice(0, 120))
const r2 = await fetch(BASE + '/auth/v1/token?grant_type=password', {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lilian@zztest.invalid', password: 'lian123' }),
})
console.log('old lilian email login (should fail):', r2.status)
