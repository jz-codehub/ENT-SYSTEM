import { readFileSync } from 'node:fs'
const d = 'supabase-v2/backup/v2-2026-10-11T23-44-19-717Z'
const staff = JSON.parse(readFileSync(d + '/staff_profiles.json', 'utf8'))
const keep = staff.filter(s => !['testdoc1', 'testadmin', 'bokskie'].includes(s.username))
for (const s of keep) console.log([s.username, `"${s.full_name}"`, s.role, s.username + '123', s.role === 'secretary' ? '(needs doctor)' : ''].join(' '))
