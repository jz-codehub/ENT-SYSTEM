/* =====================================================================
 *  CROSS-CLINIC ACCESS  ·  viewAllAccess.js
 *  ---------------------------------------------------------------------
 *  The first UI for the grant workflow. Everything underneath it was
 *  already built and proven by the live test (23/23); this is the client
 *  that was missing.
 *
 *  WHAT IT DOES, and what it deliberately does NOT do:
 *
 *    1. LISTS every clinic's final patients via ent_view_all_index().
 *    2. OPENS one via ent_open_report(id) - the only route to the payload
 *       cross-clinic, and the one that refuses without a grant.
 *    3. ASKS for permission when the refusal says PERMISSION_REQUIRED.
 *    4. OFFERS approve/revoke, which write or delete one grant row. The
 *       server decides whether the caller is allowed to.
 *
 *  THE ONE RULE THIS FILE EXISTS TO KEEP
 *
 *  The database is the ONLY authority on who may see what. This file never
 *  decides, never caches a permission, and never hides a row the server
 *  sent. can_view / can_edit / can_delete come straight from
 *  ent_view_all_index, which derives them from the same predicates that
 *  guard ent_open_report - so a button that appears here is a button the
 *  server already agreed to. A client-side permission check would be a
 *  second source of truth, and the second one is always the wrong one.
 *
 *  That is why an expired or revoked grant disappears from this list on
 *  the next refresh with no code here noticing: the server stopped saying
 *  can_view, and this file simply stops offering the button.
 *
 *  WHY NO CLIENT-SIDE FILTERING OF THE LIST
 *
 *  ent_view_all_index returns metadata for every clinic on purpose - the
 *  requirement is "see that a patient exists elsewhere", not "read their
 *  record". Hiding foreign clinics here would hide the very thing the
 *  feature exists to show. What the UI must NOT do is pretend a foreign
 *  row is readable when can_view is false, so every such row renders an
 *  explicit "Request access" affordance instead of an Open button.
 *
 *  Depends on: supabaseClient.js (window.EntSupabase), auth.js (EntAuth)
 * ===================================================================== */
