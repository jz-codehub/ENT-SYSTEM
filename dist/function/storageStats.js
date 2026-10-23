/* =====================================================================
   DEVICE STORAGE REPORT  (localStorage)
   ---------------------------------------------------------------------
   The shared database (Supabase) holds the patient records. This device
   only keeps small things locally - the sign-in session, settings, form
   auto-save and the DRAFTS (which still carry their photos as base64).
   A browser allows about 5 MB for all of it, and draft photos are the
   only large item, so this module measures exactly who is using the space
   and offers a safe clean-up.
   Exposed as window.EntStorage.
   ===================================================================== */
(function (window) {
    'use strict';

    const DRAFTS_KEY = 'entSavedDraftsV1';
    const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024;   // what browsers actually give us

    // Human names so nobody has to guess what a key is.
    function labelFor(key) {
        const map = {
            // v2: the v1 keys are listed so this tool can still explain an
            // old device's leftovers, but nothing in the app writes them any
            // more — supabase-js owns the session now.
            entSessionV1: 'Legacy sign-in session (v1 only — safe to clear)',
            entSessionProblemV1: 'Last sign-in problem note',
            entUsersCacheV1: 'Legacy user cache (v1 only — safe to clear)',
            // v2: supabase-js owns the session and its key is
            // `sb-<project-ref>-auth-token`. Both refs are named: the
            // current project and the previous session key (kept only
            // so the tool explains and clears whichever session
            // the device holds).
            'sb-ybnlvfdvfrwnmdvhxeof-auth-token': 'Supabase session (managed by supabase-js)',
            entSavedDraftsV1: 'SAVED DRAFTS (photos included)',
            entPatientRecordHistoryV1: 'Saved record history (this device)',
            entDbSavedRecordKeysV1: 'Database-save flags',
            ent_supabase_config_v1: 'Cloud database settings',
            entDashAdminPreview: 'Admin preview flag',
            theme: 'Dark / light mode',
            lastSyncTime: 'Last cloud sync time',
            cf4Settings: 'CF4 settings (may include logos)',
            clinicSettings: 'Clinic settings',
            clinicPhysicians: 'Physician list',
            clinicRefPhysicians: 'Referring physician list',
            clinicAsstSurgeons: 'Assistant surgeon list',
            clinicScrubNurses: 'Scrub nurse list',
            customHospitals: 'Custom hospital list'
        };
        if (map[key]) return map[key];
        if (/EndoscopyData$/.test(key)) return 'Form auto-save: ' + key.replace('EndoscopyData', '');
        return key;
    }

    // Browsers count localStorage in UTF-16 code units, so 2 bytes per character.
    function bytesOf(text) {
        return String(text == null ? '' : text).length * 2;
    }

    function toKB(bytes) {
        return Math.round((bytes / 1024) * 10) / 10;
    }

    // Every stored item, biggest first.
    function keys() {
        const list = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                const raw = localStorage.getItem(key) || '';
                const bytes = bytesOf(raw);
                list.push({ key, label: labelFor(key), bytes, kb: toKB(bytes), chars: raw.length });
            }
        } catch (error) {
            console.warn('[EntStorage] Could not read localStorage:', error.message);
        }
        return list.sort((a, b) => b.bytes - a.bytes);
    }

    function report() {
        const items = keys();
        const used = items.reduce((sum, item) => sum + item.bytes, 0);
        return {
            items,
            used,
            usedKB: toKB(used),
            quota: DEFAULT_QUOTA_BYTES,
            quotaKB: toKB(DEFAULT_QUOTA_BYTES),
            percent: Math.min(100, (used / DEFAULT_QUOTA_BYTES) * 100),
            level: used / DEFAULT_QUOTA_BYTES > 0.9 ? 'error' : (used / DEFAULT_QUOTA_BYTES > 0.7 ? 'warning' : 'ok')
        };
    }

    // The browser's own numbers when offered (they also count the Cache API).
    async function quota() {
        try {
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                const est = await navigator.storage.estimate();
                return { usage: est.usage || 0, quota: est.quota || 0, source: 'browser' };
            }
        } catch (error) { /* not available */ }
        const rep = report();
        return { usage: rep.used, quota: rep.quota, source: 'localStorage (5 MB rule)' };
    }

    // Prints the exact numbers to DevTools - the quickest way to see who eats the space.
    function logToConsole() {
        const rep = report();
        const rows = rep.items.map(item => ({
            key: item.key,
            what: item.label,
            KB: item.kb,
            percent: ((item.bytes / rep.quota) * 100).toFixed(2) + '%'
        }));
        console.log('%cDevice storage: ' + rep.usedKB + ' KB / ~' + rep.quotaKB + ' KB (' + rep.percent.toFixed(1) + '%)',
            'font-weight:bold;color:' + (rep.level === 'error' ? '#c0392b' : rep.level === 'warning' ? '#b9770e' : '#15803d'));
        if (console.table) console.table(rows);
        else console.log(rows);
        return rep;
    }
    // Keep the photos of the newest drafts only. Older drafts keep ALL of their
    // text - only the pictures are dropped and the card is marked "photos removed".
    // The newest drafts are first in the list (that is how they are saved).
    function trimOldDraftPhotos(keepNewest) {
        // Prefer the drafts module's own version when it is on the page.
        if (window.EntDrafts && typeof window.EntDrafts.trimOldPhotos === 'function') {
            return window.EntDrafts.trimOldPhotos(keepNewest);
        }
        const keep = Math.max(1, Number(keepNewest) || 3);
        let list;
        let raw = '';
        try {
            raw = localStorage.getItem(DRAFTS_KEY) || '';
            list = JSON.parse(raw || '[]');
        } catch (error) { return { freed: 0, changed: 0, kept: keep }; }
        if (!Array.isArray(list) || list.length <= keep) return { freed: 0, changed: 0, kept: keep };

        // The newest drafts are the ones with the latest savedAt (that is the
        // order the drafts module reads them in), so judge by that rather than
        // by whichever order the list happens to be in.
        const keepSet = new Set(list
            .map((draft, index) => ({ index, at: String((draft && draft.savedAt) || '') }))
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, keep)
            .map(item => item.index));

        let changed = 0;
        const next = list.map((draft, index) => {
            if (keepSet.has(index)) return draft;
            const images = draft && draft.formData && draft.formData.images;
            if (!Array.isArray(images) || !images.length) return draft;
            changed++;
            return { ...draft, formData: { ...draft.formData, images: [] }, imagesStripped: true };
        });
        if (!changed) return { freed: 0, changed: 0, kept: keep };
        try {
            localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
        } catch (error) {
            return { freed: 0, changed: 0, kept: keep, error: error.message };
        }
        const after = localStorage.getItem(DRAFTS_KEY) || '';
        return { freed: Math.max(0, bytesOf(raw) - bytesOf(after)), changed, kept: keep };
    }

    window.EntStorage = {
        report,
        keys,
        quota,
        logToConsole,
        trimOldDraftPhotos,
        labelFor,
        toKB,
        DEFAULT_QUOTA_BYTES,
        DRAFTS_KEY
    };
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Settings -> System Diagnostics -> Device Storage panel (optional UI).
    function paint() {
        const summaryEl = document.getElementById('storageSummary');
        const barEl = document.getElementById('storageBar');
        const tableEl = document.getElementById('storageTable');
        const noteEl = document.getElementById('storageNote');
        if (!summaryEl || !tableEl) return;
        const rep = report();

        if (barEl) {
            barEl.style.width = Math.max(2, Math.min(100, rep.percent)) + '%';
            barEl.style.background = rep.level === 'error'
                ? 'linear-gradient(90deg,#e74c3c,#c0392b)'
                : (rep.level === 'warning' ? 'linear-gradient(90deg,#f39c12,#e67e22)' : 'linear-gradient(90deg,#2ecc71,#27ae60)');
        }
        summaryEl.textContent = rep.usedKB.toFixed(1) + ' KB used of about ' + rep.quotaKB.toFixed(0)
            + ' KB (' + rep.percent.toFixed(1) + '%) across ' + rep.items.length + ' stored item(s).';
        summaryEl.style.color = rep.level === 'error' ? '#c0392b' : (rep.level === 'warning' ? '#b9770e' : 'inherit');
        summaryEl.style.fontWeight = 'bold';

        const biggest = rep.items.slice(0, 8);
        tableEl.innerHTML = biggest.length
            ? '<table style="width:100%; border-collapse:collapse; font-size:12.5px;">'
                + '<tr style="text-align:left; color:var(--secondary-text-color);"><th style="padding:4px 6px;">Item</th>'
                + '<th style="padding:4px 6px;">Key</th><th style="padding:4px 6px; text-align:right;">Size</th></tr>'
                + biggest.map(item => '<tr style="border-top:1px solid var(--border-color);">'
                    + '<td style="padding:4px 6px;">' + escapeHtml(item.label) + '</td>'
                    + '<td style="padding:4px 6px; font-family:monospace; color:var(--secondary-text-color);">' + escapeHtml(item.key) + '</td>'
                    + '<td style="padding:4px 6px; text-align:right; font-family:monospace;">' + item.kb.toFixed(1) + ' KB</td></tr>').join('')
                + '</table>'
            : '<p style="font-size:12.5px; color:var(--secondary-text-color); margin:0;">Nothing stored on this device yet.</p>';

        if (noteEl) {
            if (rep.level === 'error') {
                noteEl.innerHTML = '&#9888; <strong>Almost full.</strong> Draft photos are the usual cause. Press the button below - no report and no saved record is deleted, only old draft pictures. Records in the shared database are NOT affected.';
            } else if (rep.level === 'warning') {
                noteEl.innerHTML = '&#9888; Getting full. If saving ever fails, press the button below to free space.';
            } else {
                noteEl.innerHTML = '&#10003; Plenty of space left.';
            }
        }
    }

    function say(text) {
        const box = document.getElementById('syncLogOutput');
        if (!box) return;
        box.style.display = 'block';
        box.textContent = text;
    }

    function bind() {
        const panel = document.getElementById('storagePanel');
        if (!panel || panel.dataset.storageBound === 'true') return;
        panel.dataset.storageBound = 'true';
        const refreshBtn = document.getElementById('storageRefreshBtn');
        const trimBtn = document.getElementById('storageTrimBtn');
        const logBtn = document.getElementById('storageLogBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', paint);
        if (logBtn) logBtn.addEventListener('click', () => {
            const rep = logToConsole();
            say('Device storage: ' + rep.usedKB.toFixed(1) + ' KB / ' + rep.quotaKB.toFixed(0)
                + ' KB (' + rep.percent.toFixed(1) + '%)\n\n'
                + rep.items.map(i => (i.key + '                              ').slice(0, 30) + i.kb.toFixed(1) + ' KB').join('\n')
                + '\n\n(also printed in the browser console - F12)');
        });
        if (trimBtn) trimBtn.addEventListener('click', () => {
            const result = trimOldDraftPhotos(3);
            paint();
            say(result.changed
                ? 'Freed ' + toKB(result.freed) + ' KB: photos were removed from ' + result.changed
                    + ' older draft(s). The newest ' + result.kept + ' draft(s) keep their photos and every draft keeps all of its text.'
                : 'Nothing to clean - the newest ' + (result.kept || 3) + ' drafts already hold all the photos.');
        });
        paint();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }
})(window);
