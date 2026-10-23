(function (window, document) {
    'use strict';

    function start() {
        const form = document.querySelector('#report-form, #cf4-form');
        if (!form) return;

        let isDirty = false;
        let isStartingNew = false;
        let isSaving = false;
        let databaseSaveCompleted = false;
        let modal = null;
        let pendingAction = null;
        let opener = null;

        function setClean() {
            isDirty = false;
        }

        function ensureModal() {
            if (modal) return modal;
            modal = document.createElement('div');
            modal.className = 'modal-overlay form-exit-overlay';
            modal.style.display = 'none';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'formExitTitle');
            modal.setAttribute('aria-describedby', 'formExitText');
            modal.setAttribute('aria-hidden', 'true');
            modal.innerHTML = `
                <section class="form-exit-dialog">
                    <span class="form-exit-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 8v4l2.5 2.5"/>
                            <circle cx="12" cy="12" r="9"/>
                        </svg>
                    </span>
                    <p class="form-exit-eyebrow">UNSAVED PATIENT REPORT</p>
                    <h2 id="formExitTitle">Save this patient to the database?</h2>
                    <p id="formExitText">You edited this report. Save your changes to the database before continuing?</p>
                    <div class="form-exit-actions">
                        <button type="button" class="form-exit-keep">Keep Editing</button>
                        <button type="button" class="form-exit-discard">Don’t Save &amp; Continue</button>
                        <button type="button" class="form-exit-save">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                                <path d="M7 5v5h10V5M8 21v-7h8v7"/>
                            </svg>
                            <span>Save to Database</span>
                        </button>
                    </div>
                </section>
            `;
            document.body.appendChild(modal);
            modal.querySelector('.form-exit-keep').addEventListener('click', closeModal);
            modal.querySelector('.form-exit-discard').addEventListener('click', () => finishAction(false));
            modal.querySelector('.form-exit-save').addEventListener('click', saveAndContinue);
            modal.addEventListener('click', event => {
                if (event.target === modal) closeModal();
            });
            return modal;
        }

        function closeModal() {
            if (!modal || !pendingAction || isSaving) return;
            modal.classList.remove('is-open');
            modal.classList.add('is-closing');
            pendingAction = null;
            window.setTimeout(() => {
                modal.style.display = 'none';
                modal.classList.remove('is-closing');
                modal.setAttribute('aria-hidden', 'true');
                if (opener && opener.isConnected) opener.focus();
                opener = null;
            }, 190);
        }

        function finishAction() {
            if (!pendingAction) return;
            const action = pendingAction;
            pendingAction = null;
            modal.classList.remove('is-open');
            modal.classList.add('is-closing');
            isDirty = false;

            if (action.type === 'new') {
                isStartingNew = true;
                try {
                    const bridge = window.EntFormBridge;
                    if (!bridge || typeof bridge.startNew !== 'function') {
                        throw new Error('The form is still loading. Please try again in a moment.');
                    }
                    bridge.startNew();
                } catch (error) {
                    console.error('[Form exit] Could not start a new form:', error);
                    const bridge = window.EntFormBridge;
                    if (bridge && bridge.alert) bridge.alert('The form could not be reset.\n\n' + error.message, 'Could not start new form');
                    pendingAction = action;
                    isDirty = true;
                    isStartingNew = false;
                    modal.classList.remove('is-closing');
                    modal.setAttribute('aria-hidden', 'false');
                    modal.style.display = 'flex';
                    return;
                }
                isStartingNew = false;
                isDirty = false;
                if (opener && opener.isConnected) opener.focus();
                opener = null;
                window.setTimeout(() => {
                    modal.style.display = 'none';
                    modal.classList.remove('is-closing');
                    modal.setAttribute('aria-hidden', 'true');
                }, 190);
                return;
            }
            if (action.type === 'back') {
                window.location.assign(action.href);
            }
        }

        async function saveAndContinue() {
            if (!pendingAction) return;
            const saveButton = modal.querySelector('.form-exit-save');
            const saveLabel = saveButton.querySelector('span');

            databaseSaveCompleted = false;
            isSaving = true;
            saveButton.disabled = true;
            saveLabel.textContent = 'Saving to Database...';
            try {
                const database = window.EntDbRecords;
                if (!database || typeof database.saveToDatabase !== 'function') {
                    throw new Error('Database saving is not ready. Please try again in a moment.');
                }
                await database.saveToDatabase();
                if (databaseSaveCompleted) finishAction();
            } catch (error) {
                console.error('[Form exit] Could not save the report to the database:', error);
                const bridge = window.EntFormBridge;
                if (bridge && bridge.alert) bridge.alert('Your report was not saved to the database.\n\n' + error.message, 'Database save failed');
            } finally {
                isSaving = false;
                saveButton.disabled = false;
                saveLabel.textContent = 'Save to Database';
            }
        }

        function openModal(action) {
            pendingAction = action;
            opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const dialog = ensureModal();
            dialog.querySelector('#formExitTitle').textContent = action.type === 'new'
                ? 'Save this patient before starting a new form?'
                : 'Save this patient before leaving?';
            dialog.querySelector('#formExitText').textContent = action.type === 'new'
                ? 'Your edits will be replaced by a blank form. Save this patient to the database first?'
                : 'Your edits are not saved to the database. Save this patient before returning to the menu?';
            dialog.style.display = 'flex';
            dialog.setAttribute('aria-hidden', 'false');
            window.requestAnimationFrame(() => dialog.classList.add('is-open'));
            dialog.querySelector('.form-exit-keep').focus();
        }

        document.addEventListener('input', event => {
            if (!isStartingNew && form.contains(event.target)) isDirty = true;
        });
        document.addEventListener('change', event => {
            if (!isStartingNew && form.contains(event.target)) isDirty = true;
        });
        document.addEventListener('formStateChanged', () => {
            if (!isStartingNew) isDirty = true;
        });
        document.addEventListener('formDataRestored', setClean);
        document.addEventListener('databaseRecordSaved', () => {
            databaseSaveCompleted = true;
            setClean();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && pendingAction && !isSaving) closeModal();
            if (event.key === 'Tab' && pendingAction) {
                const buttons = Array.from(modal.querySelectorAll('button:not(:disabled)'));
                const first = buttons[0];
                const last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });

        document.addEventListener('click', event => {
            if (!(event.target instanceof Element)) return;
            const backLink = event.target.closest('.back-button');
            const newFormButton = event.target.closest('#newFormBtn');
            if (!backLink && !newFormButton) return;
            if (!isDirty) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            openModal(backLink
                ? { type: 'back', href: backLink.getAttribute('href') || '../index.html' }
                : { type: 'new' });
        }, true);

        const myDraftsButton = document.getElementById('myDraftsBtn');
        if (myDraftsButton) {
            myDraftsButton.addEventListener('click', () => {
                if (window.EntDrafts && typeof window.EntDrafts.openModal === 'function') {
                    window.EntDrafts.openModal();
                } else if (bridge.alert) {
                    bridge.alert('My Drafts is not ready yet. Please try again in a moment.', 'Drafts unavailable');
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})(window, document);
