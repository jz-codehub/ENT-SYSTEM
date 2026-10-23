// =====================================================================
//  classify_live_state.mjs — READ-ONLY. Reads the RAW SQL-Editor output
//  pasted into _live_paste.txt and classifies the live database state.
//
//  Nothing here writes anywhere. It reads one text file and prints.
//
//  Run: node supabase-v2/scripts/classify_live_state.mjs
// =====================================================================
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PASTE = join(HERE, '_live_paste.txt')
if (!existsSync(PASTE)) {
  console.error('Paste the SQL-Editor output into supabase-v2/scripts/_live_paste.txt first.')
  process.exit(1)
}
const raw = readFileSync(PASTE, 'utf8')
const flat = raw.replace(/\r/g, '').replace(/[ \t]+/g, ' ')

const out = []
const say = s => { out.push(s); console.log(s) }

// The one-shot query emits "SECTION | name | detail" rows, but the grid the
// SQL Editor returns may use tabs or several spaces. Split on all of them so
// a pasted grid lands in the same shape as the raw query output.
const rows = []
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*(FN|BODY|POLICY|ANON|TRIGGER|COLUMN|CONSTRAINT|COUNT)\s*[|\t]/)
  if (!m) continue
  const parts = line.split(/\s*[|\t]\s*/)
  rows.push({ section: m[1], name: (parts[1] || '').trim(), detail: (parts.slice(2).join(' | ')).trim() })
}
say('parsed rows: ' + rows.length +
    (rows.length ? '' : '   <-- nothing recognised; was the one-shot query pasted?'))
say('')

const FUNCS = [
  ['ent_may_touch_report',        '0003/0016'],
  ['ent_stamp_report_ownership',  '0018'],
  ['ent_may_grant_report_access', '0019'],
  ['ent_has_report_grant',        '0019'],
  ['ent_stamp_grant',             '0019'],
  ['ent_grants_narrow_only',      '0019'],
  ['ent_stamp_photo_ownership',   '0019'],
  ['ent_may_edit_report',         '0019'],
  ['ent_may_read_own_clinic',     '0020'],
  ['ent_may_open_report',         '0020'],
  ['ent_view_all_index',          '0020'],
  ['ent_open_report',             '0020'],
  ['ent_may_access_photo',        '0009/0020'],
]
const TRIGGERS = [
  ['trg_reports_stamp',        '0018  the ownership stamp'],
  ['trg_photos_stamp',         '0004  photo re-parenting'],
  ['trg_grants_stamp',         '0019  grant self-stamp'],
  ['trg_grants_narrow_only',   '0019  grants narrow-only'],
]

say('=====================================================================')
say('  LIVE STATE CLASSIFICATION   (read-only)')
say('  source: _live_paste.txt (' + raw.length + ' bytes)')
say('=====================================================================')
say('')

say('---- 1. FUNCTIONS  (from the FN rows) ----')
const fnFound = {}
for (const [fn, mig] of FUNCS) {
  const found = rows.some(r => r.section === 'FN' && r.name.startsWith(fn + '('))
  fnFound[fn] = found
  say(`  ${found ? 'PRESENT' : 'absent '}  ${fn.padEnd(30)} ${mig}`)
}
say('')

say('---- 2. TRIGGERS  (0018 and 0019 are mostly triggers) ----')
const trgFound = {}
for (const [tg, note] of TRIGGERS) {
  const found = rows.some(r => r.section === 'TRIGGER' && r.name.includes(tg))
  trgFound[tg] = found
  say(`  ${found ? 'PRESENT' : 'absent '}  ${tg.padEnd(24)} ${note}`)
}
say('')

say('---- 3. POLICIES ----')
{
  const pol = rows.filter(r => r.section === 'POLICY')
  if (!pol.length) say('  (none reported)')
  else for (const r of pol) {
    const d = r.detail || ''
    const usesEdit  = /ent_may_edit_report/.test(d)
    const usesTouch = /ent_may_touch_report/.test(d)
    const usesOwn   = /ent_may_read_own_clinic/.test(d)
    const usesGrant = /ent_has_report_grant/.test(d)
    const hasClaim  = /ent_claim_clinic_id/.test(d)
    const tag = usesOwn ? 'STRICT-0020' : usesEdit ? 'EDIT-0019'
               : usesGrant ? 'GRANT-0019' : usesTouch ? 'READ-0008/0016' : 'other'
    const flags = []
    if (hasClaim) flags.push('HAS-CLAIM-CHECK')
    if (usesTouch && r.name.includes('[SELECT]')) flags.push('select-still-on-read-fn')
    say(`  ${tag.padEnd(13)} ${r.name.padEnd(46)} ${flags.join(' ') || '-'}`)
  }
}
say('')

say('---- 4. ANON GRANTS (any row here is a STOP) ----')
{
  const anon = rows.filter(r => r.section === 'ANON')
  if (!anon.length) say('  NONE — correct, anon holds nothing.')
  else { say('  *** ' + anon.length + ' ANON GRANT(S) PRESENT ***'); anon.forEach(r => say('    ' + r.name + ' ' + r.detail)) }
}
say('')

say('---- 5. GRANT TABLE SHAPE ----')
for (const r of rows.filter(r => r.section === 'COLUMN'))   say('  col  ' + r.name.padEnd(14) + r.detail)
for (const r of rows.filter(r => r.section === 'CONSTRAINT')) say('  con  ' + r.name.padEnd(18) + r.detail)
const ncols = rows.filter(r => r.section === 'COLUMN').length
const want6 = ['report_id', 'grantee_id', 'granted_by', 'reason', 'expires_at', 'created_at']
const gotCols = rows.filter(r => r.section === 'COLUMN').map(r => r.name)
const missingCols = want6.filter(c => !gotCols.includes(c))
say(`  expected 6 columns, found ${ncols}` + (missingCols.length ? '  MISSING: ' + missingCols.join(', ') : '  (all present)'))
say('')

