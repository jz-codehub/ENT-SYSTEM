(function (window) {
    'use strict';

    const MAX_DATA_URL_LENGTH = 150000;
    const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
    const NON_NAME_TOKENS = new Set([
        'dr', 'doc', 'doctor', 'md', 'fpcs', 'fpso', 'hns', 'fpcp', 'facs',
        'fpsa', 'fpa', 'phd', 'mph', 'mba', 'ent', 'jr', 'sr', 'ii', 'iii', 'iv'
    ]);
    const auth = window.EntAuth;
    const supabase = window.EntSupabase;
    const canvas = document.getElementById('signature-pad');
    const modal = document.getElementById('signatureModal');
    const manageButton = document.getElementById('manageDoctorSignature');
    const saveButton = document.getElementById('saveSignatureBtn');
    const clearButton = document.getElementById('clearSignatureBtn');
    const deleteButton = document.getElementById('deleteDoctorSignatureBtn');
    const cancelButton = document.getElementById('cancelSignatureBtn');
    const mainStatus = document.getElementById('doctorSignatureStatus');
    const modalStatus = document.getElementById('doctorSignatureModalStatus');

    const state = {
        profile: null,
        userKey: '',
        signatureDataUrl: '',
        loadError: null,
        loadPromise: null,
        doctorCache: Object.create(null),
        previewRequest: 0,
        context: null,
        strokes: [],
        activeStroke: null,
        hasInk: false,
        pixelRatio: 1
    };

    function setMessage(node, message, isError) {
        if (!node) return;
        node.textContent = message;
        node.classList.toggle('is-error', !!isError);
    }

    function nameTokens(value) {
        let name = String(value || '');
        if (typeof name.normalize === 'function') {
            name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }
        return (name.toLocaleLowerCase().match(/[a-z0-9]+/g) || [])
            .filter(function (token) {
                return token.length > 1 && !NON_NAME_TOKENS.has(token);
            });
    }

    function normalizedName(value) {
        return nameTokens(value).sort().join(' ');
    }

    function personNameIdentity(value) {
        const parts = String(value || '').split(',');
        if (parts.length > 1) {
            const familyName = nameTokens(parts[0]);
            const givenName = nameTokens(parts[1]);
            if (familyName.length && givenName.length) {
                return givenName[0] + ' ' + familyName[familyName.length - 1];
            }
        }
        const tokens = nameTokens(value);
        return tokens.length > 1 ? tokens[0] + ' ' + tokens[tokens.length - 1] : '';
    }

    function namesMatch(firstName, secondName) {
        const firstNormalized = normalizedName(firstName);
        if (firstNormalized && firstNormalized === normalizedName(secondName)) return true;
        const firstIdentity = personNameIdentity(firstName);
        return !!firstIdentity && firstIdentity === personNameIdentity(secondName);
    }

    function profileIsDoctor(profile) {
        if (!profile || profile.role !== 'doctor' || !auth || typeof auth.scope !== 'function') return false;
        const scope = auth.scope();
        return !!scope && scope.role === 'doctor' && String(scope.doctorId || '') === String(profile.id || '');
    }

    async function currentProfile() {
        if (!auth || !supabase) throw new Error('Authentication or database services are unavailable.');
        await auth.ready();
        const profile = typeof auth.currentUser === 'function' ? auth.currentUser() : null;
        const activeProfile = profile && (profile.role === 'doctor' || profile.role === 'secretary')
            ? profile : null;
        const userKey = activeProfile ? activeProfile.role + ':' + String(activeProfile.id || '') : '';
        if (state.userKey !== userKey) {
            state.userKey = userKey;
            state.doctorCache = Object.create(null);
            state.signatureDataUrl = '';
            state.loadError = null;
            state.loadPromise = null;
        }
        state.profile = activeProfile;
        if (activeProfile) return activeProfile;
        return null;
    }

    function doctorId(doctor) {
        return String(doctor && (doctor.doctor_id || doctor.id) || '');
    }

    function doctorName(doctor) {
        return String(doctor && (doctor.doctor_name || doctor.full_name) || '').trim();
    }

    async function authorizedDoctors(profile) {
        if (profile.role === 'doctor') {
            return [{ doctor_id: profile.id, doctor_name: profile.full_name || '' }];
        }
        if (profile.role !== 'secretary' || typeof auth.fetchAssignedDoctors !== 'function') {
            return [];
        }
        const doctors = await auth.fetchAssignedDoctors(false, true);
        return Array.isArray(doctors) ? doctors.filter(function (doctor) {
            return doctor && doctor.doctor_id && doctor.doctor_name;
        }) : [];
    }

    async function resolveSurgeon(surgeonName, profile) {
        const selectedName = normalizedName(surgeonName);
        if (!selectedName) return null;
        const doctors = await authorizedDoctors(profile);
        const exactMatches = doctors.filter(function (doctor) {
            return normalizedName(doctorName(doctor)) === selectedName;
        });
        if (exactMatches.length === 1) return exactMatches[0];
        if (exactMatches.length > 1) return null;

        const compatibleMatches = doctors.filter(function (doctor) {
            return namesMatch(doctorName(doctor), surgeonName);
        });
        return compatibleMatches.length === 1 ? compatibleMatches[0] : null;
    }

    async function readSignature(doctor, force) {
        const id = doctorId(doctor);
        if (!id) return '';
        if (!force && Object.prototype.hasOwnProperty.call(state.doctorCache, id)) {
            return state.doctorCache[id];
        }
        const rows = await supabase.apiRequest(
            'doctor_signatures?select=signature_data_url&doctor_id=eq.' + encodeURIComponent(id) + '&limit=1'
        );
        if (!Array.isArray(rows)) throw new Error('The saved-signature response was not a list.');
        const value = rows.length ? rows[0].signature_data_url : '';
        if (value && (typeof value !== 'string'
            || value.length > MAX_DATA_URL_LENGTH || !PNG_DATA_URL.test(value))) {
            throw new Error('The saved signature has an invalid image format.');
        }
        state.doctorCache[id] = value;
        return value;
    }

    function renderMainStatus() {
        if (mainStatus) {
            if (!state.profile) {
                setMessage(mainStatus, 'Sign in with a doctor account to manage a personal signature.', false);
            } else if (state.profile.role === 'secretary') {
                setMessage(mainStatus, 'You can preview signatures for your assigned doctors below.', false);
            } else if (state.loadError) {
                setMessage(mainStatus, 'Could not load your saved signature: ' + state.loadError, true);
            } else if (!state.signatureDataUrl) {
                setMessage(mainStatus, 'No saved signature yet. Set it once to use it on your reports.', false);
            } else {
                setMessage(mainStatus, 'Your saved signature is available for reports where you are the Surgeon.', false);
            }
        }
        if (manageButton) {
            const canManage = profileIsDoctor(state.profile);
            manageButton.hidden = !canManage;
            if (canManage) manageButton.textContent = state.signatureDataUrl ? 'Update my signature' : 'Set my signature';
        }
        if (deleteButton) deleteButton.hidden = !profileIsDoctor(state.profile) || !state.signatureDataUrl;
    }

    async function loadSavedSignature(force) {
        const profile = await currentProfile();
        state.profile = profile;
        if (!profileIsDoctor(profile)) {
            state.signatureDataUrl = '';
            state.loadError = null;
            state.loadPromise = null;
            renderMainStatus();
            return '';
        }
        if (state.loadPromise && !force) return state.loadPromise;
        state.loadError = null;
        state.loadPromise = (async function () {
            const value = await readSignature(
                { doctor_id: profile.id, doctor_name: profile.full_name || '' },
                !!force
            );
            const latestProfile = typeof auth.currentUser === 'function' ? auth.currentUser() : null;
            if (!profileIsDoctor(latestProfile) || String(latestProfile.id) !== String(profile.id)) return '';
            state.profile = latestProfile;
            state.signatureDataUrl = value;
            return value;
        })().catch(function (error) {
            state.loadError = (error && error.message) || String(error);
            state.signatureDataUrl = '';
            console.error('Unable to load the doctor signature:', error);
            return '';
        }).finally(function () {
            renderMainStatus();
        });
        return state.loadPromise;
    }

    async function refreshPreview(force) {
        const request = ++state.previewRequest;
        const image = document.getElementById('doctorSignaturePreviewImage');
        const status = document.getElementById('doctorSignaturePreviewStatus');
        const physician = document.getElementById('physician');
        const selectedName = String(physician && physician.value || '').trim();
        if (image) {
            image.hidden = true;
            image.removeAttribute('src');
        }
        if (!selectedName) {
            setMessage(status, 'Choose a Surgeon to preview the saved signature.', false);
            return '';
        }
        setMessage(status, 'Loading signature for the selected Surgeon...', false);
        try {
            const profile = await currentProfile();
            state.profile = profile;
            renderMainStatus();
            if (!profile) {
                setMessage(status, 'Sign in as a doctor or assigned secretary to preview signatures.', false);
                return '';
            }
            const doctor = await resolveSurgeon(selectedName, profile);
            if (!doctor) {
                if (request === state.previewRequest) {
                    setMessage(status, 'No signature is available for this Surgeon in your account scope.', false);
                }
                return '';
            }
            const signature = await readSignature(doctor, !!force);
            const latestProfile = await currentProfile();
            if (!latestProfile
                || latestProfile.role !== profile.role
                || String(latestProfile.id || '') !== String(profile.id || '')) return '';
            if (request !== state.previewRequest) return '';
            if (profileIsDoctor(profile) && String(doctorId(doctor)) === String(profile.id)) {
                state.signatureDataUrl = signature;
                state.loadError = null;
                renderMainStatus();
            }
            if (!signature) {
                setMessage(status, 'No saved signature for ' + (doctorName(doctor) || 'this Surgeon') + '.', false);
                return '';
            }
            if (image) {
                image.src = signature;
                image.alt = 'Saved signature for ' + (doctorName(doctor) || 'the selected Surgeon');
                image.hidden = false;
            }
            setMessage(status, 'This saved signature will appear on the printed report.', false);
            return signature;
        } catch (error) {
            if (request === state.previewRequest) {
                setMessage(status, 'Could not load the signature preview: ' + ((error && error.message) || error), true);
                console.error('Unable to load the selected doctor signature:', error);
            }
            return '';
        }
    }

    function pointFromEvent(event) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
        };
    }

    function redrawCanvas() {
        if (!canvas || !state.context) return;
        const rect = canvas.getBoundingClientRect();
        state.context.clearRect(0, 0, rect.width, rect.height);
        state.context.lineWidth = 2.4;
        state.context.lineCap = 'round';
        state.context.lineJoin = 'round';
        state.context.strokeStyle = '#111827';
        state.context.fillStyle = '#111827';

        state.strokes.forEach(function (stroke) {
            if (!stroke.length) return;
            if (stroke.length === 1) {
                state.context.beginPath();
                state.context.arc(stroke[0].x * rect.width, stroke[0].y * rect.height, 1.2, 0, Math.PI * 2);
                state.context.fill();
                return;
            }
            state.context.beginPath();
            state.context.moveTo(stroke[0].x * rect.width, stroke[0].y * rect.height);
            for (let i = 1; i < stroke.length; i++) {
                state.context.lineTo(stroke[i].x * rect.width, stroke[i].y * rect.height);
            }
            state.context.stroke();
        });
    }

    function resizeCanvas() {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        state.pixelRatio = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.round(rect.width * state.pixelRatio);
        canvas.height = Math.round(rect.height * state.pixelRatio);
        state.context = canvas.getContext('2d');
        if (!state.context) {
            setMessage(modalStatus, 'This browser cannot open the signature pad.', true);
            return;
        }
        state.context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
        redrawCanvas();
    }

    function updateDrawingControls() {
        state.hasInk = state.strokes.some(function (stroke) { return stroke.length > 1; });
        if (saveButton) saveButton.disabled = !state.hasInk;
    }

    function closeModal() {
        if (modal) modal.style.display = 'none';
        state.activeStroke = null;
    }

    async function openModal() {
        const profile = await currentProfile();
        if (!profileIsDoctor(profile)) {
            state.profile = profile;
            renderMainStatus();
            return;
        }
        state.profile = profile;
        await loadSavedSignature(true);
        state.strokes = [];
        state.activeStroke = null;
        state.hasInk = false;
        if (saveButton) saveButton.disabled = true;
        if (modalStatus) setMessage(
            modalStatus,
            'Draw your signature. Your assigned secretary can preview it, and it prints when your name is selected as Surgeon.',
            false
        );
        if (modal) modal.style.display = 'flex';
        window.requestAnimationFrame(resizeCanvas);
    }

    async function saveSignature() {
        try {
            const profile = await currentProfile();
            if (!profileIsDoctor(profile)) throw new Error('Sign in with your own doctor account to save a signature.');
            if (!state.hasInk) throw new Error('Draw your signature before saving.');
            const signatureDataUrl = canvas.toDataURL('image/png');
            if (signatureDataUrl.length > MAX_DATA_URL_LENGTH || !PNG_DATA_URL.test(signatureDataUrl)) {
                throw new Error('The signature image is too large or has an invalid format.');
            }
            saveButton.disabled = true;
            setMessage(modalStatus, 'Saving your signature...', false);
            await supabase.apiRequest('doctor_signatures?on_conflict=doctor_id', {
                method: 'POST',
                headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
                body: JSON.stringify([{
                    doctor_id: profile.id,
                    signature_data_url: signatureDataUrl
                }])
            });
            state.profile = profile;
            state.signatureDataUrl = signatureDataUrl;
            state.doctorCache[String(profile.id)] = signatureDataUrl;
            state.loadError = null;
            state.loadPromise = Promise.resolve(signatureDataUrl);
            closeModal();
            renderMainStatus();
            await refreshPreview(false);
        } catch (error) {
            console.error('Unable to save the doctor signature:', error);
            setMessage(modalStatus, 'Could not save your signature: ' + ((error && error.message) || error), true);
            if (saveButton) saveButton.disabled = !state.hasInk;
        }
    }

    async function deleteSignature() {
        if (!state.signatureDataUrl) return;
        try {
            const bridge = window.EntFormBridge;
            if (!bridge || typeof bridge.confirm !== 'function') {
                throw new Error('The confirmation dialog is unavailable. Please reload the form and try again.');
            }
            const confirmed = await bridge.confirm(
                'Remove your saved signature from your doctor account?',
                'Remove Saved Signature',
                { label: 'Remove Signature', zIndex: 20000 }
            );
            if (!confirmed) return;

            const profile = await currentProfile();
            if (!profileIsDoctor(profile)) throw new Error('Sign in with your own doctor account to remove the signature.');
            await supabase.apiRequest(
                'doctor_signatures?doctor_id=eq.' + encodeURIComponent(profile.id),
                { method: 'DELETE' }
            );
            state.profile = profile;
            state.signatureDataUrl = '';
            state.doctorCache[String(profile.id)] = '';
            state.loadError = null;
            state.loadPromise = Promise.resolve('');
            closeModal();
            renderMainStatus();
            await refreshPreview(false);
        } catch (error) {
            console.error('Unable to remove the doctor signature:', error);
            setMessage(modalStatus, 'Could not remove your signature: ' + ((error && error.message) || error), true);
        }
    }

    function init() {
        if (!manageButton || !modal || !canvas) return;
        manageButton.addEventListener('click', function () {
            openModal().catch(function (error) {
                console.error('Unable to open the doctor signature pad:', error);
                setMessage(mainStatus, 'Could not open the signature pad: ' + ((error && error.message) || error), true);
            });
        });
        if (saveButton) saveButton.addEventListener('click', saveSignature);
        if (saveButton) saveButton.setAttribute('aria-label', 'Save your drawn signature to your doctor account');
        if (clearButton) clearButton.addEventListener('click', function () {
            state.strokes = [];
            state.activeStroke = null;
            state.hasInk = false;
            redrawCanvas();
            updateDrawingControls();
            setMessage(modalStatus, 'Drawing cleared.', false);
        });
        if (deleteButton) deleteButton.addEventListener('click', deleteSignature);
        if (cancelButton) cancelButton.addEventListener('click', closeModal);
        modal.addEventListener('click', function (event) {
            if (event.target === modal) closeModal();
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && modal.style.display !== 'none') closeModal();
        });
        window.addEventListener('resize', resizeCanvas);
        canvas.addEventListener('pointerdown', function (event) {
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            state.activeStroke = [pointFromEvent(event)];
            state.strokes.push(state.activeStroke);
            if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(event.pointerId);
            redrawCanvas();
        });
        canvas.addEventListener('pointermove', function (event) {
            if (!state.activeStroke) return;
            state.activeStroke.push(pointFromEvent(event));
            redrawCanvas();
            updateDrawingControls();
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (name) {
            canvas.addEventListener(name, function () {
                state.activeStroke = null;
                updateDrawingControls();
            });
        });
        const physician = document.getElementById('physician');
        if (physician) physician.addEventListener('change', function () { refreshPreview(true); });

        loadSavedSignature(false).catch(function (error) {
            console.error('Unable to initialize the doctor signature:', error);
            setMessage(mainStatus, 'Could not load your saved signature: ' + ((error && error.message) || error), true);
        });
        refreshPreview(false);
    }

    window.EntDoctorSignature = {
        forSurgeon: async function (surgeonName) {
            const profile = await currentProfile();
            if (!profile) return '';
            const doctor = await resolveSurgeon(surgeonName, profile);
            if (!doctor) return '';
            const signature = await readSignature(doctor, window.navigator.onLine !== false);
            const latestProfile = await currentProfile();
            if (!latestProfile
                || latestProfile.role !== profile.role
                || String(latestProfile.id || '') !== String(profile.id || '')) return '';
            return signature;
        },
        refresh: function () { return refreshPreview(true); }
    };

    init();
})(window);
