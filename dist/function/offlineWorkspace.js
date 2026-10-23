(function (window, document) {
    'use strict';

    const connectionStatus = document.querySelector('.offline-connection');
    const connectionTitle = document.getElementById('offlineConnectionTitle');
    const connectionMessage = document.getElementById('offlineConnectionMessage');
    let routingToWorkspace = false;

    function updateConnectionStatus() {
        if (!connectionStatus || !connectionTitle || !connectionMessage) return;
        const isOffline = window.navigator.onLine === false;
        connectionStatus.classList.toggle('is-offline', isOffline);
        connectionTitle.textContent = isOffline ? 'You are working offline' : 'Offline workspace is ready';
        connectionMessage.textContent = isOffline
            ? 'Your reports remain available without signal. Work saved offline stays on this device until you reconnect and sign in online.'
            : 'You can continue working here. Offline-saved reports stay on this device until you reconnect and sign in online.';
    }

    function moveToOfflineWorkspace() {
        if (routingToWorkspace ||
            (window.EntPaths && window.EntPaths.current() === 'offlineworkspace') ||
            !window.EntAuth || typeof window.EntAuth.ready !== 'function') return;

        routingToWorkspace = true;
        window.EntAuth.ready().then(function (user) {
            if (!user || window.navigator.onLine !== false) {
                routingToWorkspace = false;
                return;
            }
            const auth = window.EntAuth;
            const grant = typeof auth.getOfflineGrant === 'function' ? auth.getOfflineGrant() : null;
            const supportedRole = user.role === 'doctor' ||
                (user.role === 'secretary' && user.assigned_doctor_id);
            if (!grant || !supportedRole ||
                String(grant.username).toLowerCase() !== String(user.username || '').toLowerCase()) {
                routingToWorkspace = false;
                return;
            }

            const goToWorkspace = function () {
                window.location.replace(window.EntPaths.page('offlineWorkspace.html'));
            };
            let bridge;
            let formData;
            let draft;
            try {
                bridge = window.EntFormBridge;
                const drafts = window.EntDrafts;
                formData = bridge && typeof bridge.getData === 'function' ? bridge.getData() : null;
                draft = formData && drafts && typeof drafts.saveOfflineDraft === 'function'
                    ? drafts.saveOfflineDraft(bridge.reportType, formData)
                    : null;
            } catch (error) {
                console.error('[Offline workspace] Could not read or save the open report:', error);
                goToWorkspace();
                return;
            }
            if (!draft || !draft.offlinePersistPromise) {
                goToWorkspace();
                return;
            }
            draft.offlinePersistPromise.then(function (result) {
                if (!result || !result.saved) {
                    console.error('[Offline workspace] Could not save the open report before switching:', result && result.error);
                }
                goToWorkspace();
            }).catch(function (error) {
                console.error('[Offline workspace] Could not save the open report before switching:', error);
                goToWorkspace();
            });
        }).catch(function (error) {
            routingToWorkspace = false;
            console.error('[Offline workspace] Could not verify the offline session:', error);
        });
    }

    document.querySelectorAll('[data-page]').forEach(function (button) {
        button.addEventListener('click', function () {
            const page = button.getAttribute('data-page');
            if (page) window.location.href = window.EntPaths.page(page);
        });
    });

    window.addEventListener('online', updateConnectionStatus);
    window.addEventListener('offline', function () {
        updateConnectionStatus();
        moveToOfflineWorkspace();
    });
    updateConnectionStatus();

    const logout = document.getElementById('offlineLogout');
    if (logout) {
        logout.addEventListener('click', function (event) {
            event.preventDefault();
            if (window.EntAuth) window.EntAuth.logout();
        });
    }
})(window, document);
