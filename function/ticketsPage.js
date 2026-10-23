/* ============================================================
 * ticketsPage.js - "Your tickets", on pages/tickets.html
 * A doctor or secretary reports here; an admin answers in
 * the admin console. Migrated from ticketForm.js (old
 * dashboard pop-up). Same data contract: clinic_id,
 * created_by and author_id are STAMPED server-side, RLS
 * narrows reads. Depends on supabaseClient.js + auth.js.
 * ========================================================== */
(function (window) {
'use strict';
var Auth = window.EntAuth;
if (!Auth) return;
function byId(id) { return document.getElementById(id); }
function esc(v) { return (Auth && Auth.escapeHtml ? Auth.escapeHtml(v) : String(v == null ? '' : v)); }
var SCOPE = [
{ v: 'nasal', t: 'Nasal endoscopy', h: 'The nasal endoscopy report form' },
{ v: 'laryngeal', t: 'Laryngeal endoscopy', h: 'The laryngeal endoscopy report form' },
{ v: 'cf4', t: 'CF4 form', h: 'The CF4 / PhilHealth form' },
{ v: 'system', t: 'The app itself', h: 'Sign-in, cloud sync, navigation - anything else' }];
var KIND = [
{ v: 'bug', t: 'Something is broken' },
{ v: 'access', t: 'I cannot sign in' },
{ v: 'data', t: 'A record looks wrong' },
{ v: 'question', t: 'How do I...' },
{ v: 'other', t: 'Something else' }];
var PRIORITY = [
{ v: 'low', t: 'Low - whenever there is time' },
{ v: 'normal', t: 'Normal' },
{ v: 'high', t: 'High - it is slowing me down' },
{ v: 'urgent', t: 'Urgent - I cannot work' }];
var STATUS = {
open: { t: 'Open', c: 'is-open' },
in_progress: { t: 'Being looked at', c: 'is-progress' },
resolved: { t: 'Resolved', c: 'is-resolved' },
closed: { t: 'Closed', c: 'is-closed' } };
var ROLE_NAME = { admin: 'Administrator', doctor: 'Doctor', secretary: 'Secretary' };
function scopeLabel(v) {
for (var i = 0; i < SCOPE.length; i++) { if (SCOPE[i].v === v) return SCOPE[i].t; }
return 'The app itself'; }
function ago(iso) {
if (!iso) return '';
var d = new Date(iso);
if (isNaN(d)) return '';
var s = (Date.now() - d.getTime()) / 1000;
if (s < 60) return 'just now';
if (s < 3600) return Math.floor(s / 60) + 'm ago';
if (s < 86400) return Math.floor(s / 3600) + 'h ago';
if (s < 604800) return Math.floor(s / 86400) + 'd ago';
return d.toLocaleDateString(); }
function when(iso) {
var d = new Date(iso);
return (iso && !isNaN(d)) ? d.toLocaleString() : ''; }
var me = null, mine = [], openId = null, thread = [];
var threadLoading = false, busy = false, wantFilter = '';
function say(msg, bad) {
var box = byId('tkNotice');
if (!box) return;
box.textContent = msg || '';
box.className = 'ent-tf-notice' + (msg ? ' show' : '') + (bad ? ' is-bad' : ' is-ok'); }
function pageSay(msg, bad) {
var box = byId('tkPageNotice');
if (!box) { say(msg, bad); return; }
box.textContent = msg || '';
box.className = 'ent-tk-notice' + (msg ? ' show' : '') + (bad ? ' is-bad' : ' is-ok'); }
function friendly(e) {
var m = String((e && (e.message || e.error_description)) || e || '');
if (/row-level security|42501/i.test(m)) return 'You do not have permission for that.';
if (/no active staff profile/i.test(m)) return 'Your account is not active. Ask an administrator.';
if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection to the server.';
if (/tickets_subject_shape|btrim\(subject\)/i.test(m)) return 'The report was rejected by the server (title length). Please try again.';
return m.replace(/^.*?:\s*/, '').slice(0, 150) || 'Something went wrong.'; }
function api(path, opts) { return window.EntSupabase.apiRequest(path, opts); }
var SEEN_KEY = 'entTkSeenV1';
function seenMap() {
try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; }
catch (e) { return {}; } }
function markSeen(id, stamp) {
if (!id) return;
var m = seenMap();
m[id] = stamp || new Date().toISOString();
try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) {} }
function isUnread(t) {
if (!t || !t.last_message_by) return false;
if (me && t.last_message_by === me.id) return false;
var seen = seenMap()[t.id];
if (!seen) return true;
return new Date(t.last_message_at || 0).getTime() > new Date(seen).getTime() + 1000; }
function unreadCount() { return mine.filter(isUnread).length; }
function notifyUnread() {
try { window.dispatchEvent(new CustomEvent('ticketform:unread', { detail: { count: unreadCount() } })); }
catch (e) {} }
async function loadMine() {
var q = new URLSearchParams();
q.set('select', 'id,subject,scope,category,priority,status,created_at,last_message_at,last_message_by');
q.set('created_by', 'eq.' + me.id);
q.set('order', 'last_message_at.desc');
q.set('limit', '50');
var rows = await api('tickets?' + q.toString());
mine = Array.isArray(rows) ? rows : [];
render();
notifyUnread(); }
async function loadThread(id) {
threadLoading = true;
var q = new URLSearchParams();
q.set('select', 'id,body,author_id,author_role,created_at');
q.set('ticket_id', 'eq.' + encodeURIComponent(id));
q.set('order', 'created_at.asc');
q.set('limit', '200');
try { var rows = await api('ticket_messages?' + q.toString()); thread = Array.isArray(rows) ? rows : []; }
finally { threadLoading = false; }
render(); }
function findTicket(id) {
for (var i = 0; i < mine.length; i++) { if (mine[i].id === id) return mine[i]; }
return null; }
function openTicket(id) {
if (!id) return;
openId = id;
thread = [];
threadLoading = true;
var t = findTicket(id);
if (t) markSeen(t.id, t.last_message_at);
showDetail();
render();
loadThread(id).catch(function (err) { say(friendly(err), true); }); }
function showList() {
openId = null; thread = []; threadLoading = false;
var w = byId('tkWelcome'); if (w) w.hidden = false;
var v = byId('tkView'); if (v) v.hidden = true;
var r = byId('tkReport'); if (r) r.hidden = true;
render(); }
function showDetail() {
var w = byId('tkWelcome'); if (w) w.hidden = true;
var v = byId('tkView'); if (v) v.hidden = false;
var r = byId('tkReport'); if (r) r.hidden = true; }
function showReport() {
openId = null;
var w = byId('tkWelcome'); if (w) w.hidden = true;
var v = byId('tkView'); if (v) v.hidden = true;
var r = byId('tkReport'); if (r) r.hidden = false;
render(); }
function filtered() {
var needle = '';
var s = byId('tkSearch');
if (s) needle = String(s.value || '').trim().toLowerCase();
return mine.filter(function (t) {
if (wantFilter === 'open' && t.status !== 'open') return false;
if (wantFilter === 'in_progress' && t.status !== 'in_progress') return false;
if (wantFilter === 'resolved' && !(t.status === 'resolved' || t.status === 'closed')) return false;
if (needle && String(t.subject || '').toLowerCase().indexOf(needle) === -1) return false;
return true; }); }
function render() {
var list = byId('tkList');
if (list) {
var rows = filtered();
if (!mine.length) list.innerHTML = '<p class="ent-tf-empty">You have not reported anything yet.</p>';
else if (!rows.length) list.innerHTML = '<p class="ent-tf-empty">Nothing matches that filter.</p>';
else list.innerHTML = rows.map(function (t) {
var st = STATUS[t.status] || STATUS.open;
var on = t.id === openId ? ' is-open' : '';
var unread = isUnread(t);
return '<button type="button" class="ent-ticket' + on + '" data-id="' + esc(t.id) + '">' +
'<span class="ent-ticket-row"><strong>' + esc(t.subject) + '</strong>' +
'<span class="ent-badge ' + st.c + '">' + esc(st.t) + '</span></span>' +
'<span class="ent-ticket-meta"><span class="ent-ticket-scope">' + esc(scopeLabel(t.scope)) + '</span>' +
'<span class="ent-ticket-dot" aria-hidden="true"></span>' +
'<span class="ent-ticket-when">' + esc(ago(t.last_message_at || t.created_at)) + '</span></span>' +
(unread ? '<span class="ent-ticket-new"><span class="ent-ticket-pip" aria-hidden="true"></span>New reply from the administrator</span>' : '') +
'<span class="ent-ticket-go" aria-hidden="true"></span></button>'; }).join(''); }
var active = 0, done = 0, fresh = 0;
for (var i = 0; i < mine.length; i++) {
var x = mine[i];
if (x.status === 'open' || x.status === 'in_progress') active++; else done++;
if (isUnread(x)) fresh++; }
var sa = byId('tkStatActive'); if (sa) sa.textContent = String(active);
var sn = byId('tkStatNew'); if (sn) sn.textContent = String(fresh);
var sd = byId('tkStatDone'); if (sd) sd.textContent = String(done);
var sl = byId('tkStatAll'); if (sl) sl.textContent = String(mine.length);
renderView(); }
function renderView() {
var box = byId('tkDetailBody');
if (!box) return;
var t = openId ? findTicket(openId) : null;
if (!t) { box.innerHTML = ''; return; }
var st = STATUS[t.status] || STATUS.open;
var closed = t.status === 'resolved' || t.status === 'closed';
var kind = KIND[0].t, urg = PRIORITY[1].t;
for (var k = 0; k < KIND.length; k++) { if (KIND[k].v === t.category) { kind = KIND[k].t; break; } }
for (var p = 0; p < PRIORITY.length; p++) { if (PRIORITY[p].v === t.priority) { urg = PRIORITY[p].t; break; } }
var no = byId('tkViewNo');
if (no) no.textContent = 'Ticket ' + String(t.id).slice(0, 8);
var html = '<header class="ent-tfv-head"><div class="ent-tfv-headmain">' +
'<span class="ent-badge ' + st.c + '">' + esc(st.t) + '</span>' +
'<h3 class="ent-tfv-title">' + esc(t.subject) + '</h3>' +
'<p class="ent-tfv-meta">Ticket ' + esc(String(t.id).slice(0, 8)) + ' &middot; opened ' + esc(when(t.created_at)) + '</p>' +
'</div></header><div class="ent-tfv-body">' +
'<section class="ent-tf-report"><h5>What you reported</h5><dl>' +
'<div><dt>Part of the app</dt><dd>' + esc(scopeLabel(t.scope)) + '</dd></div>' +
'<div><dt>Kind of problem</dt><dd>' + esc(kind) + '</dd></div>' +
'<div><dt>Urgency you chose</dt><dd>' + esc(urg) + '</dd></div>' +
'<div><dt>Filed on</dt><dd>' + esc(when(t.created_at)) + '</dd></div>' +
'</dl></section><div class="ent-tf-msgs">';
if (thread.length) {
for (var i = 0; i < thread.length; i++) {
var m = thread[i];
var mineRow = me && m.author_id === me.id;
var first = i === 0;
html += '<article class="ent-tf-msg' + (mineRow ? ' is-mine' : '') + (first ? ' is-report' : '') + '">' +
'<header><b>' + (first ? 'Your description' : (mineRow ? 'You' : esc(ROLE_NAME[m.author_role] || 'Staff'))) + '</b>' +
'<time>' + esc(when(m.created_at)) + '</time></header>' +
'<p>' + esc(m.body).replace(/\n/g, '<br>') + '</p></article>'; }
} else html += '<p class="ent-tf-empty">' + (threadLoading ? 'Loading the conversation&hellip;' : 'No messages yet.') + '</p>';
html += '</div>';
if (closed) html += '<p class="ent-tf-empty">Closed. Report a new one if it is still wrong.</p>';
else html += '<form class="ent-tf-reply" id="tkReplyForm">' +
'<textarea id="tkReplyBody" rows="2" maxlength="8000" placeholder="Add a message or an update&hellip;"></textarea>' +
'<button type="submit" class="ent-btn primary">Send</button></form>';
html += '</div>';
box.innerHTML = html;
var f = byId('tkReplyForm');
if (f) f.addEventListener('submit', sendReply); }
async function file(e) {
e.preventDefault();
if (busy) return;
var subjEl = byId('tkSubject');
var scopeEl = byId('tkScope');
var catEl = byId('tkCategory');
var priEl = byId('tkPriority');
var bodyEl = byId('tkBody');
var sendEl = byId('tkSend');
var subject = subjEl ? String(subjEl.value || '').trim() : '';
var scope = (scopeEl && scopeEl.value) || 'nasal';
var category = (catEl && catEl.value) || 'bug';
var priority = (priEl && priEl.value) || 'normal';
var body = bodyEl ? String(bodyEl.value || '').trim() : '';
var finalSubject = subject.length >= 3 ? subject : scopeLabel(scope) + ' - problem reported';
if (!body) {
say('Please describe what happened, in the box below.', true);
if (bodyEl && bodyEl.focus) bodyEl.focus();
return; }
busy = true;
if (sendEl) sendEl.disabled = true;
say('');
try {
var rows = await api('tickets', {
method: 'POST',
headers: { Prefer: 'return=representation' },
body: JSON.stringify([{ subject: finalSubject, scope: scope, category: category, priority: priority }]) });
var made = Array.isArray(rows) ? rows[0] : null;
if (!made || !made.id) throw new Error('The ticket was not created.');
await api('ticket_messages', {
method: 'POST',
headers: { Prefer: 'return=representation' },
body: JSON.stringify([{ ticket_id: made.id, body: body }]) });
if (subjEl) subjEl.value = '';
if (bodyEl) bodyEl.value = '';
if (priEl) priEl.value = 'normal';
await loadMine();
openTicket(made.id);
say('Sent. You will get the answer here.', false);
} catch (err) { say(friendly(err), true); }
finally { busy = false; if (sendEl) sendEl.disabled = false; } }
async function sendReply(e) {
e.preventDefault();
if (busy || !openId) return;
var ta = byId('tkReplyBody');
var body = ta ? String(ta.value || '').trim() : '';
if (!body) return;
busy = true;
say('');
try {
await api('ticket_messages', {
method: 'POST',
headers: { Prefer: 'return=representation' },
body: JSON.stringify([{ ticket_id: openId, body: body }]) });
await loadThread(openId);
await loadMine();
say('Sent.', false);
} catch (err) { say(friendly(err), true); }
finally { busy = false; } }
function wire() {
var form = byId('tkForm');
if (form) form.addEventListener('submit', file);
var hidden = byId('tkScope');
var radios = null;
try { radios = document.querySelectorAll ? document.querySelectorAll('input[name="tfScopeRadio"]') : []; }
catch (e) { radios = []; }
var syncRadio = function (r) {
if (r && r.addEventListener) r.addEventListener('change', function () {
if (r.checked && hidden) hidden.value = r.value; }); };
if (radios && typeof radios.forEach === 'function') radios.forEach(syncRadio);
else if (radios && radios.length) { for (var ri = 0; ri < radios.length; ri++) syncRadio(radios[ri]); }
var list = byId('tkList');
if (list) list.addEventListener('click', function (e) {
var btn = (e.target && e.target.closest) ? e.target.closest('.ent-ticket') : null;
if (!btn) return;
var id = btn.getAttribute ? btn.getAttribute('data-id') : null;
if (id) openTicket(id); });
var back = byId('tkViewBack');
if (back) back.addEventListener('click', function () { showList(); });
var rback = byId('tkReportBack');
if (rback) rback.addEventListener('click', function () { showList(); });
var nb = byId('tkNew');
if (nb) nb.addEventListener('click', function () { showReport(); });
var chips = null;
try { chips = document.querySelectorAll ? document.querySelectorAll('[data-tkfilter]') : []; }
catch (e) { chips = []; }
var chipList = [];
if (chips && typeof chips.forEach === 'function') chips.forEach(function (c) { chipList.push(c); });
else if (chips && chips.length) { for (var ci = 0; ci < chips.length; ci++) chipList.push(chips[ci]); }
for (var i = 0; i < chipList.length; i++) {
(function (c) {
if (c && c.addEventListener) c.addEventListener('click', function () {
wantFilter = (c.getAttribute) ? String(c.getAttribute('data-tkfilter') || '') : '';
for (var j = 0; j < chipList.length; j++) {
var on = chipList[j] === c;
if (chipList[j].classList && chipList[j].classList.toggle) chipList[j].classList.toggle('is-on', on);
if (chipList[j].setAttribute) chipList[j].setAttribute('aria-selected', String(on)); }
render(); }); })(chipList[i]); }
var news = null;
try { news = document.querySelectorAll ? document.querySelectorAll('[data-tk-new]') : []; }
catch (e) { news = []; }
var wireNew = function (n) { if (n && n.addEventListener) n.addEventListener('click', function () { showReport(); }); };
if (news && typeof news.forEach === 'function') news.forEach(wireNew);
else if (news && news.length) { for (var ni = 0; ni < news.length; ni++) wireNew(news[ni]); }
var search = byId('tkSearch');
if (search) search.addEventListener('input', function () { render(); });
document.addEventListener('keydown', function (e) {
if (!e || e.key !== 'Escape') return;
var v = byId('tkView');
var r = byId('tkReport');
if ((v && !v.hidden) || (r && !r.hidden)) showList(); });
document.addEventListener('visibilitychange', function () {
if (!document.hidden && me) loadMine().catch(function () {}); });
setInterval(function () {
if (!me || document.hidden) return;
loadMine().catch(function () {}); }, 60000); }
async function boot() {
var session = await Auth.guard();
if (!session || !session.user) return;
me = session.user;
if (me.role === 'admin') {
try {
var dest = (Auth.pageUrl ? Auth.pageUrl('admin.html') : '../pages/admin.html');
if (window.location && typeof window.location.replace === 'function') window.location.replace(dest + '#panel-tickets');
else if (window.location) window.location.href = dest + '#panel-tickets';
} catch (e) {}
return; }
var cat = byId('tkCategory');
if (cat && !(cat.options || []).length) {
cat.innerHTML = KIND.map(function (k) { return '<option value="' + k.v + '">' + esc(k.t) + '</option>'; }).join(''); }
var pri = byId('tkPriority');
if (pri && !(pri.options || []).length) {
pri.innerHTML = PRIORITY.map(function (p) {
return '<option value="' + p.v + '"' + (p.v === 'normal' ? ' selected' : '') + '>' + esc(p.t) + '</option>'; }).join(''); }
wire();
try { await loadMine(); } catch (e) { pageSay(friendly(e), true); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
window.EntTicketForm = {
SCOPE: SCOPE,
scopeLabel: scopeLabel,
unreadCount: unreadCount,
notify: notifyUnread };
})(window);


