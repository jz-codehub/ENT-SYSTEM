/* temp/probe_rls.mjs — verify the ROOT CAUSE:
   the 0037 trigger's `SELECT d.clinic_id FROM staff_profiles d WHERE d.id=<doctor>`
   runs as the secretary and is blocked by RLS, so keep_clinic is NULL. */
import fs from 'node:fs'
const e = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) e[m[1]] = m[2]
}
const B = e.SUPABASE_URL, K = e.SUPABASE_SERVICE_ROLE_KEY, AK = e.SUPABASE_ANON_KEY
const SR = { apikey: K, Authorization: `Bearer ${K}` }
const t = await fetch(`${B}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: AK, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123' })
}).then(r => r.json()).catch(() => null)
const AH = { apikey: AK, Authorization: `Bearer ${t.access_token}` }
const DOC = '856dc35f-a3f3-41d6-b7cd-57da8c3763c6' // jess, lian's assigned doctor

// TEST 1: can lian (RLS) read her assigned doctor's staff_profiles row?
const asLian = await fetch(`${B}/rest/v1/staff_profiles?select=id,username,clinic_id&id=eq.${DOC}`, { headers: AH }).then(r => r.json())
console.log('LIAN reads doctor row (RLS):', JSON.stringify(asLian))

// TEST 2: same read as service_role (bypasses RLS) — should show the row
const asSR = await fetch(`${B}/rest/v1/staff_profiles?select=id,username,clinic_id&id=eq.${DOC}`, { headers: SR }).then(r => r.json())
console.log('SERVICE reads doctor row   :', JSON.stringify(asSR))

// TEST 3: does ent_is_my_doctor agree for lian?
const imd = await fetch(`${B}/rest/v1/rpc/ent_is_my_doctor`, {
  method: 'POST', headers: { ...AH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_doctor: DOC })
}).then(async r => [r.status, await r.json().catch(() => null)])
console.log('ent_is_my_doctor(jess) as lian:', imd[0], JSON.stringify(imd[1]))
console.log('DONE')
