document.addEventListener('DOMContentLoaded', async (event) => {
    // NEW: Store cleared data for Undo functionality
    let lastClearedData = null;
    let lastClearedImages = null;
    let lastClearedFindings = null;

    /* ------------------------------------------------------------------
       ASSET PATHS.

       This file is loaded by the root index.html AND by the pages in
       pages/ (the three report forms and settings.html). Every path below
       is resolved by the BROWSER against the open document, not against
       this script, so a bare "image/rmci-logo.png" is correct on the root
       page and 404s on every page in pages/ - a missing logo in a printed
       report, with no error anywhere.

       EntPaths.asset() adds the right prefix based on the current URL. It
       is loaded ahead of this file on every page; the fallback keeps this
       module working if a page ever omits the tag.
       ------------------------------------------------------------------ */
    const assetUrl = (window.EntPaths && typeof window.EntPaths.asset === 'function')
        ? window.EntPaths.asset
        : function (path) { return path; };

    // ===================================================================================
    // SERVICE WORKER REGISTRATION FOR OFFLINE CAPABILITY
    // ===================================================================================
    if ('serviceWorker' in navigator) {
        // Inject Toast HTML dynamically
        const toastDiv = document.createElement('div');
        toastDiv.id = 'updateToast';
        toastDiv.className = 'update-toast';
        toastDiv.style.display = 'none';
        toastDiv.innerHTML = `
            <div class="toast-content">
                <span>New update available!</span>
                <div style="display: flex; gap: 10px;">
                    <button id="reloadBtn">Update Now</button>
                    <button id="dismissUpdateBtn" class="btn-secondary">Dismiss</button>
                </div>
            </div>
        `;
        document.body.appendChild(toastDiv);

        function showUpdateToast(worker) {
            const toast = document.getElementById('updateToast');
            const reloadBtn = document.getElementById('reloadBtn');
            const dismissBtn = document.getElementById('dismissUpdateBtn');
            if (toast) {
                toast.style.display = 'flex';
                reloadBtn.onclick = () => {
                    worker.postMessage({ type: 'SKIP_WAITING' });
                    toast.style.display = 'none';
                };
                dismissBtn.onclick = () => {
                    toast.style.display = 'none';
                };
            }
        }

        window.addEventListener('load', () => {
            // sw.js stays at the app root - it has to, because its scope is
            // what makes it control every page including the ones in pages/.
            // The URL is therefore resolved through assetUrl(): from a page
            // in pages/ a bare "sw.js" would register pages/sw.js, which does
            // not exist, and the app would silently lose offline support.
            navigator.serviceWorker.register(assetUrl('sw.js')).then(reg => {
                console.log('Service worker registered successfully.');

                // Check if there's already a waiting worker
                if (reg.waiting) { showUpdateToast(reg.waiting); return; }

                reg.addEventListener('updatefound', () => {
                    const newWorker = reg.installing;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            showUpdateToast(newWorker);
                        }
                    });
                });
            }).catch(err => console.error('Service worker registration failed:', err));

            let refreshing;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (refreshing) return;
                window.location.reload();
                refreshing = true;
            });
        });
    }

    // ===================================================================================
    // PWA INSTALLATION LOGIC
    // ===================================================================================
    let deferredPrompt;
    const installBtn = document.getElementById('installAppBtn');
    const installModal = document.getElementById('installModal');
    const confirmInstallBtn = document.getElementById('confirmInstallBtn');
    const cancelInstallBtn = document.getElementById('cancelInstallBtn');

    window.addEventListener('beforeinstallprompt', (e) => {
        console.log('PWA Install Prompt fired!');
        // Prevent Chrome 67 and earlier from automatically showing the prompt
        e.preventDefault();
        // Stash the event so it can be triggered later.
        deferredPrompt = e;
        
        // Show the modal automatically
        if (installModal) installModal.style.display = 'flex';
        
        // HIDE the header button initially (cleaner UI)
        // It will only appear if they cancel the modal
        if (installBtn) installBtn.style.display = 'none';
    });

    async function triggerInstall() {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`User response to the install prompt: ${outcome}`);
            deferredPrompt = null;
        }
        if (installModal) installModal.style.display = 'none';
        if (installBtn) installBtn.style.display = 'none';
    }

    if (confirmInstallBtn) {
        confirmInstallBtn.addEventListener('click', triggerInstall);
    }

    if (cancelInstallBtn) {
        cancelInstallBtn.addEventListener('click', () => {
            if (installModal) installModal.style.display = 'none';
            // NEW: Show the persistent button if user clicks "Maybe Later"
            if (installBtn) installBtn.style.display = 'flex';
        });
    }
    
    // NEW: Close modal on click outside and show button
    if (installModal) {
        installModal.addEventListener('click', (e) => {
            if (e.target === installModal) {
                installModal.style.display = 'none';
                if (installBtn) installBtn.style.display = 'flex';
            }
        });
    }

    if (installBtn) {
        installBtn.addEventListener('click', () => {
            if (installModal) {
                installModal.style.display = 'flex';
            } else {
                triggerInstall();
            }
        });
    }

    window.addEventListener('appinstalled', () => {
        if (installBtn) installBtn.style.display = 'none';
        if (installModal) installModal.style.display = 'none';
        deferredPrompt = null;
        try { localStorage.setItem('entPwaInstalled', '1'); } catch (e) {}
        console.log('PWA was installed');
    });

    // Fallback: if the browser never fires beforeinstallprompt (already
    // installed, iOS, or desktop without support), still surface the header
    // button after a few seconds so the user always has a visible install
    // path. Clicking it opens the modal with manual instructions when no
    // native prompt is available.
    setTimeout(function () {
        let installed = false;
        try { installed = localStorage.getItem('entPwaInstalled') === '1'; } catch (e) {}
        const standalone = window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
        if (!deferredPrompt && !installed && !standalone && installBtn
            && installBtn.style.display === 'none'
            && (!installModal || installModal.style.display === 'none')) {
            installBtn.style.display = 'flex';
        }
    }, 4000);

    // ===================================================================================
    // iOS INSTALLATION INSTRUCTIONS
    // ===================================================================================
    // Detect iOS devices (iPhone, iPad, iPod)
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // Check if already in standalone mode (installed)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (window.navigator.standalone === true);

    if (isIos && !isStandalone && installModal) {
        // Customize modal content specifically for iOS users
        const modalTitle = installModal.querySelector('h2');
        const modalText = installModal.querySelector('p');
        
        if (modalTitle) modalTitle.textContent = "Install on iPhone/iPad";
        if (modalText) {
            modalText.innerHTML = `
                To install this app on your home screen:<br><br>
                1. Tap the <strong>Share</strong> button <span style="font-size: 1.3em; vertical-align: middle;">📤</span><br>
                2. Scroll down and tap <strong>"Add to Home Screen"</strong> <span style="font-size: 1.3em; vertical-align: middle;">➕</span>
            `;
            modalText.style.textAlign = 'left';
            modalText.style.lineHeight = '1.6';
            modalText.style.padding = '0 10px';
        }
        
        // Hide the "Install Now" button since iOS doesn't support programmatic install
        if (confirmInstallBtn) confirmInstallBtn.style.display = 'none';
        
        // Show the modal automatically
        installModal.style.display = 'flex';
    }

    let selectedImages = [];

    // Convert logo assets to data URLs before PDF capture so the configured
    // left/right logos render reliably in both print and PDF output.
    async function imageToBase64(url) {
        if (!url) return Promise.resolve('');
        // Reuse configured data URLs directly to avoid unnecessary canvas work.
        if (/^data:image\//i.test(url)) return Promise.resolve(url);
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const width = img.naturalWidth || img.width;
                    const height = img.naturalHeight || img.height;
                    if (!width || !height) {
                        resolve('');
                        return;
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        resolve('');
                        return;
                    }
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/png'));
                } catch (error) {
                    console.warn('Unable to embed logo for printing.', error);
                    resolve('');
                }
            };
            img.onerror = () => resolve('');
            img.src = url;
        });
    }

    async function getEndoscopyPrintLogos() {
        let settings = {};
        try {
            settings = JSON.parse(localStorage.getItem('clinicSettings') || '{}');
        } catch (error) {
            console.warn('Unable to read Endoscopy print settings.', error);
        }
        const hospitalHeader = settings.hospitalHeader || 'capitol';
        const leftPath = assetUrl(settings.leftLogo || (hospitalHeader === 'rever' ? 'image/rmci-logo.png' : 'image/cumc-logo.png'));
        const rightPath = assetUrl(settings.rightLogo || 'image/ent-logo.webp');
        const [left, right] = await Promise.all([imageToBase64(leftPath), imageToBase64(rightPath)]);
        return { left: left || leftPath, right: right || rightPath };
    }
    
    // ===================================================================================
    // 1. CACHE DOM ELEMENTS
    // ===================================================================================
    // FONT-SIZE ADJUST HELPER
    // ===================================================================================
    function measureTextWidth(element) {
        /* WHY THIS EXISTS.
           The original helper compared `element.scrollWidth` against the
           container. That works for a BLOCK or INLINE-BLOCK box, but
           scrollWidth is specified to return 0 for a non-replaced INLINE
           box - and the print header's subtitle span is inline (it has no
           display set, unlike the hospital-name span above it).

           The result was the worst possible failure: the loop compared
           0 > 384, saw "no overflow", shrank nothing, and the longest
           line in the header - "MINDANAO EAR, NOSE, THROAT OUT-PATIENT
           REHABILITATION CENTER" - ran off the page while the helper
           reported success.

           getBoundingClientRect().width is the union of the element's
           line boxes, which is correct for inline elements too and still
           measures the full OVERFLOWING width when the text is nowrap.
           So: prefer scrollWidth when it is meaningful, fall back to the
           rect when it is not. */
        const scroll = element.scrollWidth;
        if (scroll) return scroll;
        const rect = element.getBoundingClientRect();
        return Math.ceil(rect.width);
    }

    function adjustFontSizeToFit(element, container) {
        if (!element || !container) return;

        let style = window.getComputedStyle(element);
        let currentFontSize = parseFloat(style.fontSize);
        let currentLetterSpacing = parseFloat(style.letterSpacing);
        if (isNaN(currentLetterSpacing)) currentLetterSpacing = 0; // Handle 'normal'

        /* Nothing to fit into yet - the element is display:none, or the
           layout has not been computed. Shrinking here would drive the
           font to its floor for no reason, so wait for a real width. */
        const available = container.offsetWidth;
        if (!available) return;

        // 1. Try reducing letter-spacing first (down to -1px) to keep font size large
        while (measureTextWidth(element) > available && currentLetterSpacing > -1) {
            currentLetterSpacing -= 0.1;
            element.style.letterSpacing = `${currentLetterSpacing}px`;
        }

        // 2. If still doesn't fit, reduce font size
        while (measureTextWidth(element) > available && currentFontSize > 8) {
            currentFontSize -= 0.5; // Decrease font size by a small amount
            element.style.fontSize = `${currentFontSize}px`;
        }

        /* 3. Still too wide at the floor (an unusually long hospital name
           on a narrow custom paper size). Wrapping is the last resort
           because the caller sized this header for a FIXED height, but a
           second line is far better than text that is simply cut off at
           the page edge. Cleared at the start of every call so a later,
           wider setting can go back to one line. */
        element.style.whiteSpace = 'normal';
        if (measureTextWidth(element) > available) {
            element.style.overflowWrap = 'anywhere';
        }
    }

    // ===================================================================================
    // SECURITY HELPER: ESCAPE HTML
    // ===================================================================================
    function escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // ===================================================================================
    const reportForm = document.getElementById("report-form");

    const BUTTON_ICON_PATHS = {
        saveDataBtn: ['M5 3h12l4 4v14H3V3h2zm2 0v6h10V3M7 21v-7h10v7'],
        localDraftsBtn: ['M3 6h7l2 2h9v12H3z', 'M3 10h18'],
        myDraftsBtn: ['M3 6h7l2 2h9v12H3z'],
        saveToDbBtn: ['M4 5c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2z', 'M4 5v6c0 1.1 3.6 2 8 2', 'M20 5v5', 'M4 11v6c0 1.1 3.6 2 8 2', 'M20 13v6', 'M15 16l2 2 4-5'],
        dbRecordsBtn: ['M4 4h16v16H4z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
        savePdfBtn: ['M6 2h9l5 5v15H6z', 'M14 2v6h6', 'M9 13h7', 'M9 16h7'],
        printBtn: ['M6 9V3h12v6', 'M6 18H4V9h16v9h-2', 'M7 14h10v7H7z', 'M17 11h1'],
        newFormBtn: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8v8', 'M8 12h8'],
        clearFormBtn: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 14h10l1-14', 'M9 7V4h6v3'],
        helpBtn: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M9.5 9a2.6 2.6 0 1 1 4.2 2c-1.2.9-1.7 1.3-1.7 2.5', 'M12 17h.01'],
        tutorialBtn: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M10 8l6 4-6 4z'],
        clearImagesBtn: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 14h10l1-14', 'M9 7V4h6v3']
    };

    function initializeButtonIcons() {
        Object.keys(BUTTON_ICON_PATHS).forEach(function (buttonId) {
            const button = document.getElementById(buttonId);
            if (!button) return;

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.8');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('focusable', 'false');
            BUTTON_ICON_PATHS[buttonId].forEach(function (pathData) {
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', pathData);
                svg.appendChild(path);
            });

            const icon = button.querySelector('.btn-icon');
            if (icon) {
                icon.replaceChildren(svg);
                return;
            }

            const label = buttonId === 'helpBtn' ? 'Help'
                : buttonId === 'tutorialBtn' ? 'Tutorial'
                    : 'Clear Images';
            const iconWrapper = document.createElement('span');
            iconWrapper.className = 'btn-icon';
            iconWrapper.appendChild(svg);
            button.replaceChildren(iconWrapper, document.createTextNode(label));
        });
    }

    initializeButtonIcons();

    const imageInput = document.getElementById("imageInput");
    const previewDiv = document.getElementById("preview");
    const printDiv = document.getElementById("printDiv");
    const loadingSpinner = document.getElementById("loadingSpinner");
    const pdfPreviewModal = document.getElementById('pdfPreviewModal');
    const pdfPreviewFrame = document.getElementById('pdfPreviewFrame');
    const savePdfFromPreviewBtn = document.getElementById('savePdfFromPreviewBtn');
    const closePdfPreviewBtn = document.getElementById('closePdfPreviewBtn');
    let generatedPdfForSave = null; // To hold the generated PDF object
    // Cropper Modal Elements
    let cropper;
    let fileQueue = [];
    let currentFileForCropping = null;
    const cropModal = document.getElementById('cropModal');
    const imageToCrop = document.getElementById('imageToCrop');
    const cropButton = document.getElementById('cropButton');
    const skipCropButton = document.getElementById('skipCropButton');
    const cancelCropButton = document.getElementById('cancelCropButton');

    // Determine report type for local storage and dynamic printing
    let currentReportType = '';
    if (document.title.includes('Nasal')) {
        currentReportType = 'nasal';
    } else if (document.title.includes('Laryngeal')) {
        currentReportType = 'laryngeal';
    } else if (document.title.includes('ENT Endoscopy System')) {
        currentReportType = 'index';
    } else if (document.title.includes('Settings')) {
        currentReportType = 'settings';
    }
    const localStorageKey = currentReportType ? `${currentReportType}EndoscopyData` : 'endoscopyData'; // Fallback
    // Optional: Only cache patientNameInput if needed globally
    const patientNameInput = document.getElementById("patientName");

    // Check if the form was successfully loaded. If not, stop execution.
    if (!reportForm) {
        // If it's not a report page, this is fine. We'll check for other logic.
        console.log("Not a report page. Looking for settings form...");
    }

    // ===================================================================================
    // CUSTOM MODAL LOGIC (Replaces Alert/Confirm)
    // ===================================================================================
    const messageModal = document.getElementById('messageModal');
    const msgModalTitle = document.getElementById('msgModalTitle');
    const msgModalText = document.getElementById('msgModalText');
    const msgModalOkBtn = document.getElementById('msgModalOkBtn');
    const msgModalCancelBtn = document.getElementById('msgModalCancelBtn');

    function showCustomAlert(message, title = 'Notification') {
        if (!messageModal) { alert(message); return; } // Fallback
        msgModalTitle.textContent = title;
        msgModalText.textContent = message;
        msgModalCancelBtn.style.display = 'none';
        msgModalOkBtn.textContent = 'OK';
        
        // Use onclick to overwrite previous handlers (fixes stale reference issue)
        msgModalOkBtn.onclick = () => {
            messageModal.style.display = 'none';
        };
        
        messageModal.style.display = 'flex';
    }

    function showCustomConfirm(message, callback, title = 'Confirmation') {
        if (!messageModal) { const result = confirm(message); callback(result); return; } // Fallback
        msgModalTitle.textContent = title;
        msgModalText.textContent = message;
        msgModalCancelBtn.style.display = 'inline-block';
        msgModalOkBtn.textContent = 'Yes';

        // Use onclick to overwrite previous handlers


        msgModalOkBtn.onclick = () => {
            messageModal.style.display = 'none';
            callback(true);
        };

        msgModalCancelBtn.onclick = () => {
            messageModal.style.display = 'none';
            callback(false);
        };
        
        messageModal.style.display = 'flex';
    }

    // NEW HELPER FOR ASYNC CONFIRMATIONS
    function showCustomConfirmAsync(message, title = 'Confirmation') {
        return new Promise(resolve => {
            showCustomConfirm(message, resolve, title);
        });
    }

    // ===================================================================================
    // ONLINE/OFFLINE DETECTION
    // ===================================================================================
    function updateConnectionStatus(isOnline) {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
            const lastSync = localStorage.getItem('lastSyncTime');
            const syncText = lastSync ? `\nLast synced: ${lastSync}` : '';

            if (isOnline) {
                statusEl.classList.remove('offline');
                statusEl.classList.add('online');
                statusEl.title = "Online: You are connected to the internet." + syncText;
            } else {
                statusEl.classList.remove('online');
                statusEl.classList.add('offline');
                statusEl.title = "Offline: You are currently working offline." + syncText;
            }
        }
    }

    // NEW: Auto Sync Function
    function performAutoSync() {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
            statusEl.classList.remove('online', 'offline');
            statusEl.classList.add('syncing');
            statusEl.title = "Syncing data...";
        }

        console.log("Connection restored. Initiating auto-sync...");

        // 1. Retry loading images that failed (e.g., logos) while offline
        const images = document.querySelectorAll('img');
        images.forEach(img => {
            if (img.style.display === 'none') {
                const currentSrc = img.src;
                img.src = ''; // Clear to force reload
                img.src = currentSrc;
                img.style.display = ''; // Reset display to visible
            }
        });

        // 2. Simulate Data Sync (Placeholder for future backend)
        setTimeout(() => {
            const now = new Date();
            const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            localStorage.setItem('lastSyncTime', timeString);

            if (statusEl) {
                statusEl.classList.remove('syncing');
                statusEl.classList.add('online');
                statusEl.title = `Online: You are connected to the internet.\nLast synced: ${timeString}`;
            }
            console.log("Sync complete.");
        }, 2000); // 2 seconds fake sync time
    }

    // Initial check on load
    updateConnectionStatus(navigator.onLine);

    window.addEventListener('online', () => {
        updateConnectionStatus(true);
        performAutoSync(); // Trigger Auto Sync
    });

    window.addEventListener('offline', () => {
        updateConnectionStatus(false);
    });

    // ===================================================================================
    // HELPER: GET PHYSICIANS LIST
    // ===================================================================================
    function getPhysicians() {
        const stored = localStorage.getItem('clinicPhysicians');
        if (stored) {
            let physicians = JSON.parse(stored);
            // Auto-correct old name if present
            const oldName = 'Jess Ressurecion M. Jardin, MD, FPSO-HNS';
            const newName = 'JESUS RESURRECCION M. JARDIN, M.D., FPSO-HNS';
            const index = physicians.indexOf(oldName);
            if (index !== -1) {
                physicians[index] = newName;
                localStorage.setItem('clinicPhysicians', JSON.stringify(physicians));
            }
            return physicians;
        }
        // Default physicians if none stored
        return [
            'JESUS RESURRECCION M. JARDIN, MD., FPSO, HNS',
            'MONIQUE LUCIA A. JARDIN-QUING, MD, FPSO-HNS'
        ];
    }

    // ===================================================================================
    // EVENT LISTENERS
    // ===================================================================================
    // Attach listeners only if the elements exist on the current page.
    // This makes the script more robust and prevents errors on other pages.
    
    // Listeners for report pages (Nasal/Laryngeal)
    if (currentReportType === 'nasal' || currentReportType === 'laryngeal') {
        // Hide Referring Physician field as requested. This assumes the input has id="referringPhysician"
        // and is inside a div with class="form-group".
        const referringPhysicianInput = document.getElementById('referringPhysician');
        if (referringPhysicianInput) {
            const formGroup = referringPhysicianInput.closest('.form-group');
            if (formGroup) {
                formGroup.style.display = 'none';
            }
        }

        const imageInput = document.getElementById('imageInput');

        // AUTO-UPGRADE: Apply new button design to Laryngeal (or any page with old structure)
        if (imageInput && !imageInput.classList.contains('hidden-file-input')) {
            imageInput.classList.add('hidden-file-input');
            const customLabel = document.createElement('label');
            customLabel.htmlFor = 'imageInput';
            customLabel.className = 'custom-file-label';
            customLabel.textContent = '📂 Attach Image';
            if (imageInput.parentNode) {
                imageInput.parentNode.insertBefore(customLabel, imageInput.nextSibling);
            }
        }

        // Ensure preview div has the correct class for styling (fixes X button positioning)
        const previewDiv = document.getElementById('preview');
        if (previewDiv && !previewDiv.classList.contains('image-preview')) {
            previewDiv.classList.add('image-preview');
        }

        // Sync Header Logos from Settings
        const savedSettings = JSON.parse(localStorage.getItem('clinicSettings') || '{}');
        const headerLeftLogo = document.getElementById('headerLeftLogo');
        const headerRightLogo = document.getElementById('headerRightLogo');

        if (headerLeftLogo) {
            if (savedSettings.leftLogo) {
                headerLeftLogo.src = savedSettings.leftLogo;
            } else {
                // Default hospital is CUMC; an explicit "rever" selection
                // (with no custom logo) still shows the RMCI logo.
                headerLeftLogo.src = assetUrl(
                    savedSettings.hospitalHeader === 'rever'
                        ? 'image/rmci-logo.png'
                        : 'image/cumc-logo.png');
            }
        }
        if (headerRightLogo && savedSettings.rightLogo) {
            headerRightLogo.src = savedSettings.rightLogo;
        }
        // The hospital line above the form title follows the same selection
        // as the printed letterhead. Default: CAPITOL UNIVERSITY MEDICAL CENTER.
        const HOSPITAL_NAMES = {
            capitol: 'CAPITOL UNIVERSITY MEDICAL CENTER',
            rever: 'REVER MEDICAL CENTER INC.'
        };
        const hospitalNameLine = HOSPITAL_NAMES[savedSettings.hospitalHeader || 'capitol']
            || HOSPITAL_NAMES.capitol;
        document.querySelectorAll('.header-hospital').forEach(function (el) {
            el.textContent = hospitalNameLine;
        });

        // NEW: Enhance dropdowns to be editable with suggestions (Findings & Procedure Type)
        function enhanceDropdowns() {
            // --- CONFIGURATION FOR SPECIFIC OPTIONS ---
            // To add more specific options, just add a new entry here.
            // The key should be the 'id' of the select element.
            const specificOptionsConfig = {
                // --- GENERAL PATIENT INFO ---
                'patientSex': ['Male', 'Female'],
                'classification': ['Minor', 'Major'],
                
                // --- PROCEDURE CODES ---
                'rvsCode': [
                    '31290 - Nasal/ sinus endoscopy, surgical, with biopsy, single or multiple sites',
                    '31267 - Endoscopic, maxillary sinusotomy, with removal of tissue from maxillary sinus',
                    '31276 - Nasal/sinus endoscopy, surgical; with removal of tissue from nasal cavity',
                    '31255 - Endoscopic, excision of lesion from ethmoid sinus',
                    '31288 - Endoscopic, control of epistaxis, cauterization/internal packing',
                    '30120 - Excision, intranasal turbinate, partial or complete',
                    '30420 - Septoplasty or submucous resection, with or without cartilage graft',
                    '30801 - Cauterization and/or ablation, mucosa of turbinates, unilateral or bilateral',
                    '31232 - Nasal/sinus endoscopy, diagnostic, unilateral or bilateral',
                    '31231 - Nasal/sinus endoscopy, diagnostic, unilateral or bilateral',
                    '92511 - Nasal and/or sinus endoscopy (separate procedure)',
                    '41820 - Drainage of abscess, cyst, or hematoma, nasal septum',
                    '69405 - Tracheostomy (emergency procedure)',
                    '31530 - Direct laryngoscopy, operative, with excision of lesion(s)',
                    '31540 - Direct laryngoscopy, operative, with excision of tumor and/or stripping of vocal cords',
                    '31541 - Direct laryngoscopy, operative, with excision of tumor and/or stripping of vocal cords',
                    '31575 - Endoscopic laryngeal procedure (laser)',
                    '31510 - Laryngoscopy, indirect, diagnostic',
                    '31520 - Laryngoscopy, direct, operative, with biopsy',
                    '31560 - Laryngoscopic procedure with operating microscope'
                ],
                'icd10Code': [
                    // --- NASAL CODES ---
                    'J32.0 - Chronic maxillary sinusitis',
                    'J32.1 - Chronic frontal sinusitis',
                    'J32.2 - Chronic ethmoidal sinusitis',
                    'J32.3 - Chronic sphenoidal sinusitis',
                    'J32.4 - Chronic pansinusitis',
                    'J32.8 - Other chronic sinusitis',
                    'J32.9 - Chronic sinusitis, unspecified',
                    'J30.1 - Allergic rhinitis due to pollen',
                    'J30.2 - Other seasonal allergic rhinitis',
                    'J30.3 - Other allergic rhinitis',
                    'J31.0 - Chronic rhinitis',
                    'J34.2 - Deviated nasal septum',
                    'J34.3 - Nasal polyp',
                    'J34.81 - Nasal congestion',
                    'J34.89 - Other specified disorders of nose and nasal sinuses',
                    'R06.00 - Dyspnea, unspecified',
                    'R49.0 - Dysphonia (Hoarseness)',
                    'R05 - Cough',
                    'R51 - Headache',
                    'J33.0 - Polyp of nasal cavity',
                    'J33.1 - Polypoid sinus degeneration',
                    'J33.8 - Other polyp of sinus',
                    'J33.9 - Polyp of sinus, unspecified',
                    'M95.0 - Acquired deformities of nose',
                    // --- LARYNGEAL CODES ---
                    'J38.0 - Paralysis of vocal cords',
                    'J38.1 - Polyp of vocal cord',
                    'J38.2 - Nodule of vocal cords',
                    'J38.3 - Other diseases of vocal cords',
                    'J38.4 - Edema of larynx',
                    'J38.5 - Laryngeal spasm',
                    'J38.6 - Stenosis of larynx',
                    'J38.7 - Other diseases of larynx',
                    'J39.2 - Other diseases of pharynx',
                    'R49.1 - Aphonia (Loss of voice)',
                    'J04.0 - Acute laryngitis',
                    'J04.1 - Acute tracheitis',
                    'J05.0 - Acute obstructive laryngitis (croup)',
                    'D14.1 - Benign neoplasm of larynx',
                    'D14.2 - Benign neoplasm of trachea',
                    'R47.01 - Aphasia',
                    'R47.89 - Other speech disturbances'
                ],
                
                // --- PROCEDURE DETAILS ---
                // 'indication' is now dynamically set based on the report type below.
                'anesthesiaUsed': [
                    'Local', 'Topical Anesthesia', '10% Lidocaine Spray', '2% Xylocaine Spray', 'Co-Phenylcaine Spray', '4% Cocaine Solution', 
                    'Oxymetazoline Spray', 'Local Infiltration', 'General Anesthesia', 'None'
                ],

                // --- NASAL FINDINGS ---
                'septum': ['Normal / Midline', 'Deviated to the Left', 'Deviated to the Right', 'Septal Spur Left', 'Septal Spur Right', 'Perforated Septum'],
                'discharge': ['None', 'Clear / Watery', 'Mucoid', 'Purulent', 'Mucopurulent', 'Bloody', 'Crusting'],
                'mucosa': ['Pink / Normal', 'Pale / Boggy', 'Congested / Inflamed', 'Erythematous', 'Atrophic', 'Ulcerated'],
                'it': ['Normal', 'Hypertrophic Left', 'Hypertrophic Right', 'Hypertrophic Bilateral', 'Atrophic', 'Pale / Boggy', 'Congested', 'Polypoid Change'], // Inferior Turbinate
                'mt': ['Normal', 'Hypertrophic Left', 'Hypertrophic Right', 'Polypoid Change', 'Concha Bullosa Left', 'Concha Bullosa Right', 'Paradoxical Curvature'], // Middle Turbinate
                'mm': ['Clear / Patent', 'Discharge Present Left', 'Discharge Present Right', 'Edematous', 'Mass Lesion Left', 'Mass Lesion Right', 'Polyp Grade 1 Left', 'Polyp Grade 1 Right', 'Polyp Grade 2 Left', 'Polyp Grade 2 Right', 'Polyp Grade 3 Left', 'Polyp Grade 3 Right', 'Polyp Grade 4 Left', 'Polyp Grade 4 Right'], // Middle Meatus
                'im': ['Clear', 'Discharge Present Left', 'Discharge Present Right', 'Hasner\'s Valve Patent'], // Inferior Meatus
                'omc': ['Patent', 'Obstructed Left', 'Obstructed Right', 'Polypoid Obstruction', 'Discharge from Ostium'], // Ostiomeatal Complex
                'nasopharynx': ['Clear / Normal', 'Adenoid Hypertrophy Grade 1', 'Adenoid Hypertrophy Grade 2', 'Adenoid Hypertrophy Grade 3', 'Adenoid Hypertrophy Grade 4', 'Mass Lesion', 'Ulceration', 'Post-nasal Drip', 'Eustachian Tube Dysfunction Left', 'Eustachian Tube Dysfunction Right'],

                // --- LARYNGEAL FINDINGS ---
                'epiglottis': ['Normal', 'Omega-shaped', 'Edematous', 'Erythematous', 'Mass Lesion', 'Ulceration'],
                'vallecula': ['Clear', 'Vallecular Cyst Left', 'Vallecular Cyst Right', 'Mass Lesion', 'Pooling of Saliva'],
                'pyriformSinuses': ['Clear', 'Pooling of Saliva Left', 'Pooling of Saliva Right', 'Mass Lesion Left', 'Mass Lesion Right', 'Foreign Body'],
                'arytenoids': ['Normal', 'Erythematous Left', 'Erythematous Right', 'Edematous Left', 'Edematous Right', 'Mass Lesion Left', 'Mass Lesion Right', 'Contact Ulcer Left', 'Contact Ulcer Right'],
                'falseVocalCords': ['Normal', 'Hypertrophic Left', 'Hypertrophic Right', 'Erythematous'],
                'trueVocalCords': ['Normal', 'Erythematous', 'Edematous', 'Nodule Left', 'Nodule Right', 'Nodule Bilateral', 'Polyp Left', 'Polyp Right', 'Cyst Left', 'Cyst Right', 'Mass Lesion Left', 'Mass Lesion Right', 'Palsy / Paralysis Left', 'Palsy / Paralysis Right', 'Leukoplakia'],
                'vocalCordMobility': ['Mobile and Symmetrical', 'Unilateral Paralysis Left', 'Unilateral Paralysis Right', 'Bilateral Paralysis', 'Paresis Left', 'Paresis Right', 'Fixed Left', 'Fixed Right', 'BILATERAL TRUE VOCAL CORD PARALYSIS AT PARAMEDIAN POSITION'],
                'subglottis': ['Normal', 'Subglottic Stenosis', 'Mass Lesion', 'Inflamed', 'GRANULATION TISSUE AT TIP OF TRACHEOSTOMT TUBE'],

                // --- IMPRESSION & RECOMMENDATION ---
                'impression': [
                    'Normal Endoscopic Findings', 'Deviated Nasal Septum', 'Septal Spur', 'Allergic Rhinitis', 'Acute Rhinosinusitis', 'Chronic Rhinosinusitis', 
                    'Nasal Polyposis', 'Adenoid Hypertrophy', 'Nasopharyngeal Mass', 'Laryngopharyngeal Reflux', 'Acute Laryngitis', 'Chronic Laryngitis',
                    'Vocal Cord Nodule', 'Vocal Cord Polyp', 'Vocal Cord Cyst', 'Vocal Cord Paralysis',
                    'Reinke\'s Edema', 'Laryngeal Mass', 'Subglottic Stenosis', 'Laryngeal Papillomatosis', 'Foreign Body', 'Epistaxis'
                ],
                'recommendation': [
                    'Medical Management', 'Nasal Saline Irrigation', 'Intranasal Corticosteroids', 'Antihistamines', 'Antibiotics', 'Decongestants',
                    'Proton Pump Inhibitors', 'Dietary Modification', 'Lifestyle Changes', 'Voice Rest', 'Voice Therapy',
                    'CT Scan of Paranasal Sinuses', 'CT Scan of Neck', 'Biopsy', 'Direct Laryngoscopy', 'Septoplasty', 'FESS',
                    'Microlaryngeal Surgery', 'Follow up after 1 week', 'Follow up after 2 weeks', 'Refer to Neurologist', 'Refer to Oncologist', 'Refer to Gastroenterologist'
                ]
            };

            // Define indications for each report type
            if (currentReportType === 'nasal') {
                specificOptionsConfig['endoscopyType'] = [
                    'FLEXIBLE FIBEROPTIC ENDOSCOPY'
                ];
                specificOptionsConfig['indication'] = [
                    // Nasal / Sinus
                    'Nasal Obstruction', 'Epistaxis (Nosebleed)', 'Chronic Rhinosinusitis', 'Acute Rhinosinusitis', 
                    'Anosmia / Hyposmia (Loss of Smell)', 'Nasal Polyposis', 'Nasal Mass', 'Foreign Body in Nose',
                    'Rhinorrhea (Runny Nose)', 'Post-nasal Drip', 'Facial Pain / Pressure', 'Deviated Nasal Septum', 'Headache',
                    'Eustachian Tube Dysfunction',
                    // General
                    'Screening / Clearance', 'Post-op Checkup', 'Follow-up Evaluation', 'Surveillance'
                ];

            } else if (currentReportType === 'laryngeal') {
                specificOptionsConfig['endoscopyType'] = [
                    '70° Rigid Endoscope', '90° Rigid Endoscope', 'FLEXIBLE FIBEROPTIC ENDOSCOPY AND TRACHEOSCOPY', 'Video Laryngoscope'
                ];
                specificOptionsConfig['indication'] = [
                    // Laryngeal / Throat / Voice
                    'Hoarseness / Dysphonia', 'HOARSENESS AND DYSPNEA', 'Aphonia (Loss of Voice)', 'Dysphagia (Difficulty Swallowing)', 'Odynophagia (Painful Swallowing)', 
                    'Stridor', 'Hemoptysis', 'Foreign Body Sensation (Globus Pharyngeus)', 'Chronic Cough', 'Throat Clearing', 
                    'Laryngopharyngeal Reflux (LPR)', 'Neck Mass', 'Vocal Cord Paralysis', 'Sore Throat',
                    // General
                    'Screening / Clearance', 'Post-op Checkup', 'Follow-up Evaluation', 'Surveillance'
                ];

            }

            // Apply to all configured fields (Selects AND Inputs)

            Object.keys(specificOptionsConfig).forEach(id => {
                const element = document.getElementById(id);
                if (!element) return;

                const datalistId = `${id}-list`;
                
                let datalist = document.getElementById(datalistId);

                // Create datalist if it doesn't exist
                if (!datalist) {
                    datalist = document.createElement('datalist');
                    datalist.id = datalistId;
                    element.parentNode.appendChild(datalist);
                } else {
                    // Clear existing options to ensure we use the JS-defined ones (fixes empty datalist issue)
                    datalist.innerHTML = '';
                }

                specificOptionsConfig[id].forEach(val => {
                    const optionEl = document.createElement('option');
                    
                    // NEW: Separate Code from Description for RVS and ICD-10
                    if ((id === 'rvsCode' || id === 'icd10Code') && val.includes(' - ')) {
                        const splitIndex = val.indexOf(' - ');
                        optionEl.value = val.substring(0, splitIndex); // Input gets only the code (e.g. "31290")
                        optionEl.textContent = val.substring(splitIndex + 3); // List shows description as hint
                    } else {
                        optionEl.value = val;
                    }
                    
                    datalist.appendChild(optionEl);
                });
                
                if (element.tagName === 'SELECT') {
                    // Skip converting physician/assistant surgeon selects to input
                    // These need to remain as select dropdowns for surgeon selection
                    if (id === 'physician' || id === 'assistantSurgeon') {
                        return; // Skip conversion, keep as select
                    }
                    
                    // Convert SELECT to INPUT TEXT for other fields
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.id = id;
                    input.name = element.name;
                    input.setAttribute('list', datalistId);
                    input.className = element.className;
                    input.placeholder = "Select or type...";
                    // Preserve existing value or selection
                    input.value = element.value;
                    
                    element.replaceWith(input);
                } else if (element.tagName === 'INPUT' && element.type === 'text') {
                    // Attach to existing INPUT TEXT
                    element.setAttribute('list', datalistId);
                    element.placeholder = "Select or type...";
                }
            });
        }

        // NEW: Auto-Capitalize Indication field on blur for professional formatting
        const indicationField = document.getElementById('indication');
        if (indicationField) {
            indicationField.addEventListener('blur', function() {
                if (this.value && this.value.length > 0) {
                    this.value = this.value.charAt(0).toUpperCase() + this.value.slice(1);
                    this.dispatchEvent(new Event('input')); // Trigger auto-save
                }
            });
        }

        // NEW: Helper to resize/compress images (Prevents Storage Full errors & speeds up PDF)
        //
        // This is the ATTACH-TIME entry point, and it now delegates to
        // EntPhotoStore.compressImage so that every photo entering the form
        // leaves as one thing: WebP where the browser can encode it, JPEG
        // where it cannot, never above photoStore's size band.
        //
        // Doing it HERE rather than only at save time is what makes a draft
        // and a stored object the same file - the base64 sitting in
        // selectedImages is already the small one, so My Drafts, the record,
        // the printed report and the bucket all agree.
        //
        // The signature and the promise contract are unchanged, so all five
        // existing callers keep working untouched. The old inline JPEG
        // behaviour is kept as the fallback for a page where photoStore.js
        // did not load - losing the photo would be far worse than a
        // slightly bigger one.
        function resizeImage(base64Str, maxWidth = 1024, quality = 0.8) {
            const store = window.EntPhotoStore;
            if (store && typeof store.compressImage === 'function') {
                return store.compressImage(base64Str, {
                    maxDim: maxWidth,
                    maxBytes: store.COMPRESS ? store.COMPRESS.maxBytes : undefined
                }).then((result) => (result && result.ok && result.dataUrl) || base64Str);
            }
            return new Promise((resolve) => {
                const img = new Image();
                img.src = base64Str;
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;

                    // Scale down if too big
                    if (width > maxWidth) {
                        height *= maxWidth / width;
                        width = maxWidth;
                    }

                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', quality)); // Convert to JPEG 80%
                };
                img.onerror = () => resolve(base64Str); // Fallback if error
            });
        }

        imageInput?.addEventListener('change', handleFileSelectForCropping);

        imageInput?.addEventListener('click', (e) => {
            if (selectedImages.length >= 6) {
                e.preventDefault();
                showCustomAlert("Maximum of 6 images reached. Please remove an image to add a new one.", "Limit Reached");
            }
        });
        
        // AUTO-CAPITALIZE
        ['patientFirstName', 'patientLastName', 'patientMiddleName'].forEach(id => {
            const nameField = document.getElementById(id);
            if (nameField) {
                nameField.addEventListener('blur', function() {
                    if (!this.value) return;

                    // Get the capitalization setting from localStorage
                    const savedSettings = JSON.parse(localStorage.getItem('clinicSettings') || '{}');
                    const nameCaseStyle = savedSettings.patientNameCase || 'upper'; // Default to uppercase

                    if (nameCaseStyle === 'upper') {
                        this.value = this.value.toUpperCase();
                    } else { // 'title' case
                        this.value = this.value.toLowerCase().replace(/\b\w/g, s => s.toUpperCase());
                    }
                    
                    this.dispatchEvent(new Event('input')); // Trigger auto-save
                });
            }
        });

        // Call the new function to transform dropdowns before other logic
        enhanceDropdowns();
        
        // ===================================================================================
        // SET ALL NORMAL BUTTON (NEW)
        // ===================================================================================
        function setupSetNormalButton() {
            // Only for report pages
            if (currentReportType !== 'nasal' && currentReportType !== 'laryngeal') return;

            // Find a good place to insert the button. 
            // Usually before the first finding input (e.g., 'septum' or 'epiglottis')
            const firstFindingId = currentReportType === 'nasal' ? 'septum' : 'epiglottis';
            const firstInput = document.getElementById(firstFindingId);
            
            if (!firstInput) return;

            // Create the button
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-set-normal'; // Use new custom class
            btn.innerHTML = '✅ Set All Normal';

            // Insert before the parent of the first input (assuming it's in a form-group or fieldset)
            let targetContainer = firstInput.closest('fieldset');
            
            // If inside a fieldset, insert as the first item in legend or top
            if (targetContainer) {
                const legend = targetContainer.querySelector('legend');
                if (legend) {
                    legend.parentNode.insertBefore(btn, legend.nextSibling);
                } else {
                    targetContainer.insertBefore(btn, targetContainer.firstChild);
                }
            } else {
                // Fallback: Insert before the input's container
                targetContainer = firstInput.closest('.form-group') || firstInput.parentNode;
                targetContainer.parentNode.insertBefore(btn, targetContainer);
            }

            btn.addEventListener('click', () => {
                showCustomConfirm("This will overwrite all current findings with 'Normal' values. Proceed?", (confirmed) => {
                    if (confirmed) {
                        // Define Normal Values based on Report Type
                        const normalValues = currentReportType === 'nasal' ? {
                            'septum': 'Normal / Midline',
                            'discharge': 'None',
                            'mucosa': 'Pink / Normal',
                            'it': 'Normal',
                            'mt': 'Normal',
                            'mm': 'Clear / Patent',
                            'im': 'Clear',
                            'omc': 'Patent (Open)',
                            'nasopharynx': 'Clear / Normal'
                        } : {
                            'epiglottis': 'Normal',
                            'vallecula': 'Clear',
                            'pyriformSinuses': 'Clear',
                            'arytenoids': 'Normal',
                            'falseVocalCords': 'Normal',
                            'trueVocalCords': 'Normal (Pearly White)',
                            'vocalCordMobility': 'Mobile and Symmetrical',
                            'subglottis': 'Normal'
                        };

                        // Apply values
                        let changeCount = 0;
                        for (const [id, value] of Object.entries(normalValues)) {
                            const input = document.getElementById(id);
                            if (input) {
                                input.value = value;
                                input.dispatchEvent(new Event('input')); // Trigger auto-save
                                changeCount++;
                            }
                        }
                        
                        // Also update Impression/Recommendation if they are empty
                        const imp = document.getElementById('impression');
                        const rec = document.getElementById('recommendation');
                        
                        if (imp && !imp.value) {
                            imp.value = currentReportType === 'nasal' ? 'Normal Endoscopic Findings' : 'Normal Laryngoscopy';
                            imp.dispatchEvent(new Event('input'));
                        }
                        if (rec && !rec.value) {
                            rec.value = 'Follow up as needed';
                            rec.dispatchEvent(new Event('input'));
                        }

                        showCustomAlert(`Updated ${changeCount} fields to Normal.`, "Success");
                    }
                }, "Set All Normal");
            });
        }

        // NEW: Function to create "Clear Findings" button
        function setupClearFindingsButton() {
            const findingsFieldset = document.querySelector('.findings-fieldset');
            if (!findingsFieldset) return;

            if (document.getElementById('clearFindingsBtn')) return;

            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.id = 'clearFindingsBtn';
            clearBtn.className = 'btn-clear-findings';
            clearBtn.innerHTML = '🗑️ Clear';

            const undoBtn = document.createElement('button');
            undoBtn.type = 'button';
            undoBtn.id = 'undoClearFindingsBtn';
            undoBtn.className = 'btn-clear-findings';
            undoBtn.innerHTML = '↩ Undo';
            undoBtn.style.display = 'none';
            undoBtn.style.borderColor = 'var(--secondary-color)';
            undoBtn.style.color = 'var(--secondary-color)';
            undoBtn.onmouseover = () => { undoBtn.style.backgroundColor = 'var(--secondary-color)'; undoBtn.style.color = 'white'; };
            undoBtn.onmouseout = () => { undoBtn.style.backgroundColor = 'transparent'; undoBtn.style.color = 'var(--secondary-color)'; };

            const setNormalBtn = findingsFieldset.querySelector('.btn-set-normal');
            if (setNormalBtn) {
                setNormalBtn.insertAdjacentElement('beforebegin', undoBtn);
                setNormalBtn.insertAdjacentElement('beforebegin', clearBtn);
            } else {
                const legend = findingsFieldset.querySelector('legend');
                if (legend) { legend.insertAdjacentElement('afterend', undoBtn); legend.insertAdjacentElement('afterend', clearBtn); } 
                else { findingsFieldset.prepend(undoBtn); findingsFieldset.prepend(clearBtn); }
            }

            clearBtn.addEventListener('click', () => {
                showCustomConfirm("Are you sure you want to clear all findings fields? You can undo this action.", (confirmed) => {
                    if (confirmed) {
                        lastClearedFindings = {};
                        const findingsInputs = findingsFieldset.querySelectorAll('input[type="text"], select');
                        let clearedCount = 0;
                        findingsInputs.forEach(input => {
                            if (input.value !== '') {
                                lastClearedFindings[input.id] = input.value;
                                input.value = '';
                                input.dispatchEvent(new Event('input'));
                                clearedCount++;
                            }
                        });
                        if (clearedCount > 0) { clearBtn.style.display = 'none'; undoBtn.style.display = 'inline-flex'; }
                    }
                }, "Clear Findings");
            });

            undoBtn.addEventListener('click', () => {
                if (lastClearedFindings) {
                    for (const [id, value] of Object.entries(lastClearedFindings)) {
                        const input = document.getElementById(id);
                        if (input) { input.value = value; input.dispatchEvent(new Event('input')); }
                    }
                    lastClearedFindings = null;
                    undoBtn.style.display = 'none';
                    clearBtn.style.display = 'inline-flex';
                }
            });

            findingsFieldset.addEventListener('input', () => {
                if (lastClearedFindings) { lastClearedFindings = null; undoBtn.style.display = 'none'; clearBtn.style.display = 'inline-flex'; }
            });
        }

        // NEW: Initialize Set All Normal Button for efficiency
        setupSetNormalButton();
        // NEW: Initialize Clear Findings Button
        setupClearFindingsButton();
        
        // ===================================================================================
        // AUTO-CALCULATION FOR OPERATION DURATION
        // ===================================================================================
        function setupDurationCalculation() {
            // Only for report pages
            if (currentReportType !== 'nasal' && currentReportType !== 'laryngeal') return;

            const startTimeInput = document.getElementById('operationStarted');
            const endTimeInput = document.getElementById('operationEnded');
            const durationInput = document.getElementById('durationOfOperation');

            // Function to calculate duration
            const calculateDuration = () => {
                if (!startTimeInput || !endTimeInput || !durationInput) return;
                
                const start = startTimeInput.value;
                const end = endTimeInput.value;

                if (start && end) {
                    const [startHour, startMin] = start.split(':').map(Number);
                    const [endHour, endMin] = end.split(':').map(Number);

                    let startTotalMins = startHour * 60 + startMin;
                    let endTotalMins = endHour * 60 + endMin;

                    // Handle overnight procedures
                    if (endTotalMins < startTotalMins) {
                        endTotalMins += 24 * 60;
                    }

                    const diffMins = endTotalMins - startTotalMins;
                    
                    if (diffMins > 0) {
                        const hours = Math.floor(diffMins / 60);
                        const mins = diffMins % 60;
                        
                        if (hours > 0) {
                            durationInput.value = `${hours} hr ${mins} min`;
                        } else {
                            durationInput.value = `${mins} min`;
                        }
                    } else {
                        durationInput.value = '';
                    }
                } else {
                    durationInput.value = '';

                }
            };

            // Add event listeners
            if (startTimeInput) {
                startTimeInput.addEventListener('change', calculateDuration);
            }
            if (endTimeInput) {
                endTimeInput.addEventListener('change', calculateDuration);
            }
        }

        // NEW: Initialize auto-calculation for operation duration
        setupDurationCalculation();

        // Initialize Video to Image feature
        setupVideoToImage();
        // Initialize Auto Fields (Impression & Recommendation)
        setupAutoFields();
        // Textarea suggestion popups (a native <datalist> cannot attach to a
        // <textarea>). Reads the same option lists the datalists use, so the doctor
        // still gets suggestions but can type freely. id/name are unchanged, so
        // saving, drafts, the database and the printed PDF are all unaffected.
        setupTextareaSuggest(document.getElementById('preOpDiagnosis'), 'preOpDiagnosisOptions');
        setupTextareaSuggest(document.getElementById('impression'), 'impression-list');
        setupTextareaSuggest(document.getElementById('recommendation'), 'recommendation-list');
        // TYPE OF ENDOSCOPY / OPERATION PERFORMED is now a <textarea> too, so it
        // gets the same suggestion popup (reads the endoscopyType-list datalist).
        setupTextareaSuggest(document.getElementById('endoscopyType'), 'endoscopyType-list');

        // NEW: Clear Images Button Functionality
        const clearImagesBtn = document.getElementById('clearImagesBtn');
        if (clearImagesBtn) {
            const undoBtn = document.createElement('button');
            undoBtn.id = 'undoClearImagesBtn';
            undoBtn.type = 'button';
            undoBtn.className = 'btn-clear-images';
            undoBtn.style.display = 'none';
            undoBtn.style.background = 'linear-gradient(135deg, var(--secondary-color), var(--secondary-hover-color))';
            undoBtn.innerHTML = '↩ Undo Clear';
            if (clearImagesBtn.parentNode) {
                clearImagesBtn.parentNode.insertBefore(undoBtn, clearImagesBtn.nextSibling);
            }

            clearImagesBtn.addEventListener('click', () => {
                showCustomConfirm("Are you sure you want to remove all images? You can undo this action.", (confirmed) => {
                    if (confirmed) {
                        if (selectedImages.length > 0) {
                            lastClearedImages = [...selectedImages];
                            selectedImages = [];
                            refreshPreview();
                        }
                    }
                }, "Clear Images");
            });

            undoBtn.addEventListener('click', () => {
                if (lastClearedImages) {
                    selectedImages = [...lastClearedImages];
                    lastClearedImages = null;
                    refreshPreview();
                }
            });
        }

        // Button listeners: one clear action per button.
        document.getElementById('savePdfBtn')?.addEventListener('click', () => printReport());
        document.getElementById('printBtn')?.addEventListener('click', handleNativePrint);

        // NEW FORM: prepares a blank form of the same type for the next patient.
        // It reuses the Clear Form routine (blank fields, today's date, no images)
        // so the existing Undo button keeps working the same way.
        document.getElementById('newFormBtn')?.addEventListener('click', () => {
            showCustomConfirm(
                'Start a new blank form? The current entries will be cleared to prepare for the next patient. You can undo this action.',
                (confirmed) => {
                    if (confirmed) clearFormWithoutConfirmation(true);
                },
                'New Form'
            );
        });

        // ===================================================================================
        // SAVE TO EDIT & OPEN (RESTORE & EDIT) - JSON DATA FILE (SAME AS CF4)
        // ===================================================================================
        const saveDataBtn = document.getElementById('saveDataBtn');
        if (saveDataBtn) {
            saveDataBtn.addEventListener('click', async () => {
                try {
                    const formData = getFormData();
                    const dataStr = JSON.stringify(formData, null, 2);
                    const safeName = (formData.patientLastName || '').replace(/[^a-z0-9\s-]/gi, '').trim().replace(/\s+/g, '_');
                    const firstName = (formData.patientFirstName || '').replace(/[^a-z0-9\s-]/gi, '').trim().replace(/\s+/g, '_');
                    const reportLabel = currentReportType === 'laryngeal' ? 'Laryngeal' : 'Nasal';
                    const filename = firstName ? `${safeName}, ${firstName}_${reportLabel}_Data.json` : (safeName ? `${safeName}_${reportLabel}_Data.json` : `${reportLabel}_Data.json`);

                    if (window.EntDrafts && typeof window.EntDrafts.saveAndOpen === 'function') {
                        // v28: Save Draft stores the draft on THIS DEVICE (localStorage),
                        // flashes "✓ Saved" on the button and shows a small "Draft saved"
                        // popup with Open it / All drafts / .json download actions.
                        await window.EntDrafts.saveAndOpen(currentReportType, formData, filename);
                    } else {
                        // Fallback: previous behavior - download the .json right away.
                        const blob = new Blob([dataStr], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = filename;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        URL.revokeObjectURL(url);
                    }
                    window.PatientRecords?.recordSave(currentReportType, formData, { format: 'Draft', fileName: filename });

                    // v26: success feedback now appears inside the Saved Drafts popup.
                } catch (err) {
                    console.error('Error saving data:', err);
                    showCustomAlert('❌ ERROR SAVING DATA\n\n' + err.message, 'ERROR');
                }
            });
        }

        // REFACTORED: Clear Form & Undo Logic
        const clearFormBtn = document.getElementById('clearFormBtn');
        const undoClearBtn = document.createElement('button');
        undoClearBtn.id = 'undoClearBtn';
        undoClearBtn.type = 'button';
        undoClearBtn.className = 'btn-secondary';
        undoClearBtn.style.display = 'none';
        undoClearBtn.innerHTML = '↩ Undo Clear';

        if (clearFormBtn && clearFormBtn.parentNode) {
            clearFormBtn.parentNode.insertBefore(undoClearBtn, clearFormBtn.nextSibling);
            clearFormBtn.addEventListener('click', () => clearForm(true));

            undoClearBtn.addEventListener('click', () => {
                if (lastClearedData) {
                    loadDataIntoForm(lastClearedData);
                    undoClearBtn.style.display = 'none';
                    clearFormBtn.style.display = 'inline-flex';
                    lastClearedData = null;
                    showCustomAlert("Form data restored.", "Undo Successful");
                }
            });

            reportForm.addEventListener('input', () => {
                if (lastClearedData) {
                    lastClearedData = null;
                    undoClearBtn.style.display = 'none';
                    clearFormBtn.style.display = 'inline-flex';
                }
            });
        }

        // Help Modal Logic
        const helpBtn = document.getElementById('helpBtn');
        const helpModal = document.getElementById('helpModal');
        const closeHelpBtn = document.getElementById('closeHelpBtn');

        if (helpBtn && helpModal && closeHelpBtn) {
            helpBtn.addEventListener('click', () => {
                helpModal.style.display = 'flex';
            });
            closeHelpBtn.addEventListener('click', () => {
                helpModal.style.display = 'none';
            });
            // Close on click outside
            helpModal.addEventListener('click', (e) => {
                if (e.target === helpModal) helpModal.style.display = 'none';
            });
        }

        // ===================================================================================
        // TUTORIAL MODE LOGIC
        // ===================================================================================
        const tutorialBtn = document.getElementById('tutorialBtn');
        
        if (tutorialBtn) {
            const steps = [
                { id: 'saveDataBtn', title: '💾 Save to Offline Mode', text: 'Saves your current work to this device\'s offline database (IndexedDB). Works with or without signal - the sync engine uploads it to the cloud automatically when you are back online.' },
                { id: 'localDraftsBtn', title: '🗂️ Offline Records', text: 'Lists the records saved in offline mode on this device (IndexedDB). Open one to continue editing it. These sync to the cloud automatically when you are back online.' },
                { id: 'myDraftsBtn', title: '📂 My Drafts', text: 'Browse saved drafts and open one to continue editing it.' },
                { id: 'savePdfBtn', title: '📄 Save PDF', text: 'Creates the FINAL PDF copy of the completed report for printing, emailing, or archiving.' },
                { id: 'printBtn', title: '🖨️ Print', text: 'Opens the print dialog immediately. Use this to print directly to a printer.' },
                { id: 'newFormBtn', title: '🆕 New Form', text: 'Starts a fresh blank form of the same type for the next patient. You can undo this.' },
                { id: 'clearFormBtn', title: '🗑️ Clear Form', text: 'Resets all fields and removes all images to start a fresh report. You can undo this.' },
                { id: 'helpBtn', title: '❓ Help', text: 'Shows a quick reference guide explaining these buttons anytime you need it.' }
            ];

            let currentStepIndex = 0;
            let overlay, tooltip;

            function createTutorialElements() {
                overlay = document.createElement('div');
                overlay.className = 'tutorial-overlay';
                document.body.appendChild(overlay);

                tooltip = document.createElement('div');
                tooltip.className = 'tutorial-tooltip';
                document.body.appendChild(tooltip);
            }

            function showStep(index) {
                if (index >= steps.length) {
                    endTutorial();
                    return;
                }

                const step = steps[index];
                const element = document.getElementById(step.id);

                if (!element) {
                    showStep(index + 1); // Skip if element not found
                    return;
                }

                // Highlight element
                document.querySelectorAll('.tutorial-active-element').forEach(el => {
                    el.classList.remove('tutorial-active-element');
                });
                element.classList.add('tutorial-active-element');

                // Position tooltip
                const rect = element.getBoundingClientRect();
                const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
                
                // Position below the element, centered
                let top = rect.bottom + scrollTop + 15;
                let left = rect.left + (rect.width / 2) - 140; // Center 280px tooltip

                // Boundary checks to keep tooltip on screen
                if (left < 10) left = 10;
                if (left + 280 > window.innerWidth) left = window.innerWidth - 290;

                tooltip.style.top = `${top}px`;
                tooltip.style.left = `${left}px`;
                
                // Content
                tooltip.innerHTML = `
                    <h4>${step.title}</h4>
                    <p>${step.text}</p>
                    <div class="tutorial-controls">
                        <button class="tutorial-btn tutorial-skip" id="tutSkipBtn">Skip</button>
                        <button class="tutorial-btn tutorial-next" id="tutNextBtn">${index === steps.length - 1 ? 'Finish' : 'Next'}</button>
                    </div>
                `;
                
                overlay.style.display = 'block';
                tooltip.style.display = 'block';

                // Listeners
                document.getElementById('tutNextBtn').onclick = () => {
                    currentStepIndex++;
                    showStep(currentStepIndex);
                };
                document.getElementById('tutSkipBtn').onclick = endTutorial;
                
                // Scroll to element
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            function endTutorial() {
                overlay.style.display = 'none';
                tooltip.style.display = 'none';
                document.querySelectorAll('.tutorial-active-element').forEach(el => {
                    el.classList.remove('tutorial-active-element');
                });
                currentStepIndex = 0;
            }

            tutorialBtn.addEventListener('click', () => {
                if (!overlay) createTutorialElements();
                currentStepIndex = 0;
                showStep(0);
            });
        }

    function openCanvasVideoPlayer(file) {
        // 1. Create Modal
        const modal = document.createElement('div');
        Object.assign(modal.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0,0,0,0.9)', zIndex: '10000', display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
        });

        // 2. Create Elements
        const header = document.createElement('h3');
        header.textContent = "Alternative Video Player (Canvas Mode)";
        header.style.color = 'white';
        header.style.marginBottom = '10px';

        // Hidden Video Element (Source)
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.muted = true;
        
        // NEW: Load volume settings
        const savedVolume = localStorage.getItem('altPlayerVolume');
        const initialVolume = savedVolume !== null ? parseFloat(savedVolume) : 1.0;
        video.volume = initialVolume;
        video.muted = (initialVolume === 0);
        
        video.playsInline = true;
        video.autoplay = true;
        video.loop = true;
        video.style.display = 'none'; // Hide the actual video element

        // Visible Canvas Element (Display)
        const canvas = document.createElement('canvas');
        Object.assign(canvas.style, {
            maxWidth: '90%', maxHeight: '60vh', border: '2px solid #fff',
            backgroundColor: '#000', cursor: 'pointer'
        });

        // NEW: Seek Bar & Controls Container
        const seekContainer = document.createElement('div');
        Object.assign(seekContainer.style, {
            width: '90%', maxWidth: '800px', display: 'flex', alignItems: 'center', gap: '10px', marginTop: '15px'
        });

        const playPauseBtn = document.createElement('button');
        playPauseBtn.textContent = '⏸';
        Object.assign(playPauseBtn.style, {
            background: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255, 255, 255, 0.5)',
            color: 'white',
            borderRadius: '50%',
            width: '40px',
            height: '40px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '20px',
            padding: '0',
            transition: 'all 0.2s ease',
            backdropFilter: 'blur(5px)'
        });
        playPauseBtn.onmouseover = () => { playPauseBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'; playPauseBtn.style.transform = 'scale(1.1)'; };
        playPauseBtn.onmouseout = () => { playPauseBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'; playPauseBtn.style.transform = 'scale(1)'; };

        const seekBar = document.createElement('input');
        seekBar.type = 'range';
        seekBar.min = '0';
        seekBar.value = '0';
        seekBar.step = '0.1';
        seekBar.className = 'alt-player-seek-bar';
        seekBar.style.flex = '1';

        const timeDisplay = document.createElement('span');
        timeDisplay.textContent = "00:00 / 00:00";
        timeDisplay.style.color = 'white';
        timeDisplay.style.fontSize = '12px';
        timeDisplay.style.fontFamily = 'monospace';
        timeDisplay.style.minWidth = '90px';
        timeDisplay.style.textAlign = 'right';

        // NEW: Volume Controls
        const volumeContainer = document.createElement('div');
        Object.assign(volumeContainer.style, {
            display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '10px'
        });

        const volumeIcon = document.createElement('span');
        volumeIcon.textContent = video.muted || video.volume === 0 ? '🔇' : (video.volume < 0.5 ? '🔉' : '🔊');
        Object.assign(volumeIcon.style, {
            color: 'white', fontSize: '18px', cursor: 'pointer', minWidth: '24px', textAlign: 'center', userSelect: 'none'
        });

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '1';
        volumeSlider.step = '0.1';
        volumeSlider.value = video.muted ? 0 : video.volume;
        volumeSlider.className = 'alt-player-seek-bar';
        Object.assign(volumeSlider.style, {
            width: '70px', height: '4px'
        });

        const updateVolumeUI = (vol, isMuted) => {
            volumeSlider.value = isMuted ? 0 : vol;
            if (isMuted || vol === 0) volumeIcon.textContent = '🔇';
            else if (vol < 0.5) volumeIcon.textContent = '🔉';
            else volumeIcon.textContent = '🔊';
        };

        volumeSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            video.volume = val;
            video.muted = (val === 0);
            localStorage.setItem('altPlayerVolume', val);
            updateVolumeUI(val, video.muted);
        });

        volumeIcon.addEventListener('click', () => {
            const newMuted = !video.muted;
            video.muted = newMuted;
            if (newMuted) {
                updateVolumeUI(0, true);
            } else {
                let vol = parseFloat(localStorage.getItem('altPlayerVolume'));
                if (!vol || vol === 0) vol = 1.0;
                video.volume = vol;
                updateVolumeUI(vol, false);
                localStorage.setItem('altPlayerVolume', vol);
            }
        });

        volumeContainer.appendChild(volumeIcon);
        volumeContainer.appendChild(volumeSlider);

        seekContainer.appendChild(playPauseBtn);
        seekContainer.appendChild(seekBar);
        seekContainer.appendChild(timeDisplay);
        seekContainer.appendChild(volumeContainer);

        const controlsDiv = document.createElement('div');
        controlsDiv.style.marginTop = '20px';
        controlsDiv.style.display = 'flex';
        controlsDiv.style.gap = '10px';

        const captureBtn = document.createElement('button');
        captureBtn.textContent = '📸 Capture Frame';
        
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';

        // Apply styles consistent with the app's theme
        const applyBtnStyles = (btn, isPrimary = true) => {
            Object.assign(btn.style, {
                padding: '12px 24px', margin: '0', border: 'none', borderRadius: '12px',
                background: isPrimary ? 'linear-gradient(135deg, var(--primary-color, #0ea5e9), var(--primary-hover-color, #0284c7))' : 'linear-gradient(135deg, var(--secondary-color, #64748b), var(--secondary-hover-color, #475569))',
                color: 'white', fontSize: '14px', fontWeight: '600', textTransform: 'uppercase',
                cursor: 'pointer', minWidth: '140px',
                transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
            });
            // Add hover effects
            btn.onmouseover = () => {
                btn.style.transform = 'translateY(-2px)';
                btn.style.boxShadow = '0 8px 12px rgba(0,0,0,0.15)';
            };
            btn.onmouseout = () => {
                btn.style.transform = 'translateY(0)';
                btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
            };
        };
        applyBtnStyles(captureBtn, true);
        applyBtnStyles(closeBtn, false);

        controlsDiv.appendChild(captureBtn);
        controlsDiv.appendChild(closeBtn);
        modal.appendChild(header);
        modal.appendChild(canvas);
        modal.appendChild(video);
        modal.appendChild(seekContainer); // Add seek bar container
        modal.appendChild(controlsDiv);
        document.body.appendChild(modal);

        // 3. Render Loop
        let animationId;
        // OPTIMIZATION: willReadFrequently helps on old PCs/browsers when using toDataURL (Capture)
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const renderFrame = () => {
            // Safety check: Ensure video has valid dimensions before drawing
            if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
                if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }
            animationId = requestAnimationFrame(renderFrame);
        };

        video.play().then(renderFrame).catch(err => {
            console.error("Canvas player autoplay failed:", err);
            showCustomAlert("Autoplay failed. The video might be corrupted or require user interaction to start.", "Playback Error");
            // Fallback: Try playing muted if audio was the issue (Browser Autoplay Policy)
            if (!video.muted) {
                video.muted = true;
                updateVolumeUI(0, true);
                video.play().then(renderFrame).catch(() => {
                    showCustomAlert("Autoplay failed. Please click play manually.", "Playback Error");
                });
            } else {
                showCustomAlert("Autoplay failed. The video might be corrupted or require user interaction to start.", "Playback Error");
            }
        });

        // NEW: Seek Bar & Play/Pause Logic
        const formatTime = (seconds) => {
            if (isNaN(seconds)) return "00:00";
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        };

        video.addEventListener('loadedmetadata', () => {
            seekBar.max = video.duration;
            timeDisplay.textContent = `00:00 / ${formatTime(video.duration)}`;
        });

        video.addEventListener('timeupdate', () => {
            if (document.activeElement !== seekBar) {
                seekBar.value = video.currentTime;
            }
            timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
        });

        seekBar.addEventListener('input', () => {
            video.currentTime = seekBar.value;
            timeDisplay.textContent = `${formatTime(seekBar.value)} / ${formatTime(video.duration)}`;
        });

        const togglePlay = () => {
            if (video.paused) {
                video.play();
                playPauseBtn.textContent = '⏸';
            } else {
                video.pause();
                playPauseBtn.textContent = '▶';
            }
        };

        playPauseBtn.onclick = togglePlay;
        canvas.onclick = togglePlay;

        // 4. Capture Logic
        captureBtn.onclick = () => {
            if (video.videoWidth === 0 || video.videoHeight === 0) {
                showCustomAlert("Cannot capture: Video has no dimensions. It might still be loading or is corrupted.", "Capture Error");
                return;
            }
            try {
                const dataUrl = canvas.toDataURL('image/png');
                if (selectedImages.length >= 6) {
                    showCustomAlert("Maximum of 6 images reached.", "Limit Reached");
                } else {
                    resizeImage(dataUrl).then(addBase64ToPreview);
                    captureBtn.textContent = '✅ SAVED!';
                    setTimeout(() => { captureBtn.textContent = '📸 Capture Frame'; }, 800);
                }
            } catch (e) { showCustomAlert("Capture failed: " + e.message, "Error"); }
        };

        // 5. Close Logic
        const closePlayer = () => {
            cancelAnimationFrame(animationId);
            video.pause();
            URL.revokeObjectURL(video.src);
            document.body.removeChild(modal);
            document.removeEventListener('keydown', escHandler);
        };

        const escHandler = (e) => {
            if (e.key === 'Escape') closePlayer();
        };
        document.addEventListener('keydown', escHandler);

        closeBtn.onclick = closePlayer;
    }


        const physicianSelect = document.getElementById('physician');
        if (physicianSelect) {
            const physicians = getPhysicians();
            physicianSelect.innerHTML = ''; // Clear existing options
            physicians.forEach((name, index) => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                if (index === 0) option.selected = true; // Select first by default
                physicianSelect.appendChild(option);
            });
        }

        // NEW: Populate Assistant Surgeon dropdown from settings
        const asstSurgeonSelect = document.getElementById('assistantSurgeon');
        if (asstSurgeonSelect) {
            const asstSurgeons = JSON.parse(localStorage.getItem('clinicAsstSurgeons') || '[]');
            asstSurgeonSelect.innerHTML = ''; // Clear

            // Add a "None" option
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = 'None / Not Applicable';
            asstSurgeonSelect.appendChild(noneOption);

            asstSurgeons.forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                asstSurgeonSelect.appendChild(option);
            });
        }

        // Read once here and used by the datalist a few lines below.
        const scrubNurses = JSON.parse(localStorage.getItem('clinicScrubNurses') || '[]');
        // Scrub Nurse: the saved nurses go into the <datalist> as SUGGESTIONS
        // only. The control itself is a plain text input, so a nurse who is not
        // in Settings can still be recorded - that was the whole reason for the
        // change, and a <select> could not do it.
        const scrubNurseInput = document.getElementById('scrubNurse');
        const scrubNurseList = document.getElementById('scrubNurseList');
        if (scrubNurseInput && scrubNurseList) {
            scrubNurses.forEach(name => {
                const clean = String(name || '').trim();
                if (!clean) return;
                const option = document.createElement('option');
                option.value = clean;
                scrubNurseList.appendChild(option);
            });
        }

        // Title-case on blur, matching how the patient name fields behave and
        // how the indication field is capitalised. A scrub nurse's name on a
        // printed report should read "Dela Cruz", not "dela cruz" - but NOT the
        // clinic's UPPERCASE style, which is set for patient names specifically
        // and would print a person's name as shouting.
        if (scrubNurseInput) {
            scrubNurseInput.addEventListener('blur', function () {
                const typed = this.value.trim();
                if (!typed) { this.value = ''; return; }
                this.value = typed.toLowerCase().replace(/\b\w/g, s => s.toUpperCase());
                this.dispatchEvent(new Event('input')); // Trigger auto-save
            });
        }

        // Listeners for the PDF Preview Modal
        savePdfFromPreviewBtn?.addEventListener('click', () => {
            if (generatedPdfForSave) {
                generatedPdfForSave.pdf.save(generatedPdfForSave.pdfFilename);
                window.PatientRecords?.recordSave(currentReportType, getFormData(), {
                    format: 'PDF',
                    fileName: generatedPdfForSave.pdfFilename
                });
            }
            pdfPreviewModal.style.display = 'none';
        });
        closePdfPreviewBtn?.addEventListener('click', () => {
            pdfPreviewModal.style.display = 'none';
            // Revoke the blob URL to free up memory
            if (pdfPreviewFrame.src.startsWith('blob:')) {
                URL.revokeObjectURL(pdfPreviewFrame.src);
            }
        });

        function loadDataIntoForm(data) {
            clearFormWithoutConfirmation();
            for (const key in data) {
                if (key === 'images') {
                    // Validate that images is an array and contains strings to prevent PDF errors
                    if (Array.isArray(data.images)) {
                        selectedImages = data.images.filter(img => typeof img === 'string' && img.length > 0);
                    } else {
                        selectedImages = [];
                    }
                    refreshPreview();
                } else if (key === 'procedureDate') {
                    const element = document.getElementById(key);
                    if (element) {
                        element.value = data[key] ? data[key] : getTodayDate();
                    }
                } else {
                    const element = document.getElementById(key);
                    if (element) element.value = data[key] || '';
                }
            }
        }

        // ===================================================================================
        // CROPPER LOGIC (NEW)
        // ===================================================================================
        function handleFileSelectForCropping(event) {
            const maxImages = 6;
            if (selectedImages.length >= maxImages && !lastClearedImages) {
                showCustomAlert(`You can only upload a maximum of ${maxImages} images.`, "Limit Reached");
                event.target.value = null;
                return;
            }

            const files = Array.from(event.target.files);
            if (files.length === 0) return; // Stop if no file was selected
            const spaceLeft = maxImages - selectedImages.length;
            
            if (files.length > spaceLeft && !lastClearedImages) {
                showCustomAlert(`You can only add ${spaceLeft} more image(s). The first ${spaceLeft} will be processed.`);
            }

            fileQueue = files.slice(0, spaceLeft);
            event.target.value = null; // Clear input immediately

            if (fileQueue.length > 0) {
                processNextFileInQueue();
            }
        }

        function processNextFileInQueue() {
            lastClearedImages = null; // Any new file processing invalidates undo
            if (fileQueue.length === 0) {
                cropModal.style.display = 'none';
                if (cropper) {
                    cropper.destroy();
                    cropper = null;
                }
                return;
            }

            currentFileForCropping = fileQueue.shift(); // Get the next file

            // Safety Check: Prevent uploading very large images
            if (currentFileForCropping.size > 2 * 1024 * 1024) { // 2MB limit
                showCustomAlert(`The image "${currentFileForCropping.name}" is too large (>2MB) and will be skipped.`, "File Too Large");
                processNextFileInQueue(); // Skip to next file
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                // FALLBACK: If Cropper library isn't loaded (e.g., offline), add image directly.
                if (typeof Cropper === 'undefined') {
                    console.warn('Cropper.js not loaded. Skipping crop feature.');
                    resizeImage(e.target.result).then(resized => {
                        addBase64ToPreview(resized);
                        processNextFileInQueue();
                    });
                    return;
                }

                imageToCrop.src = e.target.result;
                cropModal.style.display = 'flex';
                
                if (cropper) {
                    cropper.replace(e.target.result);
                } else {
                    cropper = new Cropper(imageToCrop, {
                        aspectRatio: 1,
                        viewMode: 1,
                        background: false,
                        autoCropArea: 0.8,
                    });
                }
            };
            reader.readAsDataURL(currentFileForCropping);
        }

        // Add listeners for cropper buttons
        cropButton?.addEventListener('click', () => {
            if (cropper) {
                // 1024 square, not 512. A report photo occupies about 48% of
                // an A4 width, which is roughly 1000 px at 300 dpi - 512 was
                // printing below the paper's real resolution. This also keeps
                // the crop path inside the same 300-700 KB band as every
                // other photo instead of landing far under it.
                const canvas = cropper.getCroppedCanvas({ width: 1024, height: 1024, imageSmoothingQuality: 'high' });
                // Through resizeImage -> compressImage, like every other
                // attach path. It used to call toDataURL('image/jpeg') by
                // hand here, which is why the cropper - the path most
                // doctors actually use - was the one path that skipped
                // compression entirely.
                resizeImage(canvas.toDataURL('image/png')).then((compressed) => {
                    addBase64ToPreview(compressed);
                    // Inside the then(), not after it: the queue must not
                    // advance until this photo has actually been added, or a
                    // multi-file attach would add them out of order.
                    processNextFileInQueue(); // Process the next file in the queue
                });
            }
        });

        skipCropButton?.addEventListener('click', () => {
            if (currentFileForCropping) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    // Compress image before adding
                    const resized = await resizeImage(e.target.result);
                    addBase64ToPreview(resized);
                    processNextFileInQueue();
                };
                reader.readAsDataURL(currentFileForCropping);
            }
        });

        cancelCropButton?.addEventListener('click', () => {
            fileQueue = []; // Clear the queue
            processNextFileInQueue(); // This will just close the modal
        });

        // ===================================================================================
        // 7. AUTO-SAVE & AUTO-LOAD LOGIC (MOVED HERE)
        // ===================================================================================
        let offlineDraftDirty = false;

        function saveOfflineDraftNow() {
            if (!offlineDraftDirty) return;
            offlineDraftDirty = false;
            if (currentReportType !== 'nasal' && currentReportType !== 'laryngeal') return;
            const drafts = window.EntDrafts;
            if (!drafts || typeof drafts.saveOfflineDraft !== 'function') return;
            try {
                drafts.saveOfflineDraft(currentReportType, getFormData());
            } catch (error) {
                offlineDraftDirty = true;
                console.error('[Offline autosave] Could not queue the report:', error);
            }
        }

        function markOfflineDraftDirty() {
            if (navigator.onLine === false) offlineDraftDirty = true;
        }

        function saveToLocal() {
            const data = getFormData();
            try {
                localStorage.setItem(localStorageKey, JSON.stringify(data));
            } catch (e) {
                // Handle Storage Full Error (QuotaExceededError)
                if (e.name === 'QuotaExceededError' || e.code === 22) {
                    console.warn("LocalStorage full. Saving text data only to prevent data loss.");
                    // Try saving without images to ensure text inputs are safe
                    const dataNoImages = { ...data, images: [] };
                    try {
                        localStorage.setItem(localStorageKey, JSON.stringify(dataNoImages));
                    } catch (e2) {
                        console.error("Critical: Cannot save data even without images.", e2);
                    }
                }
            }
        }

        // Add auto-save listeners to all form elements
        Array.from(reportForm.elements).forEach(element => {
            if (element.type !== 'file' && element.tagName !== 'BUTTON') {
                element.addEventListener('input', function () {
                    saveToLocal();
                    markOfflineDraftDirty();
                });
                element.addEventListener('change', function () {
                    saveToLocal();
                    markOfflineDraftDirty();
                });
            }
        });

        // NEW: Listen for image changes to trigger auto-save
        document.addEventListener('formStateChanged', function () {
            saveToLocal();
            markOfflineDraftDirty();
        });

        window.addEventListener('offline', function () {
            offlineDraftDirty = true;
        });
        window.addEventListener('pagehide', saveOfflineDraftNow);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') saveOfflineDraftNow();
        });
        window.addEventListener('online', saveOfflineDraftNow);

        // Auto-load from localStorage
        const saved = localStorage.getItem(localStorageKey);
        if (saved) {
            const data = JSON.parse(saved);
            loadDataIntoForm(data);
        }
        if (navigator.onLine === false) {
            offlineDraftDirty = true;
        }

        // NASAL ONLY: the scope is fixed to FLEXIBLE FIBEROPTIC ENDOSCOPY. A New
        // Form / Clear wipes every field to '', so re-apply the default here when
        // the box is empty. A value restored from a draft is left untouched.
        if (currentReportType === 'nasal') {
            const endoDefault = document.getElementById('endoscopyType');
            if (endoDefault && !endoDefault.value.trim()) {
                endoDefault.value = 'FLEXIBLE FIBEROPTIC ENDOSCOPY';
            }
        }

        // Expose a small bridge so the shared database module (dbRecords.js) can
        // read the current report payload and restore one pulled from Supabase.
        window.EntFormBridge = {
            reportType: currentReportType,
            getData: () => getFormData(),
            restore: (data) => {
                loadDataIntoForm(data);
                saveToLocal();
                document.dispatchEvent(new Event('formDataRestored'));
            },
            startNew: () => clearFormWithoutConfirmation(true),
            alert: showCustomAlert
        };

        // This is placed *after* loading data, so it only applies the default if the field is truly empty.
        const procedureDescInput = document.getElementById('procedureDescription');
        const endoTypeInput = document.getElementById('endoscopyType');
        
        // NEW: Centralized function to get procedure description templates from settings
        function getProcedureTemplate(type, scope = '') {
            const savedSettings = JSON.parse(localStorage.getItem('clinicSettings') || '{}');
            const scopeValue = scope.toLowerCase();
            const isFlexible = scopeValue.includes('flexible');

            let template = '';
            let hardcodedDefault = '';

            if (type === 'nasal') {
                if (isFlexible) {
                    hardcodedDefault = `The nasal cavity was prepared with topical decongestant and anesthetic. Using a [scope], a systematic examination of the nasal cavity was performed. The floor of the nose, inferior and middle meatus, sphenoethmoidal recess, and nasopharynx were visualized.\n\nPatient tolerated the procedure well.`;
                    template = savedSettings.nasalFlexibleProcedureTemplate || hardcodedDefault;
                } else { // Rigid
                    hardcodedDefault = `The nasal cavity was prepared with topical decongestant and anesthetic. Using a [scope], the three-pass technique was performed:\n\n• First Pass: Floor of the nose to the nasopharynx.\n• Second Pass: Medial to the middle turbinate into the sphenoethmoidal recess.\n• Third Pass: Into the middle meatus to visualize the ostiomeatal complex.\n\nPatient tolerated the procedure well.`;
                    template = savedSettings.nasalProcedureTemplate || hardcodedDefault;
                }
            } else if (type === 'laryngeal') {
                if (isFlexible) {
                    hardcodedDefault = `After preparation of the nasal cavity with topical anesthetic and decongestant, a [scope] was passed transnasally to visualize the larynx. The supraglottic, glottic, and subglottic structures were systematically inspected. Vocal cord mobility was assessed. Patient tolerated the procedure well.`;
                    template = savedSettings.laryngealFlexibleTemplate || hardcodedDefault;
                } else {
                    hardcodedDefault = `The oropharynx was prepared with topical anesthesia. Using a [scope], the larynx was visualized. The supraglottic, glottic, and subglottic structures were inspected. Vocal cord mobility was assessed. Patient tolerated the procedure well.`;
                    template = savedSettings.laryngealRigidTemplate || hardcodedDefault;
                }
            }

            // Replace placeholder
            const scopeText = scope ? scopeValue : '[select endoscopy]';
            return template.replace(/\[scope\]/gi, scopeText);
        }

        // Auto-bullet points on Enter for Procedure Description
        if (procedureDescInput) {
            procedureDescInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    const start = this.selectionStart;
                    const value = this.value;
                    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                    const currentLine = value.substring(lineStart, start);
                    
                    if (currentLine.trim().startsWith('•')) {
                        e.preventDefault();
                        const newValue = value.substring(0, start) + '\n• ' + value.substring(start);
                        this.value = newValue;
                        this.selectionStart = this.selectionEnd = start + 3;
                        this.dispatchEvent(new Event('input'));
                    }
                }
            });
        }

        // REFACTORED: Procedure Description Logic
        if (procedureDescInput && endoTypeInput) {
            // 1. Set Default Text if empty, based on current scope selection
            if (!procedureDescInput.value) {
                procedureDescInput.value = getProcedureTemplate(currentReportType, endoTypeInput.value);
            }

            // 2. Always regenerate the description whenever the Type of Endoscopy
            //    changes, so the [scope] placeholder always reflects the current
            //    selection. NOTE: this intentionally overwrites any manual edits
            //    to the Procedure Description - that is the requested behaviour.
            endoTypeInput.addEventListener('input', function() {
                const newTemplate = getProcedureTemplate(currentReportType, this.value);
                if (newTemplate !== procedureDescInput.value) {
                    procedureDescInput.value = newTemplate;
                    procedureDescInput.dispatchEvent(new Event('input')); // Trigger auto-save
                }
            });
        }

        // REFACTORED: Logic for the "Reset" button for Procedure Description
        const resetProcedureDescBtn = document.getElementById('resetProcedureDescBtn');
        if (resetProcedureDescBtn && procedureDescInput) {
            resetProcedureDescBtn.addEventListener('click', () => {
                const scopeVal = endoTypeInput ? endoTypeInput.value : '';
                const defaultText = getProcedureTemplate(currentReportType, scopeVal);
                
                if (defaultText) {
                    showCustomConfirm("Are you sure you want to reset the Procedure Description to its default template?", (confirmed) => {
                        if (confirmed) {
                            procedureDescInput.value = defaultText;
                            procedureDescInput.dispatchEvent(new Event('input')); // Trigger auto-save
                        }
                    }, "Reset Description");
                }
            });
        }
    }

    // ===================================================================================
    // THEME (DARK MODE) SWITCHER
    // ===================================================================================
    const themeToggle = document.getElementById('theme-toggle');
    const currentTheme = localStorage.getItem('theme');

    if (currentTheme === 'dark') {
        document.body.classList.add('dark-mode');
        if (themeToggle) themeToggle.checked = true;
    }

    if (themeToggle) {
        themeToggle.addEventListener('change', function() {
            if (this.checked) {
                document.body.classList.add('dark-mode');
                localStorage.setItem('theme', 'dark');
            } else {
                document.body.classList.remove('dark-mode');
                localStorage.setItem('theme', 'light');
            }
        });
    }

    // ===================================================================================
    // STICKY HEADER COLLAPSE ON SCROLL (Only buttons remain visible)
    // ===================================================================================
    const reportHeader = document.querySelector('.report-header');
    if (reportHeader) {
        function handleHeaderScroll() {
            if (window.scrollY > 10) {
                reportHeader.classList.add('header-scrolled');
            } else {
                reportHeader.classList.remove('header-scrolled');
            }
        }
        window.addEventListener('scroll', handleHeaderScroll, { passive: true });
        handleHeaderScroll(); // Initial check
    }

    // ===================================================================================
    // SCROLL TO TOP BUTTON
    // ===================================================================================
    // Find the main actions container by looking for key buttons (Print, Save, etc.)
    // This ensures the Top button is placed exactly in the "line up" with them.
    const keyButtons = ['printBtn', 'saveSettingsBtn', 'savePdfBtn', 'clearFormBtn'];
    let actionsDiv = null;

    for (const btnId of keyButtons) {
        const btn = document.getElementById(btnId);
        if (btn) {
            actionsDiv = btn.closest('.actions');
            if (actionsDiv) break;
        }
    }

    // Fallback: Select the last .actions div if specific buttons aren't found
    if (!actionsDiv) {
        const allActionDivs = document.querySelectorAll('.actions');
        if (allActionDivs.length > 0) actionsDiv = allActionDivs[allActionDivs.length - 1];
    }

    if (actionsDiv && currentReportType !== 'settings' && !actionsDiv.closest('.modal-content')) {
        const scrollTopBtn = document.createElement('button');
        scrollTopBtn.type = 'button';
        scrollTopBtn.className = 'btn-secondary no-print'; // Grey style
        scrollTopBtn.innerHTML = '↑ Top';
        scrollTopBtn.onclick = () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
        actionsDiv.appendChild(scrollTopBtn);
    }


        // ===================================================================================
        // BACKUP & RESTORE LOGIC (NEW)
        // ===================================================================================
        const backupBtn = document.getElementById('backupDataBtn');
        const restoreBtn = document.getElementById('restoreDataBtn');
        const restoreInput = document.getElementById('restoreFileInput');

        if (backupBtn) {
            backupBtn.addEventListener('click', () => {
                const backupData = {
                    clinicSettings: JSON.parse(localStorage.getItem('clinicSettings') || '{}'),
                    clinicPhysicians: JSON.parse(localStorage.getItem('clinicPhysicians') || '[]'),
                    clinicRefPhysicians: JSON.parse(localStorage.getItem('clinicRefPhysicians') || '[]'),
                    clinicAsstSurgeons: JSON.parse(localStorage.getItem('clinicAsstSurgeons') || '[]'),
                    clinicScrubNurses: JSON.parse(localStorage.getItem('clinicScrubNurses') || '[]'),
                    customHospitals: JSON.parse(localStorage.getItem('customHospitals') || '[]')
                };

                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
                const downloadAnchorNode = document.createElement('a');
                downloadAnchorNode.setAttribute("href", dataStr);
                downloadAnchorNode.setAttribute("download", "ENT_System_Backup_" + getTodayDate() + ".json");
                document.body.appendChild(downloadAnchorNode);
                downloadAnchorNode.click();
                downloadAnchorNode.remove();
            });
        }

        if (restoreBtn && restoreInput) {
            restoreBtn.addEventListener('click', () => restoreInput.click());

            restoreInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const importedData = JSON.parse(event.target.result);
                        
                        showCustomConfirm("This will overwrite your current settings and history. Are you sure?", (confirmed) => {
                            if (confirmed) {
                                if (importedData.clinicSettings) localStorage.setItem('clinicSettings', JSON.stringify(importedData.clinicSettings));
                                if (importedData.clinicPhysicians) localStorage.setItem('clinicPhysicians', JSON.stringify(importedData.clinicPhysicians));
                                if (importedData.clinicRefPhysicians) localStorage.setItem('clinicRefPhysicians', JSON.stringify(importedData.clinicRefPhysicians));
                                if (importedData.clinicAsstSurgeons) localStorage.setItem('clinicAsstSurgeons', JSON.stringify(importedData.clinicAsstSurgeons));
                                if (importedData.clinicScrubNurses) localStorage.setItem('clinicScrubNurses', JSON.stringify(importedData.clinicScrubNurses));
                                if (importedData.customHospitals) localStorage.setItem('customHospitals', JSON.stringify(importedData.customHospitals));
                                
                                showCustomAlert("Data restored successfully! The page will now reload.", "Success");
                                setTimeout(() => location.reload(), 1500);
                            }
                        }, "Restore Data");
                    } catch (err) {
                        showCustomAlert("Invalid backup file.", "Error");
                        console.error(err);
                    }
                };
                reader.readAsText(file);
                e.target.value = ''; // Reset input
            });
        }

    // ===================================================================================
    // SETTINGS PAGE LOGIC
    // ===================================================================================
    if (currentReportType === 'settings') {
        const settingsForm = document.getElementById('settings-form');
        const saveBtn = document.getElementById('saveSettingsBtn');
        const settingsStorageKey = 'clinicSettings';

        // NEW: Dirty Flag for Unsaved Changes
        let isSettingsDirty = false;

        // NEW: Make Save Button Sticky (Floating Footer)
        if (saveBtn) {
            const actionsDiv = saveBtn.closest('.actions');
            if (actionsDiv) {
                Object.assign(actionsDiv.style, {
                    position: 'sticky',
                    bottom: '0',
                    backgroundColor: 'var(--panel-bg-color)',
                    zIndex: '100',
                    padding: '20px',
                    margin: '20px -20px -20px -20px', // Negative margins to stretch full width of card
                    borderTop: '1px solid var(--border-color)',
                    boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
                    borderRadius: '0 0 16px 16px' // Match card border radius
                });
            }
        }

        // INJECT: Storage Usage Monitor
        if (settingsForm) {
            const storageContainer = document.createElement('div');
            storageContainer.className = 'form-group';
            storageContainer.style.marginTop = '20px';
            storageContainer.style.padding = '15px';
            storageContainer.style.backgroundColor = 'var(--bg-color)';
            storageContainer.style.border = '1px solid var(--border-color)';
            storageContainer.style.borderRadius = '8px';

            storageContainer.innerHTML = `
                <label class="form-label" style="display:flex; justify-content:space-between;">
                    <span>App Storage Usage (LocalStorage)</span>
                    <span id="storageText">0% used</span>
                </label>
                <div class="storage-meter-container">
                    <div id="storageFill" class="storage-meter-fill"></div>
                </div>
                <p style="font-size: 11px; color: var(--secondary-text-color); margin-top: 5px;">
                    If this reaches 100%, you won't be able to save new settings or reports. 
                    Try resetting settings or clearing browser data if full.
                </p>
            `;

            // Keep shared storage diagnostics inside the Diagnostics panel.
            const storagePanel = document.getElementById('diagnostics-settings') || settingsForm;
            storagePanel.appendChild(storageContainer);

            // Calculate Storage Function
            const updateStorageDisplay = () => {
                let total = 0;
                for (let x in localStorage) {
                    if (localStorage.hasOwnProperty(x)) total += ((localStorage[x].length * 2));
                }
                // Approx 5MB limit (5 * 1024 * 1024 bytes)
                const limit = 5 * 1024 * 1024; 
                const percentage = Math.min(100, (total / limit) * 100).toFixed(1);
                const fill = document.getElementById('storageFill');
                const text = document.getElementById('storageText');
                
                if (fill && text) {
                    fill.style.width = `${percentage}%`;
                    text.textContent = `${(total / 1024).toFixed(0)}KB / 5120KB (${percentage}%)`;
                    
                    if (percentage > 90) {
                        fill.className = 'storage-meter-fill danger';
                    } else if (percentage > 70) {
                        fill.className = 'storage-meter-fill warning';
                    } else {
                        fill.className = 'storage-meter-fill';
                    }
                }
            };
            // Run immediately
            setTimeout(updateStorageDisplay, 100);
        }

        // INJECT: Image Fit Settings UI
        if (settingsForm) {
            const fitContainer = document.createElement('div');
            fitContainer.className = 'form-group';
            fitContainer.style.marginTop = '20px';
            fitContainer.style.paddingTop = '15px';
            fitContainer.style.borderTop = '1px dashed var(--border-color)';

            fitContainer.innerHTML = `
                <label class="form-label">Printed Image Scaling</label>
                <div style="display: flex; gap: 20px; justify-content: center; margin-top: 10px;">
                    <label style="cursor: pointer; display: flex; align-items: center; gap: 5px;">
                        <input type="radio" name="imageObjectFit" value="cover">
                        <span>Fill Box (Crop to Fit)</span>
                    </label>
                    <label style="cursor: pointer; display: flex; align-items: center; gap: 5px;">
                        <input type="radio" name="imageObjectFit" value="contain">
                        <span>Show Full Image (No Crop)</span>
                    </label>
                </div>
                <p style="font-size: 12px; color: var(--secondary-text-color); margin-top: 5px;">
                    "Fill Box" ensures all images are the same size but may crop edges.<br>
                    "Show Full Image" ensures the entire image is visible but may leave empty space.
                </p>
            `;

            // This option belongs only to the Endoscopy/Nasal panel.
            const endoscopyPanel = document.getElementById('endoscopy-settings') || settingsForm;
            endoscopyPanel.appendChild(fitContainer);
        }

        // INJECT: Reset Buttons for Logos (Left/Right)
        if (settingsForm) {
            const createResetUI = (inputId, resetBtnId, undoBtnId) => {
                const input = document.getElementById(inputId);
                if (!input || document.getElementById(resetBtnId)) return;

                const wrapper = document.createElement('div');
                wrapper.style.display = 'flex';
                wrapper.style.gap = '10px';
                wrapper.style.marginTop = '5px';

                const resetBtn = document.createElement('button');
                resetBtn.type = 'button';
                resetBtn.id = resetBtnId;
                resetBtn.innerHTML = '↺ Reset to Default';
                resetBtn.className = 'btn-secondary';
                resetBtn.style.padding = '4px 10px';
                resetBtn.style.fontSize = '11px';
                resetBtn.style.minWidth = 'auto';
                resetBtn.title = "Remove custom logo and use the default one";

                const undoBtn = document.createElement('button');
                undoBtn.type = 'button';
                undoBtn.id = undoBtnId;
                undoBtn.innerHTML = '↩ Undo';
                undoBtn.className = 'btn-secondary';
                undoBtn.style.padding = '4px 10px';
                undoBtn.style.fontSize = '11px';
                undoBtn.style.minWidth = 'auto';
                undoBtn.style.display = 'none';

                wrapper.appendChild(resetBtn);
                wrapper.appendChild(undoBtn);

                if (input.parentNode) {
                    input.parentNode.insertBefore(wrapper, input.nextSibling);
                }
            };

            createResetUI('leftLogoInput', 'resetLeftLogoBtn', 'undoLeftLogoBtn');
            createResetUI('rightLogoInput', 'resetRightLogoBtn', 'undoRightLogoBtn');
        }

        const CF4_DEFAULT_LOGOS = {
            left: assetUrl('image/cumc-logo.png'),
            right: assetUrl('image/ent-logo.webp')
        };

        function getCf4SettingsForEditor() {
            try {
                const stored = JSON.parse(localStorage.getItem('cf4Settings') || '{}');
                return stored && typeof stored === 'object' ? stored : {};
            } catch (error) {
                console.warn('Unable to read CF4 settings.', error);
                return {};
            }
        }

        function updateCf4LogoPreviews(settings) {
            const leftPreview = document.getElementById('cf4LeftLogoPreview');
            const rightPreview = document.getElementById('cf4RightLogoPreview');
            // The preview follows the CF4 hospital dropdown too: REVER shows
            // the RMCI logo, CUMC (default) the CUMC one - a custom upload
            // still wins, exactly like the form header after Save.
            if (leftPreview) {
                leftPreview.src = settings.cf4LeftLogo
                    || (settings.cf4Hospital === 'rever'
                        ? assetUrl('image/rmci-logo.png')
                        : CF4_DEFAULT_LOGOS.left);
            }
            if (rightPreview) rightPreview.src = settings.cf4RightLogo || CF4_DEFAULT_LOGOS.right;
        }

        function wireCf4LogoInput(inputId, previewId) {
            const input = document.getElementById(inputId);
            const preview = document.getElementById(previewId);
            if (!input || !preview) return;
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => { preview.src = reader.result; };
                reader.readAsDataURL(file);
            });
        }

        function resetCf4Logo(inputId, previewId, settingKey) {
            const input = document.getElementById(inputId);
            const preview = document.getElementById(previewId);
            if (input) input.value = '';
            if (preview) preview.src = CF4_DEFAULT_LOGOS[settingKey === 'cf4LeftLogo' ? 'left' : 'right'];
            const settings = getCf4SettingsForEditor();
            delete settings[settingKey];
            localStorage.setItem('cf4Settings', JSON.stringify(settings));
            updateCf4LogoPreviews(settings);
        }

        wireCf4LogoInput('cf4LeftLogoInput', 'cf4LeftLogoPreview');
        wireCf4LogoInput('cf4RightLogoInput', 'cf4RightLogoPreview');
        document.getElementById('resetCf4LeftLogoBtn')?.addEventListener('click', () => resetCf4Logo('cf4LeftLogoInput', 'cf4LeftLogoPreview', 'cf4LeftLogo'));
        document.getElementById('resetCf4RightLogoBtn')?.addEventListener('click', () => resetCf4Logo('cf4RightLogoInput', 'cf4RightLogoPreview', 'cf4RightLogo'));

        // Helper to read file (Defined at top for scope visibility)
        function readFileAsBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        // ===================================================================================
        // DYNAMIC HOSPITAL LIST LOGIC
        // ===================================================================================
        const headerSelect = document.getElementById('hospitalHeaderSelect');
        const newHospitalInput = document.getElementById('newHospitalInput');
        const addNewHospitalBtn = document.getElementById('addNewHospitalBtn');
        const removeHospitalBtn = document.getElementById('removeHospitalBtn');
        const editHospitalBtn = document.getElementById('editHospitalBtn');

        function renderHospitalOptions(selectedValue) {
            if (!headerSelect) return;
            const defaultHospitals = [
                { value: 'rever', text: 'REVER MEDICAL CENTER INC.' },
                { value: 'capitol', text: 'CAPITOL UNIVERSITY MEDICAL CENTER' }
            ];
            const storedHospitals = JSON.parse(localStorage.getItem('customHospitals') || '[]');
            
            headerSelect.innerHTML = '';
            
            // Add Defaults
            defaultHospitals.forEach(h => {
                const opt = document.createElement('option');
                opt.value = h.value;
                opt.textContent = h.text;
                headerSelect.appendChild(opt);
            });

            // Add Custom Stored
            storedHospitals.forEach(h => {
                const opt = document.createElement('option');
                opt.value = h; // Value is the name itself
                opt.textContent = h;
                headerSelect.appendChild(opt);
            });

            if (selectedValue) headerSelect.value = selectedValue;
            
            // Update remove button visibility
            if (removeHospitalBtn) {
                const isDefault = defaultHospitals.some(h => h.value === (selectedValue || headerSelect.value));
                removeHospitalBtn.style.display = isDefault ? 'none' : 'block';
                if (editHospitalBtn) editHospitalBtn.style.display = isDefault ? 'none' : 'block';
            }
        }

        // Listener for Hospital Header Select to toggle custom input
        if (headerSelect) {
            headerSelect.addEventListener('change', function() {
                const isDefault = ['rever', 'capitol'].includes(this.value);
                if (removeHospitalBtn) removeHospitalBtn.style.display = isDefault ? 'none' : 'block';
                if (editHospitalBtn) editHospitalBtn.style.display = isDefault ? 'none' : 'block';
                
                // Auto-populate address for Capitol
                const clinicAddressInput = document.getElementById('clinicAddress');
                if (this.value === 'capitol' && clinicAddressInput) {
                    clinicAddressInput.value = 'Gusa Highway, Cagayan de Oro City, Misamis Oriental';
                    clinicAddressInput.dispatchEvent(new Event('input')); // Trigger preview update
                } else if (this.value === 'rever' && clinicAddressInput) {
                    clinicAddressInput.value = 'Zone 4, Capunuyan, Aplaya, Jasaan, Misamis Oriental';
                    clinicAddressInput.dispatchEvent(new Event('input'));
                }
            });
        }

        if (addNewHospitalBtn && newHospitalInput) {
            addNewHospitalBtn.addEventListener('click', () => {
                const newName = newHospitalInput.value.trim();
                if (newName) {
                    const storedHospitals = JSON.parse(localStorage.getItem('customHospitals') || '[]');
                    if (!storedHospitals.includes(newName)) {
                        storedHospitals.push(newName);
                        localStorage.setItem('customHospitals', JSON.stringify(storedHospitals));
                        renderHospitalOptions(newName); // Re-render and select new
                        newHospitalInput.value = '';
                        headerSelect.dispatchEvent(new Event('change')); // Trigger change logic
                    }
                }
            });
        }

        if (removeHospitalBtn) {
            removeHospitalBtn.addEventListener('click', () => {
                const selected = headerSelect.value;
                showCustomConfirm(`Are you sure you want to permanently delete "${selected}" from your hospital list?`, (confirmed) => {
                    if (confirmed) {
                        let storedHospitals = JSON.parse(localStorage.getItem('customHospitals') || '[]');
                        storedHospitals = storedHospitals.filter(h => h !== selected);
                        localStorage.setItem('customHospitals', JSON.stringify(storedHospitals));
                        renderHospitalOptions('capitol'); // Reset to default (CUMC)
                        headerSelect.dispatchEvent(new Event('change'));
                        showCustomAlert(`"${selected}" has been removed successfully.`, "Deleted");
                    }
                }, "Remove Hospital");
            });
        }

        if (editHospitalBtn) {
            editHospitalBtn.addEventListener('click', () => {
                const currentName = headerSelect.value;
                
                // Create inline edit input
                const newInput = document.createElement('input');
                newInput.type = 'text';
                newInput.value = currentName;
                newInput.style.cssText = 'flex: 1; padding: 8px; font-size: 14px; border: 2px solid var(--primary-color); border-radius: 4px;';
                
                const saveBtn = document.createElement('button');
                saveBtn.type = 'button';
                saveBtn.textContent = 'Save';
                saveBtn.style.cssText = 'background: var(--success-color); color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;';
                
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.style.cssText = 'background: var(--secondary-color); color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; margin-left: 5px;';
                
                // Replace select with input
                const selectParent = headerSelect.parentNode;
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'display: flex; gap: 5px; flex: 1;';
                wrapper.appendChild(newInput);
                wrapper.appendChild(saveBtn);
                wrapper.appendChild(cancelBtn);
                selectParent.innerHTML = '';
                selectParent.appendChild(wrapper);
                newInput.focus();
                newInput.select();
                
                const saveEdit = () => {
                    const trimmedName = newInput.value.trim();
                    if (trimmedName && trimmedName !== currentName) {
                        let storedHospitals = JSON.parse(localStorage.getItem('customHospitals') || '[]');
                        
                        // Check for duplicates
                        if (storedHospitals.includes(trimmedName)) {
                            showCustomAlert("A hospital with this name already exists.", "Duplicate Name");
                            renderHospitalOptions(currentName);
                            return;
                        }

                        const index = storedHospitals.indexOf(currentName);
                        if (index !== -1) {
                            storedHospitals[index] = trimmedName;
                            localStorage.setItem('customHospitals', JSON.stringify(storedHospitals));
                            
                            // Update the saved setting if it matches the one being edited
                            const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
                            if (settings.hospitalHeader === currentName) {
                                settings.hospitalHeader = trimmedName;
                                localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
                            }

                            showCustomAlert(`Hospital name updated successfully.`, "Success");
                        }
                    }
                    renderHospitalOptions(currentName);
                };
                
                saveBtn.addEventListener('click', saveEdit);
                cancelBtn.addEventListener('click', () => renderHospitalOptions(currentName));
                newInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') renderHospitalOptions(currentName);
                });
            });
        }

        // Preview Header Logic
        const previewBtn = document.getElementById('previewHeaderBtn');
        const previewContainer = document.getElementById('headerPreviewContainer');
        
        if (previewBtn && previewContainer) {
            const updatePreview = async () => {
                // Get saved settings for fallback
                const savedSettings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
                const hospitalHeader = settingsForm.elements.hospitalHeader.value;

                // Keep the currently saved custom logo authoritative. Hospital
                // selection only changes the fallback when no custom logo exists.
                const hospitalLeftLogo = hospitalHeader === 'capitol'
                    ? 'image/cumc-logo.png'
                    : 'image/rmci-logo.png';
                const leftLogoSrc = assetUrl(savedSettings.leftLogo || hospitalLeftLogo);
                const rightLogoSrc = assetUrl(savedSettings.rightLogo || 'image/ent-logo.webp');

                // Get current form values
                const clinicName = settingsForm.elements.clinicName.value || 'ENT-HNS ENDOSCOPY UNIT';
                const address = settingsForm.elements.clinicAddress.value;
                const phone = settingsForm.elements.clinicPhoneNumber ? settingsForm.elements.clinicPhoneNumber.value : '';
                const rehabTextRaw = settingsForm.elements.rehabCenterText.value || 'MINDANAO EAR, NOSE, THROAT OUT-PATIENT REHABILITATION CENTER\n(MENTOR)';
                const rehabText = rehabTextRaw.replace(/\n/g, '<br>');

                // Get Styling Settings
                const headerFont = settingsForm.elements.headerFontFamily.value;
                const logoSize = settingsForm.elements.logoSize.value;
                const hospSize = settingsForm.elements.hospitalNameFontSize.value;
                const hospBold = settingsForm.elements.hospitalNameBold.checked ? 'bold' : 'normal';
                const subSize = settingsForm.elements.subtitleFontSize.value;
                const subBold = settingsForm.elements.subtitleBold.checked ? 'bold' : 'normal';
                const clinicSize = settingsForm.elements.clinicNameFontSize.value;
                const clinicBold = settingsForm.elements.clinicNameBold.checked ? 'bold' : 'normal';
                const addrSize = settingsForm.elements.addressFontSize.value;
                const addrBold = settingsForm.elements.addressBold.checked ? 'bold' : 'normal';
                const contactNoSize = settingsForm.elements.contactNoFontSize.value;
                const contactNoBold = settingsForm.elements.contactNoBold.checked ? 'bold' : 'normal';

                // Get template
                const template = document.getElementById('printHeaderTemplate');
                if (!template) return;

                // Clone and populate
                const clone = document.createElement('div');
                clone.innerHTML = template.innerHTML;

                // CUMC Specific Margin/Padding Logic for Preview (Matches Print)
                if (hospitalHeader === 'capitol') {
                    clone.querySelector('.print-header-container').style.padding = '0 20px';
                }

                // Update Logos in Preview
                const imgs = clone.querySelectorAll('img');
                imgs.forEach(img => {
                    if (img.alt === 'Left Logo') img.src = leftLogoSrc;
                    if (img.alt === 'Right Logo') img.src = rightLogoSrc;
                    img.style.width = `${logoSize}px`;
                    img.style.height = `${logoSize}px`;
                    img.style.objectFit = 'contain';
                    img.style.objectPosition = 'center';
                    img.style.display = 'block';
                });

                // Update Hospital Header Text
                const textBlock = clone.querySelector('.header-text-block');
                if (textBlock) textBlock.style.fontFamily = headerFont;
                if (textBlock) textBlock.style.overflow = 'visible';

                if (textBlock) {
                        let hospitalNameLine = hospitalHeader; // Default to value (for dynamic ones)
                        if (hospitalHeader === 'rever') {
                            hospitalNameLine = 'REVER MEDICAL CENTER INC.';
                        } else if (hospitalHeader === 'capitol') {
                            hospitalNameLine = 'CAPITOL UNIVERSITY MEDICAL CENTER';
                        }
                        
                        // Safe rehab text handling (Escape HTML first, then convert newlines)
                        const safeRehabText = escapeHtml(rehabTextRaw).replace(/\n/g, '<br>');

                        textBlock.innerHTML = `
                            <div style="margin-bottom:5px;line-height:1.2;text-align:center;overflow-wrap:anywhere;word-break:normal;">
                                <span class="hospital-name-span" style="display:block;max-width:100%;font-weight:${hospBold};font-size:${hospSize}px;white-space:normal;">${escapeHtml(hospitalNameLine)}</span>
                                <span class="subtitle-span" style="display:block;max-width:100%;font-weight:${subBold};font-size:${subSize}px;margin-bottom:2px;white-space:normal;overflow-wrap:anywhere;word-break:normal;">${safeRehabText}</span><br>
                                <span style="font-weight:${clinicBold};font-size:${clinicSize}px;">${escapeHtml(clinicName)}</span><br>
                                <span style="font-weight:${addrBold};font-size:${addrSize}px;overflow-wrap:anywhere;word-break:normal;">${escapeHtml(address)}</span>
                                ${phone ? `<br><span style="font-weight:${contactNoBold};font-size:${contactNoSize}px;">Contact No. || ${phone}</span>` : ''}
                            </div>`;
                }

                previewContainer.innerHTML = '';
                previewContainer.appendChild(clone);
                previewContainer.style.display = 'block'; // Make it visible so it has dimensions

                // Adjust font size after rendering
                const hospitalNameSpan = previewContainer.querySelector('.hospital-name-span');
                const subtitleSpan = previewContainer.querySelector('.subtitle-span');
                const textBlockContainer = previewContainer.querySelector('.header-text-block');
                adjustFontSizeToFit(hospitalNameSpan, textBlockContainer);
                adjustFontSizeToFit(subtitleSpan, textBlockContainer);
            };

            // Button click triggers toggle (Show/Hide)
            previewBtn.addEventListener('click', () => {
                if (previewContainer.style.display === 'none' || previewContainer.style.display === '') {
                    updatePreview();
                    previewBtn.textContent = "Hide Header Preview";
                    previewBtn.style.backgroundColor = "var(--secondary-hover-color)"; // Darker color to indicate active
                } else {
                    previewContainer.style.display = 'none';
                    previewBtn.textContent = "Show Header Preview";
                    previewBtn.style.backgroundColor = "var(--secondary-color)"; // Reset color
                }
            });

            // Auto-update on input change if preview is visible
            const inputs = settingsForm.querySelectorAll('input, select, textarea');
            inputs.forEach(input => {
                const eventType = (input.type === 'file' || input.tagName === 'SELECT') ? 'change' : 'input';
                input.addEventListener(eventType, () => {
                    if (previewContainer.style.display !== 'none') {
                        updatePreview();
                    }
                });
            });
        }

            // Reset Styling Button Logic
            const resetStylingBtn = document.getElementById('resetStylingBtn');
            const undoStylingBtn = document.getElementById('undoStylingBtn');
            let previousStylingState = {};

            if (resetStylingBtn) {
                resetStylingBtn.addEventListener('click', () => {
                    showCustomConfirm("Are you sure you want to reset all header styling to default values?", (confirmed) => {
                        if (confirmed) {
                            // Save current state before resetting
                            previousStylingState = {
                                headerFontFamily: settingsForm.elements.headerFontFamily.value,
                                logoSize: settingsForm.elements.logoSize.value,
                                hospitalNameFontSize: settingsForm.elements.hospitalNameFontSize.value,
                                hospitalNameBold: settingsForm.elements.hospitalNameBold.checked,
                                subtitleFontSize: settingsForm.elements.subtitleFontSize.value,
                                subtitleBold: settingsForm.elements.subtitleBold.checked,
                                clinicNameFontSize: settingsForm.elements.clinicNameFontSize.value,
                                clinicNameBold: settingsForm.elements.clinicNameBold.checked,
                                addressFontSize: settingsForm.elements.addressFontSize.value,
                                addressBold: settingsForm.elements.addressBold.checked,
                                contactNoFontSize: settingsForm.elements.contactNoFontSize.value,
                                contactNoBold: settingsForm.elements.contactNoBold.checked
                            };

                            settingsForm.elements.headerFontFamily.value = 'Arial, sans-serif';
                            settingsForm.elements.logoSize.value = '100';
                            settingsForm.elements.hospitalNameFontSize.value = '25';
                            settingsForm.elements.hospitalNameBold.checked = true;
                            settingsForm.elements.subtitleFontSize.value = '12';
                            settingsForm.elements.subtitleBold.checked = false;
                            settingsForm.elements.clinicNameFontSize.value = '16';
                            settingsForm.elements.clinicNameBold.checked = true;
                            settingsForm.elements.addressFontSize.value = '12';
                            settingsForm.elements.addressBold.checked = false;
                            settingsForm.elements.contactNoFontSize.value = '12';
                            settingsForm.elements.contactNoBold.checked = false;

                            if (previewContainer && previewContainer.style.display !== 'none') {
                                updatePreview();
                            }
                            
                            // Show Undo button
                            if (undoStylingBtn) undoStylingBtn.style.display = 'inline-block';
                            showCustomAlert('Header styling has been reset to default values. Please save settings to apply changes permanently.', 'Styling Reset');
                        }
                    }, "Reset Confirmation");
                });
            }

            if (undoStylingBtn) {
                undoStylingBtn.addEventListener('click', () => {
                    // Restore previous state
                    settingsForm.elements.headerFontFamily.value = previousStylingState.headerFontFamily;
                    settingsForm.elements.logoSize.value = previousStylingState.logoSize;
                    settingsForm.elements.hospitalNameFontSize.value = previousStylingState.hospitalNameFontSize;
                    settingsForm.elements.hospitalNameBold.checked = previousStylingState.hospitalNameBold;
                    settingsForm.elements.subtitleFontSize.value = previousStylingState.subtitleFontSize;
                    settingsForm.elements.subtitleBold.checked = previousStylingState.subtitleBold;
                    settingsForm.elements.clinicNameFontSize.value = previousStylingState.clinicNameFontSize;
                    settingsForm.elements.clinicNameBold.checked = previousStylingState.clinicNameBold;
                    settingsForm.elements.addressFontSize.value = previousStylingState.addressFontSize;
                    settingsForm.elements.addressBold.checked = previousStylingState.addressBold;
                    settingsForm.elements.contactNoFontSize.value = previousStylingState.contactNoFontSize;
                    settingsForm.elements.contactNoBold.checked = previousStylingState.contactNoBold;

                    if (previewContainer && previewContainer.style.display !== 'none') updatePreview();
                    undoStylingBtn.style.display = 'none';
                    showCustomAlert('Styling settings restored.', 'Undo Successful');
                });
            }

            // ===================================================================================
            // GENERIC LIST MANAGER (For Physicians & Referring Physicians)
            // ===================================================================================
            function setupListManager(listId, inputId, addBtnId, storageKey, title, defaultValues = []) {
                const listEl = document.getElementById(listId);
                const inputEl = document.getElementById(inputId);
                const addBtn = document.getElementById(addBtnId);
                const isDoctorNoteTemplates = storageKey === 'cf4DoctorsNoteTemplates';
                const defaultDoctorNoteTemplate = 'PATIENT UNDERWENT DIAGNOSTIC NASAL ENDOSCOPY AND WAS NOTED WITH EDEMATOUS MIDDLE TURBINATE AND LATERAL NASAL WALL MUCOSA WITH THICK MUCOID SECRETION AND ENLARGED ADENOIDS. THE PROCEDURE WAS TOLERATED WELL. PATIENT SENT HOME WITH THE FOLLOWING HOME MEDICATION: MONTELUKAST + LEVOCETIRIZINE 5/10MG 1 TAB OD @ HS X 2 WKS. NACL IRRIGATING NASAL SOLN. SPRAY 2-3 SPRAYS/NOSTRIL BID X 2 WKS. FLUTICASONE SPRAY 1 SPRAY/NOSTRIL OD X 2 WKS. ADVISE FOR FOLLOW UP AFTER 1 WEEK.';

                function normalizeItems(items) {
                    if (!isDoctorNoteTemplates) {
                        return Array.isArray(items) ? items : [];
                    }
                    const cleaned = (Array.isArray(items) ? items : []).map(item => String(item).trim()).filter(Boolean);
                    if (cleaned.length === 0) return [defaultDoctorNoteTemplate];
                    if (!cleaned.includes(defaultDoctorNoteTemplate)) {
                        return [defaultDoctorNoteTemplate, ...cleaned];
                    }
                    return cleaned;
                }

                // Initialize with defaults if storage is empty (null) so they appear in the list
                if (localStorage.getItem(storageKey) === null && defaultValues.length > 0) {
                    const initialItems = isDoctorNoteTemplates ? [defaultDoctorNoteTemplate] : defaultValues;
                    localStorage.setItem(storageKey, JSON.stringify(initialItems));
                } else if (isDoctorNoteTemplates) {
                    const storedValue = localStorage.getItem(storageKey);
                    try {
                        const parsed = JSON.parse(storedValue || '[]');
                        if (!Array.isArray(parsed) || parsed.length === 0) {
                            localStorage.setItem(storageKey, JSON.stringify([defaultDoctorNoteTemplate]));
                        } else {
                            const normalized = normalizeItems(parsed);
                            if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
                                localStorage.setItem(storageKey, JSON.stringify(normalized));
                            }
                        }
                    } catch (e) {
                        localStorage.setItem(storageKey, JSON.stringify([defaultDoctorNoteTemplate]));
                    }
                }

                function getItems() {
                    const storedValue = localStorage.getItem(storageKey);
                    try {
                        const parsed = JSON.parse(storedValue || '[]');
                        return isDoctorNoteTemplates ? normalizeItems(parsed) : (Array.isArray(parsed) ? parsed : []);
                    } catch (e) {
                        return isDoctorNoteTemplates ? [defaultDoctorNoteTemplate] : [];
                    }
                }

                function saveItems(items) {
                    localStorage.setItem(storageKey, JSON.stringify(isDoctorNoteTemplates ? normalizeItems(items) : items));
                }

                function render() {
                    if (!listEl) return;
                    const items = getItems();
                    listEl.innerHTML = '';
                    items.forEach((name, index) => {
                    const li = document.createElement('li');
                    Object.assign(li.style, {
                        padding: '10px', borderBottom: '1px solid var(--border-color)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    });
                    
                    const span = document.createElement('span');
                    span.textContent = name;
                    
                    const actionsDiv = document.createElement('div');
                    actionsDiv.style.display = 'flex';
                    actionsDiv.style.gap = '5px';

                    const editBtn = document.createElement('button');
                    editBtn.type = 'button';
                    editBtn.textContent = 'Edit';
                    Object.assign(editBtn.style, {
                        backgroundColor: '#3498db', padding: '5px 10px', fontSize: '12px',
                        margin: '0', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer'
                    });

                    editBtn.onclick = () => {
                        // Create inline edit input
                        const editInput = document.createElement('input');
                        editInput.type = 'text';
                        editInput.value = name;
                        editInput.style.cssText = 'flex: 1; padding: 6px; font-size: 13px; border: 2px solid #3498db; border-radius: 3px;';
                        
                        const saveBtn = document.createElement('button');
                        saveBtn.type = 'button';
                        saveBtn.textContent = 'Save';
                        saveBtn.style.cssText = 'background: #2ecc71; color: white; border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 12px;';
                        
                        const cancelBtn = document.createElement('button');
                        cancelBtn.type = 'button';
                        cancelBtn.textContent = 'Cancel';
                        cancelBtn.style.cssText = 'background: #95a5a6; color: white; border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; margin-left: 5px;';
                        
                        // Replace span with input
                        const spanParent = span.parentNode;
                        const actionsParent = actionsDiv.parentNode;
                        spanParent.removeChild(span);
                        spanParent.removeChild(actionsDiv);
                        
                        const editWrapper = document.createElement('div');
                        editWrapper.style.cssText = 'display: flex; gap: 5px; flex: 1; align-items: center;';
                        editWrapper.appendChild(editInput);
                        editWrapper.appendChild(saveBtn);
                        editWrapper.appendChild(cancelBtn);
                        spanParent.appendChild(editWrapper);
                        editInput.focus();
                        editInput.select();
                        
                        const saveEdit = () => {
                            const trimmedName = editInput.value.trim();
                            if (trimmedName && trimmedName !== name) {
                                const currentItems = getItems();
                                if (isDoctorNoteTemplates) {
                                    currentItems[index] = trimmedName;
                                } else {
                                    currentItems[index] = trimmedName;
                                }
                                saveItems(currentItems);
                                render();
                            } else {
                                render(); // Restore original if cancelled or empty
                            }
                        };
                        
                        saveBtn.addEventListener('click', saveEdit);
                        cancelBtn.addEventListener('click', render);
                        editInput.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') render();
                        });
                    };

                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.textContent = 'Remove';
                    Object.assign(removeBtn.style, {
                        backgroundColor: '#e74c3c', padding: '5px 10px', fontSize: '12px',
                        margin: '0', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer'
                    });
                    
                    removeBtn.onclick = () => {
                        showCustomConfirm(`Are you sure you want to remove ${name}?`, (confirmed) => {
                            if (confirmed) {
                                const currentItems = getItems();
                                if (isDoctorNoteTemplates) {
                                    currentItems.splice(index, 1);
                                    if (currentItems.length === 0) {
                                        currentItems.push(defaultDoctorNoteTemplate);
                                    }
                                    saveItems(currentItems);
                                } else {
                                    currentItems.splice(index, 1);
                                    saveItems(currentItems);
                                }
                                render();
                            }
                        }, `Remove ${title}`);
                    };
                    
                    actionsDiv.appendChild(editBtn);
                    actionsDiv.appendChild(removeBtn);
                    li.appendChild(span);
                    li.appendChild(actionsDiv);
                        listEl.appendChild(li);
                    });
                }

                if (addBtn && inputEl) {
                    addBtn.addEventListener('click', () => {
                        const name = inputEl.value.trim();
                        if (name) {
                            const items = getItems();
                            if (isDoctorNoteTemplates) {
                                items.push(name);
                            } else {
                                items.push(name);
                            }
                            saveItems(items);
                            inputEl.value = '';
                            render();
                        }
                    });
                }

                render();
                    }

            // Initialize Lists
            setupListManager('physicianList', 'newPhysicianName', 'addPhysicianBtn', 'clinicPhysicians', 'Physician', [
                'JESUS RESURRECCION M. JARDIN, MD., FPSO, HNS',
                'MONIQUE LUCIA A. JARDIN-QUING, MD, FPSO-HNS'
            ]);
            // NEW: Initialize Referring Physicians list manager
            setupListManager('refPhysicianList', 'newRefPhysicianName', 'addRefPhysicianBtn', 'clinicRefPhysicians', 'Referring Physician');
            // NEW: Initialize list managers for Asst. Surgeon and Scrub Nurse
            setupListManager('asstSurgeonList', 'newAsstSurgeonName', 'addAsstSurgeonBtn', 'clinicAsstSurgeons', 'Asst. Surgeon');
            setupListManager('scrubNurseList', 'newScrubNurseName', 'addScrubNurseBtn', 'clinicScrubNurses', 'Scrub Nurse');

            // ===================================================================================
            // CF4 QUICK TEMPLATES LIST MANAGERS
            // ===================================================================================
            setupListManager('cf4ChiefComplaintTemplateList', 'newCf4ChiefComplaintTemplate', 'addCf4ChiefComplaintTemplateBtn', 'cf4ChiefComplaintTemplates', 'CF4 Chief Complaint Template', [
                'PERSISTENT RHINORRHEA',
                'PERSISTENT RHINORRHEA WITH NASAL OBSTRUCTION',
                'NASAL OBSTRUCTION AND POSTNASAL DRIP',
                'CHRONIC NASAL CONGESTION',
                'THICK MUCOID NASAL DISCHARGE'
            ]);
            setupListManager('cf4AdmittingDiagnosisTemplateList', 'newCf4AdmittingDiagnosisTemplate', 'addCf4AdmittingDiagnosisTemplateBtn', 'cf4AdmittingDiagnosisTemplates', 'CF4 Admitting Diagnosis Template', [
                'CHRONIC RHINOSINUSITIS T/C R/O POLYPOSIS',
                'ALLERGIC RHINITIS WITH CHRONIC RHINOSINUSITIS',
                'CHRONIC RHINOSINUSITIS WITHOUT POLYPOSIS',
                'CHRONIC RHINOSINUSITIS WITH NASAL POLYPOSIS',
                'ALLERGIC RHINITIS'
            ]);
            setupListManager('cf4DischargeDiagnosisTemplateList', 'newCf4DischargeDiagnosisTemplate', 'addCf4DischargeDiagnosisTemplateBtn', 'cf4DischargeDiagnosisTemplates', 'CF4 Discharge Diagnosis Template', [
                'CHRONIC RHINOSINUSITIS WITHOUT POLYPOSIS. ALLERGIC RHINITIS.',
                'ALLERGIC RHINITIS WITH CHRONIC RHINOSINUSITIS',
                'CHRONIC RHINOSINUSITIS WITH NASAL OBSTRUCTION',
                'CHRONIC RHINOSINUSITIS, IMPROVED',
                'ALLERGIC RHINITIS, IMPROVED'
            ]);
            setupListManager('cf4HpiTemplateList', 'newCf4HpiTemplate', 'addCf4HpiTemplateBtn', 'cf4HpiTemplates', 'CF4 HPI Template', [
                'PATIENT CAME IN AND COMPLAINED OF PERSISTENT RHINORRHEA FOR SEVERAL MONTHS ASSOCIATED WITH NASAL OBSTRUCTION. ANTERIOR RHINOSCOPY WAS [SIGNATURE/INITIAL].',
                'PATIENT CAME IN WITH PERSISTENT RHINORRHEA FOR SEVERAL MONTHS ASSOCIATED WITH POSTNASAL DRIP AND NASAL OBSTRUCTION.',
                'PATIENT REPORTED CHRONIC NASAL CONGESTION AND RHINORRHEA FOR SEVERAL MONTHS WITH NO IMPROVEMENT WITH HOME CARE.',
                'PATIENT COMPLAINED OF PERSISTENT RHINORRHEA WITH THICK MUCOID SECRETION AND NASAL BLOCKAGE.'
            ]);
            setupListManager('cf4PmhTemplateList', 'newCf4PmhTemplate', 'addCf4PmhTemplateBtn', 'cf4PmhTemplates', 'CF4 PMH Template', [
                'ALLERGIC RHINITIS',
                'ALLERGIC RHINITIS WITH CHRONIC RHINOSINUSITIS',
                'HISTORY OF CHRONIC NASAL CONGESTION AND RECURRENT RHINORRHEA',
                'NO KNOWN ALLERGIES',
                'HISTORY OF RECURRENT SINUSITIS'
            ]);
            setupListManager('cf4DoctorsNoteTemplateList', 'newCf4DoctorsNoteTemplate', 'addCf4DoctorsNoteTemplateBtn', 'cf4DoctorsNoteTemplates', 'CF4 Doctor\'s Note Template', [
                'PATIENT UNDERWENT DIAGNOSTIC NASAL ENDOSCOPY AND WAS NOTED WITH EDEMATOUS MIDDLE TURBINATE AND LATERAL NASAL WALL MUCOSA WITH THICK MUCOID SECRETION AND ENLARGED ADENOIDS. THE PROCEDURE WAS TOLERATED WELL. PATIENT SENT HOME WITH THE FOLLOWING HOME MEDICATION: MONTELUKAST + LEVOCETIRIZINE 5/10MG 1 TAB OD @ HS X 2 WKS. NACL IRRIGATING NASAL SOLN. SPRAY 2-3 SPRAYS/NOSTRIL BID X 2 WKS. FLUTICASONE SPRAY 1 SPRAY/NOSTRIL OD X 2 WKS. ADVISE FOR FOLLOW UP AFTER 1 WEEK.'
            ]);

            // ===================================================================================
            // RESET ALL SETTINGS LOGIC
            // ===================================================================================
            const resetAllBtn = document.getElementById('resetAllSettingsBtn');

            if (resetAllBtn) {
                resetAllBtn.addEventListener('click', () => {
                    showCustomConfirm("Are you sure you want to reset ALL settings to default? This will delete your clinic details, physician list, and custom hospitals. This action cannot be undone.", (confirmed) => {
                        if (confirmed) {
                            localStorage.removeItem('clinicSettings');
                            localStorage.removeItem('clinicPhysicians');
                            localStorage.removeItem('clinicRefPhysicians');
                            localStorage.removeItem('clinicAsstSurgeons');
                            localStorage.removeItem('clinicScrubNurses');
                            localStorage.removeItem('customHospitals');
                            localStorage.removeItem('cf4Settings');
                            
                            isSettingsDirty = false; // Prevent unsaved changes warning on reload
                            showCustomAlert("All settings have been reset to default. The page will now reload.", "Reset Complete");
                            setTimeout(() => location.reload(), 1500);
                        }
                    }, "Confirm Reset");
                });
            }

        let activeSettingsPanelId = 'endoscopy-settings';

        // Function to save settings. Each tab owns its storage key so saving
        // Endoscopy can never overwrite CF4 values (and vice versa).
        async function saveSettings(e) {
            if (e) e.preventDefault(); // Prevent default form submission

            const saveBtn = document.getElementById('saveSettingsBtn');
            const saveCf4 = activeSettingsPanelId === 'cf4-settings';
            const saveEndoscopy = activeSettingsPanelId === 'endoscopy-settings';

            // Diagnostics contains actions, not editable settings. Do not present a
            // misleading Save button or report a successful settings save there.
            if (!saveCf4 && !saveEndoscopy) {
                showCustomAlert('There are no settings to save in Diagnostics. Use Check App or the cache tools instead.', 'Diagnostics');
                return;
            }

            const restoreLabel = saveCf4 ? 'Save CF4 Settings' : 'Save Endoscopy Settings';
            if (saveBtn) {
                saveBtn.textContent = saveCf4 ? 'Saving CF4…' : 'Saving Endoscopy…';
                saveBtn.disabled = true;
            }

            try {
                const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
                const cf4Settings = getCf4SettingsForEditor();

                if (saveCf4) {
            if (settingsForm.elements.cf4HciName) cf4Settings.cf4HciName = settingsForm.elements.cf4HciName.value;
            if (settingsForm.elements.cf4AccreditationNo) cf4Settings.cf4AccreditationNo = settingsForm.elements.cf4AccreditationNo.value;
            if (settingsForm.elements.cf4HciBldgNo) cf4Settings.cf4HciBldgNo = settingsForm.elements.cf4HciBldgNo.value;
            if (settingsForm.elements.cf4HciStreet) cf4Settings.cf4HciStreet = settingsForm.elements.cf4HciStreet.value;
            if (settingsForm.elements.cf4HciBarangay) cf4Settings.cf4HciBarangay = settingsForm.elements.cf4HciBarangay.value;
            if (settingsForm.elements.cf4HciProvince) cf4Settings.cf4HciProvince = settingsForm.elements.cf4HciProvince.value;
            if (settingsForm.elements.cf4HciZipCode) cf4Settings.cf4HciZipCode = settingsForm.elements.cf4HciZipCode.value;
            if (settingsForm.elements.cf4AttendingHcp) cf4Settings.cf4AttendingHcp = settingsForm.elements.cf4AttendingHcp.value;
            if (settingsForm.elements.cf4Hospital) cf4Settings.cf4Hospital = settingsForm.elements.cf4Hospital.value;

            const cf4LeftInput = document.getElementById('cf4LeftLogoInput');
            if (cf4LeftInput && cf4LeftInput.files.length > 0) {
                if (cf4LeftInput.files[0].size > 500 * 1024) {
                    const confirmed = await showCustomConfirmAsync("Warning: The CF4 Left Logo is large (" + (cf4LeftInput.files[0].size / 1024).toFixed(0) + "KB). Continue?", "Large File Warning");
                    if (!confirmed) return;
                }
                cf4Settings.cf4LeftLogo = await readFileAsBase64(cf4LeftInput.files[0]);
            }

            const cf4RightInput = document.getElementById('cf4RightLogoInput');
            if (cf4RightInput && cf4RightInput.files.length > 0) {
                if (cf4RightInput.files[0].size > 500 * 1024) {
                    const confirmed = await showCustomConfirmAsync("Warning: The CF4 Right Logo is large (" + (cf4RightInput.files[0].size / 1024).toFixed(0) + "KB). Continue?", "Large File Warning");
                    if (!confirmed) return;
                }
                cf4Settings.cf4RightLogo = await readFileAsBase64(cf4RightInput.files[0]);
            }

            try {
                localStorage.setItem('cf4Settings', JSON.stringify(cf4Settings));
            } catch (storageError) {
                if (storageError.name === 'QuotaExceededError' || storageError.code === 22) {
                    showCustomAlert('Storage limit exceeded! Please use smaller CF4 logos.', 'Storage Error');
                    return;
                }
                throw storageError;
            }
            updateCf4LogoPreviews(cf4Settings);
            // Reset the file pickers so the same file can be chosen again later.
            if (cf4LeftInput) cf4LeftInput.value = '';
            if (cf4RightInput) cf4RightInput.value = '';
        }

        if (saveEndoscopy) {
                    // Save Styling Settings
                    if (settingsForm.elements.clinicName) settings.clinicName = settingsForm.elements.clinicName.value;
                    if (settingsForm.elements.clinicAddress) settings.clinicAddress = settingsForm.elements.clinicAddress.value;
                    if (settingsForm.elements.clinicPhoneNumber) settings.clinicPhoneNumber = settingsForm.elements.clinicPhoneNumber.value;
                    if (settingsForm.elements.rehabCenterText) settings.rehabCenterText = settingsForm.elements.rehabCenterText.value;
                    if (settingsForm.elements.hospitalHeader) settings.hospitalHeader = settingsForm.elements.hospitalHeader.value;
                    if (settingsForm.elements.nasalProcedureTemplate) settings.nasalProcedureTemplate = settingsForm.elements.nasalProcedureTemplate.value;
                    if (settingsForm.elements.nasalFlexibleProcedureTemplate) settings.nasalFlexibleProcedureTemplate = settingsForm.elements.nasalFlexibleProcedureTemplate.value;
                    if (settingsForm.elements.laryngealRigidTemplate) settings.laryngealRigidTemplate = settingsForm.elements.laryngealRigidTemplate.value;
                    if (settingsForm.elements.laryngealFlexibleTemplate) settings.laryngealFlexibleTemplate = settingsForm.elements.laryngealFlexibleTemplate.value;
                    if (settingsForm.elements.headerFontFamily) settings.headerFontFamily = settingsForm.elements.headerFontFamily.value;
                    if (settingsForm.elements.logoSize) settings.logoSize = settingsForm.elements.logoSize.value;
                    if (settingsForm.elements.hospitalNameFontSize) settings.hospitalNameFontSize = settingsForm.elements.hospitalNameFontSize.value;
                    if (settingsForm.elements.hospitalNameBold) settings.hospitalNameBold = settingsForm.elements.hospitalNameBold.checked;
                    if (settingsForm.elements.subtitleFontSize) settings.subtitleFontSize = settingsForm.elements.subtitleFontSize.value;
                    if (settingsForm.elements.subtitleBold) settings.subtitleBold = settingsForm.elements.subtitleBold.checked;
                    if (settingsForm.elements.clinicNameFontSize) settings.clinicNameFontSize = settingsForm.elements.clinicNameFontSize.value;
                    if (settingsForm.elements.clinicNameBold) settings.clinicNameBold = settingsForm.elements.clinicNameBold.checked;
                    if (settingsForm.elements.addressFontSize) settings.addressFontSize = settingsForm.elements.addressFontSize.value;
                    if (settingsForm.elements.addressBold) settings.addressBold = settingsForm.elements.addressBold.checked;
                    if (settingsForm.elements.contactNoFontSize) settings.contactNoFontSize = settingsForm.elements.contactNoFontSize.value;
                    if (settingsForm.elements.contactNoBold) settings.contactNoBold = settingsForm.elements.contactNoBold.checked;

                // Save Image Fit Setting
                const fitInput = settingsForm.querySelector('input[name="imageObjectFit"]:checked');
                if (fitInput) settings.imageObjectFit = fitInput.value;

                // Save Patient Name Case Setting
                const nameCaseInput = settingsForm.querySelector('input[name="patientNameCase"]:checked');
                if (nameCaseInput) settings.patientNameCase = nameCaseInput.value;

                // Handle Logos
                const leftInput = document.getElementById('leftLogoInput');
                if (leftInput && leftInput.files.length > 0) {
                    // Check file size (warn if > 500KB)
                    if (leftInput.files[0].size > 500 * 1024) {
                        const confirmed = await showCustomConfirmAsync("Warning: The Left Logo file is large (" + (leftInput.files[0].size/1024).toFixed(0) + "KB). This might fill up your storage limit. Do you want to proceed?", "Large File Warning");
                        if (!confirmed) return;
                    }
                    settings.leftLogo = await readFileAsBase64(leftInput.files[0]);
                }

                const rightInput = document.getElementById('rightLogoInput');
                if (rightInput && rightInput.files.length > 0) {
                    // Check file size (warn if > 500KB)
                    if (rightInput.files[0].size > 500 * 1024) {
                        const confirmed = await showCustomConfirmAsync("Warning: The Right Logo file is large (" + (rightInput.files[0].size/1024).toFixed(0) + "KB). This might fill up your storage limit. Do you want to proceed?", "Large File Warning");
                        if (!confirmed) return;
                    }
                    settings.rightLogo = await readFileAsBase64(rightInput.files[0]);
                }

                    try {
                        localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
                    } catch (storageError) {
                        if (storageError.name === 'QuotaExceededError' || storageError.code === 22) {
                            showCustomAlert('Storage limit exceeded! Please use smaller images.', 'Storage Error');
                        } else {
                            throw storageError;
                        }
                    }
                }
                isSettingsDirty = false;
                showCustomAlert(
                    saveCf4 ? 'CF4 settings saved successfully.' : 'Endoscopy settings saved successfully.',
                    'Settings Saved'
                );
            } catch (error) {
                console.error("Error saving settings:", error);
                showCustomAlert('Failed to save settings: ' + error.message, 'Error');
            } finally {
                if (saveBtn) {
                    saveBtn.textContent = restoreLabel;
                    saveBtn.disabled = false;
                }
            }
        }

        // Load existing settings into the form
        const savedSettings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
        
        // Auto-migrate old default values to new requirements
        if (savedSettings.logoSize === '120') savedSettings.logoSize = '100';
        if (savedSettings.hospitalNameFontSize === '26') savedSettings.hospitalNameFontSize = '25';
        if (savedSettings.subtitleFontSize === '14') savedSettings.subtitleFontSize = '12';
        if (savedSettings.clinicNameFontSize === '20') savedSettings.clinicNameFontSize = '16';

        // Render options FIRST, then set value
        renderHospitalOptions(savedSettings.hospitalHeader || 'capitol');

        settingsForm.elements.clinicName.value = savedSettings.clinicName || 'ENT-HNS ENDOSCOPY UNIT';
        settingsForm.elements.clinicAddress.value = savedSettings.clinicAddress !== undefined ? savedSettings.clinicAddress : '';
        if (settingsForm.elements.clinicPhoneNumber) settingsForm.elements.clinicPhoneNumber.value = savedSettings.clinicPhoneNumber || '';
        settingsForm.elements.rehabCenterText.value = savedSettings.rehabCenterText !== undefined ? savedSettings.rehabCenterText : 'MINDANAO EAR, NOSE, THROAT OUT-PATIENT REHABILITATION CENTER\n(MENTOR)';

        // NEW: Load custom procedure templates into settings form
        const nasalTemplateInput = document.getElementById('nasalProcedureTemplate');
        const nasalFlexibleTemplateInput = document.getElementById('nasalFlexibleProcedureTemplate');
        const laryngealRigidTemplateInput = document.getElementById('laryngealRigidTemplate');
        const laryngealFlexibleTemplateInput = document.getElementById('laryngealFlexibleTemplate');

        if (nasalTemplateInput) {
            nasalTemplateInput.value = savedSettings.nasalProcedureTemplate || `The nasal cavity was prepared with topical decongestant and anesthetic. Using a [scope], the three-pass technique was performed:\n\n• First Pass: Floor of the nose to the nasopharynx.\n• Second Pass: Medial to the middle turbinate into the sphenoethmoidal recess.\n• Third Pass: Into the middle meatus to visualize the ostiomeatal complex.\n\nPatient tolerated the procedure well.`;
        }
        if (nasalFlexibleTemplateInput) {
            nasalFlexibleTemplateInput.value = savedSettings.nasalFlexibleProcedureTemplate || `The nasal cavity was prepared with topical decongestant and anesthetic. Using a [scope], a systematic examination of the nasal cavity was performed. The floor of the nose, inferior and middle meatus, sphenoethmoidal recess, and nasopharynx were visualized.\n\nPatient tolerated the procedure well.`;
        }
        if (laryngealRigidTemplateInput) {
            laryngealRigidTemplateInput.value = savedSettings.laryngealRigidTemplate || `The oropharynx was prepared with topical anesthesia. Using a [scope], the larynx was visualized. The supraglottic, glottic, and subglottic structures were inspected. Vocal cord mobility was assessed. Patient tolerated the procedure well.`;
        }
        if (laryngealFlexibleTemplateInput) {
            laryngealFlexibleTemplateInput.value = savedSettings.laryngealFlexibleTemplate || `After preparation of the nasal cavity with topical anesthetic and decongestant, a [scope] was passed transnasally to visualize the larynx. The supraglottic, glottic, and subglottic structures were systematically inspected. Vocal cord mobility was assessed. Patient tolerated the procedure well.`;
        }
        
        if (settingsForm.elements.hospitalHeader) {
            // Value already set by renderHospitalOptions, but ensure change event fires
            // Trigger change event to update UI (show/hide custom input)
            settingsForm.elements.hospitalHeader.dispatchEvent(new Event('change'));
        }

        // Load Styling Settings (with defaults)
        settingsForm.elements.headerFontFamily.value = savedSettings.headerFontFamily || 'Arial, sans-serif';
        settingsForm.elements.logoSize.value = savedSettings.logoSize || '100';
        settingsForm.elements.hospitalNameFontSize.value = savedSettings.hospitalNameFontSize || '25';
        settingsForm.elements.hospitalNameBold.checked = savedSettings.hospitalNameBold !== false; // Default true
        settingsForm.elements.subtitleFontSize.value = savedSettings.subtitleFontSize || '12';
        settingsForm.elements.subtitleBold.checked = savedSettings.subtitleBold === true; // Default false
        settingsForm.elements.clinicNameFontSize.value = savedSettings.clinicNameFontSize || '16';
        settingsForm.elements.clinicNameBold.checked = savedSettings.clinicNameBold !== false; // Default true
        settingsForm.elements.addressFontSize.value = savedSettings.addressFontSize || '12';
        settingsForm.elements.addressBold.checked = savedSettings.addressBold === true; // Default false
        settingsForm.elements.contactNoFontSize.value = savedSettings.contactNoFontSize || '12';
        settingsForm.elements.contactNoBold.checked = savedSettings.contactNoBold === true; // Default false

        // Load Image Fit Setting
        const savedFit = savedSettings.imageObjectFit || 'contain';
        const fitRadio = settingsForm.querySelector(`input[name="imageObjectFit"][value="${savedFit}"]`);
        if (fitRadio) fitRadio.checked = true;

        // Load CF4 Settings
        const savedCf4Settings = JSON.parse(localStorage.getItem('cf4Settings') || '{}');
        const cf4HciNameInput = document.getElementById('cf4HciName');
        if (cf4HciNameInput) cf4HciNameInput.value = savedCf4Settings.cf4HciName || '';
        const cf4AccreditationNoInput = document.getElementById('cf4AccreditationNo');
        if (cf4AccreditationNoInput) cf4AccreditationNoInput.value = savedCf4Settings.cf4AccreditationNo || '';
        const cf4HciBldgNoInput = document.getElementById('cf4HciBldgNo');
        if (cf4HciBldgNoInput) cf4HciBldgNoInput.value = savedCf4Settings.cf4HciBldgNo || '';
        const cf4HciStreetInput = document.getElementById('cf4HciStreet');
        if (cf4HciStreetInput) cf4HciStreetInput.value = savedCf4Settings.cf4HciStreet || '';
        const cf4HciBarangayInput = document.getElementById('cf4HciBarangay');
        if (cf4HciBarangayInput) cf4HciBarangayInput.value = savedCf4Settings.cf4HciBarangay || '';
        const cf4HciProvinceInput = document.getElementById('cf4HciProvince');
        if (cf4HciProvinceInput) cf4HciProvinceInput.value = savedCf4Settings.cf4HciProvince || '';
        const cf4HciZipCodeInput = document.getElementById('cf4HciZipCode');
        if (cf4HciZipCodeInput) cf4HciZipCodeInput.value = savedCf4Settings.cf4HciZipCode || '';
        const cf4AttendingHcpInput = document.getElementById('cf4AttendingHcp');
        if (cf4AttendingHcpInput) cf4AttendingHcpInput.value = savedCf4Settings.cf4AttendingHcp || '';
        updateCf4LogoPreviews(savedCf4Settings);

        // CF4 "Default Hospital Header" dropdown - the twin of the endoscopy
        // select above, but it drives the CF4 HCI fields instead of the print
        // letterhead. Same two values (rever / capitol), same preset idea as
        // cf4.js HCI_PRESETS: picking a hospital fills the HCI inputs below,
        // and the Save button persists them into cf4Settings.
        const CF4_HCI_PRESETS = {
            capitol: {
                cf4HciName: 'CAPITOL UNIVERSITY MEDICAL CENTER',
                cf4HciBldgNo: 'GUSA HIGHWAY',
                cf4HciStreet: '',
                cf4HciBarangay: 'GUSA, CAGAYAN DE ORO CITY',
                cf4HciProvince: 'MISAMIS ORIENTAL',
                cf4HciZipCode: '9000'
            },
            rever: {
                cf4HciName: 'REVER MEDICAL CENTER INC.',
                cf4HciBldgNo: 'ZONE 4, CAPUNUYAN',
                cf4HciStreet: '',
                cf4HciBarangay: 'APLAYA, JAASAAN',
                cf4HciProvince: 'MISAMIS ORIENTAL',
                cf4HciZipCode: '9003'
            }
        };
        const cf4HospitalSelect = document.getElementById('cf4Hospital');
        if (cf4HospitalSelect) {
            // The saved key wins. With no key yet, infer from the saved HCI
            // name so a device configured before this dropdown existed does
            // not claim CUMC while its fields still say REVER.
            let cf4Hospital = savedCf4Settings.cf4Hospital || '';
            if (!cf4Hospital) {
                cf4Hospital = /rever/i.test(String(savedCf4Settings.cf4HciName || ''))
                    ? 'rever' : 'capitol';
            }
            cf4HospitalSelect.value = cf4Hospital;
            // Nothing saved at all? Show the preset the CF4 form will use,
            // so this screen matches the form instead of showing blanks.
            const cf4Preset = CF4_HCI_PRESETS[cf4Hospital] || CF4_HCI_PRESETS.capitol;
            Object.keys(cf4Preset).forEach(function (key) {
                const el = document.getElementById(key);
                if (el && !String(el.value || '').trim()) el.value = cf4Preset[key];
            });
            cf4HospitalSelect.addEventListener('change', function () {
                const preset = CF4_HCI_PRESETS[this.value] || CF4_HCI_PRESETS.capitol;
                Object.keys(preset).forEach(function (key) {
                    const el = document.getElementById(key);
                    if (el) el.value = preset[key];
                });
            });
        }

        // Load Patient Name Case Setting
        const savedNameCase = savedSettings.patientNameCase || 'upper';
        const nameCaseRadio = settingsForm.querySelector(`input[name="patientNameCase"][value="${savedNameCase}"]`);
        if (nameCaseRadio) nameCaseRadio.checked = true;

        // Reset Logo Listeners
        let previousLeftLogo = null;
        let previousRightLogo = null;
        const undoLeftLogoBtn = document.getElementById('undoLeftLogoBtn');
        const undoRightLogoBtn = document.getElementById('undoRightLogoBtn');

        document.getElementById('resetLeftLogoBtn')?.addEventListener('click', () => {
            showCustomConfirm("Are you sure you want to reset the Left Logo to default?", (confirmed) => {
                if (confirmed) {
                    const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
                    previousLeftLogo = settings.leftLogo; // Save before delete
                    delete settings.leftLogo;
                    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
                    if (undoLeftLogoBtn) undoLeftLogoBtn.style.display = 'inline-block';
                    showCustomAlert('Left logo reset to default. Please save settings if you made other changes.');
                }
            }, "Reset Logo");
        });

        undoLeftLogoBtn?.addEventListener('click', () => {
            if (previousLeftLogo) {
                const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
                settings.leftLogo = previousLeftLogo;
                localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
                undoLeftLogoBtn.style.display = 'none';
                showCustomAlert('Left logo restored.', 'Undo Successful');
            }
        });

        document.getElementById('resetRightLogoBtn')?.addEventListener('click', () => {
            showCustomConfirm("Are you sure you want to reset the Right Logo to default?", (confirmed) => {
                if (confirmed) {
                    const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
                    previousRightLogo = settings.rightLogo; // Save before delete
                    delete settings.rightLogo;
                    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
                    if (undoRightLogoBtn) undoRightLogoBtn.style.display = 'inline-block';
                    showCustomAlert('Right logo reset to default. Please save settings if you made other changes.');
                }
            }, "Reset Logo");
        });

        undoRightLogoBtn?.addEventListener('click', () => {
            if (previousRightLogo) {
                const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
                settings.rightLogo = previousRightLogo;
                localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
                undoRightLogoBtn.style.display = 'none';
                showCustomAlert('Right logo restored.', 'Undo Successful');
            }
        });

        saveBtn.addEventListener('click', saveSettings);

        // ===================================================================================
        // SETTINGS TABS — only one settings area is visible at a time.
        // ===================================================================================
        const settingsTabs = Array.from(document.querySelectorAll('.settings-nav-btn'));
        const settingsPanels = ['endoscopy-settings', 'cf4-settings', 'diagnostics-settings', 'cloud-sync-settings']
            .map(id => document.getElementById(id))
            .filter(Boolean);

        function activateSettingsTab(targetId, updateHash = true) {
            const activePanel = settingsPanels.find(panel => panel.id === targetId);
            if (!activePanel) return;
            activeSettingsPanelId = targetId;

            settingsPanels.forEach(panel => {
                const active = panel.id === targetId;
                panel.hidden = !active;
                panel.style.display = active ? 'block' : 'none';
                panel.setAttribute('aria-hidden', active ? 'false' : 'true');
            });
            const dangerZone = document.querySelector('.danger-zone');
            if (dangerZone) {
                dangerZone.hidden = targetId !== 'diagnostics-settings';
            }
            settingsTabs.forEach(tab => {
                const active = tab.dataset.target === targetId;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
                tab.tabIndex = active ? 0 : -1;
            });
            const saveActions = saveBtn?.closest('.actions');
            const updateSaveAction = () => {
                if (!saveBtn || !saveActions) return;
                const isNoSaveAction = targetId === 'diagnostics-settings' || targetId === 'cloud-sync-settings';
                saveActions.hidden = isNoSaveAction;
                saveActions.style.display = isNoSaveAction ? 'none' : 'flex';
                saveBtn.textContent = targetId === 'cf4-settings'
                    ? 'Save CF4 Settings'
                    : 'Save Endoscopy Settings';
            };
            updateSaveAction();
            if (updateHash) history.replaceState(null, '', `#${targetId}`);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        // Initialize Supabase Cloud Sync UI Handlers if on settings page
        const testSyncBtn = document.getElementById('testSyncBtn');
        const saveSyncConfigBtn = document.getElementById('saveSyncConfigBtn');
        const syncClinicIdInput = document.getElementById('syncClinicId');
        const syncLogOutput = document.getElementById('syncLogOutput');

        if (syncClinicIdInput && window.EntSupabase) {
            const currentCfg = window.EntSupabase.getConfig();
            syncClinicIdInput.value = currentCfg.clinicId || 'main_clinic';
        }

        if (saveSyncConfigBtn && syncClinicIdInput && window.EntSupabase) {
            saveSyncConfigBtn.addEventListener('click', () => {
                const newId = syncClinicIdInput.value.trim() || 'main_clinic';
                window.EntSupabase.saveConfig({ clinicId: newId });
                showCustomAlert(`✅ Cloud Sync identifier set to: "${newId}"`, 'SETTINGS SAVED');
            });
        }

        if (testSyncBtn && syncLogOutput) {
            testSyncBtn.addEventListener('click', async () => {
                syncLogOutput.style.display = 'block';
                syncLogOutput.style.color = 'var(--text-color)';
                syncLogOutput.textContent = 'Connecting to Supabase and syncing records...';
                try {
                    if (!window.EntSync) throw new Error('Sync engine not initialized.');
                    const res = await window.EntSync.syncPatientRecords();
                    if (res && res.success) {
                        syncLogOutput.style.color = '#2e7d32';
                        syncLogOutput.textContent = `✅ Sync Successful! Total active patient records in database: ${res.count}`;
                    } else {
                        syncLogOutput.style.color = '#c0392b';
                        syncLogOutput.textContent = `❌ Sync failed: ${res.error || res.reason || 'Unknown issue'}`;
                    }
                } catch (e) {
                    syncLogOutput.style.color = '#c0392b';
                    syncLogOutput.textContent = `❌ Connection error: ${e.message}`;
                }
            });
        }

        settingsTabs.forEach((btn, index) => {
            btn.addEventListener('click', () => activateSettingsTab(btn.dataset.target));
            btn.addEventListener('keydown', (event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const offset = event.key === 'ArrowRight' ? 1 : -1;
                const next = (index + offset + settingsTabs.length) % settingsTabs.length;
                settingsTabs[next].focus();
                activateSettingsTab(settingsTabs[next].dataset.target);
            });
        });

        const requestedSettingsTab = window.location.hash.slice(1);
        const initialSettingsTab = settingsPanels.some(panel => panel.id === requestedSettingsTab)
            ? requestedSettingsTab
            : 'endoscopy-settings';
        activateSettingsTab(initialSettingsTab, false);

        // ===================================================================================
        // SYSTEM DIAGNOSTICS (Quick problem detector)
        // ===================================================================================
        const runDiagnosticsBtn = document.getElementById('runDiagnosticsBtn');
        const diagnosticsResultsEl = document.getElementById('diagnosticsResults');
        const diagnosticsSummaryEl = document.getElementById('diagnosticsSummary');
        const diagnosticsHelpBtn = document.getElementById('diagnosticsHelpBtn');
        const refreshOfflineCacheBtn = document.getElementById('refreshOfflineCacheBtn');
        const clearAllCachesBtn = document.getElementById('clearAllCachesBtn');

        // Every essential file of the system. If any of these are missing, the app breaks.
        //
        // `path` is relative to the APP ROOT, not to the page you are on, so
        // it is what a person restoring a file needs to see. It is turned
        // into a real URL by diagFetchCheck() below via assetUrl(), because
        // this panel runs on the root index.html AND on the pages in
        // pages/ - and a fetch() of "function/index.js" from pages/settings.html
        // would 404 and report a healthy file as missing.
        const DIAG_FILES = [
            { group: 'Pages & Core Files', path: 'index.html', name: 'Menu Page (index.html)', hint: 'Main menu page.' },
            { group: 'Pages & Core Files', path: 'pages/nasalEndoscopy.html', name: 'Nasal Endoscopy Page', hint: 'Nasal endoscopy report form.' },
            { group: 'Pages & Core Files', path: 'pages/laryngealEndoscopy.html', name: 'Laryngeal Endoscopy Page', hint: 'Laryngeal endoscopy report form.' },
            { group: 'Pages & Core Files', path: 'pages/cf4Form.html', name: 'CF4 Form Page', hint: 'PhilHealth claim form.' },
            { group: 'Pages & Core Files', path: 'pages/settings.html', name: 'Settings Page', hint: 'This settings page.' },
            { group: 'Pages & Core Files', path: 'manifest.json', name: 'PWA Manifest', hint: 'Enables installing the app.' },
            { group: 'Pages & Core Files', path: 'sw.js', name: 'Service Worker File', hint: 'Enables offline mode.' },
            { group: 'Pages & Core Files', path: 'function/paths.js', name: 'Path Helper', hint: 'Resolves page and asset URLs.' },
            { group: 'Pages & Core Files', path: 'function/index.js', name: 'Main Script', hint: 'Core application logic.' },
            { group: 'Pages & Core Files', path: 'function/cf4.js', name: 'CF4 Script', hint: 'CF4 form logic.' },
            { group: 'Pages & Core Files', path: 'style/index.css', name: 'Main Stylesheet', hint: 'Core styles.' },
            { group: 'Pages & Core Files', path: 'style/cf4.css', name: 'CF4 Stylesheet', hint: 'CF4 form styles.' },
            { group: 'Libraries', path: 'js/lib/jspdf.umd.min.js', name: 'jsPDF Library', hint: 'Used for PDF generation.' },
            { group: 'Libraries', path: 'js/lib/html2canvas.min.js', name: 'html2canvas Library', hint: 'Used for PDF rendering.' },
            { group: 'Libraries', path: 'js/lib/cropper.min.js', name: 'Cropper.js Library', hint: 'Used for image cropping.' },
            { group: 'Libraries', path: 'js/lib/pdf.min.js', name: 'PDF.js Library', hint: 'Used for PDF text extraction.' },
            { group: 'Libraries', path: 'js/lib/pdf.worker.min.js', name: 'PDF.js Worker', hint: 'Background worker for PDF.js.' },
            { group: 'Libraries', path: 'css/lib/cropper.min.css', name: 'Cropper Stylesheet', hint: 'Image crop styles.' },
            { group: 'Images', path: 'image/ent-logo.webp', name: 'ENT Logo', hint: 'Header logo.' },
            { group: 'Images', path: 'image/rmci-logo.png', name: 'RMCI Logo', hint: 'Header logo.' },
            { group: 'Images', path: 'image/cumc-logo.png', name: 'CUMC Logo', hint: 'Capitol hospital header logo.' },
            { group: 'Images', path: 'image/philhealth-logo.webp', name: 'PhilHealth Logo', hint: 'Used in the CF4 header.' }
        ];

        async function diagFetchCheck(path) {
            // `path` is relative to the APP ROOT. This panel runs both on the
            // root index.html and on the pages in pages/, so it has to be
            // resolved against the app root explicitly - otherwise every
            // check 404s from pages/ and the panel reports a healthy install
            // as broken. The cache lookup uses the same resolved URL,
            // because caches.match() is matched on the full request URL.
            const url = assetUrl(path);
            // 1) Ask the server (or disk) for the file directly (with a timeout so it NEVER hangs).
            try {
                const res = await Promise.race([
                    fetch(url, { cache: 'no-store', method: 'GET' }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
                ]);
                if (res && res.ok) return { found: true, source: 'server' };
            } catch (e) { /* file:// or offline or timeout */ }
            // 2) Look for the file inside an offline cache (works when offline).
            try {
                if ('caches' in window) {
                    const withTimeout = (promise, ms) => Promise.race([
                        promise,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200))
                    ]);
                    const cacheKeys = await withTimeout(caches.keys(), 1200);
                    for (const key of cacheKeys) {
                        const cache = await withTimeout(caches.open(key), 1200);
                        const hit = await withTimeout(cache.match(url), 1200);
                        if (hit) return { found: true, source: 'offline cache (' + key + ')' };
                    }
                }
            } catch (e) { /* ignore cache errors */ }
            return { found: false, source: '' };
        }

        function diagLocalStorageInfo() {
            const out = { available: false, sizeKB: 0, percent: 0, error: '' };
            try {
                const testKey = '__diag_test_key__';
                localStorage.setItem(testKey, '1');
                localStorage.removeItem(testKey);
                out.available = true;
                let total = 0;
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key) total += (localStorage.getItem(key) || '').length * 2;
                }
                out.sizeKB = Math.max(0, Math.round(total / 1024));
                out.percent = Math.min(100, (total / (5 * 1024 * 1024)) * 100).toFixed(1);
            } catch (e) {
                out.error = e && e.name ? e.name + ': ' + e.message : String(e);
            }
            return out;
        }

        async function diagServiceWorkerInfo() {
            const out = { supported: ('serviceWorker' in navigator), registered: false, state: 'none', controlled: false, scope: '' };
            if (!out.supported) return out;
            try {
                // getRegistration() can hang on file:// / insecure origins, so add a timeout.
                const reg = await Promise.race([
                    navigator.serviceWorker.getRegistration(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
                ]);
                out.registered = !!reg;
                out.scope = reg && reg.scope ? reg.scope : '';
                out.state = reg && reg.active ? reg.active.state : 'installing/waiting';
                out.controlled = !!navigator.serviceWorker.controller;
            } catch (e) {
                out.error = String(e && e.message ? e.message : e);
            }
            return out;
        }

        async function diagCacheInfo() {
            const out = { supported: ('caches' in window), caches: [] };
            if (!out.supported) return out;
            const withTimeout = (promise, ms) => Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
            ]);
            try {
                // caches API calls can hang on file://, so guard each with a timeout.
                const keys = await withTimeout(caches.keys(), 1500);
                for (const key of keys) {
                    const cache = await withTimeout(caches.open(key), 1500);
                    const reqs = await withTimeout(cache.keys(), 1500);
                    out.caches.push({
                        name: key,
                        count: reqs.length,
                        urls: reqs.map(r => { try { return new URL(r.url).pathname; } catch (e) { return r.url; } })
                    });
                }
            } catch (e) {
                out.error = String(e && e.message ? e.message : e);
            }
            return out;
        }

        function diagBuildRow(icon, statusClass, name, detail, fixText, fixClass) {
            return `
                <div class="diag-row ${statusClass}">
                    <span class="diag-icon">${icon}</span>
                    <div style="flex: 1;">
                        <div class="diag-name">${name}</div>
                        ${detail ? `<div class="diag-detail">${detail}</div>` : ''}
                        ${fixText ? `<div class="diag-fix ${fixClass || ''}">💡 ${fixText}</div>` : ''}
                    </div>
                </div>`;
        }

        async function runDiagnostics() {
            if (runDiagnosticsBtn) {
                runDiagnosticsBtn.disabled = true;
                runDiagnosticsBtn.textContent = '⏳ Running Diagnostics... Please wait...';
            }
            if (diagnosticsResultsEl) {
                diagnosticsResultsEl.style.display = 'block';
                diagnosticsResultsEl.innerHTML = '<div class="diag-row info"><span class="diag-icon">⏳</span><div>Checking system... Please wait.</div></div>';
            }
            if (diagnosticsSummaryEl) { diagnosticsSummaryEl.style.display = 'none'; }

            const rows = [];
            let errors = 0, warnings = 0;

            // --- ENVIRONMENT ---
            const protocol = window.location.protocol;
            const isFileProtocol = protocol === 'file:';

            if (navigator.onLine) {
                rows.push({ icon: '✅', cls: 'ok', name: 'Internet Connection', detail: 'You are currently online.' });
            } else {
                warnings++;
                rows.push({ icon: '⚠️', cls: 'warning', name: 'Internet Connection', detail: 'You are currently offline — the app should still work if the offline cache was installed.', fix: 'Open the app once while online so all files are saved for offline use.', fixCls: 'warning' });
            }

            if (isFileProtocol) {
                warnings++;
                rows.push({ icon: '⚠️', cls: 'warning', name: 'App opened from a file (file://)', detail: 'Service workers and offline mode are blocked when opening the app directly from a file.', fix: 'Run the app through a local server (e.g. python -m http.server) or host it on GitHub Pages for full offline support.', fixCls: 'warning' });
            } else {
                rows.push({ icon: '✅', cls: 'ok', name: 'App served over ' + protocol.replace(':', ''), detail: protocol === 'https:' ? 'HTTPS enables the service worker (offline mode).' : 'HTTP is OK for local testing. Service workers also work on localhost.' });
            }

            // --- SERVICE WORKER & OFFLINE ---
            const swInfo = await diagServiceWorkerInfo();
            const cacheInfo = await diagCacheInfo();

            if (!swInfo.supported) {
                errors++;
                rows.push({ icon: '❌', cls: 'error', name: 'Service Worker Support', detail: 'This browser does not support service workers, so offline mode will not work.', fix: 'Use a modern browser such as Chrome, Edge, or Firefox.', fixCls: 'danger' });
            } else if (!swInfo.registered) {
                errors++;
                rows.push({ icon: '❌', cls: 'error', name: 'Service Worker', detail: 'The service worker is NOT registered. Offline mode is currently disabled.', fix: 'Open the app over http:// or https:// (not file://), then reload this page once.', fixCls: 'danger' });
            } else {
                rows.push({ icon: '✅', cls: 'ok', name: 'Service Worker', detail: 'Registered. State: ' + swInfo.state + (swInfo.controlled ? ' — controlling this page.' : ' — not yet controlling this page (takes effect after next reload).') });
                if (swInfo.state !== 'activated') {
                    warnings++;
                    rows.push({ icon: '⚠️', cls: 'warning', name: 'Service Worker State', detail: 'The service worker is not fully active yet. Offline files may not be ready.', fix: 'Reload the page once or twice so it can finish installing.', fixCls: 'warning' });
                }
            }

            if (!cacheInfo.supported) {
                errors++;
                rows.push({ icon: '❌', cls: 'error', name: 'Offline Cache API', detail: 'The Cache API is not available, offline mode will not work.', fix: 'Use a modern browser.', fixCls: 'danger' });
            } else if (cacheInfo.caches.length === 0) {
                errors++;
                rows.push({ icon: '❌', cls: 'error', name: 'Offline Cache', detail: 'No offline cache found. Nothing is saved for offline use yet.', fix: 'Click "🔄 Reinstall Offline Cache" below (requires internet right now).', fixCls: 'danger' });
            } else {
                const totalCached = cacheInfo.caches.reduce((sum, c) => sum + c.count, 0);
                rows.push({ icon: '✅', cls: 'ok', name: 'Offline Cache', detail: 'Found ' + cacheInfo.caches.length + ' cache group(s) with ' + totalCached + ' file(s). Groups: ' + cacheInfo.caches.map(c => c.name + ' (' + c.count + ')').join(', ') });
                const hasV3 = cacheInfo.caches.some(c => c.name.includes('v3') || c.name.includes('offline'));
                if (!hasV3) {
                    warnings++;
                    rows.push({ icon: '⚠️', cls: 'warning', name: 'Cache Version', detail: 'The newest offline cache (v3) was not found. Your cached files may be outdated.', fix: 'Click "🔄 Reinstall Offline Cache" to update the offline cache.', fixCls: 'warning' });
                }
            }

            // --- ESSENTIAL FILES ---
            for (const item of DIAG_FILES) {
                const check = await diagFetchCheck(item.path);
                if (check.found) {
                    rows.push({ icon: '✅', cls: 'ok', name: item.name, detail: 'Found (' + check.source + '). ' + item.hint });
                } else if (isFileProtocol) {
                    // When opened directly from a file (file://), the browser cannot verify
                    // local files over the network reliably. Show an info note instead of a red error.
                    warnings++;
                    rows.push({ icon: 'ℹ️', cls: 'info', name: item.name, detail: 'Cannot be verified automatically when opened from a file (file://). ' + item.hint, fix: 'To get exact file checks, open the app through a local server or GitHub Pages.', fixCls: 'warning' });
                } else {
                    errors++;
                    rows.push({ icon: '❌', cls: 'error', name: item.name, detail: 'NOT FOUND! ' + item.hint, fix: 'Restore / re-upload the missing file: ' + item.path, fixCls: 'danger' });
                }
            }

            // --- LIBRARIES LOADED ON THIS PAGE ---
            const globalChecks = [
                { name: 'html2canvas', ok: typeof html2canvas === 'function', detail: 'PDF image rendering' },
                { name: 'jsPDF', ok: (typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined'), detail: 'PDF generation' },
                { name: 'Cropper.js', ok: typeof Cropper === 'function', detail: 'Image cropping' },
                { name: 'PDF.js', ok: typeof pdfjsLib !== 'undefined', detail: 'PDF text extraction' }
            ];
            globalChecks.forEach(g => {
                if (g.ok) {
                    rows.push({ icon: '✅', cls: 'ok', name: g.name + ' (loaded)', detail: g.detail + ' — loaded on this page.' });
                } else {
                    rows.push({ icon: 'ℹ️', cls: 'info', name: g.name + ' (not loaded here)', detail: g.detail + ' — normal on the Settings page. The file itself is checked above.' });
                }
            });

            // --- STORAGE ---
            const storage = diagLocalStorageInfo();
            if (!storage.available) {
                errors++;
                rows.push({ icon: '❌', cls: 'error', name: 'LocalStorage', detail: storage.error || 'LocalStorage is not available. Reports and settings cannot be auto-saved.', fix: 'Enable site data / cookies for this site, or clear browser site data and reload.', fixCls: 'danger' });
            } else {
                let storageIcon = '✅', storageCls = 'ok';
                if (parseFloat(storage.percent) > 90) { storageIcon = '❌'; storageCls = 'error'; errors++; }
                else if (parseFloat(storage.percent) > 70) { storageIcon = '⚠️'; storageCls = 'warning'; warnings++; }
                rows.push({ icon: storageIcon, cls: storageCls, name: 'LocalStorage', detail: 'Working. Using ' + storage.sizeKB + ' KB / ~5120 KB (' + storage.percent + '%) across ' + localStorage.length + ' stored item(s).' });
                // Say WHO is using the space, not just that it is used up.
                if (window.EntStorage && typeof window.EntStorage.report === 'function') {
                    const biggest = window.EntStorage.report().items.slice(0, 3);
                    if (biggest.length) {
                        rows.push({
                            icon: '📦', cls: 'info', name: 'Biggest storage users',
                            detail: biggest.map(i => i.key + ' (' + i.kb.toFixed(1) + ' KB)').join(' · ')
                                + ' — see the "Device Storage" panel below for the full list and a safe clean-up.'
                        });
                    }
                }
                if (storageCls === 'error') {
                    rows.push({ icon: '💡', cls: 'error', name: 'Storage Almost Full', detail: 'Auto-save may fail soon.', fix: 'Reset settings or clear browser site data, and save important reports as PDF/JSON files.', fixCls: 'danger' });
                } else if (storageCls === 'warning') {
                    rows.push({ icon: '💡', cls: 'warning', name: 'Storage Getting Full', detail: 'Storage usage is high.', fix: 'Clear old saved reports/settings to free up space.', fixCls: 'warning' });
                }
            }

            // --- INSTALLATION / PWA ---
            const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
            if (isStandalone) {
                rows.push({ icon: '✅', cls: 'ok', name: 'App Installation', detail: 'The app is running as an installed app.' });
            } else {
                rows.push({ icon: 'ℹ️', cls: 'info', name: 'App Installation', detail: 'Running in the browser (not installed). Use the Install App button for a full-screen experience.' });
            }

            // --- RENDER SUMMARY ---
            const total = rows.length;
            if (errors > 0) {
                diagnosticsSummaryEl.className = 'diagnostics-summary error';
                diagnosticsSummaryEl.innerHTML = '❌ DETECTED ' + errors + ' PROBLEM(S) AND ' + warnings + ' WARNING(S) — ' + (total - errors - warnings) + '/' + total + ' checks passed. Please fix the problems above.';
            } else if (warnings > 0) {
                diagnosticsSummaryEl.className = 'diagnostics-summary warning';
                diagnosticsSummaryEl.innerHTML = '⚠️ ALL FILES ARE PRESENT, BUT ' + warnings + ' WARNING(S) FOUND — ' + (total - warnings) + '/' + total + ' checks passed. Review the notes above.';
            } else {
                diagnosticsSummaryEl.className = 'diagnostics-summary ok';
                diagnosticsSummaryEl.innerHTML = '✅ ALL SYSTEMS OK! All ' + total + ' checks passed. The system is ready, including offline mode.';
            }
            diagnosticsSummaryEl.style.display = 'block';

            // --- RENDER RESULTS (grouped) ---
            rows.forEach(r => {
                if (r.name.includes('Service Worker') || r.name.includes('Offline Cache')) r._group = 'Service Worker & Offline';
                else if (r.name.includes('Connection') || r.name.includes('served over') || r.name.includes('opened from')) r._group = 'Environment';
                else if (r.name.includes('LocalStorage') || r.name.includes('Storage') || r.name.includes('Installation')) r._group = 'Storage & Installation';
                else if (r.name.includes('(loaded)') || r.name.includes('(not loaded here)')) r._group = 'Libraries';
                else if (r.name.includes('Logo')) r._group = 'Images';
                else r._group = 'Pages & Core Files';
            });

            let htmlOut = '';
            let shownGroup = '';
            rows.forEach(r => {
                if (r._group !== shownGroup) {
                    htmlOut += '<div class="diag-group-title">' + r._group + '</div>';
                    shownGroup = r._group;
                }
                htmlOut += diagBuildRow(r.icon, r.cls, r.name, r.detail || '', r.fix || '', r.fixCls || '');
            });
            htmlOut += '<div class="diag-legend"><span>✅ OK</span><span>⚠️ Warning</span><span>❌ Problem</span><span>ℹ️ Info</span></div>';
            diagnosticsResultsEl.innerHTML = htmlOut;

            if (runDiagnosticsBtn) {
                runDiagnosticsBtn.disabled = false;
                runDiagnosticsBtn.textContent = '🔍 Run Diagnostics Again';
            }
        }

        if (runDiagnosticsBtn) {
            runDiagnosticsBtn.addEventListener('click', runDiagnostics);
        }

        if (diagnosticsHelpBtn) {
            diagnosticsHelpBtn.addEventListener('click', () => {
                showCustomAlert(
                    '🛠️ DIAGNOSTICS GUIDE\n\n' +
                    'This tool checks the most common problems in the system:\n\n' +
                    '🌐 CONNECTION — Is the internet available and is the app opened through a proper server?\n\n' +
                    '💾 SERVICE WORKER & OFFLINE CACHE — Are the offline files installed? If the cache is missing, the app will NOT work offline.\n\n' +
                    '📄 ESSENTIAL FILES — All pages, scripts, libraries, and images must exist. Missing files are shown in red.\n\n' +
                    '🔬 LIBRARIES — PDF, cropping, and extraction libraries must be present in js/lib.\n\n' +
                    '🗄️ STORAGE — The browser storage used for auto-saving reports and settings.\n\n' +
                    'If a red problem is found, follow the 💡 fix note, then click "Run Diagnostics Again" to confirm everything is OK.',
                    'Diagnostics Guide'
                );
            });
        }

        if (refreshOfflineCacheBtn && 'serviceWorker' in navigator) {
            refreshOfflineCacheBtn.addEventListener('click', () => {
                showCustomConfirm(
                    'This will delete the current offline cache and reinstall it right away.\n\nYou need an internet connection for this step. Continue?',
                    async (ok) => {
                        if (!ok) return;
                        try {
                            const regs = await navigator.serviceWorker.getRegistrations();
                            await Promise.all(regs.map(r => r.unregister()));
                            if ('caches' in window) {
                                const keys = await caches.keys();
                                await Promise.all(keys.map(k => caches.delete(k)));
                            }
                            showCustomAlert('✅ Offline cache cleared. Reloading page to install a fresh offline cache (v3)...', 'Reinstalling');
                            setTimeout(() => window.location.reload(), 1200);
                        } catch (e) {
                            console.error('Error reinstalling offline cache:', e);
                            showCustomAlert('❌ Error reinstalling offline cache:\n\n' + (e.message || e), 'ERROR');
                        }
                    },
                    'Reinstall Offline Cache'
                );
            });
        } else if (refreshOfflineCacheBtn) {
            refreshOfflineCacheBtn.disabled = true;
            refreshOfflineCacheBtn.title = 'Service workers are not supported in this browser.';
        }

        if (clearAllCachesBtn) {
            clearAllCachesBtn.addEventListener('click', () => {
                showCustomConfirm(
                    'This will delete ALL cached offline files.\n\nThe app will still run as long as you are online. Continue?',
                    async (ok) => {
                        if (!ok) return;
                        try {
                            if ('serviceWorker' in navigator) {
                                const regs = await navigator.serviceWorker.getRegistrations();
                                await Promise.all(regs.map(r => r.unregister()));
                            }
                            if ('caches' in window) {
                                const keys = await caches.keys();
                                await Promise.all(keys.map(k => caches.delete(k)));
                            }
                            showCustomAlert('✅ All caches cleared. The page will now reload.', 'Cleared');
                            setTimeout(() => window.location.reload(), 1200);
                        } catch (e) {
                            showCustomAlert('❌ Error clearing caches:\n\n' + (e.message || e), 'ERROR');
                        }
                    },
                    'Clear All Caches'
                );
            });
        }

        // NEW: Track changes for "Unsaved Changes" protection
        const trackSettingsChange = () => { isSettingsDirty = true; };
        const settingsInputs = settingsForm.querySelectorAll('input, select, textarea');
        settingsInputs.forEach(input => {
            input.addEventListener('input', trackSettingsChange);
            input.addEventListener('change', trackSettingsChange);
        });

        // 1. Native Browser Check (Closing Tab/Window)
        window.addEventListener('beforeunload', (e) => {
            if (isSettingsDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // 2. Custom Modal for Back Button
        const backLinks = document.querySelectorAll('.back-button, a[href*="index.html"]');
        backLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                if (isSettingsDirty) {
                    e.preventDefault();
                    showCustomConfirm("You have unsaved changes in Settings. Are you sure you want to leave?", (confirmed) => {
                        if (confirmed) {
                            window.location.href = link.getAttribute('href') || './index.html';
                        }
                    }, "Unsaved Changes");
                }
            });
        });
    }

    // ===================================================================================
    // 2. HELPER FUNCTION: GET ALL FORM DATA
    // ===================================================================================
    function getFormData() {
        const data = {};
        // *** FIX: Check if reportForm exists before trying to access its elements ***
        if (!reportForm) {
            return data; // Return empty object if not on a report page
        }
        const formElements = reportForm.elements;

        for (let i = 0; i < formElements.length; i++) {
            const element = formElements[i];
            if (element.id && element.type !== 'file' && element.tagName !== 'BUTTON' && element.name) {
                if (element.type === 'checkbox') {
                    data[element.id] = element.checked;
                } else {
                    data[element.id] = element.value;
                }
            }
        }
        data.images = selectedImages;
        return data;
    }

    // ===================================================================================
    // 3. IMAGE HANDLING (Function body remains the same)
    // ===================================================================================
    function addBase64ToPreview(base64) {
        if (selectedImages.length < 6 || lastClearedImages) {
            selectedImages.push(base64);
            lastClearedImages = null; // Invalidate undo on add
            refreshPreview();
        }
    }

    function addImageToPreviewDOM(base64, index) {
        const container = document.createElement("div");
        container.draggable = true;
        container.dataset.index = index;
        container.title = "Drag to reorder";

        const img = document.createElement("img");
        img.src = base64;

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "×"; // Use × instead of X for better look
        removeBtn.className = "btn-remove-image";

        removeBtn.onclick = function() {
            const idx = parseInt(container.dataset.index);
            lastClearedImages = null; // Invalidate undo on remove
            selectedImages.splice(idx, 1);
            refreshPreview();
        };

        // Drag events
        container.addEventListener('dragstart', (e) => {
            // When dragging starts, store the index of the item being dragged.
            e.dataTransfer.setData('text/plain', container.dataset.index);
            e.dataTransfer.effectAllowed = 'move'; // Visual feedback
            // Make the dragged item semi-transparent for a visual cue.
            container.style.opacity = '0.5';
        });

        container.addEventListener('dragend', (e) => {
            // When dragging ends, restore the item's opacity.
            container.style.opacity = '1';
            // Clean up any lingering drag-over styles from all items.
            document.querySelectorAll('#preview > div').forEach(el => el.classList.remove('drag-over'));
        });

        container.addEventListener('dragover', (e) => {
            // This is necessary to allow a drop to occur.
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move'; // Visual feedback
        });

        container.addEventListener('dragenter', (e) => {
            // Add the visual indicator when dragging over an element.
            container.classList.add('drag-over');
        });

        container.addEventListener('dragleave', (e) => {
            // Remove the visual indicator when dragging leaves an element.
            // Fix flickering: Only remove if leaving the container element itself
            if (e.relatedTarget && !container.contains(e.relatedTarget) && e.relatedTarget !== container) {
                container.classList.remove('drag-over');
            }
        });

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            // Remove the visual indicator on drop.
            container.classList.remove('drag-over');
            const draggedIndex = parseInt(e.dataTransfer.getData('text/plain'));
            const targetIndex = parseInt(container.dataset.index);
            
            if (!isNaN(draggedIndex) && !isNaN(targetIndex) && draggedIndex !== targetIndex) {
                lastClearedImages = null; // Invalidate undo on reorder
                // Move the item instead of swapping for better UX
                const itemToMove = selectedImages[draggedIndex];
                selectedImages.splice(draggedIndex, 1); // Remove from old position
                selectedImages.splice(targetIndex, 0, itemToMove); // Insert at new position
                refreshPreview();
            }
        });

        container.appendChild(img);
        container.appendChild(removeBtn);
        previewDiv.appendChild(container);
    }

    function refreshPreview() {
        previewDiv.innerHTML = "";
        selectedImages.forEach((base64, idx) => addImageToPreviewDOM(base64, idx));

        if (imageInput) imageInput.disabled = false;

        // REFACTORED: Show/Hide Clear/Undo buttons for images
        const clearImagesBtn = document.getElementById('clearImagesBtn');
        const undoClearImagesBtn = document.getElementById('undoClearImagesBtn');

        if (lastClearedImages) {
            if (clearImagesBtn) clearImagesBtn.style.display = 'none';
            if (undoClearImagesBtn) undoClearImagesBtn.style.display = 'block';
        } else {
            if (undoClearImagesBtn) undoClearImagesBtn.style.display = 'none';
            if (clearImagesBtn) clearImagesBtn.style.display = selectedImages.length > 0 ? 'block' : 'none';
        }
        // NEW: Trigger global event to notify auto-save logic
        document.dispatchEvent(new Event('formStateChanged'));
    }

    // ===================================================================================
    // VIDEO TO IMAGE FEATURE (NEW)
    // ===================================================================================
    function setupVideoToImage() {
        if (!imageInput) return;
        let currentVideoFile = null; // Store original file for manual conversion
        let activeBlackScreenHandler = null; // Track active listener to prevent leaks

        // 1. Create the "Video to Image" button dynamically
        const videoBtn = document.createElement('button');
        videoBtn.type = 'button';
        videoBtn.innerHTML = '📹 Video to Image';
        videoBtn.className = 'btn-video-to-image';

        // Insert after imageInput
        // Check for custom label first (new design)
        const customLabel = document.querySelector('label[for="imageInput"].custom-file-label');
        if (customLabel && customLabel.parentNode === imageInput.parentNode) {
            // Insert after the custom label
            imageInput.parentNode.insertBefore(videoBtn, customLabel.nextSibling);
        } else if (imageInput.parentNode) {
            imageInput.parentNode.insertBefore(videoBtn, imageInput.nextSibling);
        }

        // 2. Create hidden file input for video
        const videoInput = document.createElement('input');
        videoInput.type = 'file';
        videoInput.accept = 'video/*';
        videoInput.style.display = 'none';
        document.body.appendChild(videoInput);

        // 3. Create Modal for Video Playback
        const modal = document.createElement('div');
        Object.assign(modal.style, {
            display: 'none', position: 'fixed', zIndex: '10000', left: '0', top: '0',
            width: '100%', height: '100%', overflow: 'auto', backgroundColor: 'rgba(0,0,0,0.85)',
            justifyContent: 'center', alignItems: 'center', flexDirection: 'column'
        });

        const modalContent = document.createElement('div');
        Object.assign(modalContent.style, {
            backgroundColor: document.body.classList.contains('dark-mode') ? '#2c2c2c' : '#fff',
            color: document.body.classList.contains('dark-mode') ? '#fff' : '#000',
            padding: '20px', borderRadius: '8px', maxWidth: '90%', maxHeight: '90%',
            display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
        });

        const videoPlayer = document.createElement('video');
        videoPlayer.controls = true;
        videoPlayer.muted = true; // Ensure autoplay works smoothly across browsers
        // Enable playsinline for mobile
        videoPlayer.setAttribute('playsinline', '');
        Object.assign(videoPlayer.style, {
            width: '100%', // Force width to fill
            minHeight: '300px', // Force min height (Fixes White Screen)
            backgroundColor: '#000', // Black background
            objectFit: 'contain', // Ensure video fits inside
            maxHeight: '60vh', marginBottom: '15px', border: '1px solid #ddd',
            transition: 'transform 0.3s ease',
            display: 'block'
        });

        // NEW: Add a help section for video issues
        const helpText = document.createElement('p');
        helpText.innerHTML = 'Video not playing? <a href="#" id="videoHelpLink">Click for help</a> or use <strong>Ctrl+V</strong> to paste a screenshot.';
        Object.assign(helpText.style, {
            fontSize: '12px',
            color: 'var(--secondary-text-color)',
            marginTop: '10px',
            textAlign: 'center'
        });

        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.gap = '10px';
        btnContainer.style.position = 'relative'; // Para gumana ang z-index
        btnContainer.style.zIndex = '10'; // Siguradong nasa ibabaw ng video
        
        const rotateBtn = document.createElement('button');
        rotateBtn.textContent = '🔄 Rotate'; // This is a primary-styled button by default
        Object.assign(rotateBtn.style, {
            padding: '10px 20px', fontSize: '16px', cursor: 'pointer',
            /* backgroundColor is inherited from default button styles */
        });

        const captureBtn = document.createElement('button');
        captureBtn.textContent = '📸 Capture Frame';
        captureBtn.className = 'btn-capture-frame';


        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close'; // This button is styled as secondary via its ID
        closeBtn.id = 'closeVideoBtn'; // For styling
        Object.assign(closeBtn.style, {
            padding: '10px 20px', fontSize: '16px', cursor: 'pointer',
            /* backgroundColor is handled by #closeVideoBtn selector in CSS */
        });

        btnContainer.appendChild(rotateBtn);
        btnContainer.appendChild(captureBtn);
        btnContainer.appendChild(closeBtn);
        modalContent.appendChild(videoPlayer);
        modalContent.appendChild(btnContainer);
        modalContent.appendChild(helpText); // Add the help text to the modal
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // 4. Event Listeners
        let currentRotation = 0;

        // NEW: Add listener for the help link
        const videoHelpLink = document.getElementById('videoHelpLink');
        if (videoHelpLink) {
            videoHelpLink.addEventListener('click', (e) => {
                e.preventDefault();
                showCustomAlert(
                    "**Video Troubleshooting:**\n\n1. **Black Screen?** Click '🛠️ Fix Black Screen'.\n2. **Alternative:** Open the video in an external player (like VLC), take a screenshot, and press **Ctrl+V** anywhere in this app to paste it.\n3. **Prevention:** In Bandicam settings, change the Codec to **H.264 (MP4)**.",
                    "Video Troubleshooting"
                );
            });
        }

        rotateBtn.addEventListener('click', () => {
            currentRotation = (currentRotation + 90) % 360;
            videoPlayer.style.transform = `rotate(${currentRotation}deg)`;
            
            // Adjust margin para hindi matabunan ang buttons kapag nakatayo (portrait) ang video
            if (currentRotation % 180 !== 0) {
                const offset = Math.max(0, (videoPlayer.offsetWidth - videoPlayer.offsetHeight) / 2);
                videoPlayer.style.marginBottom = `${15 + offset}px`;
            } else {
                videoPlayer.style.marginBottom = '15px';
            }
        });

        videoBtn.addEventListener('click', () => {
            if (selectedImages.length >= 6) {
                showCustomAlert("Maximum of 6 images reached. Please remove an image to add a new one.", "Limit Reached");
                return;
            }
            videoInput.dataset.playerMode = 'default'; // Set mode for default player
            videoInput.click();
        });

        // NEW: Add the alternative player button
        const altPlayerBtn = document.createElement('button');
        altPlayerBtn.type = 'button';
        altPlayerBtn.innerHTML = '🛠️ Fix Black Screen / Alt. Player';
        altPlayerBtn.className = 'btn-secondary';
        altPlayerBtn.title = 'If the video shows a black screen, use this player. It is more compatible with different video formats.';
        Object.assign(altPlayerBtn.style, {
            width: '100%',
            marginTop: '0',
            marginBottom: '10px',
            padding: '12px 20px',
            fontSize: '14px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            background: 'linear-gradient(135deg, #f39c12, #e67e22)', // Warning orange
            boxShadow: '0 4px 6px rgba(243, 156, 18, 0.25)',
        });
        // Add hover effect
        altPlayerBtn.onmouseover = () => {
            altPlayerBtn.style.transform = 'translateY(-2px)';
            altPlayerBtn.style.boxShadow = '0 7px 14px rgba(243, 156, 18, 0.3)';
        };
        altPlayerBtn.onmouseout = () => {
            altPlayerBtn.style.transform = 'translateY(0)';
            altPlayerBtn.style.boxShadow = '0 4px 6px rgba(243, 156, 18, 0.25)';
        };
 
        // Insert it after the main video button
        videoBtn.parentNode.insertBefore(altPlayerBtn, videoBtn.nextSibling);

        altPlayerBtn.addEventListener('click', () => {
            if (selectedImages.length >= 6) {
                showCustomAlert("Maximum of 6 images reached. Please remove an image to add a new one.", "Limit Reached");
                return;
            }
            videoInput.dataset.playerMode = 'canvas'; // Set mode for canvas player
            videoInput.click();
        });

        // NEW: Robust video loading logic with automatic conversion
        videoInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            const playerMode = e.target.dataset.playerMode || 'default';
            delete e.target.dataset.playerMode; // Reset for next time

            videoInput.value = null; // Clear input immediately
            if (!file) return;
            
            // CLEANUP: Remove any existing black screen detector from previous opens
            if (activeBlackScreenHandler) {
                videoPlayer.removeEventListener('timeupdate', activeBlackScreenHandler);
                activeBlackScreenHandler = null;
            }

            // BRANCH LOGIC BASED ON MODE
            if (playerMode === 'canvas') {
                openCanvasVideoPlayer(file);
                return; // Done for this mode
            }

            // Default Player Mode
            currentVideoFile = file; 
            
            // Check if browser can play it
            const testPlayer = document.createElement('video');
            let isPlayable = false;

            const playablePromise = new Promise((resolve) => {
                testPlayer.oncanplay = () => { isPlayable = true; resolve(); };
                testPlayer.onerror = () => { isPlayable = false; resolve(); };
                testPlayer.src = URL.createObjectURL(file);
            });

            await playablePromise;
            URL.revokeObjectURL(testPlayer.src);
            
            if (!isPlayable) {
                showCustomAlert("This video format is not supported by your browser. Please use the 'Alt. Player' button or convert the video to MP4.", "Unsupported Format");
                return;
            }

            // Now, load the final (original or converted) video into the visible player.
            const finalUrl = URL.createObjectURL(file);
            videoPlayer.src = finalUrl;
            modal.style.display = 'flex';

            // Reset rotation and position
            currentRotation = 0;
            videoPlayer.style.transform = 'rotate(0deg)';
            videoPlayer.style.marginBottom = '15px';
            
            // Add a 'kickstart' to render the first frame on videos that start black
            videoPlayer.addEventListener('loadeddata', () => {
                if (videoPlayer.currentTime < 0.1) videoPlayer.currentTime = 0.1;
            }, { once: true });

            // NEW: Automatic Black Screen Detection
            const blackScreenCheckHandler = () => {
                // Check after 2 seconds of playback and only once
                if (videoPlayer.currentTime > 2) {
                    // Clean up listener immediately
                    videoPlayer.removeEventListener('timeupdate', blackScreenCheckHandler);
                    activeBlackScreenHandler = null;

                    if (videoPlayer.paused || videoPlayer.videoWidth === 0) return;

                    const canvas = document.createElement('canvas');
                    const checkSize = 32; // Small size for performance
                    canvas.width = checkSize;
                    canvas.height = checkSize;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(videoPlayer, 0, 0, checkSize, checkSize);

                    try {
                        const imageData = ctx.getImageData(0, 0, checkSize, checkSize).data;
                        let isBlack = true;
                        // Check if all pixels in the sample are very dark (threshold 15)
                        for (let i = 0; i < imageData.length; i += 4) {
                            if (imageData[i] > 15 || imageData[i+1] > 15 || imageData[i+2] > 15) {
                                isBlack = false;
                                break;
                            }
                        }

                        if (isBlack) {
                            console.log("Automatic black screen detection triggered.");
                            videoPlayer.pause();
                            
                            // Close default player
                            modal.style.display = 'none';
                            if (videoPlayer.src) URL.revokeObjectURL(videoPlayer.src);
                            videoPlayer.src = '';

                            showCustomAlert("Black screen detected. Switching to Alt. Player automatically.", "Auto-Switch");
                            openCanvasVideoPlayer(file);
                        }
                    } catch (e) {
                        console.error("Error checking for black screen:", e);
                    }
                }
            };
            
            activeBlackScreenHandler = blackScreenCheckHandler;
            videoPlayer.addEventListener('timeupdate', blackScreenCheckHandler);

            // Try to autoplay
            const playPromise = videoPlayer.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => console.warn("Auto-play was prevented. User can click play.", error));
            }
        });

        captureBtn.addEventListener('click', () => {
            // SAFETY CHECK: Ensure video has valid data before capturing
            if (videoPlayer.error) {
                showCustomAlert("Cannot capture: The video file is corrupted or unsupported.", "Capture Error");
                return;
            }
            if (videoPlayer.readyState < 2) {
                showCustomAlert("Video is not ready. Please play the video first.", "Capture Error");
                return;
            }
            if (videoPlayer.videoWidth === 0 || videoPlayer.videoHeight === 0) {
                showCustomAlert("Cannot capture: Video has no dimensions (0x0).", "Capture Error");
                return;
            }

            try {
                const canvas = document.createElement('canvas');
                
                if (currentRotation === 90 || currentRotation === 270) {
                    canvas.width = videoPlayer.videoHeight;
                    canvas.height = videoPlayer.videoWidth;
                } else {
                    canvas.width = videoPlayer.videoWidth;
                    canvas.height = videoPlayer.videoHeight;
                }

                const ctx = canvas.getContext('2d');
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.rotate(currentRotation * Math.PI / 180);
                ctx.drawImage(videoPlayer, -videoPlayer.videoWidth / 2, -videoPlayer.videoHeight / 2);
                
                const dataURL = canvas.toDataURL('image/png');
                
                if (dataURL === 'data:,') throw new Error("Empty image data");

                if (selectedImages.length >= 6) {
                    showCustomAlert("Maximum of 6 images reached.", "Limit Reached");
                } else {
                    // Compress the captured frame before saving
                    resizeImage(dataURL).then(resized => {
                        selectedImages.push(resized);
                        refreshPreview();
                    });
                    
                    // Strong Visual Feedback (Flash Effect)
                    const originalTransition = videoPlayer.style.transition;
                    videoPlayer.style.transition = 'filter 0.1s ease-out, transform 0.3s ease'; 
                    videoPlayer.style.filter = 'brightness(1.8) contrast(0.8)'; 
                    
                    setTimeout(() => {
                        videoPlayer.style.filter = 'none';
                        setTimeout(() => {
                            videoPlayer.style.transition = originalTransition;
                        }, 150);
                    }, 100);

                    // Button Animation
                    const originalText = captureBtn.textContent;
                    const originalBg = captureBtn.style.backgroundColor;
                    captureBtn.textContent = '✅ SAVED!';
                    captureBtn.style.backgroundColor = '#2ecc71';
                    captureBtn.style.transform = 'scale(1.1)';
                    captureBtn.style.boxShadow = '0 0 20px rgba(46, 204, 113, 0.8)';
                    captureBtn.style.transition = 'all 0.1s ease';
                    
                    setTimeout(() => {
                        captureBtn.textContent = originalText;
                        captureBtn.style.backgroundColor = originalBg;
                        captureBtn.style.transform = 'scale(1)';
                        captureBtn.style.boxShadow = 'none';
                    }, 800);
                }
            } catch (err) {
                console.error(err);
                showCustomAlert("Failed to capture image. Video might be unsupported.", "Error");
            }
        });

        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            
            // CLEANUP: Ensure listener is removed if closed manually before 2 seconds
            if (activeBlackScreenHandler) {
                videoPlayer.removeEventListener('timeupdate', activeBlackScreenHandler);
                activeBlackScreenHandler = null;
            }

            videoPlayer.pause();
            if (videoPlayer.src) {
                URL.revokeObjectURL(videoPlayer.src);
            }
            videoPlayer.src = '';
            currentRotation = 0;
            videoPlayer.style.transform = 'rotate(0deg)';
            videoPlayer.style.marginBottom = '15px';
        });
    }

    // ===================================================================================
    // AUTO-FIELDS GENERATOR (Impression & Recommendation)
    // ===================================================================================
    // ===================================================================================
    // TEXTAREA SUGGESTION POPUP (preOpDiagnosis / impression / recommendation)
    //
    // These three fields are <textarea> boxes on the nasal and laryngeal pages.
    // A native <datalist> can only attach to an <input>, so to keep the familiar
    // "pick a common phrase or type your own" behaviour we draw a small floating list
    // ourselves, reading the SAME options the datalists already hold.
    //
    // It is deliberately isolated: the popup is appended to <body> and positioned with
    // position:fixed from the textarea rect, so it never interferes with the auto-
    // generate wrapper (setupAutoFields) or any form CSS. The textarea keeps its id/name,
    // so getFormData(), draft restore, the database record and the printed PDF
    // (data.<id>) are completely untouched.
    // ===================================================================================
    function setupTextareaSuggest(textarea, datalistId) {
        if (!textarea || textarea.dataset.suggestReady === 'true') return;
        textarea.dataset.suggestReady = 'true';

        let panel = null;

        const readOptions = () => {
            const dl = document.getElementById(datalistId);
            if (!dl) return [];
            const seen = new Set();
            const out = [];
            Array.from(dl.options).forEach(opt => {
                const v = (opt.value || '').trim();
                if (v && !seen.has(v)) { seen.add(v); out.push(v); }
            });
            return out;
        };

        const close = () => { if (panel) { panel.remove(); panel = null; } };

        const open = () => {
            const q = textarea.value.trim().toLowerCase();
            const list = readOptions().filter(o => !q || o.toLowerCase().includes(q));
            if (!list.length) { close(); return; }

            if (!panel) {
                panel = document.createElement('div');
                panel.className = 'textarea-suggest-panel';
                document.body.appendChild(panel);
            }
            panel.innerHTML = '';

            const rect = textarea.getBoundingClientRect();
            Object.assign(panel.style, {
                position: 'fixed',
                left: rect.left + 'px',
                top: (rect.bottom + 4) + 'px',
                width: rect.width + 'px',
                maxHeight: '220px',
                overflowY: 'auto',
                background: '#000000',
                color: '#d6dde6',
                border: '1px solid #333',
                borderRadius: '6px',
                boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
                zIndex: '10000',
                display: 'block',
                fontFamily: 'inherit'
            });

            list.forEach(text => {
                const item = document.createElement('div');
                item.textContent = text;
                Object.assign(item.style, {
                    padding: '7px 12px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    lineHeight: '1.3',
                    borderBottom: '1px solid rgba(255,255,255,0.08)'
                });
                item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.15)'; });
                item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // fire before blur so we can fill the box
                    textarea.value = text;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    textarea.dispatchEvent(new Event('change', { bubbles: true }));
                    close();
                });
                panel.appendChild(item);
            });
        };

        textarea.addEventListener('focus', open);
        // Only react to REAL typing (isTrusted) so the auto-generate button, which
        // fires a synthetic input event, does not pop the list open.
        textarea.addEventListener('input', (e) => { if (e.isTrusted) open(); });
        textarea.addEventListener('blur', () => { window.setTimeout(close, 150); });
        textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
        // The panel is position:fixed, so on page scroll it would float away
        // from its field. Close it the moment the page scrolls so it never
        // lingers in the wrong spot (it simply disappears, as requested).
        window.addEventListener('scroll', close, { passive: true });
    }
    function setupAutoFields() {
        const impressionInput = document.getElementById('impression');
        const recommendationInput = document.getElementById('recommendation');
        
        if (!impressionInput && !recommendationInput) return;

        // 1. Define Generator Logic
        const generateImpression = () => {
            const data = getFormData();
            let suggestions = new Set(); // Use a Set to avoid duplicates
            let laterality = {}; // To store left/right/bilateral info

            const addSuggestion = (suggestion, side = null) => {
                suggestions.add(suggestion);
                if (side) {
                    if (!laterality[suggestion]) {
                        laterality[suggestion] = new Set();
                    }
                    laterality[suggestion].add(side);
                }
            };

            // Helper to determine laterality from a string
            const getSide = (str) => {
                if (!str) return null;
                const s = str.toLowerCase();
                if (s.includes('left')) return 'Left';
                if (s.includes('right')) return 'Right';
                if (s.includes('bilateral')) return 'Bilateral';
                return null;
            };

            if (currentReportType === 'nasal') {
                // Septum
                if (data.septum?.includes('Deviated')) addSuggestion('Nasal Septal Deviation', getSide(data.septum));
                if (data.septum?.includes('Spur')) addSuggestion('Septal Spur', getSide(data.septum));
                if (data.septum?.includes('Perforated')) addSuggestion('Septal Perforation');
                
                // Mucosa / Rhinitis
                if (data.mucosa?.includes('Pale') || data.it?.includes('Pale')) addSuggestion('Allergic Rhinitis');
                if (data.mucosa?.includes('Congested') || data.mucosa?.includes('Erythematous')) addSuggestion('Rhinitis');
                
                // Turbinates
                if (data.it?.includes('Hypertrophic') || data.mt?.includes('Hypertrophic')) {
                    const sideIT = getSide(data.it);
                    const sideMT = getSide(data.mt);
                    let finalSide = null;
                    if (sideIT === 'Bilateral' || sideMT === 'Bilateral' || (sideIT && sideMT && sideIT !== sideMT)) {
                        finalSide = 'Bilateral';
                    } else {
                        finalSide = sideIT || sideMT;
                    }
                    addSuggestion('Turbinate Hypertrophy', finalSide);
                }
                if (data.it?.includes('Atrophic')) addSuggestion('Atrophic Rhinitis');
                if (data.mt?.includes('Concha Bullosa')) addSuggestion('Concha Bullosa', getSide(data.mt));

                // Sinusitis / Polyps
                if (data.mm?.includes('Polyp') || data.omc?.includes('Polypoid') || data.mt?.includes('Polypoid')) {
                    addSuggestion('Nasal Polyposis', getSide(data.mm));
                }
                if (data.mm?.includes('Discharge') || data.discharge?.includes('Purulent') || data.discharge?.includes('Mucopurulent')) {
                    addSuggestion('Sinusitis', getSide(data.mm) || getSide(data.discharge));
                }
                
                // Nasopharynx
                if (data.nasopharynx?.includes('Mass')) addSuggestion('Nasopharyngeal Mass');
                if (data.nasopharynx?.includes('Adenoid Hypertrophy')) {
                    const gradeMatch = data.nasopharynx.match(/Grade (\d)/);
                    const grade = gradeMatch ? ` (Grade ${gradeMatch[1]})` : '';
                    addSuggestion(`Adenoid Hypertrophy${grade}`);
                }
                
            } else if (currentReportType === 'laryngeal') {
                // LPR is a common finding, check for it first
                if (data.arytenoids?.includes('Erythematous') || data.arytenoids?.includes('Edematous') || 
                    data.trueVocalCords?.includes('Erythematous') || data.trueVocalCords?.includes('Edematous')) {
                    addSuggestion('Laryngopharyngeal Reflux (LPR)');
                }

                // Specific structures
                if (data.epiglottis?.includes('Mass')) addSuggestion('Epiglottic Mass');
                if (data.epiglottis?.includes('Omega-shaped')) addSuggestion('Laryngomalacia');
                
                if (data.vallecula?.includes('Mass')) addSuggestion('Vallecular Mass');
                if (data.vallecula?.includes('Cyst')) addSuggestion('Vallecular Cyst', getSide(data.vallecula));
                
                if (data.pyriformSinuses?.includes('Mass')) addSuggestion('Pyriform Sinus Mass', getSide(data.pyriformSinuses));
                if (data.pyriformSinuses?.includes('Pooling')) addSuggestion('Dysphagia');
                
                if (data.arytenoids?.includes('Mass')) addSuggestion('Arytenoid Mass', getSide(data.arytenoids));
                if (data.arytenoids?.includes('Ulcer')) addSuggestion('Contact Ulcer', getSide(data.arytenoids));

                // Vocal Cords
                if (data.trueVocalCords?.includes('Nodule')) addSuggestion('Vocal Cord Nodule', getSide(data.trueVocalCords));
                if (data.trueVocalCords?.includes('Polyp')) addSuggestion('Vocal Cord Polyp', getSide(data.trueVocalCords));
                if (data.trueVocalCords?.includes('Cyst')) addSuggestion('Vocal Cord Cyst', getSide(data.trueVocalCords));
                if (data.trueVocalCords?.includes('Mass')) addSuggestion('Laryngeal Mass', getSide(data.trueVocalCords));
                if (data.trueVocalCords?.includes('Leukoplakia')) addSuggestion('Leukoplakia');
                if (data.trueVocalCords?.includes('Edematous')) addSuggestion("Reinke's Edema");

                // Mobility
                if (data.vocalCordMobility?.includes('Paralysis') || data.vocalCordMobility?.includes('Fixed')) {
                    addSuggestion('Vocal Cord Paralysis', getSide(data.vocalCordMobility));
                } else if (data.vocalCordMobility?.includes('Paresis')) {
                    addSuggestion('Vocal Cord Paresis', getSide(data.vocalCordMobility));
                }
                
                // Subglottis
                if (data.subglottis?.includes('Stenosis')) addSuggestion('Subglottic Stenosis');
                if (data.subglottis?.includes('Mass')) addSuggestion('Subglottic Mass');
            }

            if (suggestions.size === 0) {
                return currentReportType === 'nasal' ? 'Normal Endoscopic Findings' : 'Normal Laryngoscopy';
            }

            // Format the final string with laterality
            const formattedSuggestions = Array.from(suggestions).map(s => {
                if (laterality[s]) {
                    const sides = Array.from(laterality[s]);
                    if (sides.includes('Bilateral') || sides.length > 1) {
                        return `${s} (Bilateral)`;
                    }
                    if (sides.length === 1 && sides[0] !== null) {
                        return `${s} (${sides[0]})`;
                    }
                }
                return s;
            });

            return formattedSuggestions.join(', ');
        };

        const generateRecommendation = () => {
            const impressionText = (document.getElementById('impression')?.value || generateImpression()).toLowerCase();
            let recs = new Set(); // Use a Set to avoid duplicates

            const addRec = (rec) => recs.add(rec);

            // Nasal Recommendations
            if (impressionText.includes('sinusitis')) {
                addRec('Medical Management (Antibiotics/Decongestants)');
                addRec('Nasal Saline Irrigation');
            }
            if (impressionText.includes('allergic rhinitis') || impressionText.includes('turbinate hypertrophy')) {
                addRec('Intranasal Corticosteroids');
                addRec('Antihistamines');
                addRec('Avoidance of allergens');
            }
            if (impressionText.includes('nasal polyposis')) {
                if (!recs.has('Intranasal Corticosteroids')) addRec('Intranasal Corticosteroids');
                addRec('CT Scan of Paranasal Sinuses');
                addRec('For FESS');
            }
            if (impressionText.includes('nasal septal deviation') || impressionText.includes('septal spur')) {
                addRec('For Septoplasty');
            }
            if (impressionText.includes('nasopharyngeal mass') || impressionText.includes('ulcer')) {
                addRec('Biopsy');
                addRec('CT Scan / MRI');
            }
            if (impressionText.includes('atrophic rhinitis')) {
                addRec('Nasal Saline Irrigation');
                addRec('Nasal Moisturizers');
            }

            // Laryngeal Recommendations
            if (impressionText.includes('lpr') || impressionText.includes('reflux')) {
                addRec('Proton Pump Inhibitors (PPI)');
                addRec('Dietary Modification');
                addRec('Lifestyle Changes (Anti-Reflux Protocol)');
                addRec('Voice Rest');
            }
            if (impressionText.includes('vocal cord nodule')) {
                addRec('Voice Rest');
                addRec('Voice Therapy');
            }
            if (impressionText.includes('vocal cord polyp') || impressionText.includes('vocal cord cyst') || impressionText.includes("reinke's edema")) {
                addRec('Microlaryngeal Surgery');
                if (!recs.has('Voice Rest')) addRec('Voice Rest');
            }
            if (impressionText.includes('laryngeal mass') || impressionText.includes('epiglottic mass') || 
                impressionText.includes('vallecular mass') || impressionText.includes('pyriform sinus mass') ||
                impressionText.includes('leukoplakia')) {
                addRec('Direct Laryngoscopy with Biopsy');
                addRec('CT Scan of Neck');
            }
            if (impressionText.includes('vocal cord paralysis') || impressionText.includes('vocal cord paresis')) {
                addRec('CT Scan (Skull Base to Chest)');
                addRec('Voice Therapy');
                addRec('Refer to Neurology');
            }
            if (impressionText.includes('dysphagia')) {
                addRec('Barium Swallow Study');
                addRec('Refer to Gastroenterology');
            }

            if (recs.size === 0) {
                return 'Follow up as needed';
            }
            
            return Array.from(recs).join('; ');
        };

        // 2. Helper to inject "Auto" button
        const injectAutoButton = (inputId, generatorFn) => {
            const input = document.getElementById(inputId);
            if (!input || input.parentNode.classList.contains('input-auto-wrapper')) return;

            // Create Wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'input-auto-wrapper';
            Object.assign(wrapper.style, {
                display: 'flex', alignItems: 'center', width: '100%', marginBottom: '15px', position: 'relative'
            });

            input.parentNode.insertBefore(wrapper, input);
            wrapper.appendChild(input);

            input.style.marginBottom = '0';
            input.style.flex = '1';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.innerHTML = '⚡';
            btn.title = 'Auto-Generate from Findings';
            Object.assign(btn.style, {
                marginLeft: '8px', padding: '0', width: '40px', height: '38px',
                cursor: 'pointer', backgroundColor: '#f39c12', color: 'white',
                border: 'none', borderRadius: '50%', fontSize: '20px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minWidth: '40px', boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                transition: 'all 0.2s ease'
            });
            btn.onmouseover = () => { btn.style.transform = 'scale(1.1)'; };
            btn.onmouseout = () => { btn.style.transform = 'scale(1)'; };

            btn.onclick = () => {
                const newVal = generatorFn();
                input.value = newVal;
                input.dispatchEvent(new Event('input'));
                
                const originalBg = input.style.backgroundColor;
                input.style.transition = 'background-color 0.3s';
                input.style.backgroundColor = 'rgba(243, 156, 18, 0.2)';
                setTimeout(() => {
                    input.style.backgroundColor = originalBg;
                    input.style.transition = '';
                }, 800);
            };

            wrapper.appendChild(btn);
        };

        // 3. Initialize
        if (impressionInput) injectAutoButton('impression', generateImpression);
        if (recommendationInput) injectAutoButton('recommendation', generateRecommendation);

        // 4. Keep existing "Auto Impression" button working if it exists in HTML
        const oldAutoBtn = document.getElementById('autoImpressionBtn');
        if (oldAutoBtn && impressionInput) {
            oldAutoBtn.addEventListener('click', () => {
                impressionInput.value = generateImpression();
                impressionInput.dispatchEvent(new Event('input'));
            });
        }

        // Auto-update if empty or default
        const findingsInputs = document.querySelectorAll('.findings-fieldset input, .findings-fieldset select');
        findingsInputs.forEach(input => {
            input.addEventListener('change', () => {
                if (impressionInput) {
                    const currentVal = impressionInput.value.trim();
                    // Only auto-update if empty or if it contains the default "Normal" text
                    if (currentVal === '' || currentVal === 'Normal Endoscopy' || currentVal === 'Normal Laryngoscopy') {
                        impressionInput.value = generateImpression();
                        impressionInput.dispatchEvent(new Event('input'));
                    }
                }
            });
        });
    }

    // ===================================================================================
    // 6. CLEAR FORM FUNCTION
    // ===================================================================================
    // New helper function to clear form without confirmation
    function clearFormWithoutConfirmation(saveBackup = false) {
        // Reset all form elements
        if (reportForm) { // Ensure reportForm exists before trying to access its elements
            
            // NEW: Save state for Undo
            if (saveBackup) {
                lastClearedData = getFormData();
                const clearBtn = document.getElementById('clearFormBtn');
                const undoBtn = document.getElementById('undoClearBtn');
                if (clearBtn) clearBtn.style.display = 'none';
                if (undoBtn) undoBtn.style.display = 'inline-flex';
            }

            const formElements = reportForm.elements;
            for (let i = 0; i < formElements.length; i++) {
                const element = formElements[i];
                if (element.type !== 'file' && element.tagName !== 'BUTTON') {
                    if (element.id === 'procedureDate') {
                        element.value = getTodayDate();
                    } else {
                        element.value = '';
                    }
                }
            }
            // Clear images
            selectedImages = [];
            refreshPreview();
        }
        // A blank form is a NEW report (nasal or laryngeal): drop the carried
        // identity so the next save mints a fresh record instead of
        // overwriting the previous one, while repeated saves of THIS form keep
        // updating the same row.
        if (window.PatientRecords && typeof window.PatientRecords.startNewReport === 'function') {
            window.PatientRecords.startNewReport(currentReportType);
        }
    }

    function clearForm(withConfirmation = false) {
        // *** FIX: Prevent error on pages without a form ***
        if (!reportForm) {
            console.warn("clearForm called on a page with no report form.");
            return;
        }

        if (withConfirmation) {
            showCustomConfirm('Are you sure you want to clear all form data? You can undo this action.', (confirmed) => {
                if (confirmed) clearFormWithoutConfirmation(true);
            }, "Clear Form");
        } else {
            clearFormWithoutConfirmation(true);
        }
    }


    // Helper function to get today's date in YYYY-MM-DD format
    function getTodayDate() {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const dd = String(today.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    // Helper function to format date for display (MM/DD/YYYY)
    function formatDateForDisplay(dateString) {
        if (!dateString) return '';
        const parts = dateString.split('-');
        if (parts.length !== 3) return dateString;
        return `${parts[1]}/${parts[2]}/${parts[0]}`;
    }

    // Initialize date field if it exists and is empty
    const procedureDateInput = document.getElementById('procedureDate');
    if (procedureDateInput && !procedureDateInput.value) {
        procedureDateInput.value = getTodayDate();
    }

    // Function to generate Nasal Findings HTML
    function getNasalFindingsHtml(data) {
        return `
            <h3 style="font-size: 15px; margin: 5px 0 5px 0; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 3px;">Nasal Findings</h3>
            <div style="font-size: 12px;">
                <p style="margin: 0 0 3px;"><strong>Septum:</strong> ${escapeHtml(data.septum)}</p>
                <p style="margin: 0 0 3px;"><strong>Discharge:</strong> ${escapeHtml(data.discharge)}</p>
                <p style="margin: 0 0 3px;"><strong>Mucosa:</strong> ${escapeHtml(data.mucosa)}</p>
                <p style="margin: 0 0 3px;"><strong>Inferior Turbinate:</strong> ${escapeHtml(data.it)}</p>
                <p style="margin: 0 0 3px;"><strong>Middle Turbinate:</strong> ${escapeHtml(data.mt)}</p>
                <p style="margin: 0 0 3px;"><strong>Middle Meatus:</strong> ${escapeHtml(data.mm)}</p>
                <p style="margin: 0 0 3px;"><strong>Inferior Meatus:</strong> ${escapeHtml(data.im)}</p>
                <p style="margin: 0 0 3px;"><strong>Ostiomeatal Complex:</strong> ${escapeHtml(data.omc)}</p>
                <p style="margin: 0;"><strong>Nasopharynx:</strong> ${escapeHtml(data.nasopharynx)}</p>
            </div>
        `;
    }

    // Function to generate Laryngeal Findings HTML
    function getLaryngealFindingsHtml(data) {
        return `
            <h3 style="font-size: 15px; margin: 5px 0 5px 0; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 3px;">Laryngeal Findings</h3>
            <div style="font-size: 12px;">
                <p style="margin: 0;"><strong>Epiglottis:</strong> ${escapeHtml(data.epiglottis)}</p>
                <p style="margin: 0;"><strong>Vallecula:</strong> ${escapeHtml(data.vallecula)}</p>
                <p style="margin: 0;"><strong>Pyriform Sinuses:</strong> ${escapeHtml(data.pyriformSinuses)}</p>
                <p style="margin: 0;"><strong>Arytenoids:</strong> ${escapeHtml(data.arytenoids)}</p>
                <p style="margin: 0;"><strong>False Vocal Cords:</strong> ${escapeHtml(data.falseVocalCords)}</p>
                <p style="margin: 0;"><strong>True Vocal Cords:</strong> ${escapeHtml(data.trueVocalCords)}</p>
                <p style="margin: 0;"><strong>Vocal Cord Mobility:</strong> ${escapeHtml(data.vocalCordMobility)}</p>
                <p style="margin: 0;"><strong>Subglottis:</strong> ${escapeHtml(data.subglottis)}</p>
            </div>
        `;
    }

    // Original layout: a tall, fixed-width image column on the right of the
    // report. Images are stacked vertically, not in a grid.
    function buildImageColumnHtml(availableHeightPx = 800) {
        if (selectedImages.length === 0) {
            return '';
        }

        // Limit to a maximum of 6 images and ensure they are valid strings
        const imagesToPrint = selectedImages.filter(img => typeof img === 'string' && img.length > 0).slice(0, 6);
        const numImages = imagesToPrint.length;

        const maxImagePanelHeightPx = availableHeightPx;
        const imageGapPx = 5; // Gap between images

        let individualImageMaxHeightPx;
        if (numImages <= 2) {
            individualImageMaxHeightPx = 200;
        } else {
            const totalGaps = (numImages - 1) * imageGapPx;
            individualImageMaxHeightPx = (maxImagePanelHeightPx - totalGaps) / numImages;
        }

        individualImageMaxHeightPx = Math.max(individualImageMaxHeightPx, 60); // Minimum 60px height

        let savedSettings = {};
        try {
            savedSettings = JSON.parse(localStorage.getItem('clinicSettings') || '{}');
        } catch (error) {
            console.warn('Unable to read image layout settings.', error);
        }
        const objectFit = savedSettings.imageObjectFit || 'cover';

        // Remove margin-bottom for the last image to avoid overflow clipping
        const imageElements = imagesToPrint.map((base64, index) => {
            const marginBottom = index === numImages - 1 ? 0 : imageGapPx;
            return `
            <div class="image-container" style="width: 100%; height: ${individualImageMaxHeightPx}px; margin-bottom: ${marginBottom}px; display: flex; justify-content: center; align-items: center; background-color: var(--image-bg, #f0f0f0); border-radius: 4px; overflow: hidden; page-break-inside: avoid; flex-shrink: 0;">
                <img src="${base64}" alt="Endoscopy Image" style="width: 100%; height: 100%; object-fit: ${objectFit};">
            </div>
        `;
        }).join('');

        return `
            <h3 style="font-size: 15px; margin: 10px 0 5px 0; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 3px;">Endoscopy Images (${numImages})</h3>
            <div class="image-column" style="max-height: ${maxImagePanelHeightPx}px; overflow: hidden; display: flex; flex-direction: column;">
                ${imageElements}
            </div>
        `;
    }

    function buildEndoscopyDocumentHtml({ headerHTML, patientInfoHtml, mainContentHtml, imageColumnHTML, reportTypeDisplay, containerHeightPx = 780, contentColWidth = null, imageColWidth = 220 }) {
        // Original layout: "OPERATIVE RECORD" banner, then a two-column row.
        // Text fills the left side, images sit in a fixed 220px right column.
        const textPanelStyle = contentColWidth
            ? `width: ${contentColWidth}px; flex: none; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between;`
            : `flex: 1; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between;`;

        return `
            ${headerHTML}
            ${patientInfoHtml}
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 15px; font-size: 18px; font-weight: bold; margin: 5px 0; background-color: #2c3e50; color: white; border-radius: 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact;">
                <span>OPERATIVE RECORD</span>
                <span>${reportTypeDisplay}</span>
            </div>
            <div class="print-layout-container" style="display: flex; gap: 15px; font-size: 12px; padding: 0 15px; margin-bottom: 10px; line-height: 1.3; color: black; height: ${containerHeightPx}px; overflow: hidden;">
                <div class="print-content-panel" style="${textPanelStyle}">
                    ${mainContentHtml}
                </div>
                <div class="print-image-panel" style="width: ${imageColWidth}px; flex: none; overflow: hidden;">
                    ${imageColumnHTML}
                </div>
            </div>
        `;
    }

    // Helper to build all report sections
    function buildReportSections(data, findingsHtml) {
        function formatProcedureDescription(text) {
            if (!text) return '';
            const safeText = escapeHtml(text);
            
            if (safeText.includes('•')) {
                const lines = safeText.split('\n');
                let html = '';
                let inList = false;
                
                lines.forEach(line => {
                    let trimmed = line.trim();
                    if (!trimmed) return; 
                    
                    if (trimmed.startsWith('•')) {
                        if (!inList) {
                            html += '<ul style="margin: 5px 0 5px 0; padding-left: 25px; list-style-type: disc;">';
                            inList = true;
                        }
                        let content = trimmed.substring(1).trim();
                        content = content.replace(/^(First Pass:|Second Pass:|Third Pass:)/i, '<strong>$1</strong>');
                        html += `<li style="margin-bottom: 2px;">${content}</li>`;
                    } else {
                        if (inList) {
                            html += '</ul>';
                            inList = false;
                        }
                        html += `<p style="margin: 0 0 5px 0;">${trimmed}</p>`;
                    }
                });
                
                if (inList) html += '</ul>';
                return html;
            }
            
            return `<span style="white-space: pre-wrap;">${safeText}</span>`;
        }

        function formatTime12Hour(timeStr) {
            if (!timeStr) return '';
            const [hours, minutes] = timeStr.split(':');
            let h = parseInt(hours, 10);
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12;
            h = h ? h : 12; // the hour '0' should be '12'
            return `${h}:${minutes} ${ampm}`;
        }

        const dateStr = formatDateForDisplay(data.procedureDate);
        
        // NEW: Extract only the surgeon's name, removing titles like MD, FPSO-HNS, etc.
        let rawName = (data.physician || '').split(',')[0].trim();
        // Convert to Title Case (e.g., "JESUS" -> "Jesus")
        let surgeonNameOnly = rawName.toLowerCase().replace(/\b\w/g, s => s.toUpperCase());
        // Add "Dr." prefix if not present
        if (surgeonNameOnly && !surgeonNameOnly.startsWith('Dr.')) {
            surgeonNameOnly = `Dr. ${surgeonNameOnly}`;
        }

        const patientInfoHtml = `
            <div class="patient-info-print-section" style="padding: 0 15px 10px 15px; margin-bottom: 10px; font-size: 13px; line-height: 1.5;">
                <div style="display: grid; grid-template-columns: 1fr 1fr 1.5fr 2fr; gap: 4px 15px; white-space: nowrap;">
                    <!-- Row 1 -->
                    <div><strong>Case Number:</strong> ${escapeHtml(data.caseNumber)}</div>
                    <div><strong>Room No:</strong> ${escapeHtml(data.roomNumber)}</div>
                    <div><strong>MRN:</strong> ${escapeHtml(data.mrn)}</div>
                    <div><strong>Date:</strong> ${dateStr}</div>
                    <!-- Row 2 -->
                    <div><strong>Last Name:</strong> ${escapeHtml(data.patientLastName) || ''}</div>
                    <div><strong>First Name:</strong> ${escapeHtml(data.patientFirstName) || ''}</div>
                    <div><strong>Middle Name:</strong> ${escapeHtml(data.patientMiddleName) || ''}</div>
                    <div><strong>Surgeon:</strong> ${escapeHtml(surgeonNameOnly)}</div>
                    <!-- Row 3 -->
                    <div><strong>Sex:</strong> ${escapeHtml(data.patientSex)}</div>
                    <div><strong>Age:</strong> ${escapeHtml(data.patientAge)}</div>
                    <div><strong>Suffix:</strong> ${escapeHtml(data.suffix)}</div>
                    <div><strong>Asst. Surgeon:</strong> ${escapeHtml(data.assistantSurgeon)}</div>
                </div>
            </div>
        `;

        const procedureDescHtml = data.procedureDescription ?
            `<div style="margin-bottom: 10px; font-size: 12px;" id="procedureDescriptionSection">
                <strong class="procedure-description-label">Procedure Description:</strong>
                <div style="margin-top: 2px; line-height: 1.4;">${formatProcedureDescription(data.procedureDescription)}</div>
             </div>` : '';

        const mainContentHtml = `
            <h3 style="font-size: 15px; margin: 5px 0 5px 0; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 3px;">Procedure Details</h3>

            <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 4px 20px; font-size: 12px; line-height: 1.4; padding-bottom: 5px;">
                <div style="grid-column: 1 / -1;"><strong>Pre-Operative Diagnosis:</strong> ${escapeHtml(data.preOpDiagnosis)}</div>
                <div style="grid-column: 1 / -1;"><strong>Type of Endoscopy / Operation Performed:</strong> ${escapeHtml(data.endoscopyType)}</div>
            </div>

            ${procedureDescHtml}

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; font-size: 12px; line-height: 1.4; padding-bottom: 5px;">
                <div style="grid-column: 1 / -1;"><strong>Classification:</strong> ${escapeHtml(data.classification)}</div>
                <div><strong>ICD 10 Code:</strong> ${escapeHtml(data.icd10Code)}</div>
                <div><strong>RVS Code:</strong> ${escapeHtml(data.rvsCode)}</div>
                <div><strong>Operation Started:</strong> ${escapeHtml(formatTime12Hour(data.operationStarted))}</div>
                <div><strong>Operation Ended:</strong> ${escapeHtml(formatTime12Hour(data.operationEnded))}</div>
                <div><strong>Scrub Nurse:</strong> ${escapeHtml(data.scrubNurse)}</div>
                <div><strong>Duration:</strong> ${escapeHtml(data.durationOfOperation)}</div>
                <div style="grid-column: 1 / -1;"><strong>Type of Anesthesia:</strong> ${escapeHtml(data.anesthesiaUsed)}</div>
                <div style="grid-column: 1 / -1; margin-top: 2px;"><strong>Indication:</strong> ${escapeHtml(data.indication)}</div>
            </div>

            ${findingsHtml}
            
            <h3 style="font-size: 15px; margin: 5px 0 5px 0; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 3px;">Impression / Post-Operative Diagnosis</h3>
            <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.4;">${escapeHtml(data.impression)}</p>

            <h3 style="font-size: 15px; margin: 5px 0 5px 0; border-bottom: 1px solid var(--border-color, #eee); padding-bottom: 3px;">Recommendation / Plan</h3>
            <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.4;">${escapeHtml(data.recommendation)}</p>
        `;

        const physicianFullName = data.physician || '';
        const physicianTitle = 'Surgeon';

        const physicianBlock = `
            <div class="doctor-signature-section" style="margin-top: 10px; text-align: left; page-break-inside: avoid;">
                <div style="display: inline-block; min-width: 200px; text-align: center;">
                    <div style="height: 40px; border-bottom: 1px solid var(--text-color, #333); margin-bottom: 2px;"></div>
                    <strong class="physician-name" style="margin: 0; padding: 0; font-size: 13px; white-space: nowrap; display: block;">${escapeHtml(physicianFullName)}</strong>
                    <span style="margin: 0; padding: 0; font-size: 12px; display: block;">${physicianTitle}</span>
                </div>
            </div>
        `;

        return { patientInfoHtml, mainContentHtml: mainContentHtml + physicianBlock };
    }
    function getPrintHeaderHtml(savedSettings, logos) {
        // Get Styling Settings with defaults
        const headerFont = savedSettings.headerFontFamily || 'Arial, sans-serif';
        const logoSize = savedSettings.logoSize || '100';
        const hospSize = savedSettings.hospitalNameFontSize || '25';
        const hospBold = (savedSettings.hospitalNameBold !== false) ? 'bold' : 'normal';
        const subSize = savedSettings.subtitleFontSize || '12';
        const subBold = (savedSettings.subtitleBold === true) ? 'bold' : 'normal';
        const clinicSize = savedSettings.clinicNameFontSize || '16';
        const clinicBold = (savedSettings.clinicNameBold !== false) ? 'bold' : 'normal';
        const addrSize = savedSettings.addressFontSize || '12';
        const addrBold = (savedSettings.addressBold === true) ? 'bold' : 'normal';
        const contactNoSize = savedSettings.contactNoFontSize || '12';
        const contactNoBold = (savedSettings.contactNoBold === true) ? 'bold' : 'normal';

        // Determine which logos to use
        const selectedHospital = savedSettings.hospitalHeader || 'capitol';
        const leftLogoSrc = savedSettings.leftLogo || (selectedHospital === 'rever' ? logos.left : logos.cumc);
        const rightLogoSrc = savedSettings.rightLogo || logos.right;

        // Determine header text content
        let hospitalNameLine = selectedHospital; // Default to value
        if (selectedHospital === 'rever') {
            hospitalNameLine = 'REVER MEDICAL CENTER INC.';
        } else if (selectedHospital === 'capitol') {
            hospitalNameLine = 'CAPITOL UNIVERSITY MEDICAL CENTER';
        }

        const clinicName = savedSettings.clinicName || 'ENT-HNS ENDOSCOPY UNIT';
        let address = savedSettings.clinicAddress !== undefined ? savedSettings.clinicAddress : '';
        const phone = savedSettings.clinicPhoneNumber || '';
        if (selectedHospital === 'capitol' && !address) {
            address = 'Gusa Highway, Cagayan de Oro City, Misamis Oriental';
        } else if (selectedHospital === 'rever' && !address) {
            address = 'Zone 4, Capunuyan, Aplaya, Jasaan, Misamis Oriental';
        }

        const rehabTextRaw = savedSettings.rehabCenterText !== undefined ? savedSettings.rehabCenterText : 'MINDANAO EAR, NOSE, THROAT OUT-PATIENT REHABILITATION CENTER\n(MENTOR)';
        const rehabText = rehabTextRaw.replace(/\n/g, '<br>');

        // Use the hidden template to build the header
        const template = document.getElementById('printHeaderTemplate');
        if (!template) return ''; // Safety check

        const headerContainer = document.createElement('div');
        headerContainer.innerHTML = template.innerHTML;

        // CUMC Specific Margin/Padding Logic
        if (selectedHospital === 'capitol') {
            // Add padding to the container to prevent logos from touching edges
            headerContainer.querySelector('.print-header-container').style.padding = '0 20px';
        }

        // Populate logos
        headerContainer.querySelector('img[alt="Left Logo"]').src = leftLogoSrc;
        headerContainer.querySelector('img[alt="Right Logo"]').src = rightLogoSrc;
        headerContainer.querySelectorAll('img').forEach(img => {
            img.style.width = `${logoSize}px`;
            img.style.height = `${logoSize}px`;
        });

        // Populate text block
        const textBlock = headerContainer.querySelector('.header-text-block');
        textBlock.style.fontFamily = headerFont;
        textBlock.innerHTML = `
            <div style="margin-bottom: 5px; line-height: 1.2; text-align: center;">
                <span class="hospital-name-span" style="font-weight: ${hospBold}; font-size: ${hospSize}px; display: block; max-width: 100%; white-space: nowrap;">${escapeHtml(hospitalNameLine)}</span>
                <span class="subtitle-span" style="font-weight: ${subBold}; font-size: ${subSize}px; display: block; max-width: 100%; white-space: nowrap;">${rehabText}</span>
                <span style="font-weight: ${clinicBold}; font-size: ${clinicSize}px;">${escapeHtml(clinicName)}</span><br>
                <span style="font-weight: ${addrBold}; font-size: ${addrSize}px;">${escapeHtml(address)}</span>
                ${phone ? `<br><span style="font-weight: ${contactNoBold}; font-size: ${contactNoSize}px;">Contact No. || ${phone}</span>` : ''}
            </div>`;

        return headerContainer.innerHTML;
    }

    // ===================================================================================
    // VIDEO DIAGNOSTIC TEST MODE (CANVAS RENDERER)
    // ===================================================================================
    const videoTestBtn = document.getElementById('videoTestBtn');
    if (videoTestBtn) {
        videoTestBtn.addEventListener('click', () => {
            // 1. Create File Input
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'video/*';
            
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;

                // 2. Create Test Modal
                const modal = document.createElement('div');
                Object.assign(modal.style, {
                    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                    backgroundColor: 'rgba(0,0,0,0.9)', zIndex: '10000', display: 'flex',
                    flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
                });

                // 3. Create Elements
                const header = document.createElement('h3');
                header.textContent = "Video Test Mode (Canvas Renderer)";
                header.style.color = 'white';
                header.style.marginBottom = '10px';

                // Hidden Video Element (Source)
                const video = document.createElement('video');
                video.src = URL.createObjectURL(file);
                video.muted = true;
                video.playsInline = true;
                video.autoplay = true;
                video.loop = true;
                video.style.display = 'none'; // Hide the actual video element

                // Visible Canvas Element (Display)
                const canvas = document.createElement('canvas');
                Object.assign(canvas.style, {
                    maxWidth: '90%', maxHeight: '60vh', border: '2px solid #fff',
                    backgroundColor: '#000'
                });

                const controlsDiv = document.createElement('div');
                controlsDiv.style.marginTop = '20px';
                controlsDiv.style.display = 'flex';
                controlsDiv.style.gap = '10px';

                const captureBtn = document.createElement('button');
                captureBtn.textContent = '📸 Capture from Canvas';
                
                const closeBtn = document.createElement('button');
                closeBtn.textContent = 'Close';
                closeBtn.className = 'btn-secondary';

                controlsDiv.appendChild(captureBtn);
                controlsDiv.appendChild(closeBtn);
                modal.appendChild(header);
                modal.appendChild(canvas); // We append canvas, NOT video
                modal.appendChild(video);
                modal.appendChild(controlsDiv);
                document.body.appendChild(modal);

                // 4. Render Loop (The Magic Part)
                let animationId;
                const ctx = canvas.getContext('2d');

                const renderFrame = () => {
                    if (video.paused || video.ended) {
                        // Still loop to catch updates if paused but seeking
                    }
                    
                    if (video.readyState >= 2) {
                        // Set canvas size to match video once ready
                        if (canvas.width !== video.videoWidth) {
                            canvas.width = video.videoWidth;
                            canvas.height = video.videoHeight;
                        }
                        // Draw video frame to canvas
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    }
                    animationId = requestAnimationFrame(renderFrame);
                };

                video.play().then(() => {
                    renderFrame();
                }).catch(err => {
                    console.error(err);
                    alert("Autoplay failed. Please interact with the page.");
                });

                // 5. Capture Logic
                captureBtn.onclick = () => {
                    try {
                        const dataUrl = canvas.toDataURL('image/png');
                        // Download for testing
                        const a = document.createElement('a');
                        a.href = dataUrl;
                        a.download = 'test-capture.png';
                        a.click();
                        alert("Image captured and downloaded! Check if it's black or visible.");
                    } catch (e) {
                        alert("Capture failed: " + e.message);
                    }
                };

                closeBtn.onclick = () => {
                    cancelAnimationFrame(animationId);
                    video.pause();
                    URL.revokeObjectURL(video.src);
                    document.body.removeChild(modal);
                };
            };
            input.click();
        });
    }

    /**
     * NEW: Centralized function to build the complete HTML for the print header.
     * This avoids code duplication between native print and PDF generation.
     * @param {object} savedSettings - The clinic settings object from localStorage.
     * @param {object} logos - An object containing the base64 logo strings.
     * @returns {string} The complete HTML string for the header.
     */

    async function getEndoscopyPrintDocument(data, logos = null, layout = {}) {
        const pageTitle = document.title;
        let findingsHtml = '';
        let reportTypeDisplay = '';
        if (pageTitle.includes('Nasal')) {
            findingsHtml = getNasalFindingsHtml(data);
            reportTypeDisplay = 'NASAL ENDOSCOPY REPORT';
        } else if (pageTitle.includes('Laryngeal')) {
            findingsHtml = getLaryngealFindingsHtml(data);
            reportTypeDisplay = 'LARYNGEAL ENDOSCOPY REPORT';
        }

        const printLogos = logos || await getEndoscopyPrintLogos();
        let savedSettings = {};
        try {
            savedSettings = JSON.parse(localStorage.getItem('clinicSettings') || '{}');
        } catch (error) {
            console.warn('Unable to read Endoscopy document settings.', error);
        }
        const headerHTML = getPrintHeaderHtml(savedSettings, {
            left: printLogos.left,
            right: printLogos.right,
            cumc: printLogos.left
        });
        const { patientInfoHtml, mainContentHtml } = buildReportSections(data, findingsHtml);
        // Native print uses the original 780px container and 730px image panel.
        const containerHeightPx = layout.containerHeightPx || 780;
        const imagePanelHeightPx = layout.imagePanelHeightPx || (containerHeightPx - 50);
        return buildEndoscopyDocumentHtml({
            headerHTML,
            patientInfoHtml,
            mainContentHtml,
            imageColumnHTML: buildImageColumnHtml(imagePanelHeightPx),
            reportTypeDisplay,
            containerHeightPx,
            contentColWidth: layout.contentColWidth || null,
            imageColWidth: layout.imageColWidth || 220
        });
    }

    /**
     * Opens the native print dialog and waits for it to finish. A short fallback
     * prevents a stuck page on browsers where `afterprint` is unreliable.
     */
    async function waitForNativePrintToFinish() {
        if ('onafterprint' in window) {
            await new Promise(resolve => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    window.removeEventListener('afterprint', finish);
                    clearTimeout(fallbackTimer);
                    resolve();
                };
                const fallbackTimer = window.setTimeout(finish, 2000);
                window.addEventListener('afterprint', finish, { once: true });
                window.print();
            });
            return;
        }

        window.print();
        await new Promise(resolve => window.setTimeout(resolve, 500));
    }

    async function handleNativePrint() {
        // Show spinner to indicate loading
        if (loadingSpinner) {
            const p = loadingSpinner.querySelector('p');
            if (p) p.textContent = "Preparing Print Preview...";
            loadingSpinner.style.display = 'flex';
        }

        try {
            const data = getFormData();
            // Native print keeps the original 780px container and 730px image panel.
            const finalHtml = await getEndoscopyPrintDocument(data, null, {
                containerHeightPx: 780,
                imagePanelHeightPx: 730
            });

            // Only the generated report is printed. The print stylesheet already
            // hides the live form, header, breadcrumb, and section navigation.
            printDiv.style.cssText = '';
            printDiv.innerHTML = finalHtml;
            printDiv.style.display = 'block';

            const hospitalNameSpanNative = printDiv.querySelector('.hospital-name-span');
            const subtitleSpanNative = printDiv.querySelector('.subtitle-span');
            const textBlockContainerNative = printDiv.querySelector('.header-text-block');
            adjustFontSizeToFit(hospitalNameSpanNative, textBlockContainerNative);
            adjustFontSizeToFit(subtitleSpanNative, textBlockContainerNative);

            const physicianNameNative = printDiv.querySelector('.physician-name');
            const physicianContainerNative = printDiv.querySelector('.doctor-signature-section');
            const physicianTitleSpanNative = printDiv.querySelector('.doctor-signature-section span:nth-of-type(1)');
            if (physicianNameNative && physicianContainerNative) {
                adjustFontSizeToFit(physicianNameNative, physicianContainerNative);
            }
            if (physicianTitleSpanNative && physicianContainerNative) {
                adjustFontSizeToFit(physicianTitleSpanNative, physicianContainerNative);
            }

            const images = Array.from(printDiv.querySelectorAll('img'));
            await Promise.all(images.map(img => {
                if (img.complete) return Promise.resolve();
                return new Promise(resolve => {
                    img.addEventListener('load', resolve, { once: true });
                    img.addEventListener('error', resolve, { once: true });
                });
            }));

            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (loadingSpinner) loadingSpinner.style.display = 'none';
            await waitForNativePrintToFinish();
        } finally {
            printDiv.style.display = 'none';
            printDiv.innerHTML = '';
            if (loadingSpinner) {
                loadingSpinner.style.display = 'none';
                const p = loadingSpinner.querySelector('p');
                if (p) p.textContent = "Generating PDF...";
            }
        }
    }

    async function printReport(options = {}) {
        const { isForEmail = false, paperFormat = 'A4', showPreview = false } = options;
        
        // Show spinner
        if (loadingSpinner) loadingSpinner.style.display = 'flex';

        const data = getFormData();
        const pageTitle = document.title; // e.g., "Nasal Endoscopy Report" or "Laryngeal Endoscopy Report"
        let pdfFilename = 'Endoscopy_Report.pdf';

        const displayName = [data.patientLastName, data.patientFirstName]
            .filter(Boolean)
            .join(' ')
            .replace(/[^a-z0-9\s-]/gi, '')
            .trim()
            .replace(/\s+/g, '_');
        const reportLabel = pageTitle.includes('Laryngeal') ? 'Laryngeal' : 'Nasal';
        pdfFilename = `${displayName || reportLabel}_${reportLabel}_Endoscopy_Report.pdf`;

        // Calculate dimensions based on paper format (96 DPI)
        let pdfPageWidthPx = 794; // A4 Default
        let pdfPageHeightPx = 1123; // A4 Default
        
        if (paperFormat === 'Letter') {
            pdfPageWidthPx = 816;
            pdfPageHeightPx = 1056;
        } else if (paperFormat === 'Legal') {
            pdfPageWidthPx = 816;
            pdfPageHeightPx = 1344;
        }
        
        // Original PDF layout maths: the content container is ~70% of the page
        // height, and the image column is a fixed 220px on the right.
        const containerHeight = Math.floor(pdfPageHeightPx * 0.70);
        const containerPadding = 30; // 15px * 2
        const columnGap = 15;
        const usableWidth = pdfPageWidthPx - containerPadding - columnGap;
        const imageColWidth = 220;
        const contentColWidth = usableWidth - imageColWidth;

        const documentHtml = await getEndoscopyPrintDocument(data, null, {
            containerHeightPx: containerHeight,
            imagePanelHeightPx: containerHeight - 50,
            contentColWidth,
            imageColWidth
        });

        printDiv.innerHTML = documentHtml;

        // PDF output is always a white clinical document, even when the live app is in dark mode.
        const isDarkMode = false;
        const themeStyles = `--bg-color: #ffffff; --text-color: #111111; --border-color: #d8dee6; --image-bg: #f8fafc;`;

        // Original PDF setup: fixed A4 page width with the same page height used
        // before, so the printed page fills correctly on the first sheet.
        printDiv.style.cssText = `display: block; width: ${pdfPageWidthPx}px; height: ${pdfPageHeightPx}px; box-sizing: border-box; background-color: #ffffff; color: #111111; position: fixed; top: 0; left: 0; z-index: 9999; overflow: hidden; ${themeStyles}`;

        // *** NEW: Adjust font size after rendering in the fixed-width div ***
        const hospitalNameSpanForPdf = printDiv.querySelector('.hospital-name-span');
        const subtitleSpanForPdf = printDiv.querySelector('.subtitle-span');
        const textBlockContainerForPdf = printDiv.querySelector('.header-text-block');
        adjustFontSizeToFit(hospitalNameSpanForPdf, textBlockContainerForPdf);
        adjustFontSizeToFit(subtitleSpanForPdf, textBlockContainerForPdf);

        // Adjust physician name font size to fit in one line
        const physicianNamePdf = printDiv.querySelector('.physician-name');
        const physicianContainerPdf = printDiv.querySelector('.doctor-signature-section');
        const physicianTitleSpanPdf = printDiv.querySelector('.doctor-signature-section span:nth-of-type(1)');

        if (physicianNamePdf && physicianContainerPdf) {
            adjustFontSizeToFit(physicianNamePdf, physicianContainerPdf);
        }
        if (physicianTitleSpanPdf && physicianContainerPdf) {
            adjustFontSizeToFit(physicianTitleSpanPdf, physicianContainerPdf);
        }
        // Use a short timeout to allow the browser to render the printDiv
        // before the PDF generation tries to capture it. This prevents blank/stuck PDFs.
        return new Promise((resolve, reject) => {
            // Safety timeout: Stop spinner if too long, but DO NOT print.
            const safetyTimeout = setTimeout(() => {
                if (loadingSpinner && loadingSpinner.style.display !== 'none') {
                    console.warn("PDF generation timed out.");
                    showCustomAlert("PDF generation is taking too long. Please check if the file is open or try again.", "Timeout");
                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                    printDiv.style.width = 'auto'; // Reset width
                    printDiv.style.display = 'none';
                    resolve();
                }
            }, 15000);

            // Helper to load scripts dynamically
            const loadScript = (src) => {
                return new Promise((res, rej) => {
                    const s = document.createElement('script');
                    s.src = src;
                    s.onload = res;
                    s.onerror = rej;
                    document.head.appendChild(s);
                });
            };

            // Check and try to load if missing (Fallback to CDN)
            (async () => {
                if (typeof html2canvas !== 'function' || (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined')) {
                    // Load local copies first (these work fully offline), then fall back to CDN if missing.
                    const loadLocalOrCdn = async (localSrc, cdnSrc) => {
                        try {
                            await loadScript(localSrc);
                        } catch (err) {
                            console.warn('Local library missing (' + localSrc + '), trying CDN fallback...', err);
                            try { await loadScript(cdnSrc); } catch (err2) { console.error('CDN fallback failed:', err2); }
                        }
                    };
                    if (typeof html2canvas !== 'function') await loadLocalOrCdn(assetUrl('js/lib/html2canvas.min.js'), 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
                    if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') await loadLocalOrCdn(assetUrl('js/lib/jspdf.umd.min.js'), 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
                }

                setTimeout(() => {
                    // Check if libraries are loaded
                    if (typeof html2canvas === 'function' && (typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined')) {
                        const jsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : window.jsPDF;
                        if (!jsPDF) { 
                            clearTimeout(safetyTimeout);
                            showCustomAlert("PDF libraries not loaded.", "Error");
                            if (loadingSpinner) loadingSpinner.style.display = 'none';
                            printDiv.style.display = 'none';
                            resolve();
                            return;
                        }
                        
                        const pdf = new jsPDF({
                            orientation: 'p',
                            unit: 'mm',
                            format: paperFormat.toLowerCase()
                        });

                        const pdfWidth = pdf.internal.pageSize.getWidth();
                        const pdfHeight = pdf.internal.pageSize.getHeight();

                        // PRIMARY APPROACH: Use pdf.html() for text-based/selectable PDF
                        // This produces PDFs with selectable text rather than flat images
                        let pdfGenerated = false;
                        
                        pdf.html(printDiv, {
                            x: 10,
                            y: 10,
                            width: pdfWidth - 20, // Leave margins
                            windowWidth: printDiv.scrollWidth,
                            callback: function(pdf) {
                                clearTimeout(safetyTimeout);
                                pdfGenerated = true;
                                
                                // Add page numbers
                                const totalPages = pdf.internal.getNumberOfPages();
                                for (let i = 1; i <= totalPages; i++) {
                                    pdf.setPage(i);
                                    pdf.setFontSize(9);
                                    if (isDarkMode) {
                                        pdf.setTextColor(200, 200, 200);
                                    } else {
                                        pdf.setTextColor(80, 80, 80);
                                    }
                                    pdf.text(`Page ${i} of ${totalPages}`, pdfWidth / 2, pdfHeight - 10, { align: 'center' });
                                }
                                
                                if (showPreview) {
                                    const pdfDataUri = pdf.output('bloburl');
                                    pdfPreviewFrame.src = pdfDataUri;
                                    pdfPreviewModal.style.display = 'flex';
                                    generatedPdfForSave = { pdf, pdfFilename };
                                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                                } else if (!isForEmail) { 
                                    pdf.save(pdfFilename);
                                    window.PatientRecords?.recordSave(currentReportType, data, { format: 'PDF', fileName: pdfFilename });
                                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                                }
                                
                                printDiv.style.display = 'none';
                                printDiv.style.width = 'auto';
                                printDiv.innerHTML = '';
                                printDiv.style.cssText = '';
                                resolve({ pdf, pdfFilename });
                            }
                        }).catch(async (htmlError) => {
                            console.warn('pdf.html() method failed, using html2canvas fallback:', htmlError);
                            // FALLBACK: Use html2canvas for image-based PDF
                            try {
                                const canvas = await html2canvas(printDiv, { 
                                    scale: 2,
                                    logging: false,
                                    useCORS: false,
                                    allowTaint: false
                                });
                                clearTimeout(safetyTimeout);
                                let imgData;
                                try {
                                    imgData = canvas.toDataURL('image/png');
                                } catch (e) {
                                    console.warn("Canvas tainted.", e);
                                    showCustomAlert("Unable to generate PDF due to image security restrictions.", "Security Error");
                                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                                    printDiv.style.display = 'none';
                                    resolve();
                                    return;
                                }

                                let imgHeight = canvas.height * pdfWidth / canvas.width;
                                let heightLeft = imgHeight; 
                                let position = 0;
                                const totalPages = Math.ceil(imgHeight / pdfHeight);

                                const addFooter = (pageNum) => {
                                    const str = `Page ${pageNum} of ${totalPages}`;
                                    pdf.setFontSize(9);
                                    if (isDarkMode) pdf.setTextColor(200, 200, 200);
                                    else pdf.setTextColor(80, 80, 80);
                                    pdf.text(str, pdfWidth / 2, pdfHeight - 10, { align: 'center' });
                                };

                                pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
                                addFooter(1);
                                heightLeft -= pdfHeight;
                                let pageCount = 1;
                                while (heightLeft > 0) {
                                    position = heightLeft - imgHeight;
                                    pdf.addPage(paperFormat.toLowerCase(), 'p');
                                    pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
                                    pageCount++;
                                    addFooter(pageCount);
                                    heightLeft -= pdfHeight;
                                }

                                if (showPreview) {
                                    const pdfDataUri = pdf.output('bloburl');
                                    pdfPreviewFrame.src = pdfDataUri;
                                    pdfPreviewModal.style.display = 'flex';
                                    generatedPdfForSave = { pdf, pdfFilename };
                                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                                } else if (!isForEmail) { 
                                    pdf.save(pdfFilename);
                                    window.PatientRecords?.recordSave(currentReportType, data, { format: 'PDF', fileName: pdfFilename });
                                    if (loadingSpinner) loadingSpinner.style.display = 'none';
                                }
                                
                                printDiv.style.display = 'none';
                                printDiv.style.width = 'auto';
                                printDiv.innerHTML = '';
                                printDiv.style.cssText = '';
                                resolve({ pdf, pdfFilename });
                            } catch (err) {
                                clearTimeout(safetyTimeout);
                                console.error("PDF Generation Error:", err);
                                if (loadingSpinner) loadingSpinner.style.display = 'none';
                                printDiv.style.display = 'none';
                                printDiv.style.width = 'auto';
                                printDiv.style.cssText = '';
                                printDiv.innerHTML = '';
                                resolve();
                            }
                        });
                    } else {
                        clearTimeout(safetyTimeout);
                        showCustomAlert("PDF libraries could not be loaded.\n\nPlease open the app once while online so the offline files are installed, then it will work without internet.", "Error");
                        if (loadingSpinner) loadingSpinner.style.display = 'none';
                        printDiv.style.display = 'none';
                        resolve();
                    }
                }, 200);
            })();
        });
    }

    // ===================================================================================
    // GLOBAL PASTE SUPPORT (Ctrl+V) - one guarded handler only
    // ===================================================================================

    // Paste images only on Nasal/Laryngeal report pages.
    window.addEventListener('paste', (e) => {
        if (currentReportType !== 'nasal' && currentReportType !== 'laryngeal') return;
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        let blob = null;

        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                blob = items[i].getAsFile();
                break;
            }
        }

        if (blob) {
            e.preventDefault(); // Prevent default paste behavior
            
            if (selectedImages.length >= 6) {
                showCustomAlert("Maximum of 6 images reached. Please remove an image to paste a new one.", "Limit Reached");
                return;
            }

            const reader = new FileReader();
            reader.onload = async (event) => {
                const resized = await resizeImage(event.target.result);
                addBase64ToPreview(resized);
                showCustomAlert("Image pasted from clipboard successfully!", "Image Added");
            };
            reader.readAsDataURL(blob);
        }
    });

});