(function (window) {
    'use strict';

    const Supabase = window.EntSupabase;
    if (!Supabase) {
        console.error('crossClinic: supabaseClient.js did not load.');
        return;
    }

    const PAGE_SIZE = 50;

    const state = {
        rows: [],
        offset: 0,
        limit: PAGE_SIZE,
        search: '',
        loading: false,
        error: '',
        detail: null,      // the open report, or the refusal, or null
        detailBusy: false,
        notice: '',
        // View filters over the rows ALREADY loaded. They choose what to
        // LOOK at; they never decide what this account may see. can_view is
        // read from the server and nothing here ever recomputes it.
        clinic: '',
        reportType: '',
        onlyOpen: false
    };

    // ------------------------------------------------------------------
    // Data access. Every call goes through the shared apiRequest helper,
    // so the caller's session token is what authenticates and RLS runs.
    // ------------------------------------------------------------------
    // The arguments belong in the JSON BODY, not the query string.
    //
    // PostgREST does not read RPC parameters out of the query string. It
    // parses EVERY query-string parameter as a COLUMN FILTER on the result
    // set, so `?p_limit=50` was read as "filter p_limit by 50" and the server
    // rejected it:
    //     PGRST100  unexpected "5" expecting "not" or operator (eq, gt, ...)
    //     "failed to parse filter (50)"
    // The function never saw its arguments at all. Passing them as a body is
    // what openReport() and approveGrant() below already do, and it is what
    // makes p_limit/p_offset/p_search actually reach ent_view_all_index.
    async function listIndex() {
        const args = { p_limit: state.limit, p_offset: state.offset };
        if (state.search) args.p_search = state.search;
        return Supabase.apiRequest('/rpc/ent_view_all_index', {
            method: 'POST',
            body: JSON.stringify(args)
        });
    }

    async function openReport(reportId) {
        return Supabase.apiRequest('/rpc/ent_open_report', {
            method: 'POST',
            body: JSON.stringify({ p_report: reportId })
        });
    }

    // Approve = one INSERT into report_access_grants. The trigger stamps
    // the author from the session, so this request carries no identity at
    // all: it cannot claim to have been approved by someone else.
    async function approveGrant(reportId, granteeId, reason) {
        return Supabase.apiRequest('/report_access_grants', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{ report_id: reportId, grantee_id: granteeId, reason: reason || '' }])
        });
    }

    // Revoke = DELETE. grants_delete_owner only lets the OWNING clinic's
    // admin (or the report's own doctor) remove a grant.
    async function revokeGrant(reportId, granteeId) {
        return Supabase.apiRequest(
            `/report_access_grants?report_id=eq.${encodeURIComponent(reportId)}` +
            `&grantee_id=eq.${encodeURIComponent(granteeId)}`,
            { method: 'DELETE' }
        );
    }

    // ------------------------------------------------------------------
    // Formatting. One place, so the list and the detail pane cannot
    // disagree about how a date or a name is shown.
    // ------------------------------------------------------------------
    function esc(value) {
        if (window.EntAuth && typeof window.EntAuth.escapeHtml === 'function') {
            return window.EntAuth.escapeHtml(value);
        }
        return String(value ?? '').replace(/[&<>'"]/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[c]);
    }

    function prettyDate(value) {
        if (!value) return '—';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(d);
    }

    const TYPE_LABELS = { cf4: 'CF4 Form', nasal: 'Nasal Endoscopy', laryngeal: 'Laryngeal Endoscopy' };
    function typeLabel(value) {
        const key = String(value || '').toLowerCase();
        return TYPE_LABELS[key] || value || 'Report';
    }

    // PostgREST answers a refused INSERT with the trigger's RAISE text, and
    // a refused DELETE with an empty 204 - the status alone cannot tell
    // "denied" from "done". So the message is what the user is shown, and
    // a failure is never dressed up as success.
    function friendlyError(err) {
        if (!err) return 'Something went wrong.';
        const status = err.status;
        const raw = String(err.message || '');
        const at = raw.indexOf('): ');
        const inner = at >= 0 ? raw.slice(at + 3) : raw;
        if (status === 401) return 'Your session expired. Sign in again.';
        if (status === 403 || /refused/i.test(raw)) return inner || 'The server refused that request.';
        return inner || 'The server could not complete that request.';
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    function visibleRows() {
        return state.rows.filter(function (row) {
            if (state.reportType && String(row.report_type || '') !== state.reportType) return false;
            if (state.clinic && String(row.clinic_name || '') !== state.clinic) return false;
            if (state.onlyOpen && !row.can_view) return false;
            return true;
        });
    }

    function renderStats() {
        const rows = visibleRows();
        const open = rows.filter(function (r) { return r.can_view; }).length;
        const put = function (id, value) {
            const el = document.getElementById(id);
            if (el) el.textContent = String(value);
        };
        put('ccaStatTotal', rows.length);
        put('ccaStatOpen', open);
        put('ccaStatAsk', rows.length - open);

        const count = document.getElementById('ccaCount');
        if (count) {
            // Always say what is HIDDEN as well as what is shown. A filter
            // that silently drops rows reads as "that is all there is".
            count.textContent = rows.length === state.rows.length
                ? rows.length + (rows.length === 1 ? ' record' : ' records') + ' loaded'
                : 'Showing ' + rows.length + ' of ' + state.rows.length + ' loaded';
        }
    }

    function renderClinicOptions() {
        const select = document.getElementById('ccaClinic');
        if (!select) return;
        const names = [];
        state.rows.forEach(function (row) {
            const name = String(row.clinic_name || '').trim();
            if (name && names.indexOf(name) === -1) names.push(name);
        });
        names.sort();
        const options = ['All clinics'].concat(names);
        const signature = options.join('|');
        if (select.dataset.signature === signature) return;   // never rebuild needlessly
        select.dataset.signature = signature;
        select.innerHTML = '';
        options.forEach(function (label) {
            const option = document.createElement('option');
            option.value = label === 'All clinics' ? '' : label;
            option.textContent = label;
            select.appendChild(option);
        });
        select.value = state.clinic || '';
    }

    /* "Viewing ..." - the sentence that decides whether this page is any use
       to the person reading it. It is read from the SAME helpers the user
       chip uses, so the two can never disagree about this account's reach. */
    function renderScope() {
        const el = document.getElementById('ccaScope');
        if (!el) return;
        const auth = window.EntAuth;
        let text = 'everything your account can reach';
        try {
            const user = auth && typeof auth.currentUser === 'function' ? auth.currentUser() : null;
            if (user && user.role === 'admin') text = 'every doctor in your clinic';
            else if (user && user.role === 'doctor') text = 'your own patients only';
            else if (user && user.assigned_doctor_name) text = 'Dr. ' + user.assigned_doctor_name + '\u2019s patients';
            else if (user && user.role === 'secretary') text = 'one doctor\u2019s patients';
        } catch (e) { /* keep the neutral wording */ }
        el.textContent = text;
    }

    /* The connection pill. It used to say "checking..." on this page
       FOREVER: the updater that fixes it lives in admin.js and never ran
       here, so the header looked permanently stuck. It is now driven by this
       module's own requests - and it goes QUIET when all is well, because a
       permanent badge in the corner is noise, not information. */
    function setConn(kind, text) {
        const pill = document.getElementById('connPill');
        const label = document.getElementById('connText');
        if (pill) {
            pill.classList.remove('online', 'offline', 'busy');
            if (kind) pill.classList.add(kind);
        }
        if (label) label.textContent = text;
    }

    /* THE STICKY OFFSET, MEASURED.
     *
     * The table header sticks below the page header, and the distance
     * between them was a hard-coded 124px. A guess is wrong the moment the
     * header wraps, the window is short, or the user chip is appended after
     * boot - and a wrong number is exactly what makes a sticky header float
     * in the middle of the list with records running under it. Measured, it
     * cannot drift. */
    function syncHeaderHeight() {
        const header = document.querySelector('.ent-cca-header');
        if (!header || typeof header.getBoundingClientRect !== 'function') return;
        const height = Math.round(header.getBoundingClientRect().height);
        if (height > 0) document.body.style.setProperty('--cca-head-h', height + 'px');
    }

    function statusPill(row) {
        return row.can_view
            ? '<span class="cca-pill cca-pill-ok">Accessible</span>'
            : '<span class="cca-pill cca-pill-locked">No access</span>';
    }

    function renderRow(row) {
        // can_view is the server's answer, not an estimate. A row it marked
        // false gets an "Ask" button and NEVER an "Open" button, so the UI
        // cannot offer something the database has already refused.
        const action = row.can_view
            ? `<button type="button" class="cca-btn cca-btn-open" data-open="${esc(row.report_id)}">Open</button>`
            : `<button type="button" class="cca-btn cca-btn-ask" data-ask="${esc(row.report_id)}">Request access</button>`;

        // data-label mirrors each <th> in viewAll.html: on a narrow screen the CSS
        // turns every row into a card and paints the label beside the value,
        // so a phone reader never gets an unlabelled field.
        //
        // Eight columns on a laptop was the other half of "why is this page
        // hard to read": everything shrank until nothing was legible. The
        // patient is now the headline with the case and report type under
        // it, clinic and doctor travel together, and access sits next to the
        // button it explains.
        const canOpen = !!row.can_view;
        const subline = [typeLabel(row.report_type), row.case_number ? 'Case ' + row.case_number : '']
            .filter(Boolean).join(' \u00b7 ');
        return `
            <tr class="${canOpen ? 'is-open' : 'is-locked'}">
                <td class="cca-pt" data-label="Patient">
                    <span class="cca-name">${esc(row.patient_name || 'Unnamed patient')}</span>
                    <span class="cca-sub">${esc(subline)}</span>
                </td>
                <td class="cca-clinic" data-label="Clinic & doctor">
                    <span class="cca-clinic-name">${esc(row.clinic_name || '\u2014')}</span>
                    <span class="cca-sub">${esc(row.doctor_name || 'No doctor named')}</span>
                </td>
                <td class="cca-when" data-label="Date">${esc(prettyDate(row.procedure_date || row.created_at))}</td>
                <td class="cca-act" data-label="">${statusPill(row)}${action}</td>
            </tr>`;
    }

    function renderList() {
        const body = document.getElementById('ccaTableBody');
        if (!body) return;

        if (state.loading) {
            body.innerHTML = '<tr><td colspan="4" class="cca-empty">Loading patients…</td></tr>';
            return;
        }
        if (state.error) {
            body.innerHTML = `<tr><td colspan="4" class="cca-empty cca-empty-err">${esc(state.error)}</td></tr>`;
            return;
        }
        const rows = visibleRows();
        if (!rows.length) {
            const filtered = state.rows.length > 0;
            body.innerHTML = `<tr><td colspan="4" class="cca-empty">${
                filtered
                    ? 'No patients match these filters.'
                    : (state.search ? 'No patients match that search.' : 'No patients found.')
            }</td></tr>`;
            return;
        }
        body.innerHTML = rows.map(renderRow).join('');
        renderStats();
        renderClinicOptions();
    }

    /* THE RECORD POP-UP.
     *
     * It used to be a pane BESIDE the table, and that pane was doing three
     * bad things at once: it squeezed the columns on a laptop, it sat blank
     * for most of the session, and it pushed "Load more" off the screen. A
     * <dialog> over the list fixes all three - and it brings the platform's
     * own focus trap, Escape handling and backdrop with it, which is the
     * same reason the ask/approve dialogs on this page are <dialog> too.
     */
    function showRecord(html, title) {
        const body = document.getElementById('ccaRecordBody');
        if (body) body.innerHTML = html;
        const heading = document.getElementById('ccaRecordTitle');
        if (heading && title) heading.textContent = title;
        const dlg = document.getElementById('ccaRecord');
        if (!dlg) return;
        if (typeof dlg.showModal === 'function') {
            if (!dlg.open) dlg.showModal();
            return;
        }
        // No <dialog> support: same content, plain overlay.
        dlg.setAttribute('open', '');
        dlg.classList.add('is-open');
    }

    function closeRecord() {
        const dlg = document.getElementById('ccaRecord');
        state.detail = null;
        if (!dlg) return;
        if (typeof dlg.close === 'function' && dlg.open) dlg.close();
        // Explicit, so the state does not depend on which path closed it
        // (native close(), the Close button, or the backdrop).
        dlg.open = false;
        dlg.removeAttribute('open');
        dlg.classList.remove('is-open');
    }

    // ------------------------------------------------------------------
    // The record's payload -> something a person can read.
    //
    // It used to be dumped raw into a <pre>: honest JSON, but a wall of
    // quoted keys where a form should be. Every level is now flattened
    // into labelled rows, long text stays wrapped inside the card,
    // data:image photos become thumbnails, and the original JSON is
    // still one <details> away. The SERVER decides who may see any of
    // this (ent_open_report already refused those who may not); the
    // client only lays out what it was handed.
    // ------------------------------------------------------------------
    function labelize(key) {
        const s = String(key || '')
            .replace(/[_\-]+/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    }

    function isDataImage(v) {
        return typeof v === 'string' && v.length > 100 && /^data:image\//i.test(v);
    }

    function looksBinary(v) {
        // A megabyte of bare base64 is a photo by another name; printing
        // it would bury the whole form under a wall of characters.
        return typeof v === 'string' && v.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(v);
    }

    function flattenPayload(value, label, out) {
        // Every row is {label, html, wide}: the renderer wraps it in a
        // cell with the label ABOVE the value, which is what makes a
        // column of fields scannable in one pass - side-by-side rows
        // with ragged labels were the clutter this replaced.
        function row(l, inner, wide, valueClass) {
            out.rows.push({
                label: l,
                html: '<span class="cca-field-value' + (valueClass ? ' ' + valueClass : '') + '">'
                    + inner + '</span>',
                wide: Boolean(wide)
            });
        }
        if (isDataImage(value)) {
            row(label, '<img class="cca-thumb" src="' + esc(value) + '" alt="'
                + esc(label || 'Record photo') + '">');
            return;
        }
        if (value === null || value === undefined || value === '') {
            row(label, '<span class="cca-muted">—</span>');
            return;
        }
        if (typeof value === 'boolean') {
            // Colour does the scanning: a field of Yes/No reads at once.
            row(label, value ? 'Yes' : 'No', false, value ? 'is-yes' : 'is-no');
            return;
        }
        if (typeof value !== 'object') {
            const s = String(value);
            if (looksBinary(s)) {
                row(label, '<span class="cca-muted">Binary data ('
                    + Math.round(s.length / 1024) + ' KB)</span>');
            } else if (s.length > 400 || s.indexOf('\n') !== -1) {
                // Long OR multi-line: clinical notes keep their breaks,
                // span the full grid width, and read as prose - not as a
                // squeezed cell or a code dump.
                row(label, esc(s), true, 'cca-longtext');
            } else {
                row(label, esc(s));
            }
            return;
        }
        if (Array.isArray(value)) {
            if (!value.length) {
                row(label, '<span class="cca-muted">None</span>');
                return;
            }
            value.forEach(function (item, i) {
                flattenPayload(item, (label ? label + ' ' : '') + 'Item ' + (i + 1), out);
            });
            return;
        }
        const keys = Object.keys(value);
        if (!keys.length) {
            row(label, '<span class="cca-muted">Empty</span>');
            return;
        }
        keys.forEach(function (k) {
            flattenPayload(value[k], label ? label + ' · ' + labelize(k) : labelize(k), out);
        });
    }

    function renderPayload(payload) {
        let data = payload;
        if (typeof payload === 'string') {
            try { data = JSON.parse(payload); } catch (e) { data = null; }
        }
        const raw = typeof payload === 'string'
            ? payload
            : JSON.stringify(payload ?? {}, null, 2);

        if (data === null || typeof data !== 'object') {
            // Not JSON at all: show the text, still escaped and wrapped.
            return '<pre class="cca-longtext">' + esc(raw || '—') + '</pre>';
        }

        // One section per top-level object/array; scalars gather under
        // "Details". Nested keys read as "Form data · Patient name".
        const sections = [];
        const loose = { rows: [] };
        Object.keys(data).forEach(function (k) {
            const v = data[k];
            const title = labelize(k);
            if (v !== null && typeof v === 'object' && !isDataImage(v)) {
                const sec = { title: title, rows: [] };
                flattenPayload(v, '', sec);
                if (sec.rows.length) sections.push(sec);
            } else {
                flattenPayload(v, title, loose);
            }
        });
        if (loose.rows.length) sections.unshift({ title: 'Details', rows: loose.rows });

        let html = '<div class="cca-fields">';
        if (!sections.length) {
            html += '<p class="cca-hint">This record carries no additional content.</p>';
        }
        sections.forEach(function (sec) {
            html += '<section class="cca-field-group"><h4>' + esc(sec.title) + '</h4>'
                + '<div class="cca-field-grid">';
            sec.rows.forEach(function (r) {
                html += '<div class="cca-field' + (r.wide ? ' is-wide' : '') + '">'
                    + '<span class="cca-field-label">' + esc(r.label || '') + '</span>'
                    + r.html + '</div>';
            });
            html += '</div></section>';
        });
        html += '</div>';
        // The original JSON stays reachable - the layout is a view of it,
        // never a replacement for it.
        html += '<details class="cca-raw"><summary>Raw JSON</summary>'
            + '<pre>' + esc(raw || '{}') + '</pre></details>';
        return html;
    }

    function renderDetail() {
        // Nothing to show means nothing shown: there is no pane sitting
        // empty on the page any more, and a pop-up must never appear on
        // its own.
        if (!state.detail) return;
        if (state.detailBusy) { showRecord('<p class="cca-empty">Opening…</p>'); return; }

        if (state.detail.code === 'PERMISSION_REQUIRED') {
            // The server said no AND said why, without disclosing whether
            // the record exists. Showing its own message keeps the UI from
            // implying knowledge the server refused to give.
            showRecord(`
                <div class="cca-refusal">
                    <h3>No access to this record</h3>
                    <p>${esc(state.detail.message ||
                        'You do not have permission to open this record.')}</p>
                    <p class="cca-hint">The owning clinic decides who may see this patient. Nothing about the
                        record was loaded — only the fact that you asked.</p>
                    <button type="button" class="cca-btn cca-btn-ask" data-ask="${esc(state.detail.report_id)}">
                        Request access
                    </button>
                </div>`, 'No access');
            return;
        }

        const r = state.detail.report || {};
        const listRow = state.rows.find(x => x.report_id === r.id);

        showRecord(`
            <div class="cca-detail-head">
                <div>
                    <h3>${esc(r.patient_name || 'Unnamed patient')}</h3>
                    <p class="cca-hint">${esc(typeLabel(r.report_type))} · ${esc(r.case_number || 'no case number')}</p>
                </div>
                <button type="button" class="cca-btn cca-btn-close" data-close="1">Close</button>
            </div>
            <dl class="cca-detail-grid">
                <div><dt>Owning clinic</dt><dd>${esc(listRow?.clinic_name || '—')}</dd></div>
                <div><dt>Doctor</dt><dd>${esc(listRow?.doctor_name || '—')}</dd></div>
                <div><dt>Procedure date</dt><dd>${esc(prettyDate(r.procedure_date))}</dd></div>
                <div><dt>You can edit</dt><dd>${state.detail.can_edit ? 'Yes' : 'No'}</dd></div>
                <div><dt>You can delete</dt><dd>${state.detail.can_delete ? 'Yes' : 'No'}</dd></div>
            </dl>
            <details class="cca-payload" open>
                <summary>Record content</summary>
                ${renderPayload(r.payload)}
            </details>`, r.patient_name || 'Patient record');
    }

    function renderNotice() {
        const el = document.getElementById('ccaNotice');
        if (!el) return;
        el.textContent = state.notice || '';
        el.hidden = !state.notice;
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    async function refresh() {
        state.loading = true;
        state.error = '';
        renderList();
        setConn('busy', 'loading…');
        try {
            const rows = await listIndex();
            state.rows = Array.isArray(rows) ? rows : [];
            // Quiet when all is well: a permanent badge in the corner is noise.
            if (navigator.onLine === false) setConn('offline', 'Offline');
            else setConn('online', 'Online');
        } catch (err) {
            state.error = friendlyError(err);
            state.rows = [];
            setConn('offline', 'Cannot reach the database');
        } finally {
            state.loading = false;
            renderList();
        }
    }

    async function doOpen(reportId) {
        state.detailBusy = true;
        state.detail = { report_id: reportId };
        renderDetail();
        try {
            const result = await openReport(reportId);
            state.detail = Object.assign({}, result, { report_id: reportId });
        } catch (err) {
            state.detail = {
                report_id: reportId,
                code: 'PERMISSION_REQUIRED',
                message: friendlyError(err)
            };
        } finally {
            state.detailBusy = false;
            renderDetail();
        }
    }

    // ------------------------------------------------------------------
    // Modal dialogs
    //
    // These three actions used window.prompt / window.confirm. A native
    // dialog cannot be styled, ignores the app's palette, traps the layout
    // on a phone, and gives the user no way to see what is about to happen.
    // One <dialog> serves all three; showModal() supplies the focus trap,
    // Escape handling and backdrop, so none of that is re-implemented here.
    //
    // It is a PRESENTATION swap only. Every message, the reason requirement
    // and the sessionStorage write below are unchanged, so what lands in the
    // audit trail is exactly what it was before.
    // ------------------------------------------------------------------
    function askModal(opts) {
        return new Promise(function (resolve) {
            const dlg = document.getElementById('ccaModal');
            if (!dlg || typeof dlg.showModal !== 'function') {
                // No <dialog> support: fall back rather than do nothing.
                resolve(window.prompt(opts.message, opts.value || ''));
                return;
            }
            const form = document.getElementById('ccaModalForm');
            const title = document.getElementById('ccaModalTitle');
            const msg = document.getElementById('ccaModalMsg');
            const field = document.getElementById('ccaModalField');
            const label = document.getElementById('ccaModalLabel');
            const input = document.getElementById('ccaModalInput');
            const help = document.getElementById('ccaModalHelp');
            const ok = document.getElementById('ccaModalOk');
            const cancel = document.getElementById('ccaModalCancel');
            const icon = document.getElementById('ccaModalIcon');

            title.textContent = opts.title || '';
            msg.textContent = opts.message || '';
            icon.innerHTML = opts.icon || '&#128172;';
            ok.textContent = opts.confirmText || 'Confirm';
            cancel.textContent = opts.cancelText || 'Cancel';
            help.textContent = opts.help || '';
            // An alert needs no Cancel; the caller opts in to hiding it
            // rather than every dialog paying for a special case.
            cancel.hidden = Boolean(opts.hideCancel);

            const wantsField = opts.field !== false;
            field.hidden = !wantsField;
            label.textContent = opts.label || 'Reason';
            input.value = opts.value || '';
            input.rows = opts.rows || 3;
            input.placeholder = opts.placeholder || '';

            function cleanup(result) {
                form.onsubmit = null;
                cancel.onclick = null;
                dlg.close();
                resolve(result);
            }
            form.onsubmit = function (e) {
                e.preventDefault();
                cleanup(wantsField ? input.value : true);
            };
            cancel.onclick = function () { cleanup(null); };
            dlg.onclose = function () { resolve(null); };

            dlg.showModal();
            const focus = wantsField ? input : ok;
            setTimeout(function () { focus.focus(); }, 30);
        });
    }

    function confirmModal(opts) {
        return askModal({
            title: opts.title || 'Are you sure?',
            message: opts.message || '',
            icon: opts.icon || '&#9888;&#65039;',
            confirmText: opts.confirmText || 'Yes, continue',
            cancelText: opts.cancelText || 'Cancel',
            danger: opts.danger !== false,
            field: false
        }).then(function (v) { return v === true; });
    }

    // An announcement, not a question: the same <dialog>, one button, no
    // Cancel. Used where the action already succeeded and the user must
    // actually SEE that it did - a notice line is easy to scroll past.
    function alertModal(opts) {
        return askModal({
            title: opts.title || 'Done',
            message: opts.message || '',
            icon: opts.icon || '&#9989;',
            confirmText: opts.confirmText || 'OK',
            field: false,
            hideCancel: true,
            help: opts.help || ''
        }).then(function () { return true; });
    }

    // Asking is NOT approving. grants_insert_owner would refuse the
    // requester anyway, and trying anyway would be a client attempting to
    // grant itself access - so the request is recorded locally and the
    // owning clinic is asked to act. Nothing is shared until they do.
    async function doAsk(reportId) {
        const row = state.rows.find(r => r.report_id === reportId);
        const who = row
            ? `${row.patient_name || 'this patient'} (${row.clinic_name || 'another clinic'})`
            : 'this patient';
        const reason = await askModal({
            title: 'Ask the owning clinic',
            message: 'Request access to ' + who + '. Your reason is stored in the '
                + 'audit trail with your name.',
            label: 'Reason for the request',
            placeholder: 'Consultation on this patient',
            value: 'Consultation on this patient',
            help: 'The owning clinic decides. Nothing is shared until their admin approves.',
            confirmText: 'Send request',
            icon: '&#128172;'
        });
        if (reason === null) return;                        // cancelled
        const tr = String(reason).trim();
        if (!tr) {
            state.notice = 'A reason is required — it becomes part of the audit record.';
            renderNotice();
            return;
        }
        state.notice = 'Sending request…';
        renderNotice();
        try {
            // apiRequest THROWS on failure and resolves with the parsed body
            // (null for a void RPC) on success - there is no resp.ok to read,
            // and checking it made every successful send look like a failure.
            await Supabase.apiRequest('/rpc/ent_request_report', {
                method: 'POST',
                body: JSON.stringify({ p_report: reportId, p_reason: tr })
            });
            state.notice = 'Request sent. The owning clinic must still approve it. The answer will appear in My requests.';
            renderNotice();
            if (document.getElementById('ccaInboxList')) {
                await renderInbox();
            }
            await refresh();
            // The confirmation the user actually SEES: a notice line is
            // easy to miss, a dialog is not. It closes only on its own
            // button or Escape - the send already happened above, this
            // is the receipt.
            await alertModal({
                title: 'Request sent',
                message: 'Your access request for ' + who
                    + ' has reached the owning clinic. Nothing is shared until they approve it - the answer will appear in My requests.',
                icon: '&#9989;',
                confirmText: 'Got it'
            });
        } catch (err) {
            state.notice = friendlyError(err);
            renderNotice();
        }
    }

    // Approve is the OWNING clinic's action. The grantee id is asked for
    // explicitly rather than guessed, because the server must be the one to
    // decide that this caller may approve at all.
    async function doApprove(reportId) {
        const typed = await askModal({
            title: 'Grant access',
            message: 'Enter the staff UUID of the person you are granting access to. '
                + 'The server decides whether you may approve this at all.',
            label: 'Staff UUID',
            placeholder: '00000000-0000-4000-8000-000000000000',
            help: 'Copied from that person in Admin → Users.',
            rows: 1,
            confirmText: 'Grant access',
            icon: '&#128275;'
        });
        if (!typed || !String(typed).trim()) return;
        state.notice = 'Approving…';
        renderNotice();
        try {
            await approveGrant(reportId, typed.trim(), 'Approved from View All');
            state.notice = 'Access approved. The grant is recorded with your name as the approver.';
        } catch (err) {
            // The trigger's own refusal text reaches the user verbatim,
            // because it is the honest answer ("that person is in your own
            // clinic", "you may not grant access to that report").
            state.notice = friendlyError(err);
        } finally {
            renderNotice();
            await refresh();
        }
    }

    async function doRevoke(reportId, granteeId) {
        const ok = await confirmModal({
            title: 'Remove access?',
            message: 'Access for this patient will be taken away. The grant is recorded '
                + 'with your name as the person who removed it.',
            confirmText: 'Remove access',
            icon: '&#128465;'
        });
        if (!ok) return;
        try {
            await revokeGrant(reportId, granteeId || '');
            state.notice = 'Access removed.';
        } catch (err) {
            state.notice = friendlyError(err);
        } finally {
            renderNotice();
            await refresh();
        }
    }

    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // The request-side inbox. One RPC: "what letters did I write, and what
    // happened to them?" The front end never decides status.
    // ------------------------------------------------------------------
    async function renderMyRequests() {
        const list = document.getElementById('ccaMyRequestsList');
        if (!list) return;
        try {
            const rows = await Supabase.apiRequest('/rpc/ent_view_my_access_requests', {
                method: 'POST',
                body: JSON.stringify({})
            });
            const data = Array.isArray(rows) ? rows : [];
            // Explicit second argument on purpose: Array.map passes the
            // INDEX as arg2, and any index >= 1 reads as "true" for
            // canHandle - which would put Grant/Deny buttons back on the
            // requester's own letters from the second row down.
            list.innerHTML = data.length
                ? data.map((row) => renderRequestCard(row, false)).join('')
                : '<div class="cca-empty">No access requests yet.</div>';
            list.classList.remove('cca-empty');
        } catch (err) {
            list.innerHTML = '<div class="cca-empty cca-empty-err">Could not load requests.</div>';
            list.classList.remove('cca-empty');
        }
    }


    // ------------------------------------------------------------------
    // The owner's inbox. One RPC: "who is asking me for what right now?"
    // ------------------------------------------------------------------
    async function renderInbox() {
        const list = document.getElementById('ccaInboxList');
        if (!list) return;
        try {
            const rows = await Supabase.apiRequest('/rpc/ent_view_incoming_access_requests', {
                method: 'POST',
                body: JSON.stringify({})
            });
            const data = Array.isArray(rows) ? rows : [];
            // The inbox IS the owning clinic's view: these cards may act.
            list.innerHTML = data.length
                ? data.map((row) => renderRequestCard(row, true)).join('')
                : '<div class="cca-empty">No pending requests right now.</div>';
            list.classList.remove('cca-empty');
            // The count on the top-bar Inbox button: how a busy clinic
            // sees "something is waiting" without opening anything.
            const badge = document.getElementById('ccaInboxBadge');
            if (badge) {
                badge.hidden = data.length === 0;
                badge.textContent = String(data.length);
            }
        } catch (err) {
            list.innerHTML = '<div class="cca-empty cca-empty-err">Could not load inbox.</div>';
            list.classList.remove('cca-empty');
        }
    }


    // ------------------------------------------------------------------
    // Render one request as a small card. Used both on the requester's
    // outbox and the owner's inbox.
    // ------------------------------------------------------------------
    function renderRequestCard(q, canHandle) {
        // The inbox RPC (ent_view_incoming_access_requests) returns NO
        // status column at all - every row it returns IS pending, because
        // its WHERE clause only selects pending letters. Reading q.status
        // off it gave undefined, which fell through the pill ternary to
        // "Denied" (making every waiting letter look refused) and also
        // hid the Grant/Deny buttons (undefined !== 'pending'). Pending
        // is the honest default for both views; only the outbox, which
        // really returns status, ever overrides it.
        const status = q.status || 'pending';
        const approved = status === 'approved';
        const denied = status === 'denied';
        // ONLY the inbox - the OWNING clinic's view - may act. The
        // requester's own pending letter in "My requests" used to render
        // these buttons too: pressing Grant there sent the letter to the
        // server, which correctly answered 42501 "caller cannot grant
        // this report", because the requester is the one person who may
        // never decide his own ask. The UI must not offer it.
        const handleable = Boolean(canHandle) && status === 'pending';
        const meta = [q.patient_name, q.case_number, q.report_type, q.procedure_date].filter(Boolean).join(' · ');
        let html = '<article class="cca-request-card ' + (approved ? 'approved' : denied ? 'denied' : 'pending') + '">';
        html += '<div class="cca-request-head">';
        html += '<span class="cca-request-patient">' + esc(q.patient_name || '—') + '</span>';
        html += '<span class="cca-pill ' + (approved ? 'cca-pill-ok' : denied ? 'cca-pill-bad' : 'cca-pill-wait') + '">';
        html += (approved ? 'Approved' : denied ? 'Denied' : 'Pending');
        html += '</span>';
        html += '</div>';
        html += '<p class="cca-hint">' + esc(meta) + '</p>';
        if (q.requester_name) {
            // Inbox only: who is asking, and from which clinic - the owner
            // must recognise the asker before deciding.
            html += '<p class="cca-hint">From <b>' + esc(q.requester_name) + '</b> · ' + esc(q.requester_clinic || '') + '</p>';
        }
        html += '<p class="cca-modal-msg">' + esc(q.reason || '') + '</p>';
        if (approved) {
            html += '<p class="cca-hint">Opened by <b>' + esc(q.handled_by_name || '—') + '</b></p>';
        }
        if (denied) {
            html += '<p class="cca-hint">Denied by <b>' + esc(q.handled_by_name || '—') + '</b> on ' + esc(q.handled_at || '') + '</p>';
        }
        if (approved || denied) {
            html += '<details class="cca-payload"><summary>Details</summary><pre>' + esc(q.handled_at || '') + ' ' + esc(q.handled_by_name || '') + ' ' + esc(q.deny_reason || '') + '</pre></details>';
        }
        if (handleable) {
            html += '<div class="cca-request-actions">';
            html += '<button type="button" class="cca-btn cca-btn-open" data-respond="' + esc(q.request_id) + '" data-decision="grant">Grant</button>';
            html += '<button type="button" class="cca-btn" data-respond="' + esc(q.request_id) + '" data-decision="deny">Deny</button>';
            html += '</div>';
        } else if (status === 'pending') {
            // The requester's side of a still-open letter: no buttons,
            // just the honest state - only the owning clinic can answer.
            html += '<p class="cca-hint cca-waiting">Waiting for the owning clinic to answer.</p>';
        }
        html += '</article>';
        return html;
    }


    // ------------------------------------------------------------------
    // Owner answers a pending letter. One RPC decides status. The client
    // can only act through the <dialog>; the server is the only writer.
    // ------------------------------------------------------------------
    async function doHandle(requestId, decision, denyReason) {
        // MUST be awaited: confirmModal returns a Promise (always truthy),
        // so without await the code raced on while the dialog was still
        // open - for deny that meant a second showModal() on the same open
        // <dialog>, which throws InvalidStateError and killed the action.
        if (!(await confirmModal({
            title: decision === 'grant' ? 'Grant access?' : 'Deny access?',
            message: decision === 'grant'
                ? 'This will record a grant for the request and make the record openable by the requester.'
                : 'This will mark the request denied. The requester will see why.',
            confirmText: decision === 'grant' ? 'Grant' : 'Deny',
            icon: decision === 'grant' ? '&#128275;' : '&#128465;'
        }))) return;

        let denyText = '';
        if (decision === 'deny') {
            denyText = await askModal({
                title: 'Deny request',
                message: 'Why is access denied to this patient?',
                label: 'Reason for denial',
                placeholder: 'No clinical need',
                help: 'The denial is recorded in the audit trail.',
                confirmText: 'Deny',
                field: true
            });
            if (!denyText || !String(denyText).trim()) return; // user cancelled the reason step
        }

        state.notice = 'Updating…';
        renderNotice();
        try {
            // Throws on failure; void RPC resolves null. Success is simply
            // "it did not throw", so update both views and the table.
            await Supabase.apiRequest('/rpc/ent_handle_access_request', {
                method: 'POST',
                body: JSON.stringify({ p_request_id: requestId, p_decision: decision, p_reason: denyText })
            });
            state.notice = decision === 'grant'
                ? 'Grant recorded. The requester may now open this record.'
                : 'Denied. The requester will see your reason.';
            renderNotice();
            if (document.getElementById('ccaInboxList')) await renderInbox();
            if (document.getElementById('ccaMyRequestsList')) await renderMyRequests();
            await refresh();
        } catch (err) {
            state.notice = friendlyError(err);
            renderNotice();
        }
    }

    // Wiring
    // ------------------------------------------------------------------
    function mount() {
        const table = document.getElementById('ccaTableBody');
        if (!table) return;      // not this page

        const search = document.getElementById('ccaSearch');
        if (search) {
            let timer = null;
            search.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    state.search = search.value.trim();
                    state.offset = 0;
                    refresh();
                }, 280);
            });
        }

        const more = document.getElementById('ccaMore');
        if (more) {
            more.addEventListener('click', () => {
                state.offset += PAGE_SIZE;
                refresh();
            });
        }

        // One delegated listener per container. The table is re-rendered
        // wholesale on every refresh, so per-row listeners would have to be
        // rebound each time and would leak.
        const onClick = ev => {
            const ask = ev.target.closest('[data-ask]');
            if (ask) return doAsk(ask.getAttribute('data-ask'));
            const open = ev.target.closest('[data-open]');
            if (open) return doOpen(open.getAttribute('data-open'));
            const close = ev.target.closest('[data-close]');
            if (close) return closeRecord();
            const revoke = ev.target.closest('[data-revoke]');
            if (revoke) {
                return doRevoke(revoke.getAttribute('data-revoke'),
                                revoke.getAttribute('data-grantee') || '');
            }
            const respond = ev.target.closest('[data-respond]');
            if (respond) {
                const requestId = respond.getAttribute('data-respond');
                const decision = respond.getAttribute('data-decision');
                return doHandle(requestId, decision, '');
            }
        };
        table.addEventListener('click', onClick);
        // The record lives in a pop-up now, so its buttons listen there.
        const recordBody = document.getElementById('ccaRecordBody');
        if (recordBody) recordBody.addEventListener('click', onClick);
        // The My-requests / Inbox cards are re-rendered wholesale as well,
        // and they live OUTSIDE the table - without this delegated listener
        // the Grant and Deny buttons had no handler at all and did nothing.
        const views = document.querySelector('.ent-cca-views');
        if (views) views.addEventListener('click', onClick);

        // The pop-up's own close button, and a click on the backdrop (which
        // is the dialog element itself). Escape needs no code: <dialog>
        // closes itself.
        const recordClose = document.getElementById('ccaRecordClose');
        if (recordClose) recordClose.addEventListener('click', closeRecord);
        const recordDialog = document.getElementById('ccaRecord');
        if (recordDialog) {
            recordDialog.addEventListener('click', (event) => {
                if (event.target === recordDialog) closeRecord();
            });
        }

        const refreshBtn = document.getElementById('ccaRefresh');
        if (refreshBtn) refreshBtn.addEventListener('click', () => refresh());

        /* The three view filters. They re-draw from the rows already in
           hand - no request, and no permission decided here: can_view is
           read from the server and never recomputed. */
        const clinicSelect = document.getElementById('ccaClinic');
        if (clinicSelect) {
            clinicSelect.addEventListener('change', () => {
                state.clinic = clinicSelect.value || '';
                renderList();
            });
        }
        const typeSelect = document.getElementById('ccaType');
        if (typeSelect) {
            typeSelect.addEventListener('change', () => {
                state.reportType = typeSelect.value || '';
                renderList();
            });
        }
        const onlyOpen = document.getElementById('ccaOnlyOpen');
        if (onlyOpen) {
            onlyOpen.addEventListener('change', () => {
                state.onlyOpen = Boolean(onlyOpen.checked);
                renderList();
            });
        }

        // Tab wiring. tabMy MUST be declared here in mount()'s scope: it
        // used to be declared inside the onlyOpen block above, so the very
        // next line threw "ReferenceError: tabMy is not defined" in strict
        // mode - which killed renderScope(), the tab listeners and the
        // initial refresh() below it. The whole page looked dead because of
        // one mis-scoped const.
        const tabMy = document.getElementById('ccaTabMy');
        const tabInbox = document.getElementById('ccaTabInbox');
        if (tabMy && tabInbox) {
            const switchView = (showMy) => {
                // showMy IS the desired state - comparing it against the
                // current active tab (as before) inverted the result and
                // made every cross-tab click a no-op.
                document.getElementById('ccaViewMy').hidden = !showMy;
                document.getElementById('ccaViewInbox').hidden = showMy;
                tabMy.classList.toggle('active', showMy);
                tabInbox.classList.toggle('active', !showMy);
                const title = document.getElementById('ccaRequestsTitle');
                if (title) {
                    title.textContent = showMy
                        ? 'My requests'
                        : 'Inbox (pending to my clinic)';
                }
                if (showMy) renderMyRequests();
                else renderInbox();
            };
            tabMy.addEventListener('click', () => switchView(true));
            tabInbox.addEventListener('click', () => switchView(false));

            // THE LISTS LIVE IN A POP-UP now. The two buttons parked at
            // the top of the body open this same dialog on the right tab;
            // the close button and the backdrop follow the record pop-up's
            // pattern, and Escape comes free with <dialog>. showModal()
            // is guarded so a second open can never throw
            // InvalidStateError.
            const reqDialog = document.getElementById('ccaRequests');
            const openRequests = (showMy) => {
                if (!reqDialog) return;
                switchView(showMy);
                if (typeof reqDialog.showModal === 'function') {
                    if (!reqDialog.open) reqDialog.showModal();
                } else {
                    reqDialog.setAttribute('open', '');
                }
            };
            const openMy = document.getElementById('ccaOpenMy');
            const openInbox = document.getElementById('ccaOpenInbox');
            if (openMy) openMy.addEventListener('click', () => openRequests(true));
            if (openInbox) openInbox.addEventListener('click', () => openRequests(false));
            const reqClose = document.getElementById('ccaRequestsClose');
            if (reqClose && reqDialog) {
                reqClose.addEventListener('click', () => reqDialog.close());
            }
            if (reqDialog) {
                reqDialog.addEventListener('click', (event) => {
                    if (event.target === reqDialog) reqDialog.close();
                });
            }
        }
        // The default tab shows its list without a click, and the Inbox
        // button needs its first count before anyone opens anything.
        renderMyRequests();
        renderInbox();

        // The header states this account's reach before any list arrives, and
        // the connection pill stops saying "checking..." once a real answer
        // has been had.
        renderScope();
        syncHeaderHeight();
        window.addEventListener('resize', syncHeaderHeight);
        // auth.js appends the user chip after this module mounts, which can
        // change the header's height a moment later.
        if (typeof ResizeObserver === 'function') {
            const header = document.querySelector('.ent-cca-header');
            if (header) new ResizeObserver(syncHeaderHeight).observe(header);
        }
        if (typeof setTimeout === 'function') setTimeout(syncHeaderHeight, 80);

        window.addEventListener('offline', () => setConn('offline', 'Offline'));
        window.addEventListener('online', () => refresh());

        refresh();
    }

    window.EntCrossClinic = {
        refresh,
        open: doOpen,
        request: doAsk,
        approve: doApprove,
        revoke: doRevoke,
        state
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})(window);
