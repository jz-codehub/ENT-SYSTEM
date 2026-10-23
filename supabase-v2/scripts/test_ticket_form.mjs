/* =====================================================================
 *  test_ticket_form.mjs - the ticket system: pages/tickets.html
 * ---------------------------------------------------------------------
 *  A doctor or a secretary reports a problem on THEIR OWN page now:
 *  pages/tickets.html carries the form, the thread and the replies, so
 *  reading back an answer does not mean scrolling past a form inside a
 *  pop-up on the dashboard. The dashboard keeps only a LINK to that page
 *  (plus the unread badge), and an admin answers the clinic queue from
 *  the admin console, which never links here.
 *
 *  Checked here:
 *    A. pages/tickets.html exists, and the dashboard links to it
 *    B. tickets.html carries the form and loads its module AFTER auth.js
 *    C. the four scope choices exist as real radios
 *    D. the page boots and a create reaches the server with a scope
 *    E. an admin gets no page at all (redirected away from filing)
 *    F. the admin queue reads scope and can filter by it
 *    G. supabase-js is loaded (a missing tag bounces to login)
 *
 *  Run: node supabase-v2/scripts/test_ticket_form.mjs
 * ===================================================================== */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const indexHtml = readFileSync(join(APP, 'index.html'), 'utf8')
const ticketsHtml = readFileSync(join(APP, 'pages', 'tickets.html'), 'utf8')
const formJs = readFileSync(join(APP, 'function', 'ticketsPage.js'), 'utf8')
const adminHtml = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
const adminJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')

let passed = 0, failed = 0
const ok = (i, w, d) => { passed++; console.log('  PASS  ' + i.padEnd(5) + ' ' + w + (d ? ' - ' + d : '')) }
const bad = (i, w, d) => { failed++; console.log('  FAIL  ' + i.padEnd(5) + ' ' + w + (d ? ' - ' + d : '')) }
const is = (i, w, c, d) => (c ? ok(i, w, d) : bad(i, w, d))

console.log('')
console.log('==== TICKET FORM TESTS ====')
console.log('')

/* ---- A. the page exists, and the dashboard links to it -------------- */
is('T1', 'pages/tickets.html exists', existsSync(join(APP, 'pages', 'tickets.html')),
   'reporting and reading back answers has its own page')
const dashLinks = /href="pages\/tickets\.html"/.test(indexHtml) ||
                  /href="\.\/pages\/tickets\.html"/.test(indexHtml)
is('T2', 'the dashboard links to the ticket page', dashLinks,
   'the "Report a problem" card is a LINK, not a pop-up trigger')

