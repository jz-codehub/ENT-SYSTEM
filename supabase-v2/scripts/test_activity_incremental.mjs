// =====================================================================
//  test_activity_incremental.mjs
//
//  Proves the P2 incremental activity_logs poll. The functions are lifted
//  OUT of the real admin.js and executed here, so these tests break if the
//  shipped code changes - they do not test a copy.
//
//  Load-bearing check at the end: M1 reverts the cursor to a full re-fetch
//  and the incremental assertions must fail. A suite that cannot go red
//  proves nothing.
// =====================================================================
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const adminCode = readFileSync(join(ROOT, 'function', 'admin.js'), 'utf8')

let pass = 0, fail = 0
const failures = []
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + id.padEnd(4) + ' ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failures.push(id + ' ' + name); console.log('FAIL  ' + id.padEnd(4) + ' ' + name + '  ' + (detail || '')) }
}
const eq = (id, name, got, want) =>
  ok(id, name, JSON.stringify(got) === JSON.stringify(want),
     JSON.stringify(got) === JSON.stringify(want) ? '' : 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want))

console.log('')
console.log('==== ACTIVITY LOG INCREMENTAL POLL ====')
console.log('')

// ---- lift the real functions out of admin.js --------------------------
const mergeSrc = /function mergeActivity\(incoming\) \{[\s\S]*?\n    \}/.exec(adminCode)
const loadSrc = /async function loadActivity\(force\) \{[\s\S]*?\n    \}/.exec(adminCode)
ok('S1', 'mergeActivity exists in admin.js', !!mergeSrc)
ok('S2', 'loadActivity exists in admin.js', !!loadSrc)
if (!mergeSrc || !loadSrc) { console.log('\nABORT: cannot locate the functions.'); process.exit(1) }

// Build a runnable instance of the REAL source, with a fake `api` that
// records every path it is asked for.
function build(api, window = 1000) {
  return new Function('api', `
    const ACTIVITY_WINDOW = ${window};
    let activity = [], activityLoaded = false, activityCursorId = 0, activityError = '';
    let renders = 0;
    function populateActivityUsers() {}
    function populateActivityActions() {}
    function renderActivity() { renders++; }
    function renderHourly() { renders++; }
    ${mergeSrc[0]}
    ${loadSrc[0]}
    return {
      loadActivity, mergeActivity,
      get activity() { return activity; },
      get cursor() { return activityCursorId; },
      get loaded() { return activityLoaded; },
      get error() { return activityError; },
      get renders() { return renders; }
    };
  `)(api)
}
const rows = (from, to) => {
  const out = []
  for (let i = from; i <= to; i++) out.push({ id: i, action: 'LOGIN', created_at: '2026-01-01T00:00:00Z' })
  return out
}
const ids = a => a.map(r => r.id)

console.log('--- 1. initial load ---')
{
  const seen = []
  const m = build(async (p) => { seen.push(p); return rows(1, 5) })
  await m.loadActivity(true)
  ok('T1', 'first load asks for the newest window, no cursor',
     !/id=gt\./.test(seen[0]) && /limit=1000/.test(seen[0]), seen[0])
  ok('T1b', 'first load orders by id.desc', /order=id\.desc/.test(seen[0]))
  eq('T2', 'first load fills the array newest-first', ids(m.activity), [5, 4, 3, 2, 1])
  eq('T3', 'cursor is the highest id seen', m.cursor, 5)
  ok('T3b', 'loaded flag set', m.loaded === true)
}

console.log('')
console.log('--- 2. no new rows ---')
{
  const seen = []
  let call = 0
  const m = build(async (p) => { seen.push(p); return call++ === 0 ? rows(1, 5) : [] })
  await m.loadActivity(true)
  const before = m.renders
  await m.loadActivity(true)
  ok('T4', 'second load uses the id cursor', /id=gt\.5/.test(seen[1]), seen[1])
  ok('T5', 'it does NOT re-download the full window', /id=gt\./.test(seen[1]), seen[1])
  eq('T6', 'array unchanged when nothing is new', ids(m.activity), [5, 4, 3, 2, 1])
  ok('T7', 'no repaint when nothing changed', m.renders === before, 'renders ' + before + ' -> ' + m.renders)
  ok('T7b', 'cursor did not move', m.cursor === 5)
}

