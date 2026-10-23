// =====================================================================
//  validate_sql.mjs — offline structural check of a .sql file before it
//  is pasted into the SQL Editor.  READ-ONLY: reads a file, prints.
//
//  It cannot run Postgres, so it cannot prove the query works. What it
//  CAN catch is the class of mistake that produces an instant red error
//  in the editor and costs a round trip:
//
//    · unbalanced parentheses
//    · a UNION branch with a different column count than the first
//    · a statement that does not end in ;
//    · dollar-quote markers left open
//
//  Run: node supabase-v2/scripts/validate_sql.mjs <file.sql>
// =====================================================================
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: validate_sql.mjs <file.sql>'); process.exit(1) }
const raw = readFileSync(file, 'utf8')
let bad = 0
const fail = m => { bad++; console.log('  FAIL  ' + m) }
const pass = m => console.log('  PASS  ' + m)

// strip line comments and single-quoted strings so their contents cannot
// affect any structural count
let s = raw.replace(/--[^\n]*/g, ' ').replace(/'[^']*'/g, "''")

console.log('')
console.log('==== SQL STRUCTURE CHECK: ' + file + ' ====')
console.log('')

// ---- parentheses ----
{
  let depth = 0, min = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth < min) min = depth }
  }
  if (depth === 0 && min === 0) pass('parentheses balanced')
  else fail(`parentheses UNBALANCED (net ${depth}, went to ${min})`)
}

// ---- dollar quotes ----
{
  const n = (s.match(/\$\$/g) || []).length
  if (n % 2 === 0) pass(`dollar quotes balanced (${n} markers)`)
  else fail(`dollar quotes UNBALANCED (${n} markers)`)
}

// ---- statement termination ----
{
  const trimmed = raw.trim()
  if (trimmed.endsWith(';')) pass('file ends on a complete statement')
  else fail('file does not end with ";"')
}

// ---- UNION branch column counts ----
// The first branch fixes the arity. Every other branch, and the final
// SELECT list, must produce the same number of expressions, or Postgres
// answers "each UNION query must have the same number of columns".
{
  const cleaned = raw.replace(/--[^\n]*/g, ' ')
  const u = cleaned.split(/\bUNION\s+ALL\b/i)
  if (u.length < 2) {
    pass('no UNION ALL to check')
  } else {
    // The first split chunk still carries the "WITH facts AS (" prefix, so
    // its first top-level comma belongs to the CTE header, not the SELECT
    // list. Start the scan after the first top-level "SELECT" instead.
    const firstSelect = u[0].search(/\bSELECT\b/i)
    const arity = t => {
      let depth = 0, n = 1, inStr = false
      t = t.replace(/'(?:''|[^'])*'/g, "''")
      for (const ch of t) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        else if (ch === ',' && depth === 0) n++
      }
      return n
    }
    const first = arity(u[0].slice(firstSelect).split(/\bFROM\b/i)[0])
    let mismatch = 0
    u.slice(1).forEach((b, i) => {
      const head = b.split(/\bFROM\b/i)[0]
      const a = arity(head)
      if (a !== first) {
        mismatch++
        fail(`UNION branch ${i + 1} has ${a} column(s); the first has ${first}`)
      }
    })
    if (!mismatch) pass(`all ${u.length} UNION branches have ${first} column(s)`)
  }
}

// ---- trailing SELECT arity ----
{
  const m = raw.match(/ORDER\s+BY[\s\S]*$/i)
  if (m) {
    const sel = m[0]
    const outer = (sel.match(/\bAS\s+[a-z_]+\s+FROM/gi) || []).length
    if (outer === 0) pass('outer SELECT list present for the CTE form')
  }
}

console.log('')
console.log(bad === 0
  ? '==== STRUCTURE OK — safe to paste into the SQL Editor ===='
  : `==== ${bad} STRUCTURAL PROBLEM(S) — fix before pasting ====`)
console.log('')
process.exit(bad === 0 ? 0 : 1)