/* ---- A2. every element the JS looks up exists on the page ----------- */
const ids2 = new Set([...ticketsHtml.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(m => m[1]))
const need = ['tkForm', 'tkScope', 'tkSubject', 'tkCategory', 'tkPriority',
               'tkBody', 'tkSend', 'tkNotice', 'tkList', 'tkDetail', 'tkViewCard']
const absent = need.filter(function (x) { return !ids2.has(x) })
is('T3', 'tickets.html carries every element the form needs', absent.length === 0,
   absent.length ? 'MISSING: ' + absent.join(', ') : need.length + ' elements present')
const authAt = ticketsHtml.indexOf('function/auth.js')
const formAt = ticketsHtml.indexOf('function/ticketsPage.js')
is('T4', 'ticketsPage.js loads AFTER auth.js (it needs the session)',
   authAt !== -1 && formAt !== -1 && formAt > authAt,
   'auth.js at ' + authAt + ', ticketsPage.js at ' + formAt)

/* ---- A3. the four scope choices ------------------------------------ */
const radios = [...ticketsHtml.matchAll(/name="tfScopeRadio"\s+value="([a-z0-9]+)"/g)].map(m => m[1])
const wantScope = ['nasal', 'laryngeal', 'cf4', 'system']
is('T5', 'there are exactly four scope choices', radios.length === 4, 'found: ' + radios.join(', '))
is('T6', 'the four are nasal, laryngeal, cf4 and system',
   wantScope.every(function (v) { return radios.includes(v) }), 'expected: ' + wantScope.join(', '))
is('T7', 'the scope radios are real radio inputs (one answer, keyboard navigable)',
   /type="radio"\s+name="tfScopeRadio"/.test(ticketsHtml) && /id="tkScope"\s+name="scope"/.test(ticketsHtml),
   'radios drive a single hidden field, so the form carries one value')


/* ---- B. the panel and the script order ---------------------------- */
/* ---- B2. the card lives in the quick-action grid ------------------ */
/* Counts <a> OR <button>: the ticket card is a LINK (it navigates to
   pages/tickets.html), the View All card always was one, and only the
   three report cards are buttons - FIVE cards in the grid. Either way
   the ent-quick-sub / -label / -icon SPANS inside them must not be
   counted, which is what anchoring on the tag name does - a bare
   /ent-quick/g would match the spans too and report 20 cards. */
const cards = [...indexHtml.matchAll(/<(?:a|button)[^>]*class="ent-quick[^"]*"/g)].length
const cardIds = [...indexHtml.matchAll(/class="ent-quick[^\"]*"\s+id="([^"]+)"/g)].map(m => m[1])
is('T18', 'there are FIVE quick-action cards (3 reports + ticket + view all)',
   cards === 5,
   cards + ' found: ' + cardIds.join(', '))
is('T19', 'the fourth card is the report-a-problem card',
   cardIds.includes('tfOpen'), 'id="tfOpen" present')
// It must NOT carry data-report-type: dashboard.js delegates on that and
// would open a report instead. The click belongs to ticketForm.js.
const ticketCard = indexHtml.match(/<(?:a|button)[^>]*id="tfOpen"[^>]*>/)
is('T20', 'the ticket card has NO data-report-type (dashboard.js would hijack it)',
   !!ticketCard && !/data-report-type/.test(ticketCard[0]),
   !!ticketCard ? 'the card is a plain link to pages/tickets.html' : 'card not found')
is('T20b', 'the ticket card IS a link (works even if a script fails to load)',
   !!ticketCard && /^<a\b/.test(ticketCard[0]) && /href="pages\/tickets\.html"/.test(ticketCard[0]),
   ticketCard ? ticketCard[0].slice(0, 90) : 'card not found')
is('T21', 'the three report cards still carry data-report-type',
   (indexHtml.match(/data-report-type=/g) || []).length === 3,
   (indexHtml.match(/data-report-type=/g) || []).length + ' report buttons')

/* ---- B3. two columns, and cards that are tall enough to tap ------- */
// Comments are stripped first. The CSS explains why it is NOT auto-fit
// and says the word uto-fit in prose, which would otherwise lose the match
// and report a correct layout as broken.
const dashCss = readFileSync(join(APP, 'style', 'dashboard.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const gridBlock = (dashCss.match(/\.ent-quick-grid\s*\{[\s\S]*?\}/) || [''])[0]
is('T22', 'the quick-action grid is TWO columns',
   /grid-template-columns:\s*repeat\(2,/.test(gridBlock) &&
   !/auto-fit/.test(gridBlock),
   (gridBlock.match(/grid-template-columns:[^;]*/) || ['none'])[0].trim())
const cardBlock = (dashCss.match(/\.ent-quick\s*\{[\s\S]*?\}/) || [''])[0]
is('T23', 'the cards are taller than the original 13px padding',
   /min-height:\s*7\dpx/.test(cardBlock) && /padding:\s*1[89]px|20px/.test(cardBlock),
   (cardBlock.match(/min-height:[^;]*/) || [''])[0].trim())

/* ---- B4. the form lives on its OWN PAGE, not in a pop-up ----------- */
is('T24', 'the form lives in the page body, not in a modal dialog',
   !/id="tfModal"/.test(ticketsHtml) && /id="tkForm"/.test(ticketsHtml),
   'one pane of the page is the form')

/* ---- B4b. the old pop-up is GONE from the dashboard ---------------- */
is('T25', 'the dashboard carries NO ticket pop-up any more',
   !/id="tfModal"/.test(indexHtml) && !/ent-tf-card/.test(indexHtml),
   'reporting navigates away instead of opening a dialog')
is('T26', 'the old inline panel is GONE',
   !/id="tfPanel"/.test(indexHtml) && !/id="tfToggle"/.test(indexHtml),
   'no leftover section that nothing opens')
is('T27', 'the thread can be left, and Escape returns to the list',
   /id="tkViewBack"/.test(ticketsHtml) && /Escape/.test(formJs) && /showList\(\)/.test(formJs),
   'a Back control on the detail pane, Escape returns to the list')
// There is no overlay to click now, but a reply must never navigate away
// from the page mid-typing.
is('T28', 'the composer stops the default submit',
   /e\.preventDefault\(\)/.test(formJs),
   'the page stays put while a reply is being typed')


/* ---- B5. the dialog's SHAPE, so the redesign cannot silently rot --- */
// Scope first and biggest: it is the only answer that changes WHO reads
// the ticket, so it is asked before any free text.
const scopeAt = ticketsHtml.indexOf('ent-tf-scopes')
const subjectAt = ticketsHtml.indexOf('id="tkSubject"')
is('T29', 'the scope picker comes BEFORE the free-text fields',
   scopeAt !== -1 && subjectAt !== -1 && scopeAt < subjectAt,
   'scope at ' + scopeAt + ', subject at ' + subjectAt)
is('T30', 'each scope tile has an icon and a plain-language hint',
   (ticketsHtml.match(/ent-tf-scope-icon/g) || []).length === 4 &&
   (ticketsHtml.match(/ent-tf-scope-text/g) || []).length === 4,
   '4 icons + 4 labels, so laryngeal is not a bare word')
is('T31', 'the thread pane has a header with a Back control',
   /class="ent-tk-viewhead"/.test(ticketsHtml) && /id="tkViewBack"/.test(ticketsHtml),
   'title + one-tap back, no hunting for a button at the bottom')
// The form and the ticket list are different jobs and must not read as one:
// they are two PANES of the page, and the form is ruled into fieldsets.
is('T32', 'the form and the ticket list are visually separated',
   /id="tkList"/.test(ticketsHtml) && /ent-tf-block/.test(ticketsHtml),
   'fieldsets for the form, a separate pane for your tickets')
// The chosen tile must be obvious without reading the tick.
const tkCss = readFileSync(join(APP, 'style', 'tickets.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
is('T33', 'the chosen scope tile is styled in more than one way',
   /ent-tf-scope:has\(input:checked\)/.test(tkCss) &&
   /inset 0 0 0 1px/.test(tkCss),
   'border + tint + shadow, not a tick alone')

/* ---- B6. THE PANES MUST ACTUALLY SCROLL ---------------------------- */
/* This shipped broken once, in the old pop-up, and it is the kind of bug
   a static check cannot see: a container that hides its overflow with no
   scroller beside it, so the Send button sat below the fold with nothing
   that looked scrollable. Each pane is a bounded flex column: header
   pinned, one region that scrolls. */
const paneCss = (tkCss.match(/\.ent-tk-pane\s*\{[\s\S]*?\}/) || [''])[0]
is('T34', 'each pane is bounded by the viewport, not by its content',
   /max-height:[^;]*dvh/.test(paneCss) ||
   /height:\s*calc\([^)]*dvh/.test(paneCss),
   (paneCss.match(/max-height:[^;]*|height:\s*calc\([^;]*/) || ['none'])[0].trim())
is('T35', 'the pane header is pinned so the Back control stays reachable',
   /\.ent-tk-viewhead\s*\{[^}]*position:\s*sticky/.test(tkCss),
   'position: sticky, top: 0')
/* min-height:0 is not optional. Without it a flex item refuses to shrink
   below its content and overflows the pane instead of scrolling - which
   is the exact bug this block exists to prevent. */
is('T36', 'the list can actually shrink and scroll',
   /\.ent-tk-list\s*\{[\s\S]*?overflow-y:\s*auto[\s\S]*?min-height:\s*0/.test(tkCss),
   'overflow-y:auto + min-height:0')
is('T37', 'the scrolling regions exist in the markup',
   /id="tkList"/.test(ticketsHtml) && /id="tkDetailBody"/.test(ticketsHtml),
   'id="tkList" and id="tkDetailBody" present')
/* If a pane ever hides overflow with no scroller beside it, the bottom of
   the form is unreachable again - so assert the pairing. */
is('T38', 'the pane only hides overflow because a scroller replaces it',
   !/overflow:\s*hidden/.test(paneCss) || /\.ent-tk-list\s*\{|\.ent-tk-detail-body\s*\{/.test(tkCss),
   'hidden is safe ONLY because the scrollers exist')

/* ---- C. the form really loads and really posts --------------------- */
function makeEl(id) {
  const L = {}
  return { id, value: '', checked: false, disabled: false, hidden: false,
    textContent: '', innerHTML: '', className: '', dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener: (e, f) => { (L[e] = L[e] || []).push(f) },
    removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild() {}, remove() {}, focus() {}, scrollIntoView() {},
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    getAttribute: () => null, contains: () => false,
    fire: (e, a) => Promise.all((L[e] || []).map(f => f(a || { preventDefault() {} }))) }
}
function harness(profile) {
  const els = new Map()
  const writes = []
  const J = b => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b })
  const win = {
    __session: { user: { id: profile.id, email: profile.username + '@zztest.invalid' },
                 access_token: 'jwt', expires_at: Date.now() / 1000 + 3600 },
    location: { pathname: '/pages/tickets.html', search: '', href: '',
                origin: 'http://localhost:5500', protocol: 'http:',
                replace() { win.redirected = true }, assign() {} },
    navigator: { userAgent: 'node', onLine: true }, console,
    URLSearchParams, URL, TextEncoder, TextDecoder,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0, clearInterval() {},
    setTimeout: (f) => { try { f() } catch (e) { void e } return 0 }, clearTimeout() {},
    addEventListener() {}, dispatchEvent() {}, confirm: () => true,
    fetch: async (u, o) => {
      const opt = o || {}
      let body = null
      try { body = opt.body ? JSON.parse(opt.body) : null } catch (e) { body = null }
      const url = String(u)
      if (opt.method === 'POST') writes.push({ url, body })
      if (url.includes('/rest/v1/staff_profiles')) return J([profile])
      if (url.includes('ticket_messages')) return opt.method === 'POST' ? J([{ id: 'm1' }]) : J([])
      if (url.includes('/rest/v1/tickets')) {
        if (opt.method === 'POST') return J([{ id: 'T1', subject: body[0].subject, status: 'open' }])
        return J([{ id: 'T1', subject: 's', scope: 'cf4', category: 'bug', priority: 'high',
                   status: 'open', created_at: new Date().toISOString(),
                   last_message_at: new Date().toISOString() }])
      }
      return J([])
    },
    supabase: { createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: win.__session }, error: null }),
      signInWithPassword: async () => ({ data: { user: { id: profile.id } }, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    } }) },
  }
  win.document = {
    readyState: 'complete', hidden: false, title: '',
    body: makeEl('body'),
    createElement: () => makeEl('new'),
    getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id) },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {},
  }
  win.window = win; win.globalThis = win
  let err = ''
  try {
    vm.createContext(win)
    for (const f of ['supabaseClient.js', 'auth.js', 'ticketsPage.js']) {
      vm.runInContext(readFileSync(join(APP, 'function', f), 'utf8'), win, { filename: f })
    }
  } catch (e) { err = String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ') }
  return { win, els, writes, err, g: (id) => win.document.getElementById(id) }
}

const DOC = { id: 'd1', username: 'jess', full_name: 'Jess', role: 'doctor',
              clinic_id: 'c', assigned_doctor_id: null, is_active: true, must_change_password: false }
const ADM = { id: 'a1', username: 'bokskie', full_name: 'Bokskie', role: 'admin',
              clinic_id: 'c', assigned_doctor_id: null, is_active: true, must_change_password: false }

const h = harness(DOC)
is('T8', 'the form scripts load cleanly on tickets.html', h.err === '', h.err || 'clean load')
await new Promise(r => setTimeout(r, 40))

h.g('tkSubject').value = 'CF4 will not save'
h.g('tkBody').value = 'It saves on the device but never reaches the cloud.'
h.g('tkScope').value = 'cf4'
h.g('tkPriority').value = 'high'
await h.g('tkForm').fire('submit', { preventDefault() {} })
await new Promise(r => setTimeout(r, 40))

const post = h.writes.find(w => w.url.includes('/rest/v1/tickets') && w.body)
is('T9', 'filing a ticket sends the scope the user chose', !!post && post.body[0].scope === 'cf4',
   post ? JSON.stringify(post.body[0]) : 'no create POST')
is('T10', 'the create carries NO ownership column',
   !!post && !('clinic_id' in post.body[0]) && !('created_by' in post.body[0]),
   post ? 'keys: ' + Object.keys(post.body[0]).join(', ') : 'n/a')
const msg = h.writes.find(w => w.url.includes('ticket_messages') && w.body)
is('T11', 'the description is sent as the first message', !!msg,
   msg ? JSON.stringify(msg.body[0]).slice(0, 70) : 'none')

const ha = harness(ADM)
await new Promise(r => setTimeout(r, 40))
is('T12', 'an admin is sent away from the filing page',
   ha.win.redirected === true,
   'redirect=' + ha.win.redirected + '  (they answer from the admin console)')
const adminTickets = ha.writes.filter(function (w) { return w.url.includes('/rest/v1/tickets') })
is('T13', 'an admin files no TICKET', adminTickets.length === 0,
   ha.writes.length + ' network write(s) total, ' + adminTickets.length + ' of them tickets')

/* ---- F. the admin queue reads and filters scope -------------------- */
is('T14', 'the admin queue SELECTs scope', /select', 'id,subject,scope/.test(adminJs),
   'scope is in the column list')
is('T15', 'the admin queue can FILTER by scope', /ticketScopeFilter/.test(adminJs),
   'and admin.html offers the filter')
is('T16', 'the admin filter offers all four areas',
   ['nasal', 'laryngeal', 'cf4', 'system'].every(v =>
     new RegExp('value="' + v + '"').test(adminHtml)),
   'nasal, laryngeal, cf4, system')

/* ---- G. supabase-js on the page ----------------------------------- */
is('T17', 'index.html loads supabase-js before auth.js',
   /js\/lib\/supabase\.min\.js/.test(indexHtml) &&
   indexHtml.indexOf('js/lib/supabase.min.js') < indexHtml.indexOf('function/auth.js'),
   'order correct')


/* ---- C2. THE SUBJECT IS OPTIONAL ---------------------------------- */
/* This shipped as a dead end. The four tiles already answer "where", and
   then the form refused to send until the user ALSO wrote a one-line
   subject. Someone who had already answered in four taps was told to go
   and write something else, which reads as the app being broken.

   The description is what the admin actually reads. That is the only
   required free-text field; the title is a convenience. */
const h2 = harness(DOC)
await new Promise(function (r) { setTimeout(r, 40) })
h2.g('tkSubject').value = ''            // deliberately blank
h2.g('tkBody').value = 'The form will not save at all.'
h2.g('tkScope').value = 'cf4'
await h2.g('tkForm').fire('submit', { preventDefault() {} })
await new Promise(function (r) { setTimeout(r, 40) })

const p2 = h2.writes.find(function (w) { return w.url.includes('/rest/v1/tickets') && w.body })
is('T39', 'a ticket files with NO title typed', !!p2,
   p2 ? 'title derived: ' + JSON.stringify(p2.body[0].subject)
      : 'REFUSED - the form is still asking for a title')
is('T40', 'the derived title is legal for the database (3-200 chars)',
   !!p2 && p2.body[0].subject.length >= 3 && p2.body[0].subject.length <= 200,
   p2 ? p2.body[0].subject.length + ' chars' : 'n/a')
is('T41', 'the label marks the title optional',
   /for="tkSubject"[^>]*>[^<]*Add a title/.test(ticketsHtml) && /ent-tf-optional/.test(ticketsHtml),
   'labelled optional rather than discovered by being refused')
is('T42', 'the DESCRIPTION leads, the optional title follows',
   ticketsHtml.indexOf('id="tkBody"') < ticketsHtml.indexOf('id="tkSubject"'),
   'body at ' + ticketsHtml.indexOf('id="tkBody"') + ', subject at ' + ticketsHtml.indexOf('id="tkSubject"'))
console.log('')
console.log('==== ' + (failed ? failed + ' FAILED' : 'TICKET FORM OK') + ' - ' + passed + ' passed, ' + failed + ' failed ====')
console.log('')
process.exitCode = failed ? 1 : 0
