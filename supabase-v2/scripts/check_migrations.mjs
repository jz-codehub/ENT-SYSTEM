#!/usr/bin/env node
/* =====================================================================
   check_migrations.mjs — offline reviewer for the v2 SQL + Edge Functions
   ---------------------------------------------------------------------
   There is no psql / docker / supabase CLI on this machine, so this
   script does NOT claim to have executed the schema. What it does, and
   can genuinely prove offline:

     S1  dollar-quoted blocks ($$ ... $$) are balanced in every file
     S2  parentheses balance outside strings, comments and dollar quotes
     S3  no statement is left unterminated (every stripped statement ends ;)
     S4  SECURITY: no anonymous access is granted anywhere
     S5  SECURITY: no permissive "USING (true)" / "WITH CHECK (true)" policy
     S6  SECURITY: no credential-shaped column is ever created
     S7  every policy statement targets authenticated (or service_role)
     S8  Edge Functions: no service-role key can be read from client code,
         balanced braces, no custom password hashing or token minting
     S9  no JWT-shaped secret is committed anywhere in this folder
     S10 every statement STARTS with a real SQL verb. A file that lost a
         line to its own tail leaves a fragment behind (");", "GROUP BY ...",
         "FOR EACH ROW ...") that looks like the start of a statement and
         only fails on the server, long after the file looked fine offline.
     S11 every PL/pgSQL body balances its own blocks: BEGIN..END,
         LOOP..END LOOP, IF..END IF. S1/S2/S3 are blind to these because
         the body sits inside a $$ quote, so a dropped END LOOP is invisible
         to every other check here.
     S12 no CHECK constraint contains a subquery. Postgres rejects that
         with ERROR 0A000 "cannot use subquery in check constraint": a CHECK
         may only reference columns of its own row, so a rule that needs
         another table has to be a trigger, not a table-level constraint.
     S13 no migration DDL that needs table OWNERSHIP targets the storage
         schema. storage.objects is owned by supabase_storage_admin and the
         Dashboard SQL editor runs as `postgres`, so ALTER TABLE / CREATE or
         DROP POLICY there fails with 42501 "must be owner of table objects".

   Exit code 0 = all checks passed. Non-zero = something to fix.

   Run:  node supabase-v2/scripts/check_migrations.mjs
   ===================================================================== */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