console.log('')
console.log('--- 3. new rows arrive ---')
{
  const seen = []
  let call = 0
  const m = build(async (p) => { seen.push(p); return call++ === 0 ? rows(1, 5) : rows(6, 6) })
  await m.loadActivity(true)
  await m.loadActivity(true)
  eq('T8', '1 new row is merged', ids(m.activity), [6, 5, 4, 3, 2, 1])
  eq('T9', 'cursor advances to the new max', m.cursor, 6)
  ok('T9b', 'only rows past the cursor were requested', /id=gt\.5/.test(seen[1]))
}
{
  let call = 0
  const m = build(async () => (call++ === 0 ? rows(1, 5) : rows(6, 10)))
  await m.loadActivity(true)
  await m.loadActivity(true)
  eq('T10', '5 new rows merged newest-first', ids(m.activity), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
}
{
  // server returns them shuffled and overlapping -> order must still hold
  const m = build(async (p) => (/id=gt/.test(p)
    ? [{ id: 9 }, { id: 7 }, { id: 8 }, { id: 9 }, { id: 7 }]
    : [{ id: 5 }, { id: 4 }]))
  await m.loadActivity(true)
  await m.loadActivity(true)
  eq('T11', 'out-of-order and duplicate rows dedup + sort', ids(m.activity), [9, 8, 7, 5, 4])
}
console.log('')
console.log('--- 4. the 1000 cap ---')
{
  let call = 0
  const m = build(async () => (call++ === 0 ? rows(1, 1000) : rows(1001, 1005)))
  await m.loadActivity(true)
  ok('T12', 'initial array is exactly 1000', m.activity.length === 1000, 'len ' + m.activity.length)
  await m.loadActivity(true)
  eq('T13', 'after 5 new rows the newest 1000 are kept', ids(m.activity).slice(0, 5), [1005, 1004, 1003, 1002, 1001])
  ok('T14', 'array NEVER exceeds 1000', m.activity.length === 1000, 'len ' + m.activity.length)
  ok('T14b', 'oldest row evicted, newest kept', m.activity[999].id === 6, 'oldest held id ' + m.activity[999].id)
  eq('T14c', 'cursor is the true max, not the array length', m.cursor, 1005)
}

console.log('')
console.log('--- 5. gaps, reloads, errors ---')
{
  let call = 0
  const m = build(async (p) => (call++ === 0
    ? [{ id: 1 }, { id: 2 }, { id: 10 }, { id: 11 }]     // 3..9 never existed
    : [{ id: 12 }]))
  await m.loadActivity(true)
  await m.loadActivity(true)
  eq('T15', 'a gap in the id sequence loses nothing', ids(m.activity), [12, 11, 10, 2, 1])
  eq('T16', 'cursor is the real max across the gap', m.cursor, 12)
}
{
  const seen = []
  const m = build(async (p) => { seen.push(p); return rows(1, 3) })
  await m.loadActivity(true)
  const fresh = build(async (p) => { seen.push(p); return rows(1, 3) })
  await fresh.loadActivity(true)                        // simulates a page reload
  ok('T17', 'a page reload fetches the full window again', !/id=gt\./.test(seen[3]), seen[3])
}
{
  const m = build(async () => { throw new Error('boom') })
  await m.loadActivity(true)
  eq('T18', 'a failed fetch still surfaces the error', m.error, 'boom')
  ok('T18b', 'a failed fetch still repaints (so the error is visible)', m.renders === 2)
}
{
  // a backdated created_at must not affect order or cursor - we key on id only
  const m = build(async (p) => (p.includes('id=gt')
    ? [{ id: 3, created_at: '1999-01-01T00:00:00Z' }]
    : [{ id: 2, created_at: '2030-01-01T00:00:00Z' }, { id: 1, created_at: '2030-01-01T00:00:00Z' }]))
  await m.loadActivity(true)
  await m.loadActivity(true)
  eq('T19', 'backdated created_at does not reorder (id wins)', ids(m.activity), [3, 2, 1])
}
{
  // an empty table must not corrupt the cursor or wedge the poll
  let call = 0
  const m = build(async () => (call++ === 0 ? [] : [{ id: 1 }]))
  await m.loadActivity(true)
  ok('T19b', 'empty first load sets no cursor', m.cursor === 0)
  await m.loadActivity(true)
  eq('T19c', 'first row after an empty load is picked up', ids(m.activity), [1])
  eq('T19d', 'cursor adopts it', m.cursor, 1)
}

console.log('')
console.log('--- 6. untouched guarantees ---')
{
  const tick = /async function analyticsTick\(\)\s*\{([\s\S]*?)\n    \}/.exec(adminCode)
  const body = tick ? tick[1] : ''
  ok('T20', 'hidden-tab guard still in analyticsTick', /if \(document\.hidden\) return;/.test(body))
  const g = body.indexOf('if (document.hidden) return;')
  const f = Math.min(...['loadBuckets(true)', 'loadActivity(true)'].map(s => body.indexOf(s)))
  ok('T20b', 'guard still precedes every fetch', g >= 0 && f >= 0 && g < f, 'guard@' + g + ' fetch@' + f)
  ok('T21', 'ANALYTICS_REFRESH_MS still the free-plan value (120s)',
     /const ANALYTICS_REFRESH_MS = 120000/.test(adminCode),
     'doubled 60s->120s to halve console egress; must not creep back down')
  ok('T22', 'created_at is NOT used as a cursor',
     !/created_at\.gt|created_at\.gte|order=created_at/.test(loadSrc[0]))
  const sql = readFileSync(join(HERE, '..', 'migrations', '0005_activity_and_presence.sql'), 'utf8')
  ok('T23', 'append-only trigger still in place', /BEFORE UPDATE OR DELETE ON public\.activity_logs/.test(sql))
  // Comments are stripped first: 0018 documents "GRANT STAYS. Revoking
  // INSERT on public.activity_logs is the ..." and that prose otherwise
  // matches a GRANT scan perfectly well.
  const MIG = join(HERE, '..', 'migrations')
  const grants = readdirSync(MIG)
    .filter(f => f.endsWith('.sql'))
    .map(f => readFileSync(join(MIG, f), 'utf8').replace(/--[^\n]*/g, ''))
    .join('\n')
  const everyGrant = (grants.match(/GRANT[^;]*ON public\.activity_logs[^;]*/gi) || []).join(' | ')
  ok('T24', 'grant is still SELECT, INSERT only - no UPDATE/DELETE anywhere',
     everyGrant.length > 0 && !/UPDATE|DELETE/i.test(everyGrant), everyGrant || 'NO GRANT FOUND')
  ok('T25', 'admin.js issues no DELETE/PATCH/POST against activity_logs',
     !/activity_logs[^"']*['"]\s*,?\s*method:\s*['"](DELETE|PATCH|POST|PUT)/.test(adminCode))
  ok('T26', 'RLS still enabled on activity_logs', /ALTER TABLE public\.activity_logs ENABLE ROW LEVEL SECURITY/.test(sql))
  ok('T27', 'audit_select_admin policy still present',
     /CREATE POLICY audit_select_admin ON public\.activity_logs/.test(grants))
}

console.log('')
console.log('--- 7. MUTATION: revert to a full re-fetch, incremental must break ---')
{
  // The pre-P2 implementation, lifted verbatim. If the incremental
  // assertions above also passed against THIS, they would be measuring the
  // wrong thing entirely.
  const OLD = `async function loadActivity(force) {
        if (activityLoaded && !force) return;
        try {
            const rows = await api('activity_logs?select=*&order=created_at.desc&limit=1000');
            activity = Array.isArray(rows) ? rows : [];
            activityLoaded = true;
            activityError = '';
        } catch (error) {
            activityError = (error && error.message) || String(error);
        }
        populateActivityUsers();
        populateActivityActions();
        renderActivity();
        renderHourly();
    }`
  const seen = []
  let call = 0
  const mutant = new Function('api', `
    const ACTIVITY_WINDOW = 1000;
    let activity = [], activityLoaded = false, activityCursorId = 0, activityError = '';
    let renders = 0;
    function populateActivityUsers() {}
    function populateActivityActions() {}
    function renderActivity() { renders++; }
    function renderHourly() { renders++; }
    ${OLD}
    return { loadActivity, get activity(){return activity;}, get cursor(){return activityCursorId;} };
  `)(async (p) => { seen.push(p); return call++ === 0 ? rows(1, 5) : rows(6, 6) })
  await mutant.loadActivity(true)
  const before = mutant.activity.length
  await mutant.loadActivity(true)
  ok('M1', 'MUTANT redownloads the whole log (no cursor)', !/id=gt\./.test(seen[1]), seen[1])
  ok('M2', 'MUTANT replaces instead of merging, dropping held rows',
     mutant.activity.length < before + 1, 'before ' + before + ' -> after ' + mutant.activity.length)
  ok('M3', 'MUTANT keeps no cursor at all', mutant.cursor === 0, 'cursor ' + mutant.cursor)
}

console.log('')
console.log(fail === 0
  ? '==== ALL PASSED — ' + pass + ' passed, 0 failed ===='
  : '==== ' + fail + ' FAILED — ' + pass + ' passed, ' + fail + ' failed ====')
if (fail) { failures.forEach(f => console.log('   - ' + f)); process.exitCode = 1 }
console.log('')
     