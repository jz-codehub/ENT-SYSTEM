(function (window) {
    'use strict';

    var Auth = window.EntAuth;
    var Supabase = window.EntSupabase;
    if (!Auth || !Supabase) return;

    var rows = [];
    var unreadCount = 0;
    var unreadMessageCount = 0;
    var loadState = 'loading';
    var panelOpen = false;
    var userId = '';
    var channel = null;
    var host = null;
    var panelNode = null;
    var api = Supabase.apiRequest;

    function esc(value) { return Auth.escapeHtml(String(value == null ? '' : value)); }
    function byId(id) { return document.getElementById(id); }
    function getHref(row) {
        if (row && row.kind === 'announcement') return '';
        var target = String(row && row.target_url || '');
        if (/^pages\/messages\.html\?conversation=[0-9a-f-]{36}$/i.test(target)) return '#messages';
        if (target === 'pages/viewAll.html') {
            return Auth.pageUrl ? Auth.pageUrl('viewAll.html') : 'pages/viewAll.html';
        }
        if (target === 'pages/admin.html#panel-tickets') {
            return (Auth.pageUrl ? Auth.pageUrl('admin.html') : 'pages/admin.html') + '#panel-tickets';
        }
        return Auth.pageUrl ? Auth.pageUrl('reportProblem.html') : 'pages/reportProblem.html';
    }

    function kindLabel(kind) {
        var labels = {
            access_request: 'Access request',
            access_decision: 'Access update',
            chat_message: 'New message',
            ticket_new: 'Support ticket',
            ticket_message: 'Support reply',
            ticket_status: 'Ticket update',
            doctor_work_complete: 'Doctor work complete',
            announcement: 'Clinic-wide announcement'
        };
        return labels[kind] || 'Notification';
    }

    function formatCreatedAt(value) {
        var date = new Date(value);
        if (!value || !Number.isFinite(date.getTime())) return '';
        return date.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    function renderNotification(row) {
        var conversationMatch = /^pages\/messages\.html\?conversation=([0-9a-f-]{36})$/i
            .exec(String(row.target_url || ''));
        var href = getHref(row);
        var unreadClass = row.read_at ? '' : ' is-unread';
        var kindClass = ' is-' + String(row.kind || 'info').replace(/[^a-z0-9_-]/gi, '');
        var time = formatCreatedAt(row.created_at);
        var readClass = row.read_at ? 'is-read' : 'is-unread';
        var readLabel = row.read_at ? 'Read' : 'Unread';
        var content = '<span class="ent-notification-kind">' + esc(kindLabel(row.kind)) + '</span>'
            + '<strong>' + esc(row.title) + '</strong>'
            + '<span class="ent-notification-body">' + esc(row.body) + '</span>'
            + '<span class="ent-notification-meta">'
            + (time ? '<time datetime="' + esc(row.created_at) + '">' + esc(time) + '</time>' : '')
            + '<span class="ent-notification-state ' + readClass + '">' + readLabel + '</span></span>';
        var attrs = ' data-notification-id="' + esc(row.id) + '"'
            + (conversationMatch ? ' data-chat-conversation="' + esc(conversationMatch[1]) + '"' : '');

        if (href) {
            return '<a class="ent-notification-item' + kindClass + unreadClass + '" href="'
                + esc(href) + '"' + attrs + '>' + content + '</a>';
        }

        return '<article class="ent-notification-item is-static' + kindClass + unreadClass + '">'
            + content
            + (row.read_at ? '' : '<button type="button" class="ent-notification-mark-read"'
                + ' data-notification-id="' + esc(row.id) + '" aria-label="Mark '
                + esc(row.title) + ' as read">Mark as read</button>')
            + '</article>';
    }

    function notifyDashboard() {
        document.dispatchEvent(new CustomEvent('ent:notifications-updated'));
    }

    function renderMessageBadge() {
        var link = document.querySelector('.ent-messages-link[data-messages-toggle]');
        if (!link) return;
        var badge = link.querySelector('[data-message-unread-count]');
        if (unreadMessageCount > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ent-messages-unread-count';
                badge.setAttribute('data-message-unread-count', '');
                badge.setAttribute('aria-hidden', 'true');
                link.appendChild(badge);
            }
            badge.textContent = unreadMessageCount > 99 ? '99+' : String(unreadMessageCount);
            link.setAttribute('aria-label', 'Messages, ' + unreadMessageCount + ' unread');
            link.title = unreadMessageCount + ' unread messages';
        } else {
            if (badge) badge.remove();
            link.setAttribute('aria-label', 'Messages');
            link.title = 'Messages';
        }
    }

    async function load() {
        if (!userId) return;
        if (!navigator.onLine) {
            loadState = 'offline';
            render();
            return;
        }
        loadState = 'loading';
        var unreadQuery = new URLSearchParams();
        unreadQuery.set('select', 'id,kind,title,body,target_url,created_at,read_at');
        unreadQuery.set('read_at', 'is.null');
        unreadQuery.set('order', 'created_at.desc');
        unreadQuery.set('limit', '30');
        var recentQuery = new URLSearchParams();
        recentQuery.set('select', 'id,kind,title,body,target_url,created_at,read_at');
        recentQuery.set('order', 'created_at.desc');
        recentQuery.set('limit', '10');
        try {
            var result = await Promise.all([
                api('/app_notifications?' + unreadQuery.toString()),
                api('/app_notifications?' + recentQuery.toString()),
                api('/rpc/ent_unread_notification_count', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}'
                })
            ]);
            var merged = [];
            (Array.isArray(result[0]) ? result[0] : []).concat(Array.isArray(result[1]) ? result[1] : [])
                .forEach(function (row) {
                    if (!merged.some(function (existing) { return existing.id === row.id; })) merged.push(row);
                });
            rows = merged;
            unreadCount = Math.max(0, Number(result[2]) || 0);
            loadState = 'ready';
            render();
            notifyDashboard();
        } catch (error) {
            loadState = 'error';
            render();
            console.error('[Notifications] Could not load notifications.', error);
        }
    }

    async function markRead(id) {
        if (!id || !userId) return;
        await api('/rpc/ent_mark_notifications_read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_notification_id: id })
        });
        var changed = false;
        rows = rows.map(function (row) {
            if (row.id !== id) return row;
            changed = !row.read_at;
            return Object.assign({}, row, { read_at: row.read_at || new Date().toISOString() });
        });
        if (changed) unreadCount = Math.max(0, unreadCount - 1);
        render();
        notifyDashboard();
        load();
    }

    async function markAllRead() {
        await api('/rpc/ent_mark_notifications_read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_notification_id: null })
        });
        var now = new Date().toISOString();
        rows = rows.map(function (row) {
            return Object.assign({}, row, { read_at: row.read_at || now });
        });
        unreadCount = 0;
        render();
        notifyDashboard();
    }

    function renderGeneric() {
        if (!host) return;
        var unread = unreadCount;
        var items = loadState === 'loading'
            ? '<p class="ent-notification-empty">Checking for new updates…</p>'
            : loadState === 'offline'
                ? '<p class="ent-notification-empty">Connect to the internet to see your latest updates.</p>'
                : loadState === 'error'
                    ? '<p class="ent-notification-empty is-error">Your notifications could not be loaded. Check your connection and try again.</p>'
                    : rows.length
            ? rows.map(renderNotification).join('')
            : '<p class="ent-notification-empty">You’re all caught up. New updates will appear here.</p>';
        if (panelNode && panelNode.parentNode) panelNode.parentNode.removeChild(panelNode);
        host.innerHTML = '<button type="button" class="ent-notification-toggle" data-notification-toggle'
            + ' aria-label="Notifications' + (unread ? ', ' + unread + ' unread' : '') + '"'
            + ' aria-expanded="' + (panelOpen ? 'true' : 'false') + '" aria-controls="entGlobalNotificationPanel"'
            + ' title="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>'
            + (unread ? '<span class="ent-notification-count" aria-hidden="true">' + unread + '</span>' : '')
            + '</button>';
        var panelHost = document.createElement('div');
        panelHost.innerHTML = '<section class="ent-notification-panel" id="entGlobalNotificationPanel"'
            + ' aria-label="Notifications"' + (panelOpen ? '' : ' hidden') + '><div class="ent-notification-heading">'
            + '<div class="ent-notification-heading-copy"><h2>Notifications</h2>'
            + '<p>Clinic-wide news, account updates, and messages</p></div><button type="button" data-notification-read-all'
            + (unread ? '' : ' disabled') + '>Mark all as read</button></div>'
            + '<div class="ent-notification-list" aria-live="polite">' + items + '</div></section>';
        panelNode = panelHost.firstElementChild;
        document.body.appendChild(panelNode);
        positionPanel();
    }

    function positionPanel() {
        if (!panelOpen || !host || host.id !== 'entGlobalNotificationCenter') return;
        var toggle = host.querySelector('.ent-notification-toggle');
        var panel = panelNode;
        if (toggle && panel) {
            var panelWidth = Math.min(560, Math.max(0, window.innerWidth - 24));
            var toggleRect = toggle.getBoundingClientRect();
            var center = Math.max(panelWidth / 2 + 12,
                Math.min(window.innerWidth - panelWidth / 2 - 12,
                    toggleRect.left + toggleRect.width / 2));
            var top = Math.max(12, Math.round(toggleRect.bottom + 10));
            panel.style.setProperty('--ent-notification-panel-top',
                top + 'px');
            panel.style.setProperty('--ent-notification-panel-left', Math.round(center) + 'px');
            panel.style.setProperty('--ent-notification-panel-max-height',
                Math.max(120, window.innerHeight - top - 12) + 'px');
        }
    }

    function render() {
        if (host && host.id === 'entGlobalNotificationCenter') renderGeneric();
    }

    function mount() {
        var dashboardHost = byId('dashNotificationCenter');
        var headerSlot = byId('headerUserSlot');
        var parent = null;
        if (dashboardHost) {
            host = dashboardHost;
            parent = dashboardHost.parentElement;
        } else {
            if (!headerSlot || !headerSlot.parentElement) return;
            parent = headerSlot.parentElement;
            host = byId('entGlobalNotificationCenter');
            if (!host) {
                host = document.createElement('div');
                host.className = 'ent-notification-center';
                host.id = 'entGlobalNotificationCenter';
                parent.insertBefore(host, headerSlot);
            }
        }
        if (!parent.querySelector('.ent-messages-link')) {
            var link = document.createElement('button');
            link.type = 'button';
            link.className = 'ent-messages-link';
            link.setAttribute('data-messages-toggle', '');
            link.setAttribute('aria-expanded', 'false');
            link.setAttribute('aria-controls', 'entMessagesWidget');
            link.setAttribute('aria-label', 'Messages');
            link.title = 'Messages';
            link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
                + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                + '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>'
                + '<span class="ent-messages-label">Messages</span>';
            parent.insertBefore(link, host);
        }
        var messagesPage = window.EntMessagesPage;
        if (messagesPage && typeof messagesPage.getUnreadCount === 'function') {
            unreadMessageCount = Math.max(0, Number(messagesPage.getUnreadCount()) || 0);
        }
        renderMessageBadge();
    }

    function wire() {
        document.addEventListener('ent:messages-unread-updated', function (event) {
            unreadMessageCount = Math.max(0, Number(event.detail && event.detail.count) || 0);
            renderMessageBadge();
        });
        if (host) {
            host.addEventListener('click', function (event) {
                var toggle = event.target.closest('[data-notification-toggle]');
                var readAll = event.target.closest('[data-notification-read-all]');
                if (toggle) {
                    panelOpen = !panelOpen;
                    render();
                    var button = host.querySelector('[data-notification-toggle]');
                    if (button) button.focus();
                    positionPanel();
                } else if (readAll) {
                    markAllRead().catch(function (error) {
                        console.error('[Notifications] Could not mark notifications as read.', error);
                    });
                }
            });
        }
        document.addEventListener('click', function (event) {
            var readAll = event.target.closest('[data-notification-read-all]');
            if (readAll) {
                markAllRead().catch(function (error) {
                    console.error('[Notifications] Could not mark notifications as read.', error);
                });
                return;
            }
            var link = event.target.closest('[data-notification-id]');
            if (link) {
                event.preventDefault();
                var href = link.getAttribute('href');
                var conversationId = link.getAttribute('data-chat-conversation');
                markRead(link.dataset.notificationId).catch(function (error) {
                    console.error('[Notifications] Could not mark notification as read.', error);
                }).finally(function () {
                    if (conversationId) {
                        panelOpen = false;
                        render();
                        document.dispatchEvent(new CustomEvent('ent:open-messages', {
                            detail: { conversationId: conversationId }
                        }));
                    } else if (href) {
                        window.location.href = href;
                    }
                });
                return;
            }
            if (panelOpen && host) {
                var eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
                var insideHost = host.contains(event.target) || eventPath.indexOf(host) !== -1;
                var insidePanel = panelNode && (panelNode.contains(event.target) || eventPath.indexOf(panelNode) !== -1);
                if (!insideHost && !insidePanel) {
                    panelOpen = false;
                    render();
                }
            }
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && panelOpen) {
                panelOpen = false;
                render();
            }
        });
        window.addEventListener('resize', positionPanel);
        window.addEventListener('scroll', positionPanel, true);
        window.addEventListener('online', load);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) load();
        });
        window.setInterval(function () {
            if (!document.hidden) load();
        }, 60000);
    }

    async function boot() {
        var session = await Auth.guard();
        if (!session || !session.user || session.offline) return;
        userId = String(session.user.id || '');
        if (!userId) return;
        mount();
        wire();
        render();
        await load();

        var client = Supabase.getClient();
        if (client && typeof client.channel === 'function') {
            channel = client.channel('ent-notifications-' + userId)
                .on('postgres_changes', {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'app_notifications',
                    filter: 'recipient_id=eq.' + userId
                }, function () {
                    load();
                })
                .subscribe(function (status) {
                    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                        console.warn('[Notifications] Realtime updates unavailable; periodic refresh remains active.');
                    }
                });
        }
    }

    window.EntNotificationCenter = {
        getItems: function () { return rows.slice(); },
        getUnreadCount: function () { return unreadCount; },
        getHref: getHref,
        markRead: markRead
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            boot().catch(function (error) {
                console.error('[Notifications] Notification center could not start.', error);
            });
        }, { once: true });
    } else {
        boot().catch(function (error) {
            console.error('[Notifications] Notification center could not start.', error);
        });
    }
})(window);
