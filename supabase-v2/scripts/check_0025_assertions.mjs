// Offline check: do 0025's own assertion patterns actually match the
// function body it ships? A DO $$ block that cannot match itself would
// refuse to apply, and the error would say nothing about the real cause.
//
// This simulates what Postgres sees: pg_get_functiondef returns prosrc
// verbatim, so the spacing in the file is what the ILIKE sees.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIG = join(HERE, '..', 'migrations')
const sql = readFileSync(join(MIG, '0025_grant_author_survives_deletion.sql'), 'utf8')

// The whole CREATE FUNCTION statement, not just the $$ ... $$ body.
// search_path and SECURITY DEFINER sit OUTSIDE the dollar quotes, so a
// check scoped to the body would miss them - and SECURITY DEFINER would
// appear to "pass" by matching the word inside a comment.
const stmt = sql.match(/CREATE OR REPLACE FUNCTION public\.ent_stamp_grant\(\)[\s\S]*?\n\$\$;/)
if (!stmt) { console.log('BAD  no ent_stamp_grant definition found'); process.exit(1) }

const blocks = [...stmt[0].matchAll(/AS \$\$([\s\S]*?)\n\$\$;/g)].map(m => m[1])
const body = blocks[0]
if (!body) { console.log('BAD  no trigger body found'); process.exit(1) }

// Strip comments exactly as the assertion does.
const stripped = body.replace(/--[^\n]*/g, '')
const lc = stripped.toLowerCase()

const checks = [
  ['0025 stamps the name',         lc.includes('new.granted_by_name :=')],
  ['0024 stamp line, single space', lc.includes('new.granted_by := me.id')],
  ['caller from ent_auth_uid()',    lc.includes('ent_auth_uid')],
  ['no current_user in body',       !lc.includes('current_user')],
  ['name never taken from NEW',     !/new\.granted_by_name\s*:=\s*new\./i.test(stripped)],
  ['0024 guard intact',             /if\s+caller\s+is\s+null\s+then\s+return\s+new;/i.test(stripped)],
  // Clauses, checked on the statement with comments stripped so a comment
  // mentioning them cannot make them look present.
  ['SECURITY DEFINER clause',       /^security\s+definer$/im.test(stmt[0].replace(/--[^\n]*/g, ''))],
  ['search_path pinned to public',  /^set\s+search_path\s*=\s*public$/im.test(stmt[0].replace(/--[^\n]*/g, ''))],
  ['author resolved before stamp',  resolvedBeforeStamped(stripped)],
]

// Order matters: the author must be resolved (and refused if unusable)
// BEFORE anything is stamped, so a nameless profile cannot leave a
// half-written row. Case-insensitive, because the body writes NEW and the
// local variable in lower case - and an indexOf that quietly returns -1
// for a missing needle would make this check pass for the wrong reason.
function resolvedBeforeStamped(s) {
  const t = s.toLowerCase()
  const a = t.indexOf('author :=')
  const n = t.indexOf('new.granted_by_name :=')
  if (a < 0 || n < 0) {
    console.log(`     (needle not found: author := at ${a}, stamp at ${n})`)
    return false
  }
  return a < n
}

let bad = 0
for (const [name, pass] of checks) {
  if (!pass) bad++
  console.log(`  ${pass ? 'OK  ' : 'BAD '} ${name}`)
}
console.log('')
console.log(bad === 0
  ? 'ALL ASSERTION PATTERNS MATCH THE SHIPPED BODY'
  : `${bad} PATTERN(S) WOULD NOT MATCH - the file would refuse to apply`)
process.exit(bad === 0 ? 0 : 1)
