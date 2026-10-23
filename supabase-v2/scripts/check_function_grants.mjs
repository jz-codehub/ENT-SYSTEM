/* =====================================================================
 *  check_function_grants.mjs — every FUNCTION a migration creates must be
 *  reachable by the roles that actually call it.
 *  ---------------------------------------------------------------------
 *  The sibling of check_grants.mjs (which covers TABLES). The rule it
 *  enforces was written by 0011, proven against the live project:
 *
 *    0010 created ent_admin_set_active and granted EXECUTE only TO
 *    authenticated. The preceding REVOKE ... FROM anon, public leaves
 *    service_role with NOTHING (Postgres defaults grant EXECUTE to
 *    PUBLIC only), so admin().rpc('ent_admin_set_active') answered
 *      HTTP 403 {"code":"42501","permission denied for function ..."}
 *    and no admin could ever deactivate an account. Every migration
 *    after 0007 needs its OWN grant; nothing is inherited.
 *
 *  Four checks, all static, all offline:
 *    G1  every non-trigger function holds EXECUTE for `authenticated`
 *        (the browser calls rpc/<name> with a user JWT; a policy that
 *        names the function also runs as that user).
 *    G2  no function grants EXECUTE to `anon` (fail CLOSED at the
 *        privilege layer, 0001/0007's whole posture).
 *    G3  every admin().rpc('<name>') in an Edge Function holds EXECUTE
 *        for service_role. (asUser(jwt).rpc() needs only `authenticated`,
 *        which is G1. Functions whose GUARD demands a real caller —
 *        ent_reassign_doctor_records — must be called asUser(), NOT
 *        granted to service_role: a grant cannot fix auth.uid() NULL.)
 *    G4  every literal rpc/<name> in the browser code exists in the
 *        migrations AND holds EXECUTE for `authenticated`.
 *
 *  Run: node supabase-v2/scripts/check_function_grants.mjs
 * ===================================================================== */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MIG = join(ROOT, 'migrations')
const APP = resolve(ROOT, '..')

let pass = 0, fail = 0
const ok = (cond, msg) => { cond ? pass++ : fail++; if (!cond) console.log('  FAIL  ' + msg) }
const note = (m) => console.log('  NOTE  ' + m)

console.log('')
console.log('==== DOES EVERY FUNCTION GRANT FOR WHO CALLS IT? ====')
console.log('')

/* ------------------------------------------------------------------ */
/* 1. Parse the migrations.                                            */
/* ------------------------------------------------------------------ */
const files = readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()

const funcs = new Map()        // name -> { file, trigger, sig }
const grants = new Map()       // name -> Set(roles)
const grantFile = new Map()    // name -> file (for the anon message)
const allFuncsGrants = []      // { file, roles } for "GRANT ALL ON ALL FUNCTIONS"

const stripDashes = (s) => s.replace(/--[^\n]*/g, '')

