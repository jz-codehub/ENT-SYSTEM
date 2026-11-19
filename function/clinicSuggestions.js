(function () {
    'use strict';

    const ALLOWED_FIELDS = {
        cf4: new Set([
            'chiefComplaint', 'admittingDiagnosis', 'dischargeDiagnosis',
            'firstCaseRateCode', 'secondCaseRateCode', 'historyPresentIllness',
            'pertinentPastMedicalHistory', 'obGravida', 'obPara', 'obDetails',
            'obLmp', 'painSite', 'symptomOthers', 'referredReason',
            'alteredSensoriumDetail', 'vitalBp', 'vitalHr', 'vitalRr',
            'vitalTemp', 'vitalWeight', 'vitalHeight', 'heentOthers',
            'chestLungsOthers', 'cvsOthers', 'abdomenOthers', 'guOthers',
            'skinExtremitiesOthers', 'neuroExamOthers', 'courseOrder',
            'drugGenericName', 'drugQuantity', 'drugTotalCost'
        ]),
        nasal: new Set([
            'durationOfOperation', 'classification', 'rvsCode', 'icd10Code',
            'preOpDiagnosis', 'endoscopyType', 'procedureDescription',
            'indication', 'anesthesiaUsed', 'septum', 'discharge', 'mucosa',
            'it', 'mt', 'mm', 'im', 'omc', 'nasopharynx', 'impression',
            'recommendation', 'imageFinding', 'imageDescription'
        ]),
        laryngeal: new Set([
            'durationOfOperation', 'classification', 'rvsCode', 'icd10Code',
            'preOpDiagnosis', 'endoscopyType', 'procedureDescription',
            'indication', 'anesthesiaUsed', 'epiglottis', 'vallecula',
            'pyriformSinuses', 'arytenoids', 'falseVocalCords', 'trueVocalCords',
            'vocalCordMobility', 'subglottis', 'impression', 'recommendation',
            'imageFinding', 'imageDescription'
        ])
    };
    let clinicValues = {};
    let refreshSequence = 0;

    function values(reportType, fieldId) {
        const fields = clinicValues[reportType];
        return fields && Array.isArray(fields[fieldId]) ? fields[fieldId].slice() : [];
    }

    async function refresh(reportType) {
        const allowed = ALLOWED_FIELDS[reportType];
        if (!allowed || !window.EntAuth || !window.EntSupabase) return 0;

        const requestSequence = ++refreshSequence;
        clinicValues = {};
        await window.EntAuth.ready();
        const scope = window.EntAuth.scope();
        const doctorId = scope && scope.doctorId;
        if (!doctorId || scope.role === 'offline' || scope.role === 'guest') return 0;

        const rows = await window.EntSupabase.apiRequest('/rpc/ent_clinic_clinical_suggestions', {
            method: 'POST',
            body: JSON.stringify({ p_report_type: reportType, p_doctor_id: doctorId })
        });
        if (!Array.isArray(rows)) throw new Error('Clinic suggestions response was not a list.');

        const currentScope = window.EntAuth.scope();
        if (requestSequence !== refreshSequence || !currentScope || currentScope.doctorId !== doctorId) return 0;
        const fields = {};

        rows.forEach(row => {
            if (!row || typeof row.field_key !== 'string' || !allowed.has(row.field_key)
                || typeof row.suggestion_value !== 'string') return;
            const value = row.suggestion_value.trim();
            if (!value) return;
            if (!Array.isArray(fields[row.field_key])) fields[row.field_key] = [];
            if (!fields[row.field_key].some(item => item.toLowerCase() === value.toLowerCase())) {
                fields[row.field_key].push(value);
            }
        });

        clinicValues[reportType] = fields;
        return rows.length;
    }

    window.EntClinicSuggestions = { refresh, values };
})();
