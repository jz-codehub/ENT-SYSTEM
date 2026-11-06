(function (window, document) {
    'use strict';

    const status = document.getElementById('recordStatus');
    const fields = Array.from(document.querySelectorAll('[data-abstract-field]'));

    function setStatus(message, isError) {
        status.textContent = message;
        status.classList.toggle('error', Boolean(isError));
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
        setStatus('CF4 record loaded. You can edit the abstract text and print it now.', false);
    }

    window.EntFormBridge = {
        reportType: 'cf4',
        getData: () => ({}),
        restore: restoreAbstract
    };

    async function initialize() {
        if (!window.EntAuth || !window.EntSupabase) {
            setStatus('The sign-in or database service is not available. Reload the page and try again.', true);
            return;
        }
        const session = await window.EntAuth.guard();
        if (!session || !session.user) return;
    }

    document.getElementById('clearAbstractBtn').addEventListener('click', () => {
        clearFields();
        setStatus('Abstract cleared. Enter text manually or open a saved CF4 record from DB Records.', false);
    });

    initialize().catch(error => {
        console.error('Could not initialize the clinical abstract page:', error);
        setStatus(`Could not initialize this page: ${error.message || error}`, true);
    });
})(window, document);