// ===================================================================================
// OFFLINE RECORDS VIEWER - Shows records saved in IndexedDB (EntOfflineStore)
// ===================================================================================
(function (window) {
    'use strict';

    let offlineModal = null;
    let offlineListElement = null;
    let offlineSearchElement = null;
    let offlineStatusElement = null;
    let offlineStatusTimer = null;
    let offlineSearchTerm = '';
    let offlineSiteFilter = '';

    const SITE_REVER = 'RMCI';
    const SITE_CAPITOL = 'CUMC';
    const SITE_UNKNOWN = '';

    const SITE_LABELS = { [SITE_REVER]: 'RMCI', [SITE_CAPITOL]: 'CUMC' };

    function normaliseSite(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return SITE_UNKNOWN;
        const upper = raw.toUpperCase();
        if (upper === SITE_REVER || upper === SITE_CAPITOL) return upper;
        if (/rever/i.test(raw)) return SITE_REVER;
        if (/capitol|cumc/i.test(raw)) return SITE_CAPITOL;
        return SITE_UNKNOWN;
    }

    function formatTimestamp(value) {
        if (!value) return 'Unknown';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Unknown';
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        }).format(date);
    }

    function formatDay(value) {
        const raw = String(value || '').trim().slice(0, 10);
        const parts = raw.split('-');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || 'No date';
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return parts[2] + ' ' + (MONTHS[Number(parts[1]) - 1] || '') + ' ' + parts[0];
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/'/g, '\u0027')
            .replace(/"/g, '\u0022');
    }

    function showAlert(message, title) {
        const bridge = window.EntFormBridge;
        if (bridge && typeof bridge.alert === 'function') {
            bridge.alert(message, title);
        } else {
            window.alert(message);
        }
    }

    function setOfflineStatus(message, isError) {
        if (!offlineModal || !offlineStatusElement) return;
        if (offlineStatusTimer) {
            clearTimeout(offlineStatusTimer);
            offlineStatusTimer = null;
        }
        offlineStatusElement.textContent = message || '';
        offlineStatusElement.classList.toggle('is-error', Boolean(isError));
        offlineStatusElement.hidden = !message;
        if (message) {
            offlineStatusTimer = setTimeout(() => {
                offlineStatusElement.textContent = '';
                offlineStatusElement.hidden = true;
                offlineStatusElement.classList.remove('is-error');
                offlineStatusTimer = null;
            }, 6000);
        }
    }

    async function loadOfflineRecords() {
        const store = window.EntOfflineStore;
        if (!store || typeof store.listRecords !== 'function') {
            return [];
        }
        try {
            const records = await store.listRecords();
            return Array.isArray(records) ? records.filter(Boolean) : [];
        } catch (error) {
            console.warn('[OfflineViewer] Failed to load offline records:', error);
            return [];
        }
    }

    function getFilteredOfflineRecords(records) {
        const query = offlineSearchTerm.trim().toLowerCase();
        return records.filter(record => {
            const site = normaliseSite(record.site);
            if (offlineSiteFilter && site !== offlineSiteFilter) return false;
            if (!query) return true;
            return [record.patientName, record.patientId, record.caseNumber, record.fileName,
                record.reportType, record.procedureDate].some(value => String(value || '').toLowerCase().includes(query));
        });
    }

    function siteChips(records) {
        const counts = new Map();
        records.forEach(function (d) {
            const s = normaliseSite(d && d.site);
            counts.set(s, (counts.get(s) || 0) + 1);
        });
        const known = [SITE_REVER, SITE_CAPITOL].filter(function (s) { return counts.get(s); });
        const unknown = counts.get(SITE_UNKNOWN) || 0;
        const chips = [{ value: '', label: 'All', count: records.length }];
        known.forEach(function (s) {
            chips.push({ value: s, label: SITE_LABELS[s] || s, count: counts.get(s) });
        });
        if (unknown) {
            chips.push({
                value: SITE_UNKNOWN,
                label: 'Untagged',
                count: unknown,
                title: 'Saved before the hospital tag existed, or from a device with no letterhead set.'
            });
        }
        return chips.length > 2 ? chips : chips.slice(0, 1);
    }

    function createOfflineCard(record) {
        const card = document.createElement('article');
        card.className = 'ent-drafts-card';
        const reportType = record.reportType || '';
        const reportLabel = reportType === 'cf4' ? 'CF4 Form' : (reportType === 'nasal' ? 'Nasal Endoscopy' : 'Laryngeal Endoscopy');
        const site = normaliseSite(record.site);
        const siteChip = site
            ? `<span class="ent-drafts-site-badge is-${site.toLowerCase()}" title="This patient's visit belongs to ${escapeHtml(site)}.">${escapeHtml(site)}</span>`
            : '<span class="ent-drafts-site-badge is-untagged" title="No hospital recorded.">Untagged</span>';
        const syncLabel = record.syncStatus === 'failed'
            ? 'Sync Failed'
            : record.synced
                ? 'Synced'
                : record.syncStatus === 'pending'
                    ? 'Pending Sync'
                    : 'Local Draft';
        const syncClass = record.syncStatus === 'failed'
            ? 'is-error'
            : record.synced ? 'is-shared' : '';
        const statusTitle = [
            record.lastSyncError || '',
            record.photosLocalOnly ? 'Attached photos remain on this device and were not synced.' : ''
        ].filter(Boolean).join(' ');
        const syncError = statusTitle ? ` title="${escapeHtml(statusTitle)}"` : '';
        const localPhotoNote = record.photosLocalOnly
            ? '<span class="ent-drafts-local-photo-note">Photos remain on this device · not synced</span>'
            : '';
        const identifier = record.patientId || record.caseNumber || '';
        card.innerHTML = `
            <div class="ent-drafts-main">
                <div class="ent-drafts-top">
                    <span class="ent-drafts-badge">${escapeHtml(reportLabel)}</span>
                    ${siteChip}
                    <span class="ent-drafts-date">📅 ${escapeHtml(formatDay(record.procedureDate))}</span>
                    <span class="ent-drafts-state ${syncClass}"${syncError}>${escapeHtml(syncLabel)}</span>
                </div>
                <h3 class="ent-drafts-name">${escapeHtml(record.patientName || 'Unnamed patient')}</h3>
                <div class="ent-drafts-meta">
                    ${identifier ? `<span class="ent-drafts-id">ID ${escapeHtml(identifier)}</span>` : ''}
                    <span>Saved ${escapeHtml(formatTimestamp(record.offlineSavedAt || record.savedAt || record.createdAt || ''))}</span>
                </div>
                ${localPhotoNote}
                ${record.fileName ? `<div class="ent-drafts-file" title="${escapeHtml(record.fileName)}">📄 ${escapeHtml(record.fileName)}</div>` : ''}
            </div>
            <div class="ent-drafts-actions">
                <button type="button" class="ent-drafts-open" data-record-key="${escapeHtml(record.key)}" title="Load this record back into the form">📂 Open</button>
                <button type="button" class="ent-drafts-delete" data-record-key="${escapeHtml(record.key)}" title="Delete this offline record">🗑️ Delete</button>
            </div>`;
        return card;
    }

    function buildOfflineModal() {
        if (offlineModal) return offlineModal;
        offlineModal = document.createElement('div');
        offlineModal.className = 'ent-drafts-modal no-print';
        offlineModal.id = 'offlineRecordsModal';
        offlineModal.setAttribute('role', 'dialog');
        offlineModal.setAttribute('aria-modal', 'true');
        offlineModal.setAttribute('aria-label', 'Offline mode saved records');
        offlineModal.innerHTML = `
            <div class="ent-drafts-dialog" role="document">
                <div class="ent-drafts-header">
                    <div class="ent-drafts-heading">
                        <h2>📴 Offline Records</h2>
                        <p class="ent-drafts-subtitle">Records saved on this device while offline. They will sync to the cloud automatically when you're back online.</p>
                    </div>
                    <button type="button" class="ent-drafts-close" title="Close" aria-label="Close">&times;</button>
                </div>
                <div class="ent-drafts-toolbar">
                    <input type="search" class="ent-drafts-search" placeholder="Search patient name, ID, report..." aria-label="Search offline records">
                </div>
                <div class="ent-drafts-sites" role="group" aria-label="Filter by hospital" hidden></div>
                <div class="ent-drafts-status" hidden></div>
                <div class="ent-drafts-list"></div>
                <div class="ent-drafts-footer">
                    <span class="ent-drafts-summary"></span>
                    <button type="button" class="ent-drafts-clear">🗑️ Delete All Offline Records</button>
                </div>
            </div>`;
        document.body.appendChild(offlineModal);

        offlineListElement = offlineModal.querySelector('.ent-drafts-list');
        offlineStatusElement = offlineModal.querySelector('.ent-drafts-status');
        offlineSearchElement = offlineModal.querySelector('.ent-drafts-search');

        // Close button
        offlineModal.querySelector('.ent-drafts-close').addEventListener('click', closeOfflineModal);
        offlineModal.addEventListener('click', (e) => { if (e.target === offlineModal) closeOfflineModal(); });

        // Search
        offlineSearchElement.addEventListener('input', (e) => {
            offlineSearchTerm = e.target.value;
            renderOfflineRecords();
        });

        // Clear all
        offlineModal.querySelector('.ent-drafts-clear').addEventListener('click', async () => {
            const confirmed = confirm('Delete ALL offline records from this device? This cannot be undone.');
            if (!confirmed) return;
            try {
                const store = window.EntOfflineStore;
                if (store && typeof store.clearAll === 'function') {
                    await store.clearAll();
                }
                renderOfflineRecords();
                setOfflineStatus('All offline records deleted.', false);
            } catch (error) {
                setOfflineStatus('Failed to delete: ' + error.message, true);
            }
        });

        // List clicks
        offlineListElement.addEventListener('click', async (e) => {
            const button = e.target.closest('button[data-record-key]');
            if (!button) return;
            const recordKey = button.dataset.recordKey;
            if (!recordKey) return;

            if (button.classList.contains('ent-drafts-open')) {
                await openOfflineRecord(recordKey);
            } else if (button.classList.contains('ent-drafts-delete')) {
                await deleteOfflineRecord(recordKey);
            }
        });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && offlineModal && offlineModal.classList.contains('is-open')) {
                closeOfflineModal();
            }
        });

        return offlineModal;
    }

    async function openOfflineRecord(recordKey) {
        const store = window.EntOfflineStore;
        if (!store || typeof store.getRecord !== 'function') {
            setOfflineStatus('Offline store not available.', true);
            return;
        }
        const record = await store.getRecord(recordKey);
        if (!record) {
            setOfflineStatus('Record not found.', true);
            return;
        }
        const bridge = window.EntFormBridge;
        if (!bridge || typeof bridge.restore !== 'function') {
            setOfflineStatus('Cannot open record on this page.', true);
            return;
        }
        // Check if same report type
        if (record.reportType !== bridge.reportType) {
            setOfflineStatus(`This is a ${record.reportType} record. Open it from the ${record.reportType} page.`, true);
            return;
        }
        const drafts = window.EntDrafts;
        try {
            bridge.restore(record.formData || record);
            if (window.PatientRecords && typeof window.PatientRecords.recordOpen === 'function') {
                window.PatientRecords.recordOpen(record.reportType, record.formData || record, { format: 'Draft', fileName: record.fileName });
            }
            closeOfflineModal();
            if (drafts && typeof drafts.showFeedbackModal === 'function') {
                await drafts.showFeedbackModal({
                    eyebrow: 'READY TO CONTINUE',
                    title: 'Record opened',
                    description: `${record.patientName || 'The saved record'} is now loaded in the form.`,
                    details: [record.reportType || 'Patient record', 'Continue editing, then save your changes.'],
                    actions: [{ label: 'Continue editing', value: true, primary: true }]
                });
            } else {
                showAlert('Record loaded. You can continue editing and save your changes.', 'SUCCESS');
            }
        } catch (error) {
            setOfflineStatus('Could not open record: ' + error.message, true);
        }
    }

    async function deleteOfflineRecord(recordKey) {
        const confirmed = confirm('Delete this offline record?');
        if (!confirmed) return;
        const store = window.EntOfflineStore;
        if (!store || typeof store.deleteRecord !== 'function') {
            setOfflineStatus('Offline store not available.', true);
            return;
        }
        try {
            await store.deleteRecord(recordKey);
            renderOfflineRecords();
            setOfflineStatus('Record deleted.', false);
        } catch (error) {
            setOfflineStatus('Failed to delete: ' + error.message, true);
        }
    }

    function renderOfflineRecords() {
        if (!offlineModal || !offlineListElement) return;
        loadOfflineRecords().then(records => {
            // OFFLINE MODE: a row that reached the database is no longer an
            // "offline record" - after the sync engine uploads it, it LEAVES
            // this list (the syncedCount below keeps the number visible so
            // nothing looks silently deleted). What stays here is what this
            // device still OWES the cloud.
            const pendingRecords = records.filter(record => record && !record.synced);
            const syncedCount = records.length - pendingRecords.length;
            // Build site filter chips
            const siteBar = offlineModal.querySelector('.ent-drafts-sites');
            if (siteBar) {
                const chips = siteChips(pendingRecords);
                const wanted = chips.length > 1;
                siteBar.hidden = !wanted;
                siteBar.innerHTML = '';
                if (wanted) {
                    chips.forEach(chip => {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'ent-drafts-site';
                        if (offlineSiteFilter === chip.value) btn.classList.add('is-active');
                        btn.textContent = chip.label + ' ' + chip.count;
                        if (chip.title) btn.title = chip.title;
                        else btn.title = chip.value ? 'Show only ' + chip.label + ' records.' : 'Show records from every hospital.';
                        btn.setAttribute('aria-pressed', String(offlineSiteFilter === chip.value));
                        btn.addEventListener('click', () => {
                            offlineSiteFilter = chip.value;
                            renderOfflineRecords();
                        });
                        siteBar.appendChild(btn);
                    });
                } else if (offlineSiteFilter) {
                    offlineSiteFilter = '';
                }
            }

            const filtered = getFilteredOfflineRecords(pendingRecords);
            offlineListElement.innerHTML = '';

            if (!filtered.length) {
                const empty = document.createElement('div');
                empty.className = 'ent-drafts-empty';
                if (!offlineSearchTerm && !pendingRecords.length && syncedCount) {
                    // Everything this device owed the cloud is already there.
                    empty.className = 'ent-drafts-empty is-all-synced';
                    empty.textContent = '\u2705 All offline records already saved to database.'
                        + ((typeof navigator === 'undefined' || navigator.onLine)
                            ? ' You have signal right now.' : '');
                } else {
                    empty.textContent = offlineSearchTerm ? 'No records match this search.' : 'No offline records saved yet.';
                }
                offlineListElement.appendChild(empty);
            } else {
                filtered.forEach(record => offlineListElement.appendChild(createOfflineCard(record)));
            }

            const summaryElement = offlineModal.querySelector('.ent-drafts-summary');
            if (summaryElement) {
                if (pendingRecords.length) {
                    summaryElement.textContent = `${filtered.length} shown · ${pendingRecords.length} waiting to sync`
                        + (syncedCount ? ` · ${syncedCount} already saved to database` : '');
                } else if (syncedCount) {
                    summaryElement.textContent = `${syncedCount} offline record${syncedCount === 1 ? '' : 's'} already saved to database`;
                } else {
                    summaryElement.textContent = 'No offline records saved yet';
                }
            }
        });
    }

    function openOfflineRecordsModal() {
        buildOfflineModal();
        offlineSearchTerm = '';
        offlineSiteFilter = '';
        offlineModal.classList.add('is-open');
        offlineModal.style.display = 'flex';
        renderOfflineRecords();
        if (offlineSearchElement) offlineSearchElement.focus();
    }

    function closeOfflineModal() {
        if (offlineModal) {
            offlineModal.classList.remove('is-open');
            offlineModal.style.display = 'none';
        }
    }

    // Redraw the moment the sync engine uploads offline records: a row
    // LEAVES this list when it reaches the cloud, and the "everything is
    // already in the database" state has to appear by itself - the doctor
    // must never have to close and reopen this window to see the truth.
    window.addEventListener('ent-offline:all-synced', function () {
        if (offlineModal && offlineModal.classList.contains('is-open')) renderOfflineRecords();
    });
    window.addEventListener('ent-offline:queue-changed', function () {
        if (offlineModal && offlineModal.classList.contains('is-open')) renderOfflineRecords();
    });

    // Bind button
    function bindOfflineRecordsButton() {
        const btn = document.getElementById('localDraftsBtn');
        if (btn && !btn.dataset.offlineBound) {
            btn.dataset.offlineBound = 'true';
            btn.addEventListener('click', openOfflineRecordsModal);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindOfflineRecordsButton, { once: true });
    } else {
        bindOfflineRecordsButton();
    }

    // Expose for other modules
    window.EntOfflineViewer = {
        open: openOfflineRecordsModal,
        close: closeOfflineModal
    };
})(window);
