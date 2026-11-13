(function (window, document) {
    'use strict';

    const status = document.getElementById('recordStatus');
    const fields = Array.from(document.querySelectorAll('[data-abstract-field]'));
    const reportKind = document.querySelector('.certificate-toolbar') ? 'certificate' : 'abstract';
    const toolbar = document.querySelector('.abstract-toolbar, .certificate-toolbar');
    const draftStoragePrefix = `ent-medical-document-draft-v1:${reportKind}`;
    let draftStorageKey = null;
    let cleanSnapshot = '';
    let isDirty = false;

    function updateToolbarOnScroll() {
        if (toolbar) {
            toolbar.classList.toggle('is-compact', window.scrollY > 48);
        }
    }

    const HOSPITALS = {
        capitol: {
            name: 'CAPITOL UNIVERSITY MEDICAL CENTER',
            address: 'GUSA HIGHWAY, GUSA, CAGAYAN DE ORO CITY, MISAMIS ORIENTAL 9000',
            logo: 'image/cumc-logo.png',
            alt: 'Capitol University Medical Center logo',
            phone: '',
            email: ''
        },
        rever: {
            name: 'REVER MEDICAL CENTER INC.',
            address: 'ZONE 4, CAPUNUYAN, APLAYA, JASAAN, MISAMIS ORIENTAL 9003',
            logo: 'image/rmci-logo.png',
            alt: 'Rever Medical Center logo',
            phone: 'TEL. NO.: (088) 890-4412 / CEL. NO.: 0966-621-2306',
            email: 'revermedicalcenter.hr1@gmail.com'
        }
    };

    function syncHospitalBranding() {
        let settings = {};
        try {
            settings = JSON.parse(window.localStorage.getItem('clinicSettings') || '{}');
        } catch (error) {
            console.warn('Unable to read the selected hospital for document headers.', error);
        }
        const hospital = HOSPITALS[settings.hospitalHeader] || HOSPITALS.capitol;
        const logoUrl = window.EntPaths && typeof window.EntPaths.asset === 'function'
            ? window.EntPaths.asset(hospital.logo)
            : `../${hospital.logo}`;

        document.querySelectorAll('[data-hospital-name]').forEach(element => {
            element.textContent = hospital.name;
        });
        document.querySelectorAll('[data-hospital-address]').forEach(element => {
            element.textContent = hospital.address;
        });
        document.querySelectorAll('[data-hospital-phone]').forEach(element => {
            element.textContent = hospital.phone;
            element.hidden = !hospital.phone;
        });
        document.querySelectorAll('[data-hospital-email]').forEach(element => {
            element.textContent = `EMAIL: ${hospital.email}`;
            element.hidden = !hospital.email;
        });
        document.querySelectorAll('[data-hospital-logo]').forEach(element => {
            element.src = logoUrl;
            element.alt = hospital.alt;
        });
        const documentType = document.title.split(' - ')[0] || 'Clinical Document';
        document.title = `${documentType} - ${hospital.name}`;
    }

    function setStatus(message, isError) {
        status.textContent = message;
        status.classList.toggle('error', Boolean(isError));
    }

    function getFormData() {
        return Object.fromEntries(fields.map(field => [
            field.getAttribute('data-abstract-field'),
            field.value
        ]));
    }

    function snapshotForm() {
        return JSON.stringify(getFormData());
    }

    function updateDirtyState() {
        isDirty = snapshotForm() !== cleanSnapshot;
    }

    function markClean() {
        cleanSnapshot = snapshotForm();
        isDirty = false;
    }

    function hasFormData() {
        return fields.some(field => field.value.trim() !== '');
    }

    function clearSavedDraft() {
        if (!draftStorageKey) {
            setStatus('Please wait for your sign-in to finish before managing local drafts.', true);
            return false;
        }
        try {
            window.localStorage.removeItem(draftStorageKey);
            return true;
        } catch (error) {
            console.error('Could not remove the saved document draft:', error);
            setStatus('The form is clear, but its saved draft could not be removed from this device.', true);
            return false;
        }
    }

    function saveDraft() {
        if (!draftStorageKey) {
            setStatus('Please wait for your sign-in to finish before saving a local draft.', true);
            return;
        }
        if (!hasFormData()) {
            setStatus('There is nothing to save yet. Enter some form details first.', true);
            return;
        }
        try {
            window.localStorage.setItem(draftStorageKey, JSON.stringify({
                savedAt: new Date().toISOString(),
                fields: getFormData()
            }));
            markClean();
            setStatus('Draft saved on this device. It will be restored when you return to this page.', false);
        } catch (error) {
            console.error('Could not save the document draft on this device:', error);
            setStatus('Could not save the draft on this device. Check available browser storage and try again.', true);
        }
    }

    function restoreSavedDraft() {
        if (!draftStorageKey) {
            setStatus('The signed-in account is not ready to access local drafts.', true);
            return;
        }
        let rawDraft;
        try {
            rawDraft = window.localStorage.getItem(draftStorageKey);
        } catch (error) {
            console.error('Could not read the saved document draft:', error);
            setStatus('Could not access saved drafts on this device.', true);
            markClean();
            return;
        }
        if (!rawDraft) {
            markClean();
            return;
        }
        try {
            const draft = JSON.parse(rawDraft);
            if (!draft || typeof draft.fields !== 'object' || Array.isArray(draft.fields)) {
                throw new Error('The saved draft has an invalid format.');
            }
            fields.forEach(field => {
                const key = field.getAttribute('data-abstract-field');
                if (Object.prototype.hasOwnProperty.call(draft.fields, key)) {
                    field.value = asText(draft.fields[key]);
                }
            });
            markClean();
            setStatus('Saved draft restored from this device.', false);
        } catch (error) {
            console.error('Could not restore the saved document draft:', error);
            setStatus('The saved draft could not be restored. It remains on this device; save a new draft to replace it.', true);
        }
    }

    function openPrintPreview() {
        const documentContent = document.querySelector('.sheet, .certificate');
        if (!documentContent) {
            setStatus('Print preview is unavailable because the document page could not be found.', true);
            return;
        }
        let previewDialog = document.getElementById('documentPreviewDialog');
        if (!previewDialog) {
            previewDialog = document.createElement('dialog');
            previewDialog.id = 'documentPreviewDialog';
            previewDialog.className = 'document-preview-dialog no-print';
            previewDialog.setAttribute('aria-labelledby', 'documentPreviewTitle');
            previewDialog.innerHTML = `
                <div class="document-preview-toolbar">
                    <h2 id="documentPreviewTitle">Print Preview</h2>
                    <div>
                        <button type="button" class="document-preview-print">Print</button>
                        <button type="button" class="document-preview-close">Close</button>
                    </div>
                </div>
                <iframe title="Document print preview" sandbox="allow-same-origin"></iframe>
            `;
            document.body.appendChild(previewDialog);
            previewDialog.querySelector('.document-preview-close').addEventListener('click', () => previewDialog.close());
            previewDialog.querySelector('.document-preview-print').addEventListener('click', () => {
                previewDialog.close();
                window.setTimeout(() => window.print(), 50);
            });
        }

        const clonedContent = documentContent.cloneNode(true);
        const sourceFields = documentContent.querySelectorAll('[data-abstract-field]');
        const previewFields = clonedContent.querySelectorAll('[data-abstract-field]');
        sourceFields.forEach((field, index) => {
            const previewField = previewFields[index];
            if (!previewField) return;
            if (field instanceof HTMLTextAreaElement) {
                previewField.textContent = field.value;
            } else if (field instanceof HTMLSelectElement) {
                Array.from(previewField.options).forEach((option, optionIndex) => {
                    if (optionIndex === field.selectedIndex) option.setAttribute('selected', '');
                    else option.removeAttribute('selected');
                });
            } else {
                previewField.setAttribute('value', field.value);
            }
        });
        const escapeAttribute = value => String(value).replace(/[&"<>]/g, character => ({
            '&': '&amp;',
            '"': '&quot;',
            '<': '&lt;',
            '>': '&gt;'
        })[character]);
        const styles = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style')).map(style => {
            if (style.tagName === 'STYLE') return style.outerHTML;
            const href = new URL(style.getAttribute('href'), document.baseURI).href;
            return `<link rel="stylesheet" href="${escapeAttribute(href)}">`;
        }).join('\n');
        const iframe = previewDialog.querySelector('iframe');
        iframe.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<style>html,body{min-height:100%;margin:0}body{padding:18px;background:#e5e7eb}.sheet,.certificate{margin:0 auto 18px;box-shadow:0 4px 18px rgba(15,23,42,.16)}</style></head><body>${clonedContent.outerHTML}</body></html>`;
        previewDialog.showModal();
    }

    function asText(value) {
        if (Array.isArray(value)) return value.filter(Boolean).join('; ');
        return value == null ? '' : String(value);
    }

    function combineFindings(values, other) {
        const findings = Array.isArray(values) ? values.filter(Boolean) : [];
        if (other) findings.push(String(other));
        return findings.join('; ');
    }

    function displayDate(value) {
        const date = asText(value);
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
        return match ? `${match[2]}-${match[3]}-${match[1]}` : date;
    }

    function medicationText(data) {
        const names = Array.isArray(data.drugGenericName) ? data.drugGenericName : [];
        const quantities = Array.isArray(data.drugQuantity) ? data.drugQuantity : [];
        return names.map((name, index) => {
            const detail = [name, quantities[index]].filter(Boolean).join(' - ');
            return detail.trim();
        }).filter(Boolean).join('\n');
    }

    function procedureText(data) {
        const orders = Array.isArray(data.courseOrder) ? data.courseOrder : [];
        const dates = Array.isArray(data.courseDate) ? data.courseDate : [];
        const times = Array.isArray(data.courseTime) ? data.courseTime : [];
        return orders.map((order, index) => {
            const dateTime = [dates[index], times[index]].filter(Boolean).join(' ');
            return [dateTime, order].filter(Boolean).join(' - ');
        }).filter(Boolean).join('\n');
    }

    function mapFormData(data) {
        const patientName = [data.patientFirstName, data.patientMiddleName, data.patientLastName]
            .filter(Boolean).join(' ');
        const vitalSummary = [
            data.vitalBp && `BP: ${data.vitalBp}`,
            data.vitalHr && `HR: ${data.vitalHr}`,
            data.vitalRr && `RR: ${data.vitalRr}`,
            data.vitalTemp && `TEMP: ${data.vitalTemp}`,
            data.vitalHeight && `HEIGHT: ${data.vitalHeight}`,
            data.vitalWeight && `WEIGHT: ${data.vitalWeight}`
        ].filter(Boolean).join('  ');
        return {
            lastName: data.patientLastName,
            firstName: data.patientFirstName,
            middleName: data.patientMiddleName,
            patientName,
            age: data.patientAge,
            sex: data.patientSex,
            mrn: data.patientPin,
            dateAdmitted: displayDate(data.dateAdmitted),
            dateDischarged: displayDate(data.dateDischarged),
            disposition: data.outcome,
            chiefComplaint: data.chiefComplaint,
            history: data.historyPresentIllness,
            pastHistory: data.pertinentPastMedicalHistory,
            vitalSummary,
            bp: data.vitalBp,
            hr: data.vitalHr,
            rr: data.vitalRr,
            temperature: data.vitalTemp,
            height: data.vitalHeight,
            weight: data.vitalWeight,
            otherVital: '',
            generalSurvey: data.generalSurvey,
            abdomen: combineFindings(data.abdomen, data.abdomenOthers),
            heent: combineFindings(data.heent, data.heentOthers),
            gu: combineFindings(data.gu, data.guOthers),
            chestLungs: combineFindings(data.chestLungs, data.chestLungsOthers),
            skinExtremities: combineFindings(data.skinExtremities, data.skinExtremitiesOthers),
            cvs: combineFindings(data.cvs, data.cvsOthers),
            neuroExam: combineFindings(data.neuroExam, data.neuroExamOthers),
            diagnosis: data.dischargeDiagnosis || data.admittingDiagnosis,
            medications: medicationText(data),
            procedures: procedureText(data),
            physician: data.attendingHcpName,
            dateSigned: displayDate(data.dateSigned),
            certificateDate: displayDate(data.dateSigned || data.dateDischarged || data.dateAdmitted),
            seenDate: displayDate(data.dateAdmitted || data.dateDischarged),
            certificateDiagnosis: data.dischargeDiagnosis || data.admittingDiagnosis
        };
    }

    function clearFields() {
        fields.forEach(field => { field.value = ''; });
    }

    function restoreAbstract(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('The selected CF4 record does not contain editable form data.');
        }
        const mapped = mapFormData(data);
        clearFields();
        fields.forEach(field => {
            const key = field.getAttribute('data-abstract-field');
            if (Object.prototype.hasOwnProperty.call(mapped, key)) {
                field.value = asText(mapped[key]);
            }
        });
        const draftRemoved = clearSavedDraft();
        markClean();
        if (draftRemoved) {
            setStatus('CF4 record loaded. You can edit the abstract text and print it now.', false);
        }
    }

    window.EntFormBridge = {
        reportType: 'cf4',
        getData: getFormData,
        restore: restoreAbstract
    };

    async function initialize() {
        syncHospitalBranding();
        markClean();
        if (!window.EntAuth || !window.EntSupabase) {
            setStatus('The sign-in or database service is not available. Reload the page and try again.', true);
            return;
        }
        const session = await window.EntAuth.guard();
        if (!session || !session.user) return;
        let activeClinicId = String(session.user.clinic_id || '').trim();
        let activeClinicName = String(session.user.clinic_name || '').trim();
        let activeClinicCode = String(session.user.clinic_code || '').trim();
        if (session.user.role === 'secretary' &&
            typeof window.EntAuth.fetchAssignedDoctors === 'function') {
            let doctors;
            try {
                doctors = await window.EntAuth.fetchAssignedDoctors(true, true);
            } catch (error) {
                console.error('Could not verify the active clinic for medical documents:', error);
                setStatus('Could not verify clinic access. Return to the dashboard and try again while online.', true);
                window.location.replace('../index.html?denied=medical-documents');
                return;
            }
            const scope = window.EntAuth.scope();
            const selectedDoctor = Array.isArray(doctors) && doctors.find(doctor =>
                String(doctor.doctor_id || '') === String(scope && scope.doctorId || '')
            );
            activeClinicId = String(selectedDoctor && selectedDoctor.clinic_id
                || scope && scope.workingClinicId
                || session.user.clinic_id || '').trim();
            activeClinicName = String(selectedDoctor && selectedDoctor.clinic_name
                || scope && scope.workingClinicName || '').trim();
            activeClinicCode = '';
        }
        if (!window.EntAuth.isDocJessClinic(activeClinicId, activeClinicName, activeClinicCode)
            && activeClinicId
            && typeof window.EntAuth.getClinicIdentity === 'function') {
            try {
                const clinic = await window.EntAuth.getClinicIdentity(activeClinicId);
                activeClinicName = clinic.name;
                activeClinicCode = clinic.code;
            } catch (error) {
                console.error('Could not verify the clinic for medical documents:', error);
                setStatus('Could not verify clinic access. Return to the dashboard and try again while online.', true);
                window.location.replace('../index.html?denied=medical-documents');
                return;
            }
        }
        if (!window.EntAuth.isDocJessClinic(activeClinicId, activeClinicName, activeClinicCode)) {
            setStatus('Clinical Abstract and Medical Certificate are currently available only to Doc Jess clinic.', true);
            window.location.replace('../index.html?denied=medical-documents');
            return;
        }
        draftStorageKey = `${draftStoragePrefix}:${session.user.id}`;
        if (isDirty) {
            setStatus('Your current edits were kept. The saved draft was not restored over them.', false);
        } else {
            restoreSavedDraft();
        }
    }

    fields.forEach(field => {
        field.addEventListener('input', updateDirtyState);
        field.addEventListener('change', updateDirtyState);
    });

    window.addEventListener('scroll', updateToolbarOnScroll, { passive: true });
    updateToolbarOnScroll();

    document.getElementById('saveDraftBtn').addEventListener('click', saveDraft);
    document.getElementById('previewBtn').addEventListener('click', openPrintPreview);
    document.getElementById('newFormBtn').addEventListener('click', event => {
        if (hasFormData() && !window.confirm('Start a new blank form? The current form contents and saved draft on this device will be removed.')) {
            event.preventDefault();
            return;
        }
        clearFields();
        const draftRemoved = clearSavedDraft();
        markClean();
        if (!draftRemoved) return;
        setStatus('New form started. Enter text manually or open a saved CF4 record from DB Records.', false);
    });

    document.getElementById('dbRecordsBtn').addEventListener('click', event => {
        updateDirtyState();
        if (isDirty && !window.confirm('You have unsaved changes. Open DB Records anyway? If you choose a record, it will replace the current form.')) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    document.querySelector('.back-button').addEventListener('click', event => {
        updateDirtyState();
        if (isDirty && !window.confirm('You have unsaved changes that are not in your saved draft. Leave this page anyway?')) {
            event.preventDefault();
        }
    }, true);

    window.addEventListener('beforeunload', event => {
        updateDirtyState();
        if (!isDirty) return;
        event.preventDefault();
        event.returnValue = '';
    });

    initialize().catch(error => {
        console.error('Could not initialize the clinical abstract page:', error);
        setStatus(`Could not initialize this page: ${error.message || error}`, true);
    });
})(window, document);
