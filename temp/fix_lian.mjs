/* temp/fix_lian.mjs — SURGICAL FIX (service_role, server-side only).
   1. Delete staff 'lian' (Lian Santiago, 0 reports, no assignments — verified).
   2. Rename 'lilian' (Lilian Tapongot, 52 reports) -> username 'lian', password 'lian123'.
   Assignment + clinic_id untouched, so her 52 reports stay visible.
   Run from repo root: node temp/fix_lian.mjs            <-- DRY RUN
                        node temp/fix_lian.mjs --go       <-- APPLY */
import fs from 'node:fs'

const GO = process.argv.includes('--go')
const env = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*(.+?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const BASE = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const call = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, { headers: H, ...o })
  let b = null; try { b = await r.json() } catch {}
  return { s: r.status, b }
}

const LIAN_ID = 'd17b6938-835b-413c-992a-ea35a106cdf8'       // Lian Santiago (delete)
const LILIAN_ID = 'd6d300b9-af32-46bd-b17c-b81dde950598'     // Lilian Tapongot (rename -> lian)

// --- pre-checks ---
const lian = await call(`/rest/v1/staff_profiles?select=id,username,full_name,role,clinic_id,assigned_doctor_id&id=eq.${LIAN_ID}`)
const lil = await call(`/rest/v1/staff_profiles?select=id,username,full_name,role,clinic_id,assigned_doctor_id&id=eq.${LILIAN_ID}`)
const lianAssign = await call(`/rest/v1/secretary_assignments?select=id&secretary_id=eq.${LIAN_ID}`)
const lilianAssign = await call(`/rest/v1/secretary_assignments?select=id&secretary_id=eq.${LILIAN_ID}`)
const lianRep = await call(`/rest/v1/reports?select=id&created_by=eq.${LIAN_ID}&limit=1`)
const lilianRep = await call(`/rest/v1/reports?select=id&created_by=eq.${LILIAN_ID}&limit=1`)
console.log('lian profile:', JSON.stringify(lian.b))
console.log('lilian profile:', JSON.stringify(lil.b))
console.log('lian assignments:', Array.isArray(lianAssign.b) ? lianAssign.b.length : lianAssign.s,
  '| lilian assignments:', Array.isArray(lilianAssign.b) ? lilianAssign.b.length : lilianAssign.s)
const cr = h => { const m = (h['content-range'] || '').match(/\/(\d+)/); return m ? m[1] : '?' }
console.log('reports created_by lian:', cr(Object.fromEntries([...[]])) , '| (range check below)')
console.log('  lian sample:', lianRep.s, 'len:', Array.isArray(lianRep.b) ? lianRep.b.length : '?')
console.log('  lilian sample:', lilianRep.s, 'len:', Array.isArray(lilianRep.b) ? lilianRep.b.length : '?')

if (!GO) { console.log('\nDRY RUN — add --go to apply.'); process.exit(0) }

// --- 1. delete lian (auth user; staff_profiles cascades) ---
console.log('\n--- STEP 1: delete auth user lian ---')
const del = await call(`/auth/v1/admin/users/${LIAN_ID}`, { method: 'DELETE' })
console.log('deleteUser lian:', del.s, JSON.stringify(del.b)?.slice(0, 200))
const staffAfter = await call(`/rest/v1/staff_profiles?select=id&id=eq.${LIAN_ID}`)
console.log('staff row after:', staffAfter.s, JSON.stringify(staffAfter.b))

// --- 2. rename lilian -> lian (username only; id/clinic/assignment untouched) ---
console.log('\n--- STEP 2: rename lilian -> lian ---')
const ren = await call(`/rest/v1/staff_profiles?id=eq.${LILIAN_ID}`, {
  method: 'PATCH', body: JSON.stringify({ username: 'lian', full_name: 'Lilian Tapongot' }),
})
console.log('rename staff:', ren.s, JSON.stringify(ren.b)?.slice(0, 200))

// --- 3. fix auth email lilian@ -> lian@, set password lian123 ---
console.log('\n--- STEP 3: auth email + password ---')
const upd = await call(`/auth/v1/admin/users/${LILIAN_ID}`, {
  method: 'PUT', body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123', email_confirm: true }),
})
console.log('auth update:', upd.s, JSON.stringify(upd.b)?.slice(0, 300))

// --- verify ---
console.log('\n--- VERIFY ---')
const v = await call(`/rest/v1/staff_profiles?select=id,username,full_name,role,clinic_id,assigned_doctor_id&id=eq.${LILIAN_ID}`)
console.log('final profile:', JSON.stringify(v.b))
const docs = await call(`/rest/v1/staff_profiles?select=id,username,full_name&id=eq.${(v.b?.[0]?.assigned_doctor_id) || 'none'}`)
console.log('assigned doctor:', JSON.stringify(docs.b))
const login = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: (env2 => env2)(env).SUPABASE_URL && (() => { try { const e2 = {}; for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split('\n')) { const m = l.match(/^\s*SUPABASE_ANON_KEY\s*=\s*(.+?)\s*$/); if (m) e2.k = m[1] } return e2.k } catch { return '' } })(), 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123' }),
}).then(async r => ({ s: r.status, b: await r.json().catch(() => null) })).catch(e => ({ s: 'ERR', b: String(e) }))
console.log('login lian/lian123:', login.s, login.b?.user ? 'TOKEN OK role=' + login.b.user.user_metadata?.role : JSON.stringify(login.b)?.slice(0, 200))
console.log('\nDONE.')
