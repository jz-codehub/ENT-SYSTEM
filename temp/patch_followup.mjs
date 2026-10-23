/* temp/patch_followup.mjs — make the follow-up NON-blocking.
   1. Remove the pre-save blocking askFollowUp (keep the declaration).
   2. Reset the button right after the success alert, then offer the
      follow-up AFTER the save; if a date is chosen, merge it into the
      row's payload.followUpDate. Never blocks, never errors the save. */
import fs from 'node:fs'
const p = 'function/dbRecords.js'
const orig = fs.readFileSync(p, 'utf8')
const eol = orig.includes('\r\n') ? '\r\n' : '\n'
let t = orig.replace(/\r\n/g, '\n')
let changed = 0

// ---- EDIT 1: remove the pre-save blocking follow-up prompt ----
const old1 =
`        let followUpChoice = '';
        {
            followUpChoice = await askFollowUp({});
        }`
const new1 =
`        // NOT asked here any more. It used to be a BLOCKING prompt before
        // the save - two dialogs in a row (hospital, then follow-up) and a
        // second click before anything was written, which is what confused
        // the doctors. The record now saves FIRST; the follow-up is offered
        // AFTER, non-blocking (see the FOLLOW-UP step at the end of this
        // save). Kept declared so the write below is unchanged and safe:
        // followUpChoice stays '' here, so no payload.followUpDate key rides
        // on the first save - it is merged in afterwards instead.
        let followUpChoice = '';`
if (t.includes(old1)) { t = t.replace(old1, new1); changed++ } else { console.log('EDIT1 not found') }

// ---- EDIT 2: post-save follow-up, after the success alert ----
const old2 =
`            } else {
                showAlert(
                    'SAVED TO DATABASE!\\n\\n' +
                    label + who + ' was saved to the shared cloud database.\\n\\n' +
                    'You can reopen it anytime from the "DB Records" button in the header.' + mergeBit,
                    'SUCCESS'
                );
            }`
const new2 =
`            } else {
                showAlert(
                    'SAVED TO DATABASE!\\n\\n' +
                    label + who + ' was saved to the shared cloud database.\\n\\n' +
                    'You can reopen it anytime from the "DB Records" button in the header.' + mergeBit,
                    'SUCCESS'
                );
            }

            // The record is saved and the success message is up. Reset the
            // button NOW so it never sits on "Saving..." while the doctor
            // answers the optional follow-up. (The finally below resets it
            // again - harmless, and it keeps this path independent of it.)
            saving = false;
            if (saveButton) saveButton.disabled = false;
            if (mainLabel) mainLabel.textContent = originalLabel;

            // ---- FOLLOW-UP, AFTER the save (non-blocking) ----------------
            // Offered only now, so it can never delay or block the save. A
            // cancel or "No follow-up" leaves the record exactly as saved.
            // If a date IS chosen it is merged into the row's payload under
            // followUpDate - the SAME field the dashboard reminder and the
            // admin follow-up tracker already read - so nothing new is
            // invented. Wrapped in its own try/catch: a hiccup storing the
            // date can never turn a successful save into an error.
            {
                const followUpDate = await askFollowUp({});
                if (followUpDate) {
                    try {
                        const fuRows = await window.EntSupabase.apiRequest(
                            'reports?record_key=eq.' + encodeURIComponent(record.key)
                            + '&select=id,payload&limit=5');
                        const fuList = Array.isArray(fuRows) ? fuRows : [];
                        for (const fuRow of fuList) {
                            if (!fuRow || fuRow.id == null) continue;
                            await window.EntSupabase.apiRequest(
                                'reports?id=eq.' + encodeURIComponent(fuRow.id), {
                                    method: 'PATCH',
                                    headers: { 'Prefer': 'return=representation' },
                                    body: JSON.stringify({
                                        payload: { ...(fuRow.payload || {}), followUpDate: followUpDate }
                                    })
                                });
                        }
                        if (fuList.length) {
                            logActivity('SET_FOLLOWUP', 'Follow-up set (' + record.reportType + ')');
                            setStatus('Follow-up reminder set for ' + dupDateLabel(followUpDate) + '.', false, false);
                        }
                    } catch (fuErr) {
                        console.warn('Could not store the follow-up date:', fuErr);
                        setStatus('Saved. The follow-up date could not be stored - you can set it later from DB Records.', false, true);
                    }
                }
            }`
if (t.includes(old2)) { t = t.replace(old2, new2); changed++ } else { console.log('EDIT2 not found') }

if (changed) {
  fs.writeFileSync(p, eol === '\r\n' ? t.replace(/\n/g, '\r\n') : t)
  console.log('PATCHED dbRecords.js follow-up (' + changed + '/2 edits)')
} else {
  console.log('NO CHANGES')
  process.exit(1)
}
