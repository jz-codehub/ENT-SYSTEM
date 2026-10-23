/* =========================================
   SHARED PATIENT RECORDS
   Lightweight metadata history stored only on this device.
   ========================================= */
(function () {
    'use strict';

    const STORAGE_KEY = 'entPatientRecordHistoryV1';
    const MAX_RECORDS = 500;
    const TYPE_LABELS = {
        cf4: 'CF4 Form',
        nasal: 'Nasal Endoscopy',
        laryngeal: 'Laryngeal Endoscopy'
    };
    const FILTERS = [
        { id: 'all', label: 'All' },
        { id: 'cf4', label: 'CF4' },
        { id: 'nasal', label: 'Nasal' },
        { id: 'laryngeal', label: 'Laryngeal' }
    ];

    let activeFilter = 'all';
    let searchTerm = '';
    let button = null;
    let panel = null;
    let countElement = null;

    function normalizeType(type) {
        const value = String(type || '').toLowerCase();
        return ['cf4', 'nasal', 'laryngeal'].includes(value) ? value : '';
    }

    function cleanText(value) {
        if (value === undefined || value === null) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function firstValue(data, keys) {
        for (const key of keys) {
            const value = cleanText(data && data[key]);
            if (value) return value;
        }
        return '';
    }

    // ------------------------------------------------------------------
    // STABLE REPORT IDENTITY
    //
    // record_key is the report's identity AND the cloud upsert target
    // (reports UNIQUE (clinic_id, doctor_id, record_key)). It used to be
    // `type|identity|date`, so ANY edit to the date - an admit/discharge
    // date first typed in later, or a corrected date - produced a DIFFERENT
    // key and therefore a SECOND database row for the same report. That is
    // the duplicate explosion (one patient, many rows).
    //
    // The identity is now a value minted ONCE per report and CARRIED, so it
    // never depends on an editable field:
    //   - a key carried from an opened cloud record wins (re-saving that
    //     record updates the SAME row, even after its dates change);
    //   - otherwise the key already active for this report type in this
    //     session is reused (autosave, repeated save, photo upload of the
    //     report currently in the form);
    //   - otherwise a brand-new id is minted (a genuinely new report).
    // A new report therefore keys on `type|<id>` with no date and no PIN in
    // it. A legacy `type|identity|date` row is replayed verbatim when it is
    // opened, so re-saving it updates that same row - nothing is merged or
    // rewritten automatically.
    //
    // The active key is persisted so a reload mid-edit keeps updating the
    // same report, and cleared by startNewReport() when a blank form begins,
    // so the next save mints a fresh one (a new encounter). Multiple genuine
    // encounters of the same patient therefore stay separate records.
    // ------------------------------------------------------------------
    const ACTIVE_KEY_STORAGE = 'entActiveReportKeyV1';
    let activeKeys = null;
    function loadActiveKeys() {
        if (activeKeys) return activeKeys;
        try {
            activeKeys = JSON.parse(localStorage.getItem(ACTIVE_KEY_STORAGE) || '{}') || {};
        } catch (e) {
            activeKeys = {};
        }
        return activeKeys;
    }
    function persistActiveKeys() {
        try { localStorage.setItem(ACTIVE_KEY_STORAGE, JSON.stringify(activeKeys || {})); } catch (e) { /* storage unavailable */ }
    }
    function activeReportKey(type) {
        return loadActiveKeys()[type] || '';
    }
    function setActiveReportKey(type, key) {
        if (!type) return;
        const map = loadActiveKeys();
        if (key) map[type] = key; else delete map[type];
        persistActiveKeys();
    }
    function mintId() {
        try {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                return window.crypto.randomUUID();
            }
        } catch (e) { /* fall through to the manual id */ }
        return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[char]);
    }

    function readRecords() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn('Unable to read patient record history.', error);
            return [];
        }
    }

    function writeRecords(records) {
        const nextRecords = records
            .filter(Boolean)
            .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
            .slice(0, MAX_RECORDS);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords));
        } catch (error) {
            console.warn('Unable to save patient record history.', error);
        }
        updateButtonCount();
        renderPanel();
        window.dispatchEvent(new CustomEvent('patientrecords:updated'));
        
        // Background sync to Supabase when new records are written
        if (window.EntSync && typeof window.EntSync.syncPatientRecords === 'function') {
            window.EntSync.syncPatientRecords().catch(err => {
                console.warn('Background Supabase sync notice:', err);
            });
        }

        return nextRecords;
    }

    function buildPatientName(data) {
        const first = firstValue(data, ['patientFirstName', 'firstName']);
        const middle = firstValue(data, ['patientMiddleName', 'middleName']);
        const last = firstValue(data, ['patientLastName', 'lastName']);
        const suffix = firstValue(data, ['suffix']);
        if (first || middle || last) {
            const givenName = [first, middle].filter(Boolean).join(' ');
            const displayName = last ? [last, givenName].filter(Boolean).join(', ') : [givenName, suffix].filter(Boolean).join(' ');
            return cleanText(displayName);
        }
        return firstValue(data, ['patientName', 'name']);
    }

    function buildRecordKey(metadata) {
        const identity = metadata.patientId
            ? `id:${metadata.patientId.toLowerCase()}`
            : metadata.patientName
                ? `name:${metadata.patientName.toLowerCase()}`
                : `file:${(metadata.fileName || 'unnamed').toLowerCase()}`;
        return `${metadata.reportType}|${identity}|${metadata.procedureDate || 'no-date'}`;
    }

    function extractMetadata(reportType, data = {}, meta = {}) {
        const normalizedType = normalizeType(reportType);
        if (!normalizedType) return null;
        const patientName = buildPatientName(data);
        const patientId = firstValue(data, ['patientPin', 'mrn', 'patientId', 'caseNumber']);
        const caseNumber = firstValue(data, ['caseNumber']);
        // The report date is part of the record_key, so it must be STABLE:
        // re-saving the same patient on the same day has to hit the SAME key
        // (and UPDATE the row), never mint a new one. `savedAt` / `createdAt`
        // used to be the last fallbacks here, and that is exactly what made
        // the CF4 shelf multiply: a CF4 saved before dateAdmitted/dateDischarged
        // was typed fell back to the SAVE TIMESTAMP, so the key changed on
        // every single save ("cf4|...|2026-10-01T14:30:00" then
        // "...|2026-10-01T15:02:11"), and the upsert treated each save as a
        // brand-new patient. That is how ~95 real patients became ~275 rows.
        //
        // With the timestamp fallbacks removed, a record with no typed date
        // keys on 'no-date' - one stable value - so repeated saves update the
        // same row. The moment a real admit/discharge date is entered the key
        // moves to that date ONCE (a normal, single re-key), not on every save.
        const rawReportDate = firstValue(data, [
            'procedureDate',
            'dateDischarged',
            'dateAdmitted',
            'reportDate',
            'operationDate',
            'dateOfProcedure',
            'date'
        ]);
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawReportDate);
        const parsedDate = rawReportDate ? new Date(isDateOnly ? `${rawReportDate}T00:00:00` : rawReportDate) : null;
        const isValidDate = parsedDate && !Number.isNaN(parsedDate.getTime());
        const procedureDate = isDateOnly
            ? rawReportDate
            : isValidDate
                ? `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`
                : (rawReportDate || '');
        return {
            reportType: normalizedType,
            reportLabel: TYPE_LABELS[normalizedType],
            patientName,
            patientId,
            caseNumber,
            procedureDate,
            fileName: cleanText(meta.fileName),
            format: cleanText(meta.format)
        };
    }

    function addFormat(existing, format) {
        const values = Array.isArray(existing) ? existing.slice() : [];
        if (format && !values.includes(format)) values.push(format);
        return values;
    }

    function formatTimestamp(value) {
        if (!value) return 'Not yet';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Unknown';
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        }).format(date);
    }

    function getFilteredRecords() {
        const query = searchTerm.toLowerCase();
        return readRecords().filter(record => {
            if (activeFilter !== 'all' && record.reportType !== activeFilter) return false;
            if (!query) return true;
            return [record.patientName, record.patientId, record.caseNumber, record.fileName, record.reportLabel]
                .some(value => String(value || '').toLowerCase().includes(query));
        });
    }

    function createCard(record) {
        const card = document.createElement('article');
        card.className = 'patient-record-card';
        card.dataset.reportType = record.reportType;
        const identifier = record.patientId || record.caseNumber || 'No patient ID';
        const savedFormats = Array.isArray(record.savedFormats) ? record.savedFormats.join(' + ') : '';
        const reportDate = record.procedureDate
            ? (() => {
                const parsed = new Date(`${record.procedureDate}T00:00:00`);
                if (Number.isNaN(parsed.getTime())) return record.procedureDate;
                return new Intl.DateTimeFormat(undefined, {
                    year: 'numeric', month: 'short', day: '2-digit'
                }).format(parsed);
            })()
            : 'Not set';
        card.innerHTML = `
            <div class="patient-record-topline">
                <span class="patient-record-type">${escapeHtml(record.reportLabel || TYPE_LABELS[record.reportType] || record.reportType)}</span>
                <span class="patient-record-id">${escapeHtml(identifier)}</span>
            </div>
            <h4 class="patient-record-name">${escapeHtml(record.patientName || 'Unnamed patient')}</h4>
            <div class="patient-record-meta">
                <div class="patient-record-meta-item"><strong>Report date</strong>${escapeHtml(reportDate)}</div>
                <div class="patient-record-meta-item"><strong>Last saved</strong>${escapeHtml(formatTimestamp(record.lastSavedAt))}</div>
                <div class="patient-record-meta-item"><strong>Last opened</strong>${escapeHtml(formatTimestamp(record.lastOpenedAt))}</div>
                <div class="patient-record-meta-item"><strong>Activity</strong>${Number(record.saveCount || 0)} save${Number(record.saveCount || 0) === 1 ? '' : 's'} · ${Number(record.openCount || 0)} open${Number(record.openCount || 0) === 1 ? '' : 's'}${savedFormats ? ` · ${escapeHtml(savedFormats)}` : ''}</div>
            </div>
            ${record.fileName ? `<div class="patient-record-file" title="${escapeHtml(record.fileName)}">📄 ${escapeHtml(record.fileName)}</div>` : ''}
        `;
        return card;
    }

    function renderPanel() {
        if (!panel) return;
        const list = panel.querySelector('.patient-records-list');
        const summary = panel.querySelector('.patient-records-summary');
        const clearButton = panel.querySelector('.patient-records-clear');
        if (!list || !summary || !clearButton) return;

        const records = getFilteredRecords();
        const allCount = readRecords().length;
        list.innerHTML = '';
        if (!records.length) {
            const empty = document.createElement('div');
            empty.className = 'patient-records-empty';
            empty.textContent = allCount
                ? 'No records match this search or filter.'
                : 'No saved reports yet. Use Save Draft or Save PDF to start the patient history.';
            list.appendChild(empty);
        } else {
            records.forEach(record => list.appendChild(createCard(record)));
        }
        summary.textContent = `${records.length} shown · ${allCount} total · stored on this device`;
        clearButton.disabled = allCount === 0;
    }

    function updateButtonCount() {
        if (!countElement) return;
        const count = readRecords().length;
        countElement.textContent = count > 99 ? '99+' : String(count);
        countElement.hidden = count === 0;
    }

    // Who is using this browser right now.
    //
    // The device history lives in ONE localStorage key that every account on
    // this machine shares. Without an owner stamp, a doctor who signs out and a
    // new doctor who signs in on the same PC inherits the previous doctor's
    // local records - and, because loadDeviceRows() labels them with the
    // CURRENT username, the dashboard counts them as the new doctor's own
    // patients. That is precisely how a brand-new account opens with 20
    // patients it has never treated.
    //
    // Read once and cached per page load; upsertRecord() is called on every
    // save, so re-reading localStorage each time would be wasteful.
    let cachedOwner = null;
    function currentOwner() {
        if (cachedOwner) return cachedOwner;
        cachedOwner = { id: '', name: '' };
        try {
            const auth = window.EntAuth;
            const u = auth && typeof auth.currentUser === 'function' ? auth.currentUser() : null;
            if (u) {
                cachedOwner.id = String(u.id || '').trim();
                cachedOwner.name = String(u.username || u.full_name || '').trim();
            }
        } catch (e) { /* no auth on this page: treat as anonymous */ }
        return cachedOwner;
    }

    function upsertRecord(reportType, data, meta, action) {
        const metadata = extractMetadata(reportType, data, meta);
        if (!metadata) return null;
        const timestamp = new Date().toISOString();
        const records = readRecords();
        // STABLE REPORT IDENTITY (see the block above firstValue). Priority:
        //  1. a key carried from an opened cloud record (meta.recordKey) - so
        //     re-saving that report updates the SAME row even after its dates
        //     or PIN change;
        //  2. the key already active for this report type this session - an
        //     autosave / repeated save / photo upload of the report currently
        //     in the form;
        //  3. a freshly minted id - a genuinely new report.
        // A new report keys on `type|<id>` (no date, no PIN), so neither an
        // initially-empty admit/discharge date nor a later date entry can fork
        // the row. Legacy `type|identity|date` keys are replayed verbatim via
        // case 1, so re-saving a legacy row updates that same row.
        const type = metadata.reportType;
        const carriedKey = cleanText(meta.recordKey) || cleanText(data.__recordKey);
        let key = carriedKey || activeReportKey(type);
        if (!key) key = `${type}|${mintId()}`;
        setActiveReportKey(type, key);
        metadata.recordKey = key;
        let record = records.find(item => item.key === key);
        if (!record) {
            record = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                key,
                createdAt: timestamp,
                firstSavedAt: null,
                lastSavedAt: null,
                firstOpenedAt: null,
                lastOpenedAt: null,
                saveCount: 0,
                openCount: 0,
                savedFormats: [],
                openedFormats: []
            };
        }

        // Stamp the owner on every write, not only on creation: an existing
        // record reopened by a different account is that account's record from
        // now on, and leaving the old owner on it is what let the leak start.
        const owner = currentOwner();
        record.ownerId = owner.id;
        record.ownerName = owner.name;

        Object.assign(record, metadata);
        if (action === 'save') {
            record.firstSavedAt = record.firstSavedAt || timestamp;
            record.lastSavedAt = timestamp;
            record.saveCount = Number(record.saveCount || 0) + 1;
            record.savedFormats = addFormat(record.savedFormats, metadata.format);
        } else if (action === 'open') {
            record.firstOpenedAt = record.firstOpenedAt || timestamp;
            record.lastOpenedAt = timestamp;
            record.openCount = Number(record.openCount || 0) + 1;
            record.openedFormats = addFormat(record.openedFormats, metadata.format);
        }
        record.lastActivityAt = timestamp;
        const existingIndex = records.findIndex(item => item.key === key);
        if (existingIndex >= 0) records.splice(existingIndex, 1);
        records.unshift(record);
        writeRecords(records);
        return record;
    }

    function positionPanel() {
        if (!panel || !button) return;
        const rect = button.getBoundingClientRect();
        const panelWidth = Math.min(440, window.innerWidth - 24);
        const left = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, rect.right - panelWidth));
        panel.style.left = `${left}px`;
        panel.style.right = 'auto';
        panel.style.top = `${Math.max(8, rect.bottom + 6)}px`;
        const availableHeight = window.innerHeight - Math.max(8, rect.bottom + 6) - 10;
        panel.style.maxHeight = `${Math.max(180, availableHeight)}px`;
    }

    function setPanelOpen(open) {
        if (!panel || !button) return;
        panel.classList.toggle('is-open', open);
        button.setAttribute('aria-expanded', String(open));
        if (open) {
            positionPanel();
            renderPanel();
        }
    }

    function buildPanel() {
        panel = document.createElement('section');
        panel.className = 'patient-records-popover no-print';
        panel.id = 'patientRecordsPopover';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Saved patient reports');
        panel.innerHTML = `
            <div class="patient-records-header">
                <div>
                    <h2 class="patient-records-title">🗂 Patient Records</h2>
                    <p class="patient-records-subtitle">Saved CF4 and Endoscopy reports on this device</p>
                </div>
                <button type="button" class="patient-records-close" aria-label="Close patient records">×</button>
            </div>
            <div class="patient-records-search-wrap">
                <input type="search" class="patient-records-search" placeholder="Search patient, MRN/PIN, case no., or file..." aria-label="Search patient records">
            </div>
            <div class="patient-records-filters" role="group" aria-label="Filter patient records">
                ${FILTERS.map(filter => `<button type="button" class="patient-records-filter${filter.id === 'all' ? ' is-active' : ''}" data-record-filter="${filter.id}">${filter.label}</button>`).join('')}
            </div>
            <div class="patient-records-list"></div>
            <div class="patient-records-footer" style="display:flex; justify-content:space-between; align-items:center;">
                <span class="patient-records-summary"></span>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="patient-records-sync" title="Sync records with Supabase cloud" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; border-radius:6px; font-size:12px; padding:4px 8px; cursor:pointer;">☁️ Sync Now</button>
                    <button type="button" class="patient-records-clear">Clear History</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('.patient-records-close').addEventListener('click', () => setPanelOpen(false));
        panel.querySelector('.patient-records-search').addEventListener('input', event => {
            searchTerm = event.target.value;
            renderPanel();
        });
        panel.querySelectorAll('[data-record-filter]').forEach(filterButton => {
            filterButton.addEventListener('click', () => {
                activeFilter = filterButton.dataset.recordFilter;
                panel.querySelectorAll('[data-record-filter]').forEach(item => item.classList.toggle('is-active', item === filterButton));
                renderPanel();
            });
        });
        panel.querySelector('.patient-records-clear').addEventListener('click', () => {
            if (!readRecords().length) return;
            if (window.confirm('Clear the saved patient-record history from this device? Your downloaded draft and PDF files will not be deleted.')) {
                writeRecords([]);
            }
        });
        const syncBtn = panel.querySelector('.patient-records-sync');
        if (syncBtn) {
            syncBtn.addEventListener('click', async () => {
                if (!window.EntSync) return;
                const orig = syncBtn.textContent;
                syncBtn.textContent = '⏳ Syncing...';
                syncBtn.disabled = true;
                try {
                    const res = await window.EntSync.syncPatientRecords();
                    if (res && res.success) {
                        syncBtn.textContent = '✅ Synced!';
                    } else {
                        syncBtn.textContent = '⚠️ Failed';
                    }
                } catch (e) {
                    syncBtn.textContent = '⚠️ Error';
                } finally {
                    setTimeout(() => {
                        syncBtn.textContent = orig;
                        syncBtn.disabled = false;
                    }, 2500);
                }
            });
        }
    }

    // The floating "Records / saved patients" popover button is switched off:
    // Database ▸ DB Records already lets the user browse every saved report, and
    // the extra button crowded the report header. This module keeps running so
    // recordSave()/recordOpen() still maintain the local saved-patients history
    // (dbRecords.js, draftsBrowser.js and the form scripts call into it).
    // Flip this flag to true to bring the button back on every report page.
    const RECORDS_UI_ENABLED = false;

    function initializeUI() {
        if (!RECORDS_UI_ENABLED) return;
        if (!document.querySelector('.report-header')) return;
        const actions = document.querySelector('.report-header .header-actions');
        if (!actions) return;
        if (panel) {
            button = document.getElementById('patientRecordsBtn') || button;
            countElement = button?.querySelector('.patient-records-count') || countElement;
            bindUI();
            return;
        }

        button = document.getElementById('patientRecordsBtn');
        if (button) {
            // The report pages provide the button in markup; the shared module only binds it.
        } else {
            button = document.createElement('button');
            button.type = 'button';
            button.id = 'patientRecordsBtn';
            button.className = 'btn-patient-records no-print';
            button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-expanded', 'false');
            button.title = 'View saved CF4 and Endoscopy patient reports';
            button.innerHTML = `
                <span class="btn-icon">🗂</span>
                <span class="btn-label"><span class="btn-main">Records</span><span class="btn-sub">saved patients</span></span>
                <span class="patient-records-count" hidden>0</span>
            `;
            actions.insertBefore(button, actions.firstChild);
        }
        countElement = button.querySelector('.patient-records-count');
        buildPanel();
        bindUI();
    }

    function bindUI() {
        if (!panel || !button || button.dataset.patientRecordsBound === 'true') return;
        button.dataset.patientRecordsBound = 'true';
        updateButtonCount();
        button.addEventListener('click', event => {
            event.stopPropagation();
            setPanelOpen(!panel.classList.contains('is-open'));
        });
        panel.addEventListener('click', event => event.stopPropagation());
        document.addEventListener('click', event => {
            if (!button.contains(event.target) && !panel.contains(event.target)) setPanelOpen(false);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') setPanelOpen(false);
        });
        window.addEventListener('resize', positionPanel);
        window.addEventListener('scroll', positionPanel, true);
        window.addEventListener('patientrecords:updated', updateButtonCount);
    }

    window.PatientRecords = {
        recordSave(reportType, data, meta = {}) {
            return upsertRecord(reportType, data, meta, 'save');
        },
        recordOpen(reportType, data, meta = {}) {
            const type = normalizeType(reportType);
            const carried = cleanText(meta.recordKey);
            // Opening a cloud record carries its identity forward, so the next
            // "Save to Database" updates that SAME row. Opening a file or a
            // draft (no recordKey) starts a fresh identity so it can never
            // overwrite an unrelated report.
            setActiveReportKey(type, carried || '');
            return upsertRecord(reportType, data, meta, 'open');
        },
        // A blank form is a NEW report: drop the carried identity so the next
        // save mints a fresh one instead of overwriting the previous patient.
        startNewReport(reportType) {
            setActiveReportKey(normalizeType(reportType), '');
        },
        getActiveReportKey(reportType) {
            return activeReportKey(normalizeType(reportType));
        },
        getAll() {
            return readRecords();
        },
        clear() {
            writeRecords([]);
        },
        ensureUI() {
            initializeUI();
            updateButtonCount();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initializeUI();
            updateButtonCount();
        }, { once: true });
    } else {
        initializeUI();
        updateButtonCount();
    }
})();

