import fs from 'fs';
const env = {};
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2];
}
(async () => {
  const h = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };
  const B = env.SUPABASE_URL;
  // 1. ALL staff
  let r = await fetch(B + '/rest/v1/staff_profiles?select=username,full_name,role,is_active,assigned_doctor_id&order=username', { headers: h });
  console.log('ALL STAFF:', r.status, await r.text());
  // 2. doctors list (for Jesus Jardin id)
  r = await fetch(B + '/rest/v1/staff_profiles?select=id,username,full_name&role=eq.doctor', { headers: h });
  console.log('DOCTORS:', r.status, await r.text());
  // 3. reports count by created_by for the two lians
  const ids = { lilian: 'd6d300b9-af32-46bd-b17c-b81dde950598' };
  // get lian Santiago id first
  r = await fetch(B + '/rest/v1/staff_profiles?select=id,username&username=eq.lian', { headers: h });
  const lj = await r.json();
  console.log('lian Santiago id:', JSON.stringify(lj));
  const lianId = lj[0]?.id;
  for (const [name, id] of [['lilian-Tapongot', ids.lilian], ['lian-Santiago', lianId]]) {
    r = await fetch(B + `/rest/v1/reports?select=id&created_by=eq.${id}`, { headers: { ...h, Prefer: 'count=exact' } });
    const txt = await r.text();
    console.log(`reports by ${name} (${id}):`, r.status, 'count-range:', r.headers.get('content-range'), 'len:', txt.length);
  }
  // 4. auth users emails
  r = await fetch(B + '/auth/v1/admin/users', { headers: h });
  const j = await r.json();
  const users = j.users || [];
  console.log('AUTH USERS:', users.map(u => u.email).join(', '));
})();


