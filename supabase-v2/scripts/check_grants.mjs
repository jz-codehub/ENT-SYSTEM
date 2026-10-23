/* =====================================================================
 *  check_grants.mjs - every table a migration creates must grant for itself.
 * ---------------------------------------------------------------------
 *  0001 does   ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES FROM anon
 *  0007 grants table by table to authenticated, then once with
 *       GRANT ALL ON ALL TABLES ... TO service_role
 *
 *  Both reach only the tables that EXIST AT THAT MOMENT. A table created by
 *  a LATER migration inherits nothing at all: not anon (intended) and not
 *  authenticated or service_role (a bug).
 *
 *  The symptom is misleading. PostgREST answers a missing privilege with
 *
 *      HTTP 403  {"code":"42501","hint":"Grant the required privileges..."}
 *
 *  which reads like a permissions problem, and is NOT the HTTP 404 PGRST205
 *  that a table which does not exist returns. That is how the tickets
 *  tables were created and were immediately unusable, with no error in the
 *  SQL editor at all.
 *
 *  Run: node supabase-v2/scripts/check_grants.mjs
 * ===================================================================== */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIG = resolve(HERE, '..', 'migrations')

console.log('')
console.log('==== DOES EVERY CREATED TABLE GRANT FOR ITSELF? ====')
console.log('')

// Every table name mentioned by a CREATE TABLE anywhere in the schema.
const created = new Map()          // table -> file that created it
const granted = new Set()          // tables that some GRANT names
for (const f of readdirSync(MIG).filter(x => x.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(MIG, f), 'utf8')
  for (const m of sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?(\w+)/gi)) {
    if (!created.has(m[1])) created.set(m[1], f)
  }
  for (const m of sql.matchAll(/GRANT\s+[^;]*?\bON\s+(?:public\.)?(\w+)\b/gi)) {
    granted.add(m[1])
  }
  // "GRANT ALL ON ALL TABLES" reaches every table that exists AT THAT
  // MOMENT, which is a real grant for the tables declared earlier in the
  // same run order. Treat it as covering the tables from files up to and
  // including this one.
  if (/GRANT\s+ALL\s+ON\s+ALL\s+TABLES/i.test(sql)) {
    for (const [t, file] of created) {
      if (file <= f) granted.add(t)
    }
  }
}

const orphan = [...created.entries()].filter(([t]) => !granted.has(t))
for (const [t, f] of created) {
  const has = granted.has(t)
  console.log('  ' + (has ? 'ok    ' : 'NO GRANT') + '  ' + t.padEnd(22) + f + (has ? '' : '   <-- unusable by everyone'))
}
console.log('')
if (orphan.length) {
  console.log('  ' + orphan.length + ' table(s) are created but never granted.')
  console.log('  Add a GRANT to that migration. anon must stay absent;')
  console.log('  authenticated and service_role need theirs.')
  console.log('')
  process.exitCode = 1
} else {
  console.log('  every created table is granted. anon is deliberately excluded.')
  console.log('')
}