for (const f of files) {
  const raw = readFileSync(join(MIG, f), 'utf8')
  const sql = stripDashes(raw)

  // --- CREATE FUNCTION public.name( ... ) [RETURNS trigger] ---------
  const createRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z_0-9]+)\s*\(/gi
  for (let m; (m = createRe.exec(sql)); ) {
    // balance the argument parens (DEFAULTs contain their own)
    let i = createRe.lastIndex - 1, depth = 0, end = -1
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++
      else if (sql[i] === ')') { depth--; if (!depth) { end = i; break } }
    }
    const sig = end > 0 ? sql.slice(createRe.lastIndex, end).replace(/\s+/g, ' ').trim() : '?'
    const head = sql.slice(end, end + 120)
    const trigger = /RETURNS\s+(?:trigger|event_trigger)/i.test(head)
    funcs.set(m[1], { file: f, trigger, sig })
  }

  // --- GRANT EXECUTE ON FUNCTION [public.a(x), public.b(y), ...] TO roles;
  const grantRe = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\s\S]+?)\s+TO\s+([a-z_,\s]+);/gi
  for (let m; (m = grantRe.exec(sql)); ) {
    const roles = new Set(m[2].split(/[,\s]+/).filter(Boolean))
    const listRe = /public\.([a-z_0-9]+)\s*\(/g
    for (let g; (g = listRe.exec(m[1])); ) {
      if (!grants.has(g[1])) grants.set(g[1], new Set())
      roles.forEach(r => grants.get(g[1]).add(r))
      grantFile.set(g[1], f)
    }
  }

  // --- GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO roles ----------
  // Reaches only the functions that exist AT THAT MOMENT (0007 covers
  // 0001..0007's own); the same sweep rule check_grants.mjs uses for
  // tables.
  const allRe = /GRANT\s+ALL\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+public\s+TO\s+([a-z_,\s]+);/gi
  for (let m; (m = allRe.exec(sql)); ) {
    allFuncsGrants.push({ file: f, roles: new Set(m[1].split(/[,\s]+/).filter(Boolean)) })
  }

  // --- DO-block grants (0009's pattern) ------------------------------
  // A FOREACH loop runs EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO
  // role', f) over an ARRAY of signatures. A plain GRANT regex cannot
  // see those, and three storage-policy helpers are granted exactly
  // this way - treating them as ungranted is a false alarm.
  const doRe = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi
  for (let m; (m = doRe.exec(sql)); ) {
    const names = [...m[1].matchAll(/public\.([a-z_0-9]+)\s*\(/g)].map(x => x[1])
    const g = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+%s\s+TO\s+([a-z_]+)/i.exec(m[2])
    if (g) for (const n of names) {
      if (!grants.has(n)) grants.set(n, new Set())
      grants.get(n).add(g[1])
      grantFile.set(n, f + ' (DO block)')
    }
  }
}
for (const { file, roles } of allFuncsGrants) {
  for (const [name, fn] of funcs) {
    if (fn.file > file) continue          // did not exist yet
    if (!grants.has(name)) grants.set(name, new Set())
    roles.forEach(r => grants.get(name).add(r))
  }
}

const rolesOf = (n) => grants.get(n) || new Set()

/* ------------------------------------------------------------------ */
/* 2. G1 + G2 — authenticated present, anon absent.                    */
/* ------------------------------------------------------------------ */
const ungranted = [], anonGranted = []
for (const [name, fn] of funcs) {
  if (fn.trigger) continue                  // fired by the system, no EXECUTE needed
  const r = rolesOf(name)
  if (!r.has('authenticated')) ungranted.push(`${name}(${fn.sig}) — ${fn.file}`)
  if (r.has('anon')) anonGranted.push(`${name} — granted to anon in ${grantFile.get(name)}`)
}
ok(ungranted.length === 0,
  'G1: every non-trigger function grants EXECUTE to authenticated')
if (ungranted.length) ungranted.forEach(x => console.log('        · ' + x))
ok(anonGranted.length === 0, 'G2: no function grants EXECUTE to anon')
if (anonGranted.length) anonGranted.forEach(x => console.log('        · ' + x))

/* ------------------------------------------------------------------ */
/* 3. G3 — every admin().rpc('x') in the Edge Functions.               */
/* ------------------------------------------------------------------ */
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}
const edgeDir = join(ROOT, 'edge-functions')
const svcCalls = []     // { name, file, line } via admin()
const userCalls = []    // ... via asUser()
for (const p of walk(edgeDir)) {
  const src = readFileSync(p, 'utf8').split(/\r?\n/)
  const rel = p.slice(ROOT.length + 1)
  src.forEach((line, i) => {
    for (const m of line.matchAll(/admin\(\)\s*\.\s*rpc\(\s*'([a-z_0-9]+)'/g)) {
      svcCalls.push({ name: m[1], file: rel, line: i + 1 })
    }
    for (const m of line.matchAll(/asUser\([^)]*\)\s*\.\s*rpc\(\s*'([a-z_0-9]+)'/g)) {
      userCalls.push({ name: m[1], file: rel, line: i + 1 })
    }
  })
}
for (const c of svcCalls) {
  const has = rolesOf(c.name).has('service_role')
  ok(has, `G3: ${c.file}:${c.line} admin().rpc('${c.name}') has service_role EXECUTE` +
    (has ? '' : ' — MISSING. If the function guard needs a real caller (ent_auth_uid), ' +
      'switch the call to asUser(me.jwt) like set_active does; a GRANT cannot fix a NULL auth.uid().'))
}
note(`edge RPC calls: ${svcCalls.length} via service_role, ${userCalls.length} via asUser`)
for (const c of userCalls) {
  ok(rolesOf(c.name).has('authenticated'),
    `G3b: ${c.file}:${c.line} asUser().rpc('${c.name}') has authenticated EXECUTE`)
}

/* ------------------------------------------------------------------ */
/* 4. G4 — every literal rpc/<name> in the browser code.               */
/* ------------------------------------------------------------------ */
function walkJs(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walkJs(p)) }
    else if (/\.(js|html)$/.test(e.name)) out.push(p)
  }
  return out
}
const browserRpc = new Map()   // name -> "file"
for (const p of [...walkJs(join(APP, 'function')), ...walkJs(join(APP, 'pages'))]) {
  const src = readFileSync(p, 'utf8')
  const rel = p.slice(APP.length + 1)
  for (const m of src.matchAll(/rpc\/([a-z_0-9]+)/g)) {
    if (!browserRpc.has(m[1])) browserRpc.set(m[1], rel)
  }
}
for (const [name, src] of browserRpc) {
  ok(funcs.has(name), `G4a: browser rpc/${name} (${src}) exists in the migrations`)
  if (funcs.has(name)) {
    ok(!funcs.get(name).trigger && rolesOf(name).has('authenticated'),
      `G4b: browser rpc/${name} (${src}) holds authenticated EXECUTE`)
  }
}
note(`browser rpc names found: ${browserRpc.size}`)

/* ------------------------------------------------------------------ */
console.log('')
console.log(`==== ${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' FAILED'} · ${pass + fail} checks ====`)
console.log('')
console.log('NOTE: static review of the SQL files. It proves the GRANT')
console.log('statements exist on paper; a deployed project is the real')
console.log('authority (run test_live_functions.mjs against it).')
console.log('')
if (fail) process.exitCode = 1