say('---- 6. COUNTS (baseline for the repair plan) ----')
for (const r of rows.filter(r => r.section === 'COUNT')) say(`  ${r.name.padEnd(24)} ${r.detail}`)
say('')

// ---- 4. fingerprint the live bodies against the revised files -------
say('---- 7. FUNCTION BODIES vs THE REVISED FILES ON DISK ----')
say('  (a function whose body was not pasted cannot be judged)')
say('')
// Each mark is a string that exists in exactly one revision of the file.
// `want` true  = the revised file has it, so the live body must have it too.
// `want` false = the revised file REMOVED it, so its presence means stale.
const MARKS = [
  ['ent_may_grant_report_access', 'AND r.is_draft = false',
   true,  'drafts refused AT APPROVAL time'],
  ['ent_may_grant_report_access', 'me.clinic_id = r.clinic_id',
   true,  'own-clinic equality (any role) replaces the read helper'],
  ['ent_may_grant_report_access', "me.role = 'admin' AND me.clinic_id",
   false, 'ADMIN-ONLY gate must be GONE since 0032 - whole clinic approves'],
  ['ent_may_grant_report_access', 'ent_may_touch_report',
   false, 'OLD read-based gate must be GONE'],
  ['ent_may_edit_report', 'rr.is_draft = false',
   true,  'drafts excluded from the WRITE grant'],
  ['ent_has_report_grant', 'r.is_draft = false',
   true,  'drafts excluded from the READ grant'],
  ['ent_stamp_report_ownership', 'ent_has_report_grant(OLD.id)',
   true,  'cross-clinic write gated on a GRANT'],
  ['ent_stamp_report_ownership', 'ent_admin_covers_clinic',
   false, 'OLD managed_by widening must be GONE'],
]
{
  // Isolate the text belonging to each function: from "fn(" up to the
  // next function's "fn(", so a mark inside one body is never matched
  // against a neighbouring body.
  // Each BODY row is exactly one function's definition, so no region
  // splitting or "$$;" guessing is needed: the row IS the body. Matching
  // against the flattened paste instead would let a marker inside one
  // function be found inside a different one.
  const bodyOf = {}
  for (const r of rows.filter(x => x.section === 'BODY')) {
    const fn = r.name.replace(/\(.*$/, '')
    bodyOf[fn] = r.detail || ''
  }
  let stale = 0
  for (const [fn, needle, want, meaning] of MARKS) {
    const body = bodyOf[fn]
    if (body === undefined) { say(`  ??    ${fn.padEnd(30)} body not in the paste`); continue }
    const has = body.includes(needle)
    const good = (has === want)
    if (!good) stale++
    say(`  ${good ? 'OK   ' : 'STALE'} ${fn.padEnd(30)} ${(has ? 'has ' : 'lacks')} ${needle.slice(0, 36).padEnd(38)} ${meaning}`)
  }  say('')
  say(`  bodies that disagree with the reviewed files: ${stale}`)
  say('')
  var staleCount = stale
}
var staleCount = (typeof staleCount === 'undefined') ? -1 : staleCount

// ---- 8. verdict -----------------------------------------------------
say('---- 8. VERDICT ----')
const s0018    = trgFound.trg_reports_stamp
const s0019trg = trgFound.trg_grants_stamp && trgFound.trg_grants_narrow_only
const s0019fn  = fnFound.ent_may_edit_report && fnFound.ent_has_report_grant
const anonBad  = rows.some(r => r.section === 'ANON')
const staleN   = (typeof staleCount === 'number' && staleCount >= 0) ? staleCount : null
say('')
if (anonBad) {
  say('  STOP — anon holds a table grant. Nothing else matters until that')
  say('         is understood; it is the finding that made v1 dangerous.')
} else if (!s0018 && !s0019trg && !s0019fn) {
  say('  CASE 1 — nothing from 0018/0019 is live.')
  say('  ACTION: apply 0018, then 0019 (revised), then 0020. In that order.')
} else if (s0018 && s0019trg && s0019fn && staleN === 0) {
  say('  CASE 2 — 0018 and 0019 are live AND every body matches the files.')
  say('  ACTION: apply 0020 only. Nothing to repair.')
} else if (s0018 && s0019trg && s0019fn) {
  say('  CASE 2b — complete, but ' + staleN + ' body/bodies differ from the files.')
  say('  ACTION: 0021 does CREATE OR REPLACE on exactly the differing')
  say('          functions. No DROP, no table rebuild, grants preserved.')
  say('          Then apply 0020.')
} else if (s0019fn && !s0018) {
  say('  CASE 3 — 0019 functions are live, the 0018 stamp trigger is NOT.')
  say('  This is the partial-apply shape: 0019 got as far as its functions')
  say('  and stopped where it needed the 0018 stamp to exist.')
  say('  ACTION: apply 0018 (adds the missing trigger and function), then')
  say('          a minimal 0021 for whichever 0019 triggers are still')
  say('          absent, then 0020. report_access_grants is left alone.')
} else if (s0018 && !s0019fn) {
  say('  CASE 4 — the 0018 stamp is live but 0019 functions are not.')
  say('  ACTION: apply 0019 (revised), then 0020.')
} else {
  say('  CASE 5 — MIXED. Decide per object from sections 1, 2 and 7.')
  say('          Do NOT re-apply 0019 wholesale; target only what is')
  say('          missing or differs.')
}
say('')
say('=====================================================================')

writeFileSync(join(HERE, '_classify.txt'), out.join('\n'), 'utf8')

