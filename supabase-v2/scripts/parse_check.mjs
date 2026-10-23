/* =====================================================================
   parse_check.mjs â€” real parser for the Edge Functions
   ---------------------------------------------------------------------
   Why: `node --check` parses as CommonJS and so rejects `export`, and
   brace counting cannot see a MISPLACED brace â€” the two files that
   passed check_migrations.mjs still would not have deployed. This uses
   acorn, a real ECMAScript parser, and reports exact line + column.

   It only PARSES. Nothing is executed, so the Deno globals do not need
   to exist. Supabase's own `supabase functions deploy` compiles these
   with Deno; passing here is a necessary, not sufficient, condition.

   Run:  node supabase-v2/scripts/parse_check.mjs
         (first run:  cd supabase-v2/scripts && npm install)
   ===================================================================== */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let acorn = null
try { acorn = require('acorn') } catch { acorn = null }

/* ---------------- fallback: vm module (no position info) ------------- */
let vm = null
if (!acorn) {
  vm = (await import('node:vm')).default
  if (!vm.SourceTextModule) {
    const { spawnSync } = await import('node:child_process')
    spawnSync(process.execPath,
      ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { stdio: 'inherit' })
    process.exit(1)
  }
  console.log('  NOTE  acorn not found â€” falling back to vm.SourceTextModule,')
  console.log('        which detects errors but cannot report a line number.')
  console.log('        Run `npm install` in supabase-v2/scripts for positions.')
  console.log('')
}

function parse(source, identifier) {
  if (acorn) {
    acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    return
  }
  new vm.SourceTextModule(source, { identifier })
}

/* ---------------- self-test: trust the tool before its verdict ------- */
const GOOD = 'export const a = 1\nexport async function b(x) { try { return x } catch (e) { return null } }\n'
const BROKEN = 'const a = 1\n})\ncatch (e) { }\n'

let selftest = true
try { parse(GOOD, 'selftest-good') }
catch (e) { selftest = false; console.log('  SELF-TEST  valid module REJECTED: ' + e.message) }
try { parse(BROKEN, 'selftest-broken'); selftest = false; console.log('  SELF-TEST  broken module ACCEPTED') }
catch { /* the wanted outcome */ }

console.log('')
console.log('==== EDGE FUNCTION PARSE CHECK ====')
console.log(selftest
  ? '  PASS  self-test (accepts valid ES module, rejects a broken one)'
  : '  FAIL  self-test â€” the results below are not trustworthy')
console.log('')
if (!selftest) process.exit(2)

/* ---------------- the actual check ---------------------------------- */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (fs.statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts')) yield full
  }
}

let failures = 0
for (const file of walk(path.join(ROOT, 'edge-functions'))) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file)
  try {
    parse(src, rel)
    console.log(`  PASS  parses as an ES module Â· ${rel}`)
  } catch (err) {
    failures++
    const loc = err.loc
    console.log(`  FAIL  ${rel}${loc ? ':' + loc.line + ':' + loc.column + ' ' : ' '}${err.message.split('\n')[0]}`)
    if (loc) {
      const rows = src.split('\n')
      for (let i = Math.max(0, loc.line - 4); i < Math.min(rows.length, loc.line + 1); i++) {
        console.log(`        ${i + 1 === loc.line ? '>>' : '  '} ${i + 1}: ${rows[i]}`)
      }
      console.log(`           ${' '.repeat(Math.max(0, loc.column - 1))}^`)
    }
  }
}

console.log('')
console.log(failures === 0 ? '==== ALL EDGE FUNCTIONS PARSE ===='
                           : `==== ${failures} PARSE FAILURE(S) ====`)
console.log('')
process.exit(failures === 0 ? 0 : 1)
