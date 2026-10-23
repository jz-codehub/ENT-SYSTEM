import { readFileSync, writeFileSync } from 'node:fs'
const d = 'supabase-v2/backup/v2-2026-10-11T23-44-19-717Z'
const a = JSON.parse(readFileSync(d + '/auth_users.json', 'utf8'))
console.log('total: ' + a.length)
for (const u of a) console.log((u.email || '').padEnd(26) + ' enc_pw=' + (u.encrypted_password ? u.encrypted_password.slice(0, 12) + '...' : 'NULL') + ' provider=' + (u.app_metadata?.provider || u.raw_app_meta_data?.provider || '?'))
