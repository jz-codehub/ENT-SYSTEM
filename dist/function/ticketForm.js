/* =====================================================================
 *  ticketForm.js  -  "Report a problem", mounted on index.html
 * ---------------------------------------------------------------------
 *  A doctor or a secretary must be able to say something is wrong
 *  WITHOUT leaving the page they are working on and WITHOUT hunting for a
 *  separate site. So this is a panel on the dashboard, not a page of its
 *  own.
 *
 *  IT DOES NOT EXIST FOR AN ADMIN. An admin answers the queue; they do not
 *  file against it. mount() returns immediately for that role, so the
 *  markup can stay in index.html unconditionally.
 *
 *  SCOPE is the first question an admin asks: is the CF4 form broken, or
 *  the whole app? Four choices beats a free-text subject the admin has to
 *  guess at, and it makes the queue filterable by area.
 *
 *  As with every other query here, "mine" is filtered EXPLICITLY and not
 *  left to RLS. That is the admin.js lesson: a policy that narrows to one
 *  row for a doctor returns the wrong row for an admin, silently.
 *
 *  Depends on: supabaseClient.js (EntSupabase), auth.js (EntAuth).
 * ===================================================================== */
(function (window) {
    'use strict';

    const Auth = window.EntAuth;
    const byId = (id) => document.getElementById(id);
    const esc = (v) => (Auth && Auth.escapeHtml ? Auth.escapeHtml(v) : String(v == null ? '' : v));

    const SCOPE = [
        { v: 'nasal',    t: 'Nasal endoscopy',    h: 'The nasal endoscopy report form' },
        { v: 'laryngeal', t: 'Laryngeal endoscopy', h: 'The laryngeal endoscopy report form' },
        { v: 'cf4',      t: 'CF4 form',            h: 'The CF4 / PhilHealth form' },
        { v: 'system',   t: 'The app itself',      h: 'Sign-in, cloud sync, navigation - anything else' },
    ];
    const KIND = [
        { v: 'bug',      t: 'Something is broken' },
        { v: 'access',   t: 'I cannot sign in' },
        { v: 'data',     t: 'A record looks wrong' },
        { v: 'question', t: 'How do I...' },
        { v: 'other',    t: 'Something else' },
    ];
    const PRIORITY = [
        { v: 'low',    t: 'Low - whenever there is time' },
        { v: 'normal', t: 'Normal' },
        { v: 'high',   t: 'High - it is slowing me down' },
        { v: 'urgent', t: 'Urgent - I cannot work' },
    ];
    const STATUS = {
        open:        { t: 'Open',        c: 'is-open' },
        in_progress: { t: 'Being looked at', c: 'is-progress' },
        resolved:    { t: 'Resolved',    c: 'is-resolved' },
        closed:      { t: 'Closed',      c: 'is-closed' },
    };
    const ROLE_NAME = { admin: 'Administrator', doctor: 'Doctor', secretary: 'Secretary' };

    function scopeLabel(v) {
        const hit = SCOPE.find(function (s) { return s.v === v; });
        return hit ? hit.t : 'The app itself';
    }
    function ago(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const s = (Date.now() - d.getTime()) / 1000;
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        if (s < 604800) return Math.floor(s / 86400) + 'd ago';
        return d.toLocaleDateString();
    }
    function when(iso) {
        const d = new Date(iso);
        return (iso && !isNaN(d)) ? d.toLocaleString() : '';
    }

    let me = null;
    let mine = [];
    let openId = null;
    let thread = [];
    let threadLoading = false;
    let busy = false;

    // Declared out here, not inside wire(): boot() needs them too, to hide the
    // card for an admin, and a const inside wire() would simply not exist
    // by the time boot() runs.
    const modal = byId('tfModal');
    const card = byId('tfOpen');

    function say(msg, bad) {
        const box = byId('tfNotice');
        if (!box) return;
        box.textContent = msg || '';
        box.className = 'ent-tf-notice' + (msg ? ' show' : '') + (bad ? ' is-bad' : ' is-ok');
    }
    function friendly(e) {
        const m = String((e && (e.message || e.error_description)) || e || '');
        if (/row-level security|42501/i.test(m)) return 'You do not have permission for that.';
        if (/no active staff profile/i.test(m)) return 'Your account is not active. Ask an administrator.';
        if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection to the server.';
        // The title is optional and is derived when blank, so this can only
        // mean the DATABASE refused it - which is our fault, not the reporter's.
        // Do not tell a clinic staff member they failed to type a field they
        // were never asked for.
        if (/tickets_subject_shape|btrim\(subject\)/i.test(m))
            return 'The report was rejected by the server (title length). Please try again.';
        return m.replace(/^.*?:\s*/, '').slice(0, 150) || 'Something went wrong.';
    }
    function api(path, opts) { return window.EntSupabase.apiRequest(path, opts); }

    /* --------------------------- data ---------------------------- */

    /* "Has the admin answered yet?"
     *
     * The thread already knows who wrote the last message
     * (tickets.last_message_by), so "there is something new for you" needs no
     * notifications table, no server change and no migration. What it does
     * need is a memory of what you had already looked at, because "the last
     * message is not mine" is not the same as "you have not read it yet" -
     * without that, a badge would sit on a ticket forever.
     *
     * localStorage is the right size for this: it is per-person, per-device,
     * and losing it costs nothing worse than one extra badge. A server table
     * would mean the badge follows you to another machine and then needs a
     * read-receipt write on every open, which is a lot of machinery for a
     * convenience that only has to survive a page reload.
     */
    const SEEN_KEY = 'entTkSeenV1';
    function seenMap() {
        try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function markSeen(id, stamp) {
        if (!id) return;
        const m = seenMap();
        m[id] = stamp || new Date().toISOString();
        try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ }
    }
    /** True when someone else wrote last and the reader had not seen it. */
    function isUnread(t) {
        if (!t || !t.last_message_by) return false;
        if (t.last_message_by === me.id) return false;
        const seen = seenMap()[t.id];
        if (!seen) return true;
        return new Date(t.last_message_at || 0).getTime() > new Date(seen).getTime() + 1000;
    }
    function unreadCount() {
        return mine.filter(isUnread).length;
    }

    /* Declared as a function so switchTab() and loadMine() can call it before
     * the export object at the bottom of the file has been assigned. */
    function notifyUnread() {
        try {
            window.dispatchEvent(new CustomEvent('ticketform:unread', {
                detail: { count: unreadCount() }
            }));
        } catch (e) { /* no CustomEvent in this environment */ }
    }

    /** Drives the badge in the page header for everyone. */
    function paintBell(count) {
        const bell = byId('tfBell');
        if (!bell) return;
        const pip = byId('tfBellCount');
        if (pip) {
            pip.textContent = count > 9 ? '9+' : String(count);
            pip.hidden = !count;
        }
        bell.classList.toggle('has-unread', count > 0);
        bell.setAttribute('title', count
            ? count + (count === 1 ? ' ticket needs your attention' : ' tickets need your attention')
            : 'Your tickets');
    }

    function switchTab(which) {
        const minePane = byId('tfPaneMine');
        const newPane = byId('tfPaneNew');
        const tMine = byId('tfTabMine');
        const tNew = byId('tfTabNew');
        if (!minePane || !newPane) return;
        const onNew = which === 'new';
        minePane.hidden = onNew;
        newPane.hidden = !onNew;
        if (tMine) { tMine.classList.toggle('is-active', !onNew); tMine.setAttribute('aria-selected', String(!onNew)); }
        if (tNew) { tNew.classList.toggle('is-active', onNew); tNew.setAttribute('aria-selected', String(onNew)); }
        const title = byId('tfTitle');
        const sub = byId('tfSub');
        if (title) title.textContent = onNew ? 'Report a problem' : 'Your tickets';
        if (sub) sub.textContent = onNew
            ? 'An administrator answers here. Pick what is broken, say what happened.'
            : 'See what you reported, and whether an administrator has answered.';
        // Opening the list is an implicit "I have looked", so clear it there.
        if (!onNew) {
            mine.forEach(function (t) { markSeen(t.id, t.last_message_at); });
            paintBell(0);
            if (typeof notifyUnread === 'function') notifyUnread();
        } else {
            const first = document.querySelector('input[name="tfScopeRadio"]:checked')
                || document.querySelector('input[name="tfScopeRadio"]');
            if (first && first.focus) setTimeout(function () { first.focus(); }, 60);
        }
    }

    async function loadMine() {
        const q = new URLSearchParams();
        q.set('select', 'id,subject,scope,category,priority,status,created_at,last_message_at,last_message_by');
        // EXPLICIT. RLS agrees, but never rely on it alone.
        q.set('created_by', 'eq.' + me.id);
        q.set('order', 'last_message_at.desc');
        q.set('limit', '50');
        const rows = await api('tickets?' + q.toString());
        mine = Array.isArray(rows) ? rows : [];
        render();
        // The count just changed, so tell the dashboard badge about it.
        notifyUnread();
    }

    async function loadThread(id) {
        threadLoading = true;
        const q = new URLSearchParams();
        q.set('select', 'id,body,author_id,author_role,created_at');
        q.set('ticket_id', 'eq.' + encodeURIComponent(id));
        q.set('order', 'created_at.asc');
        q.set('limit', '200');
        try {
            const rows = await api('ticket_messages?' + q.toString());
            thread = Array.isArray(rows) ? rows : [];
        } finally {
            threadLoading = false;
        }
        render();
    }

    /* Open one ticket.
     *
     * The list stays exactly where it is; the report comes to the reader as a
     * pop-up with its own close control, instead of appearing underneath the
     * list and pushing it out of view. */
    function openView(id) {
        if (!id) return;
        openId = id;
        thread = [];
        threadLoading = true;
        // Opening it IS reading it. Without this the "New reply" flag survives
        // the very click that was meant to clear it.
        const t = mine.find(function (x) { return x.id === id; });
        if (t) markSeen(t.id, t.last_message_at);
        render();
        loadThread(id).catch(function (err) { say(friendly(err), true); });
    }
    function closeView() {
        if (!openId) return;
        openId = null;
        thread = [];
        threadLoading = false;
        render();
    }

    /* -------------------------- rendering ------------------------- */
    function render() {
        const list = byId('tfList');
        if (list) {
            if (!mine.length) {
                list.innerHTML = '<p class="ent-tf-empty">You have not reported anything yet.</p>';
            } else {
                /* A COUNT LINE ABOVE THE LIST.
                   Before, the only way to learn whether an administrator had
                   ever answered was to read every card. Three words - how many
                   are still active, how many carry a new reply, how many in
                   total - answer the question a reporter actually opens this
                   panel with, without scrolling a single card. */
                const active = mine.filter(function (t) {
                    return t.status === 'open' || t.status === 'in_progress';
                }).length;
                const newReplies = mine.filter(isUnread).length;
                const summary =
                    '<div class="ent-tf-summary">'
                    + '<span class="ent-tf-sum-item"><b>' + active + '</b> active</span>'
                    + (newReplies
                        ? '<span class="ent-tf-sum-item is-alert"><b>' + newReplies + '</b> new '
                            + (newReplies === 1 ? 'reply' : 'replies') + '</span>'
                        : '')
                    + '<span class="ent-tf-sum-item is-quiet"><b>' + mine.length + '</b> in total</span>'
                    + '</div>';

                list.innerHTML = summary + mine.map(function (t) {
                    const st = STATUS[t.status] || STATUS.open;
                    const on = t.id === openId ? ' is-open' : '';
                    // The whole reason this row exists: is there something here
                    // for me that I have not read? Say so in words, not with a
                    // coloured dot alone.
                    const unread = isUnread(t);
                    /* THREE LINES, EACH WITH ONE JOB.
                       1. what it is      - subject, two lines of room
                       2. where and when  - the part of the app, and how long ago
                       3. what to do      - the new-reply banner, or nothing
                       The chevron is decoration, not a control: the whole card is
                       the button, so the arrow only has to point at a target
                       that is already comfortably tappable. */
                    return '<button type="button" class="ent-ticket' + on
                            + (unread ? ' is-unread' : '') + '" data-id="' + esc(t.id) + '">' +
                        '<span class="ent-ticket-top">' +
                            '<span class="ent-ticket-subject">' + esc(t.subject) + '</span>' +
                            '<span class="ent-badge ' + st.c + '">' + esc(st.t) + '</span>' +
                        '</span>' +
                        '<span class="ent-ticket-meta">' +
                            '<span class="ent-ticket-scope">' + esc(scopeLabel(t.scope)) + '</span>' +
                            '<span class="ent-ticket-sep" aria-hidden="true"></span>' +
                            '<span class="ent-ticket-when">'
                                + esc(ago(t.last_message_at || t.created_at)) + '</span>' +
                        '</span>' +
                        (unread
                            ? '<span class="ent-ticket-new">'
                                + '<span class="ent-ticket-pip" aria-hidden="true"></span>'
                                + 'New reply from the administrator</span>'
                            : '') +
                        '<span class="ent-ticket-go" aria-hidden="true"></span>' +
                    '</button>';
                }).join('');
            }
        }

        const count = unreadCount();
        const tabCount = byId('tfTabCount');
        if (tabCount) {
            tabCount.textContent = mine.length ? String(mine.length) : '';
            tabCount.hidden = !mine.length;
        }
        paintBell(count);

        renderView();
    }

    /* renderView() - the one ticket the reader opened, as a pop-up card.
     *
     * This used to render into a panel UNDERNEATH the list, so "opening" a
     * ticket grew the page downward, pushed the list out of view and left the
     * close control below the fold. Reading one report is a deliberate step
     * INTO it, so it belongs on top of the list with its own close button.
     */
    function renderView() {
        const wrap = byId('tfView');
        const box = byId('tfViewCard');
        if (!wrap || !box) return;
        const t = openId ? mine.find(function (x) { return x.id === openId; }) : null;
        if (!t) { wrap.hidden = true; box.innerHTML = ''; return; }
        wrap.hidden = false;
        const st = STATUS[t.status] || STATUS.open;
        const closed = t.status === 'resolved' || t.status === 'closed';
        const kind = (KIND.find(function (k) { return k.v === t.category; }) || KIND[0]).t;
        const urg = (PRIORITY.find(function (p) { return p.v === t.priority; }) || PRIORITY[1]).t;

        /* What they actually sent.
         *
         * The opening message holds the description, but the scope, the kind
         * of problem and the urgency were chosen on three other controls and
         * then vanished from view. So "the report I filled in" could only be
         * half-reconstructed from the thread, and a secretary checking back
         * weeks later could not see what they had claimed about urgency - or
         * that they had claimed it at all. These four values come straight
         * off the ticket row, so they cannot disagree with what was stored.
         */
        const reportCard =
            '<section class="ent-tf-report">' +
                '<h5>What you reported</h5>' +
                '<dl>' +
                    '<div><dt>Part of the app</dt><dd>' + esc(scopeLabel(t.scope)) + '</dd></div>' +
                    '<div><dt>Kind of problem</dt><dd>' + esc(kind) + '</dd></div>' +
                    '<div><dt>Urgency you chose</dt><dd>' + esc(urg) + '</dd></div>' +
                    '<div><dt>Filed on</dt><dd>' + esc(when(t.created_at)) + '</dd></div>' +
                '</dl>' +
            '</section>';

        box.innerHTML =
            '<header class="ent-tfv-head">' +
                '<div class="ent-tfv-headmain">' +
                    '<span class="ent-badge ' + st.c + '">' + esc(st.t) + '</span>' +
                    '<h3 class="ent-tfv-title">' + esc(t.subject) + '</h3>' +
                    '<p class="ent-tfv-meta">Ticket ' + esc(String(t.id).slice(0, 8)) +
                        ' &middot; opened ' + esc(when(t.created_at)) + '</p>' +
                '</div>' +
                '<button type="button" class="ent-tf-x" id="tfViewClose" ' +
                    'aria-label="Close ticket">&times;</button>' +
            '</header>' +
            '<div class="ent-tfv-body">' +
            reportCard +
            '<div class="ent-tf-msgs">' +
                (thread.length ? thread.map(function (m, i) {
                    const mineRow = m.author_id === me.id;
                    // The first message is the report itself, not a reply, so
                    // it is labelled as what it is rather than as a bubble.
                    const first = i === 0;
                    return '<article class="ent-tf-msg' + (mineRow ? ' is-mine' : '') +
                            (first ? ' is-report' : '') + '">' +
                        '<header><b>' + (first ? 'Your description'
                            : (mineRow ? 'You' : esc(ROLE_NAME[m.author_role] || 'Staff'))) +
                        '</b><time>' + esc(when(m.created_at)) + '</time></header>' +
                        '<p>' + esc(m.body).replace(/\n/g, '<br>') + '</p>' +
                    '</article>';
                }).join('')
                    : '<p class="ent-tf-empty">' + (threadLoading
                        ? 'Loading the conversation&hellip;' : 'No messages yet.') + '</p>') +
            '</div>' +
            (closed
                ? '<p class="ent-tf-empty">Closed. Report a new one if it is still wrong.</p>'
                : '<form class="ent-tf-reply" id="tfReplyForm">' +
                    '<textarea id="tfReplyBody" rows="2" maxlength="8000" ' +
                    'placeholder="Add a message or an update&hellip;"></textarea>' +
                    '<button type="submit" class="ent-btn primary">Send</button>' +
                  '</form>') +
            '</div>';
        const closeBtn = byId('tfViewClose');
        if (closeBtn) closeBtn.addEventListener('click', closeView);
        const f = byId('tfReplyForm');
        if (f) f.addEventListener('submit', sendReply);
    }

    /* --------------------------- writing -------------------------- */
    async function file(ev) {
        ev.preventDefault();
        if (busy) return;
        const subject = byId('tfSubject').value.trim();
        const scope = byId('tfScope').value;
        // These are database ENUMS, so an empty string is rejected outright
        // and the whole ticket fails with a raw constraint error. Never send
        // what a <select> happens to hold: fall back to the documented
        // default instead. A control that silently failed to populate must
        // not be able to cost the user their report.
        const category = byId('tfCategory').value || 'bug';
        const priority = byId('tfPriority').value || 'normal';
        const body = byId('tfBody').value.trim();

        // The SUBJECT IS OPTIONAL. Picking the four tiles already told the
        // admin which part of the app is broken, which is the only thing the
        // subject was ever used for. Requiring a second, free-text box on top
        // of that made people stop and stare at a one-line field they had
        // already answered in four taps - and the form refused to send
        // until they wrote something, which read as the app being broken.
        //
        // So: type a subject if you want to, and it is used verbatim. Leave
        // it blank and one is derived from the scope. What the admin READS is
        // the description, and that is still required - it is the whole
        // report.
        const finalSubject = subject.length >= 3
            ? subject
            : scopeLabel(scope) + ' - problem reported';

        if (!body) {
            say('Please describe what happened, in the box below.', true);
            const b = byId('tfBody');
            if (b && b.focus) b.focus();
            return;
        }

        busy = true;
        byId('tfSend').disabled = true;
        say('');
        try {
            // No clinic_id, no created_by: the trigger stamps both.
            const rows = await api('tickets', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify([{
                    subject: finalSubject, scope: scope,
                    category: category, priority: priority,
                }]),
            });
            const made = Array.isArray(rows) ? rows[0] : null;
            if (!made || !made.id) throw new Error('The ticket was not created.');

            // The first message is the description, so nobody has to file a
            // ticket and then immediately type the detail into a second box.
            await api('ticket_messages', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify([{ ticket_id: made.id, body: body }]),
            });

            byId('tfSubject').value = '';
            byId('tfBody').value = '';
            byId('tfPriority').value = 'normal';
            // Show the ticket that was just filed, so the sender sees where it
            // landed instead of a form that simply emptied itself.
            await loadMine();
            switchTab('mine');
            openView(made.id);
            say('Sent. You will get the answer here.', false);
        } catch (e) {
            say(friendly(e), true);
        } finally {
            busy = false;
            byId('tfSend').disabled = false;
        }
    }

    async function sendReply(ev) {
        ev.preventDefault();
        if (busy || !openId) return;
        const body = byId('tfReplyBody').value.trim();
        if (!body) return;
        busy = true;
        say('');
        try {
            // No author_id: it is stamped from the caller's live profile.
            await api('ticket_messages', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify([{ ticket_id: openId, body: body }]),
            });
            await loadThread(openId);
            await loadMine();
            say('Sent.', false);
        } catch (e) {
            say(friendly(e), true);
        } finally {
            busy = false;
        }
    }

    /* --------------------------- mount --------------------------- */
    function wire() {
        // The form and the ticket list now live on pages/reportProblem.html
        // (ticketsPage.js). This file stays on index.html only so the
        // dashboard badge can read unreadCount(), so every element lookup
        // here is GUARDED: on the dashboard none of these ids exist, and an
        // unguarded addEventListener would throw and kill the rest of boot.
        const form = byId('tfForm');
        if (form) form.addEventListener('submit', file);

        // The four big buttons ARE the control; the hidden field is only
        // what the form carries. Keeping them in step is the whole job here.
        const radios = document.querySelectorAll('input[name="tfScopeRadio"]');
        const hidden = byId('tfScope');
        radios.forEach(function (r) {
            r.addEventListener('change', function () {
                if (r.checked) hidden.value = r.value;
            });
        });

        // The "Report a problem" card in the quick-action grid. It has no
        // data-report-type, so dashboard.js ignores the click and this owns
        // it. Reporting is a POP-UP: the dashboard stays exactly as it was,
        // so the doctor goes straight back to their patients.
        function openModal() {
            if (!modal) return;
            modal.classList.add('open');
            // Open on the LIST, not the form. Checking whether the
            // administrator answered is what people come back for; filing a
            // new report is the rare occasion.
            closeView();
            switchTab('mine');
            loadMine().catch(function (err) { say(friendly(err), true); });
        }
        function closeModal() {
            // The one-ticket pop-up lives inside this dialog, so closing the
            // dialog must take it with it rather than leave it to reappear on
            // the next open.
            closeView();
            if (modal) modal.classList.remove('open');
        }
        function setOpen(open) {
            if (modal) modal.classList.toggle('open', !!open);
        }

        if (card) card.addEventListener('click', openModal);

        const close = byId('tfClose');
        if (close) close.addEventListener('click', closeModal);

        // Clicking the dimmed backdrop closes it, but a click INSIDE the card
        // must not - otherwise filling the form would dismiss it halfway.
        if (modal) {
            modal.addEventListener('click', function (e) {
                if (e.target === modal) closeModal();
            });
        }
        // The pop-up's own dimmed area closes it, but a click inside the card
        // must not - the same rule the dialog itself follows.
        const viewWrap = byId('tfView');
        if (viewWrap) {
            viewWrap.addEventListener('click', function (e) {
                if (e.target === viewWrap) closeView();
            });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            // Escape closes the ticket first, then the dialog: one press, one
            // thing, in the order they were opened.
            const view = byId('tfView');
            if (view && !view.hidden) { closeView(); return; }
            closeModal();
        });
        const tfList = byId('tfList');
        if (tfList) tfList.addEventListener('click', function (e) {
            const btn = e.target.closest('.ent-ticket');
            if (!btn) return;
            openView(btn.getAttribute('data-id'));
        });

        // The tab strip. Keyboard users get the usual left/right behaviour.
        const tMine = byId('tfTabMine');
        const tNew = byId('tfTabNew');
        if (tMine) tMine.addEventListener('click', function () { switchTab('mine'); });
        if (tNew) tNew.addEventListener('click', function () { switchTab('new'); });
        document.addEventListener('keydown', function (e) {
            if (!modal || !modal.classList.contains('open')) return;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const pane = byId('tfPaneNew');
            if (!pane) return;
            e.preventDefault();
            const onNew = !pane.hidden;
            switchTab(onNew ? 'mine' : 'new');
            const next = onNew ? tMine : tNew;
            if (next && next.focus) next.focus();
        });

        // While the page is open, a reply that lands should show up on its own.
        // Polling is cheap here - one narrow row read - and it is the only way
        // someone leaves the dashboard open all day and still hears back.
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && me) loadMine().catch(function () { /* offline */ });
        });
        setInterval(function () {
            if (!me || document.hidden) return;
            loadMine().catch(function () { /* offline: keep the last good list */ });
        }, 60000);
    }

    async function boot() {
        const session = await Auth.guard();
        if (!session || !session.user) return;
        me = session.user;

        // An admin answers tickets, they do not file them. The markup stays
        // in index.html unconditionally and is simply hidden here, so there
        // is one page to maintain rather than two role variants.
        if (me.role === 'admin') {
            // The pop-up is for staff to report with. An admin answers the
            // queue from the admin console, so there is nothing here to open.
            if (card) card.hidden = true;
            return;
        }

        // Fill the scope dropdown from the single definition, so the label
        // and the hint can never drift apart.
        const sel = byId('tfScope');
        // options is not guaranteed on a stubbed or freshly parsed node, so
        // ask for the list defensively rather than trusting the property.
        if (sel && !(sel.options || []).length) {
            sel.innerHTML = SCOPE.map(function (s) {
                return '<option value="' + s.v + '"' + (s.v === 'system' ? ' selected' : '') + '>' +
                    esc(s.t) + '</option>';
            }).join('');
        }
        const cat = byId('tfCategory');
        if (cat && !(cat.options || []).length) {
            cat.innerHTML = KIND.map(function (k) { return '<option value="' + k.v + '">' + esc(k.t) + '</option>'; }).join('');
        }
        const pri = byId('tfPriority');
        if (pri && !(pri.options || []).length) {
            pri.innerHTML = PRIORITY.map(function (p) {
                return '<option value="' + p.v + '"' + (p.v === 'normal' ? ' selected' : '') + '>' + esc(p.t) + '</option>';
            }).join('');
        }

        wire();
        try { await loadMine(); } catch (e) { say(friendly(e), true); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    window.EntTicketForm = {
        SCOPE: SCOPE,
        scopeLabel: scopeLabel,
        /* Exposed so the dashboard's "Admin replied" badge can show the count
         * without a second query and, more importantly, without a second copy of
         * the seen-map. dashboard.js reads this; it does not store its own
         * "have I seen this" anywhere. */
        unreadCount: unreadCount,
        notify: notifyUnread
    };
})(window);
