(function (window, document) {
    'use strict';

    const connectionStatus = document.querySelector('.offline-connection');
    const connectionTitle = document.getElementById('offlineConnectionTitle');
    const connectionMessage = document.getElementById('offlineConnectionMessage');

    function updateConnectionStatus() {
        if (!connectionStatus || !connectionTitle || !connectionMessage) return;
        const isOffline = window.navigator.onLine === false;
        connectionStatus.classList.toggle('is-offline', isOffline);
        connectionTitle.textContent = isOffline ? 'You are working offline' : 'Offline workspace is ready';
        connectionMessage.textContent = isOffline
            ? 'Your reports remain available without signal. Work saved offline stays on this device until you reconnect and sign in online.'
            : 'You can continue working here. Offline-saved reports stay on this device until you reconnect and sign in online.';
    }

    document.querySelectorAll('[data-page]').forEach(function (button) {
        button.addEventListener('click', function () {
            const page = button.getAttribute('data-page');
            if (page) window.location.href = window.EntPaths.page(page);
        });
    });

    window.addEventListener('online', updateConnectionStatus);
    window.addEventListener('offline', updateConnectionStatus);
    updateConnectionStatus();

    const logout = document.getElementById('offlineLogout');
    if (logout) {
        logout.addEventListener('click', function (event) {
            event.preventDefault();
            if (window.EntAuth) window.EntAuth.logout();
        });
    }
})(window, document);