let checks = 0
function ok(label, detail = '') { checks++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`) }
function bad(label, detail = '') { checks++; failures++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

/* ------------------------------------------------------------------ */
/* Strip comments, string literals and dollar-quoted bodies so that a   */
/* parenthesis or word inside them cannot affect a structural count.    */
/* ------------------------------------------------------------------ */
function stripSql(code) {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const two = code.substr(i, 2)
    if (two === '--') {
      while (i < n && code[i] !== '\n') i++
      continue
    }
    if (code[i] === "'") {                       // '...' with '' escapes
      i++
      while (i < n) {
        if (code[i] === "'" && code[i + 1] === "'") { i += 2; continue }
        if (code[i] === "'") { i++; break }
        i++
      }
      out += ' '
      continue
    }
    const dq = /^\$[a-zA-Z_0-9]*\$/.exec(code.slice(i))
    if (dq) {                                    // $$ ... $$ / $tag$ ... $tag$
      const tag = dq[0]
      const end = code.indexOf(tag, i + tag.length)
      i = end === -1 ? n : end + tag.length
      out += ' '
      continue
    }
    out += code[i]
    i++
  }
  return out
}

function balance(text, open, close) {
  let depth = 0
  for (const ch of text) {
    if (ch === open) depth++
    else if (ch === close) { depth--; if (depth < 0) return -1 }
  }
  return depth
}

const sqlFiles = [...walk(join(ROOT, 'migrations'))].filter(f => f.endsWith('.sql')).sort()
const fnFiles = [...walk(join(ROOT, 'edge-functions'))].filter(f => f.endsWith('.ts')).sort()

console.log('')
console.log('==== ENT RECORDS v2 · OFFLINE REVIEW ====')
console.log(`migrations : ${sqlFiles.length} files`)
console.log(`functions  : ${fnFiles.length} files`)
console.log('')

/* ---------------- S1 / S2 / S3 : structure -------------------------- */
for (const file of sqlFiles) {
  const raw = readFileSync(file, 'utf8')
  const name = file.slice(ROOT.length + 1)

  const tags = raw.match(/\$[a-zA-Z_0-9]*\$/g) || []
  if (tags.length % 2 === 0) ok(`S1 dollar quotes balanced · ${name}`, `${tags.length} markers`)
  else bad(`S1 dollar quotes balanced · ${name}`, `${tags.length} (odd count)`)

  const stripped = stripSql(raw)
  const p = balance(stripped, '(', ')')
  if (p === 0) ok(`S2 parentheses balanced · ${name}`)
  else bad(`S2 parentheses balanced · ${name}`, `depth ${p}`)

  const lastReal = stripped.split('\n').filter(l => l.trim() && !/^\s*--/.test(l)).pop() || ''
  const trimmed = stripped.replace(/--.*$/gm, '').trim()
  // A file may opt out of S3 by declaring itself documentation-only. It has
  // to say so explicitly: silently tolerating "ends without ;" would hide a
  // file that lost its last statement to a bad edit, which is exactly the
  // failure this check exists for.
  const docOnly = /^\s*--\s*@doc-only\b/m.test(raw)
  if (docOnly) {
    ok(`S3 documentation-only file, no statement required · ${name}`)
  } else if (trimmed.endsWith(';')) ok(`S3 file ends on a complete statement · ${name}`)
  else bad(`S3 file ends on a complete statement · ${name}`, `last line: ${lastReal.trim().slice(0, 60)}`)

  /* ------------------------------------------------------------------
     S10 : every statement must START with a real SQL verb.

     WHY THIS EXISTS. These files were all green offline and still failed
     on the server. Five of them had lost a line to their own tail: the
     fragment reappeared after the closing NOTIFY, so the file balanced
     (S2 passed), ended on a ";" (S3 passed) and contained an even number
     of $$ markers (S1 passed) while being syntactically dead.

     The tell is a statement whose first token is not a verb -- a stray
     ");", a "GROUP BY 1, 2, 3" that belongs to a function body, a
     "FOR EACH ROW ..." that belongs to a CREATE TRIGGER. On the server
     that is exactly "syntax error at or near ...".
     ------------------------------------------------------------------ */
  const VERBS = new RegExp(
    '^(?:' + [
      'ADD', 'ALTER', 'BEGIN', 'COMMENT', 'COMMIT', 'COPY', 'CREATE', 'DELETE',
      'DO', 'DROP', 'GRANT', 'INSERT', 'MERGE', 'NOTIFY', 'REFRESH', 'REVOKE',
      'ROLLBACK', 'SELECT', 'SET', 'TRUNCATE', 'UPDATE', 'VACUUM', 'WITH',
    ].join('|') + ')\\b', 'i')

  // stripSql has already blanked comments, strings and $$ bodies, so a
  // semicolon now terminates a statement and nothing else can hide one.
  let fragmentHits = 0
  for (const stmt of stripped.split(';')) {
    const s = stmt.trim()
    if (!s) continue
    if (!VERBS.test(s)) {
      fragmentHits++
      bad(`S10 statement starts with a SQL verb · ${name}`,
          `"${s.replace(/\s+/g, ' ').slice(0, 60)}"`)
    }
  }
  if (!fragmentHits) ok(`S10 every statement starts with a SQL verb · ${name}`)

  /* ------------------------------------------------------------------
     S11 : PL/pgSQL block balance, counted inside $$ bodies only.

     A dropped "END LOOP;" inside a DO block or a trigger function is
     invisible to S1/S2/S3, which is precisely how 9100 shipped a broken
     seed script. Count the keywords per body, not per file: nesting is
     legal, only the DIFFERENCE has to be zero.
     ------------------------------------------------------------------ */
  const bodies = [...raw.matchAll(/\$([a-zA-Z_0-9]*)\$([\s\S]*?)\$\1\$/g)].map(m => m[2])
  let plHits = 0
  bodies.forEach((body, idx) => {
    const code = body.replace(/--.*$/gm, ' ').replace(/'[^']*'/g, "''")
    const n = re => (code.match(re) || []).length
    const at = f => `body #${idx + 1}: ${f()}`

    // Count the words, then SUBTRACT the closers out of the totals. Every
    // \bIF\b is either an IF opener or the IF of an "END IF"; every \bLOOP\
    // is a loop terminator or the LOOP of an "END LOOP"; every \bEND\b is
    // one of the three closers, a bare "END" (which closes BEGIN) or the
    // END of a CASE EXPRESSION. Deriving the openers by subtraction is what
    // makes these numbers add up exactly instead of nearly.
    const endAll  = n(/\bEND\b/gi)
    const endIf   = n(/\bEND\s+IF\b/gi)
    const endLoop = n(/\bEND\s+LOOP\b/gi)
    const endCase = n(/\bEND\s+CASE\b/gi)
    const caseAll = n(/\bCASE\b/gi)
    // A CASE block closes with END CASE, so the CASE expressions (closed by
    // a bare END) are exactly the surplus.
    const caseExpr = caseAll - endCase
    const bareEnd  = endAll - endIf - endLoop - endCase - caseExpr

    const ifOpen   = n(/\bIF\b(?!\s*\()/gi) - endIf
    const loopOpen = n(/\bLOOP\b/gi) - endLoop
    const beginOpen = n(/\bBEGIN\b/gi)

    const report = (label, o, c) => {
      if (o !== c) {
        plHits++
        bad(`S11 PL/pgSQL ${label} balance · ${name}`,
          `${at(() => `${o} ${label} vs ${c} END ${label}`)}`)
      }
    }
    report('BEGIN', beginOpen, bareEnd)
    report('LOOP',  loopOpen,   endLoop)
    report('IF',    ifOpen,     endIf)

    // No body may close a block it never opened: that surplus "END" is
    // exactly what a lost END LOOP / END IF looks like on the server.
    if (endAll !== endIf + endLoop + endCase + caseExpr + beginOpen) {
      plHits++
      bad(`S11 PL/pgSQL END accounting · ${name}`,
        `${at(() => `${endAll} END vs ${endIf + endLoop + endCase + caseExpr + beginOpen} accounted for`)}`)
    }
  })
  if (!plHits) ok(`S11 PL/pgSQL blocks balanced in ${bodies.length} body/bodies · ${name}`)
}

/* ---------------- S4 / S5 / S6 / S7 : the security rules ------------- */
console.log('')
console.log('--- security rules encoded as assertions ---')

const FORBIDDEN = [
  {
    re: /^\s*GRANT\b[^\n;]*\bFROM\b/im,
    why: 'GRANT uses TO, never FROM (REVOKE uses FROM) — 0040 shipped exactly this typo and failed at apply time',
  },
  {
    re: /\bGRANT\b[^;]*\bTO\s+anon\b/i,
    why: 'privileges granted to anon (the old project did exactly this)',
  },
  {
    re: /\bUSING\s*\(\s*true\s*\)/i,
    why: 'permissive USING (true) policy — authorizes nothing',
  },
  {
    re: /\bWITH\s+CHECK\s*\(\s*true\s*\)/i,
    why: 'permissive WITH CHECK (true) — accepts any written row',
  },
  {
    re: /\bTO\s+anon\b/i,
    why: 'a policy or grant naming the anon role',
  },
  {
    re: /\bALTER\s+DEFAULT\s+PRIVILEGES\b[^;]*\bGRANT\b[^;]*\bTO\s+anon\b/i,
    why: 'default privileges would hand future tables to anon',
  },
  {
    re: /\b(password_hash|password_salt)\s+[\w(]/i,
    why: 'a credential column — Supabase Auth owns passwords',
  },
  {
    re: /\bsalt\s+text\b/i,
    why: 'a password salt column — Supabase Auth owns passwords',
  },
  {
    re: /\bsession_token\s+text\b|\btoken\s+text\s+not\s+null\s+unique/i,
    why: 'a column storing session tokens — Supabase Auth owns sessions',
  },
]

for (const file of sqlFiles) {
  const name = file.slice(ROOT.length + 1)
  // Strip comments: this file explains the old insecure design at length,
  // and explaining a bad pattern is not the same as using it.
  const code = stripSqlKeepStrings(readFileSync(file, 'utf8'))
  let hit = 0
  for (const rule of FORBIDDEN) {
    const m = rule.re.exec(code)
    if (m) { hit++; bad(`S4-S7 ${name}`, `${rule.why} :: ${m[0].replace(/\s+/g, ' ').slice(0, 70)}`) }
  }
  if (!hit) ok(`S4-S7 no forbidden pattern · ${name}`)

  // Every policy must name a real role; a policy with no TO clause would
  // apply to PUBLIC, i.e. everyone including anon.
  const rawNoComment = readFileSync(file, 'utf8').replace(/--.*$/gm, '')
  const policies = rawNoComment.match(/CREATE\s+POLICY[\s\S]*?;/gi) || []
  let unscoped = 0
  for (const p of policies) {
    if (!/\bTO\s+(authenticated|service_role)\b/i.test(p)) {
      unscoped++
      bad(`S7 policy names a role · ${name}`,
        p.replace(/\s+/g, ' ').slice(0, 80))
    }
  }
  if (!unscoped && policies.length) ok(`S7 all ${policies.length} policy(ies) name a role · ${name}`)

  /* ------------------------------------------------------------------
     S12 : no CHECK constraint may contain a subquery.

     ERROR 0A000 "cannot use subquery in check constraint" is Postgres
     refusing the DDL outright, because a CHECK is evaluated against a
     single row and cannot read another table. Found the hard way, on a
     file that had already passed every other check here.
     ------------------------------------------------------------------ */
  let subqueryChecks = 0
  for (const t of rawNoComment.match(/CONSTRAINT\s+\w+\s+CHECK\s*\([\s\S]*?\)\s*[),]/gi) || []) {
    if (/\(\s*SELECT\b/i.test(t)) {
      subqueryChecks++
      bad(`S12 no subquery inside a CHECK · ${name}`,
          t.replace(/\s+/g, ' ').slice(0, 70))
    }
  }
  if (!subqueryChecks) ok(`S12 no subquery inside a CHECK · ${name}`)

  /* ------------------------------------------------------------------
     S13 : no ownership-requiring DDL against the storage schema.

     These files are run from the Dashboard SQL editor, which connects as
     `postgres`. storage.objects is owned by supabase_storage_admin, so
     ALTER TABLE / CREATE POLICY / DROP POLICY there is refused with
     SQLSTATE 42501. Those policies must be applied through Dashboard >
     Storage > Policies instead — see 0009b. Everything else in storage
     (a plain INSERT into storage.buckets) is fine.
     ------------------------------------------------------------------ */
  const OWNERSHIP_DDL =
    /\b(?:ALTER\s+TABLE\s+storage\.|CREATE\s+POLICY[^;]*?\bON\s+storage\.|DROP\s+POLICY[^;]*?\bON\s+storage\.|ALTER\s+TABLE[^;]*?\bOWNER\s+TO\b)/gi
  const ownerHits = code.match(OWNERSHIP_DDL)
  if (!ownerHits) {
    ok(`S13 no ownership DDL against the storage schema · ${name}`)
  } else {
    for (const h of ownerHits) {
      bad(`S13 no ownership DDL against the storage schema · ${name}`,
          `${h.replace(/\s+/g, ' ').slice(0, 70)} — use Dashboard > Storage > Policies`)
    }
  }
}

/** Strip line/block comments but KEEP string literals, for pattern rules. */
function stripSqlKeepStrings(code) {
  return code.replace(/--.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/* ---------------- S8 : Edge Functions ------------------------------- */
console.log('')
console.log('--- edge functions ---')

for (const file of fnFiles) {
  const name = file.slice(ROOT.length + 1)
  const raw = readFileSync(file, 'utf8')
  const code = raw.replace(/^\s*\/\/.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')

  // STRUCTURE: delegated to parse_check.mjs, which runs a real ECMAScript
  // parser. Counting braces here once reported "balanced" for three files
  // that did not compile, because a MISSING brace and a MISPLACED one both
  // net to zero, and braces inside strings, comments and `${}` all count.
  const parsed = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'parse_check.mjs')], { encoding: 'utf8' })
  if (parsed.status === 0) ok(`S8 every edge function parses · ${name}`)
  else {
    bad(`S8 every edge function parses · ${name}`,
      (parsed.stdout || parsed.stderr || '').split('\n')
        .filter(l => l.includes('FAIL')).slice(0, 3).join(' | ') || 'see parse_check.mjs')
  }

  // The service-role key may be READ from the environment but must never
  // be handed to anything the browser can see.
  if (/Deno\.env\.get\(['"]SUPABASE_SERVICE_ROLE_KEY['"]\)/.test(code) &&
      /return\s+json\([^)]*SERVICE_ROLE/.test(code)) {
    bad(`S8 service key never returned to the browser · ${name}`)
  } else {
    ok(`S8 service key never returned to the browser · ${name}`)
  }

  // The old design is gone and must stay gone.
  const banned = [
    { re: /issueToken\s*\(/, why: 'mints a custom token (old Phase A design)' },
    { re: /matchesStoredHash\s*\(/, why: 'verifies a custom password hash' },
    { re: /sha256Hex\(String\(salt/, why: 'hashes salt+password (old design)' },
    { re: /Access-Control-Allow-Origin'\s*:\s*'\*'(?![\s\S]*ENT_ALLOWED_ORIGIN)/, why: 'hardcoded wildcard CORS with no env override' },
    // A 204 is a NULL-BODY status. `new Response('ok', {status: 204})` throws
    // TypeError, which Deno reports as HTTP 500 EDGE_FUNCTION_ERROR with no
    // Access-Control-Allow-Origin header. The browser then refuses to send
    // the real request and the page sees only "Failed to fetch" - while every
    // Node test in this repo still calls the function healthy, because Node
    // never performs a preflight. This one line made the whole admin console
    // unreachable from a browser.
    { re: /new Response\(\s*['"`][^'"`]*['"`]\s*,\s*\{\s*status:\s*20[45]\b/, why: '204/205 response built WITH a body (null-body status) - throws TypeError' },
  ]
  let hits = 0
  for (const b of banned) {
    const m = b.re.exec(code)
    if (m) { hits++; bad(`S8 ${name}`, `${b.why} :: ${m[0].slice(0, 50)}`) }
  }
  if (!hits) ok(`S8 no retired custom-auth primitives · ${name}`)
}

/* ---------------- S9 : no secrets in the repo ----------------------- */
console.log('')
console.log('--- repository hygiene ---')
const secretRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
const suspicious = []
for (const f of walk(ROOT)) {
  if (/\.(mjs|ts|sql|md|json|example|ps1)$/.test(f)) {
    const t = readFileSync(f, 'utf8')
    if (secretRe.test(t) && !/security_probe/.test(f)) suspicious.push(f.slice(ROOT.length + 1))
  }
}
if (!suspicious.length) ok('S9 no JWT-shaped secret inside supabase-v2/')
else bad('S9 no JWT-shaped secret inside supabase-v2/', suspicious.join(', '))

console.log('')
console.log(`==== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILURE(S)'} · ${checks} checks ====`)
console.log('')
console.log('NOTE: this is a static review. It proves the schema does not')
console.log('contain the patterns that caused the original audit findings.')
console.log('It does NOT prove the database behaves correctly — that is what')
console.log('docs/06-TEST-PLAN.md against a real project is for.')
console.log('')

process.exit(failures === 0 ? 0 : 1)

