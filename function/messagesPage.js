(function (window) {
    'use strict';

    var Auth = window.EntAuth;
    if (!Auth || !window.EntSupabase) return;

    var me = null;
    var conversations = [];
    var unreadMessageCount = 0;
    var currentId = '';
    var currentChannel = null;
    var searchTimer = 0;
    var searchRequest = 0;
    var busy = false;
    var activeList = 'chats';
    var listQuery = '';
    var directoryRows = [];
    var messageReceipts = Object.create(null);
    var api = window.EntSupabase.apiRequest;
    var widget = null;
    var workspace = null;

    function byId(id) { return document.getElementById(id); }
    function esc(value) { return Auth.escapeHtml(String(value == null ? '' : value)); }
    function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }

    function mountWidget() {
        if (byId('entMessagesWidget')) {
            widget = byId('entMessagesWidget');
            workspace = byId('messagesWorkspace');
            return;
        }

        var host = document.createElement('div');
        host.innerHTML = '<section class="ent-messages-widget" id="entMessagesWidget" aria-label="Staff messages" hidden>'
            + '<header class="ent-messages-widget-head"><span class="ent-messages-widget-title">'
            + '<span class="ent-messages-widget-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8'
            + ' 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1'
            + ' 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg></span>'
            + '<span><strong>Messages</strong><small class="messages-connection-status" id="msgConnection">'
            + '<i aria-hidden="true"></i><span id="msgConnectionText">Connecting…</span></small></span></span>'
            + '<button type="button" class="ent-messages-widget-close" id="messagesClose" aria-label="Close messages">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
            + ' stroke-linecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg></button></header>'
            + '<p class="messages-privacy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/>'
            + '<path d="m9 12 2 2 4-4"/></svg><span>Staff coordination only · Please don’t share patient details.</span></p>'
            + '<p class="messages-notice" id="messagesNotice" role="status" hidden></p>'
            + '<section class="messages-workspace" id="messagesWorkspace" aria-label="Staff conversations">'
            + '<aside class="messages-sidebar" id="messagesSidebar"><div class="messages-sidebar-heading">'
            + '<div><h2>Chats</h2><p>Connect with your clinic team</p></div>'
            + '<button type="button" class="messages-refresh" id="messagesRefresh" title="Refresh chats"'
            + ' aria-label="Refresh chats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></svg></button></div>'
            + '<form class="messages-search" id="staffSearchForm">'
            + '<label class="sr-only" for="staffSearch">Search conversations or staff</label><div class="messages-search-field">'
            + '<input id="staffSearch" type="search" autocomplete="off" placeholder="Search conversations">'
            + '<span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></span></div>'
            + '<div class="messages-list-tabs" role="tablist" aria-label="Message lists">'
            + '<button type="button" class="messages-list-tab is-active" id="messagesChatsTab" role="tab"'
            + ' aria-selected="true" aria-controls="conversationList" data-message-tab="chats">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
            + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7'
            + ' 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8'
            + ' 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>'
            + '<span>Chats</span></button>'
            + '<button type="button" class="messages-list-tab" id="messagesPeopleTab" role="tab"'
            + ' aria-selected="false" aria-controls="staffDirectoryView" data-message-tab="people">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
            + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>'
            + '<circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'
            + '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span>People</span></button></div></form>'
            + '<div class="messages-chat-list-view" id="messagesChatListView">'
            + '<div class="messages-conversation-list" id="conversationList" aria-label="Conversation list">'
            + '<p class="messages-empty">Loading conversations…</p></div></div>'
            + '<div class="messages-directory-view" id="staffDirectoryView" hidden>'
            + '<div class="messages-directory-summary"><span><strong>Active staff</strong>'
            + '<small>Choose someone to start a private chat</small></span><span class="messages-online-count" id="onlineStaffCount"></span></div>'
            + '<div class="messages-search-results" id="staffSearchResults" role="list" aria-label="Active staff">'
            + '<span class="messages-search-hint">Loading staff…</span></div></div></aside>'
            + '<section class="messages-thread" id="messagesThread" aria-label="Conversation">'
            + '<div class="messages-thread-empty" id="threadEmpty"><div class="messages-empty-card">'
            + '<span class="messages-empty-icon" aria-hidden="true">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'
            + ' stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7'
            + ' 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6'
            + ' 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg></span>'
            + '<span class="messages-empty-eyebrow">STAFF MESSENGER</span>'
            + '<h3>Keep your team in sync</h3>'
            + '<p>Choose your clinic group or start a private chat with a teammate.</p>'
            + '<button type="button" class="messages-empty-action" id="messagesStartChat">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
            + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>'
            + '<circle cx="10" cy="7" r="4"/><path d="M20 8v6m-3-3h6"/></svg>'
            + 'Start a private chat</button>'
            + '<small class="messages-empty-note">For clinic staff coordination only</small></div></div>'
            + '<div class="messages-thread-active" id="threadActive" hidden><header class="messages-thread-head">'
            + '<button type="button" class="messages-thread-back" id="threadBack" aria-label="Back to conversations">&larr;</button>'
            + '<span class="messages-thread-avatar" id="threadAvatar" aria-hidden="true">C</span><span class="messages-thread-heading">'
            + '<strong id="threadTitle">Conversation</strong><small id="threadSubtitle"></small></span></header>'
            + '<div class="messages-thread-body" id="messageList" aria-live="polite"><p class="messages-empty">'
            + 'Select a conversation to view messages.</p></div><form class="messages-compose" id="messageForm">'
            + '<label class="sr-only" for="messageInput">Write a staff message. Press Enter to send; Shift+Enter for a new line.</label>'
            + '<textarea id="messageInput" maxlength="2000" rows="1" placeholder="Write a staff message…" required'
            + ' title="Press Enter to send; Shift+Enter for a new line"></textarea>'
            + '<button type="submit" id="messageSend" aria-label="Send message" title="Send message">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
            + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/>'
            + '<path d="M22 2 11 13"/></svg></button></form></div></section></section>'
            + '<p class="messages-widget-footer">Messages are stored online and are not available offline.</p></section>';
        document.body.appendChild(host.firstChild);
        widget = byId('entMessagesWidget');
        workspace = byId('messagesWorkspace');
    }

    function showWidget(conversationId) {
        if (!widget) return;
        widget.hidden = false;
        widget.classList.add('is-open');
        var button = document.querySelector('[data-messages-toggle]');
        if (button) button.setAttribute('aria-expanded', 'true');
        loadConversations().then(function () {
            if (conversationId && uuid(conversationId)) return openConversation(conversationId);
        }).catch(function (error) {
            console.error('[Messages] Could not refresh conversations when opening Messenger.', error);
            notice('Could not refresh messages. Check your connection and try again.', true);
        });
    }

    function hideWidget() {
        if (!widget) return;
        widget.hidden = true;
        widget.classList.remove('is-open');
        var button = document.querySelector('[data-messages-toggle]');
        if (button) {
            button.setAttribute('aria-expanded', 'false');
            button.focus();
        }
    }

    function notice(message, bad) {
        var box = byId('messagesNotice');
        if (!box) return;
        box.textContent = message || '';
        box.hidden = !message;
        box.classList.toggle('is-error', !!bad);
    }

    function setConnection(online) {
        var box = byId('msgConnection');
        var text = byId('msgConnectionText');
        if (box) box.classList.toggle('offline', !online);
        if (text) text.textContent = online ? 'Online' : 'Offline';
        var send = byId('messageSend');
        if (send) send.disabled = !online || busy || !currentId;
    }

    function initials(value) {
        return String(value || 'C').trim().split(/\s+/).slice(0, 2).map(function (part) {
            return part.charAt(0).toUpperCase();
        }).join('') || 'C';
    }

    function presenceStatus(lastSeen) {
        var timestamp = lastSeen ? new Date(lastSeen).getTime() : NaN;
        if (!isFinite(timestamp)) return { online: false, label: 'Last seen unavailable' };
        var elapsed = Math.max(0, Date.now() - timestamp);
        if (elapsed < 5 * 60 * 1000) return { online: true, label: 'Online' };
        var minutes = Math.floor(elapsed / 60000);
        if (minutes < 60) return { online: false, label: 'Offline · ' + minutes + ' ' + (minutes === 1 ? 'minute' : 'minutes') + ' ago' };
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return { online: false, label: 'Offline · ' + hours + ' ' + (hours === 1 ? 'hour' : 'hours') + ' ago' };
        var days = Math.floor(hours / 24);
        if (days < 30) return { online: false, label: 'Offline · ' + days + ' ' + (days === 1 ? 'day' : 'days') + ' ago' };
        return { online: false, label: 'Offline · ' + new Date(timestamp).toLocaleDateString() };
    }

    function apiJson(path, body) {
        return api(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
    }

    function renderConversations() {
        var list = byId('conversationList');
        if (!list) return;
        var query = String(listQuery || '').trim().toLowerCase();
        var visible = conversations.filter(function (item) {
            return !query || [item.title, item.last_message, item.peer_clinic, item.kind]
                .join(' ').toLowerCase().indexOf(query) !== -1;
        });
        if (!visible.length) {
            list.innerHTML = '<p class="messages-list-empty">'
                + (query ? 'No conversations match that search.' : 'No conversations yet. Your clinic group will appear here.')
                + '</p>';
            return;
        }
        list.innerHTML = visible.map(function (item) {
            var unread = Number(item.unread_count || 0);
            return '<button type="button" class="messages-conversation'
                + (item.conversation_id === currentId ? ' is-active' : '')
                + (unread ? ' is-unread' : '')
                + '" data-conversation-id="' + esc(item.conversation_id) + '">'
                + '<span class="messages-conversation-avatar" aria-hidden="true">'
                + esc(initials(item.title)) + '</span>'
                + '<span class="messages-conversation-copy"><span class="messages-conversation-topline">'
                + '<strong>' + esc(item.title) + '</strong>'
                + (item.last_message_at ? '<time datetime="' + esc(item.last_message_at) + '">'
                    + esc(displayTime(item.last_message_at)) + '</time>' : '')
                + '</span>'
                + '<small>' + esc(item.last_message || (item.kind === 'clinic' ? 'Clinic group chat' : item.peer_clinic || 'Direct message')) + '</small></span>'
                + (unread ? '<span class="messages-conversation-unread" aria-label="' + unread + ' unread">'
                    + (unread > 99 ? '99+' : unread) + '</span>' : '')
                + '</button>';
        }).join('');
    }

    function renderUnreadCount() {
        unreadMessageCount = conversations.reduce(function (total, item) {
            return total + Math.max(0, Number(item.unread_count) || 0);
        }, 0);
        document.dispatchEvent(new CustomEvent('ent:messages-unread-updated', {
            detail: { count: unreadMessageCount }
        }));
    }

    function unreadForStaff(userId) {
        return conversations.reduce(function (total, item) {
            if (item.kind !== 'direct' || String(item.peer_id || '') !== String(userId || '')) return total;
            return total + Math.max(0, Number(item.unread_count) || 0);
        }, 0);
    }

    async function loadConversations() {
        var rows = await apiJson('/rpc/ent_my_chat_conversations');
        conversations = Array.isArray(rows) ? rows : [];
        await apiJson('/rpc/ent_mark_chats_delivered');
        renderUnreadCount();
        renderConversations();
        if (activeList === 'people') renderStaff(directoryRows);
        return conversations;
    }

    function displayTime(iso) {
        var date = new Date(iso);
        return iso && !isNaN(date.getTime()) ? date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    }

    function messageDayLabel(iso) {
        var date = new Date(iso);
        if (!iso || isNaN(date.getTime())) return null;
        var today = new Date();
        if (date.toDateString() === today.toDateString()) return { key: date.toDateString(), label: 'Today' };
        var yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return { key: date.toDateString(), label: 'Yesterday' };
        var options = { month: 'short', day: 'numeric' };
        if (date.getFullYear() !== today.getFullYear()) options.year = 'numeric';
        return { key: date.toDateString(), label: date.toLocaleDateString([], options) };
    }

    function messageClock(iso) {
        var date = new Date(iso);
        return iso && !isNaN(date.getTime())
            ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : '';
    }

    function messageReceipt(messageId) {
        var receipt = messageReceipts[String(messageId || '')];
        if (!receipt || !receipt.recipient_count) {
            return { label: 'Sent', detail: 'Sent to the chat server' };
        }
        if (receipt.read_count > 0) {
            return {
                label: receipt.read_count >= receipt.recipient_count
                    ? 'Seen'
                    : 'Seen ' + receipt.read_count + '/' + receipt.recipient_count,
                detail: 'Seen by ' + receipt.read_count + ' of ' + receipt.recipient_count + ' recipients'
            };
        }
        if (receipt.delivered_count > 0) {
            return {
                label: receipt.delivered_count >= receipt.recipient_count
                    ? 'Delivered'
                    : 'Delivered ' + receipt.delivered_count + '/' + receipt.recipient_count,
                detail: 'Delivered to ' + receipt.delivered_count + ' of ' + receipt.recipient_count + ' recipients'
            };
        }
        return { label: 'Sent', detail: 'Sent; waiting for delivery confirmation' };
    }

    async function loadMessageReceipts(conversationId) {
        var rows = await apiJson('/rpc/ent_my_chat_message_receipts', {
            p_conversation_id: conversationId
        });
        messageReceipts = Object.create(null);
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
            messageReceipts[String(row.message_id)] = {
                delivered_count: Math.max(0, Number(row.delivered_count) || 0),
                read_count: Math.max(0, Number(row.read_count) || 0),
                recipient_count: Math.max(0, Number(row.recipient_count) || 0)
            };
        });
    }

    function renderMessages(rows) {
        var list = byId('messageList');
        if (!list) return;
        if (!rows.length) {
            list.innerHTML = '<p class="messages-empty">No messages yet. Start the conversation.</p>';
            return;
        }
        var previousDay = '';
        list.innerHTML = rows.map(function (message) {
            var own = message.sender_id === me.id;
            var day = messageDayLabel(message.created_at);
            var divider = '';
            if (day && day.key !== previousDay) {
                previousDay = day.key;
                divider = '<div class="messages-date-divider"><span>' + esc(day.label) + '</span></div>';
            }
            var receipt = own ? messageReceipt(message.id) : null;
            return divider + '<article class="messages-bubble' + (own ? ' is-mine' : '') + '">'
                + '<div class="messages-bubble-meta">'
                + (!own ? '<span class="messages-bubble-author">' + esc(message.sender_name || 'Clinic staff') + '</span>' : '')
                + '<time datetime="' + esc(message.created_at) + '">' + esc(messageClock(message.created_at)) + '</time></div>'
                + '<p>' + esc(message.body) + '</p>'
                + (receipt ? '<div class="messages-bubble-receipt" title="' + esc(receipt.detail) + '">'
                    + esc(receipt.label) + '</div>' : '')
                + '</article>';
        }).join('');
        list.scrollTop = list.scrollHeight;
    }

    async function loadMessages(conversationId) {
        if (!uuid(conversationId)) throw new Error('That conversation could not be opened.');
        var query = new URLSearchParams();
        query.set('select', 'id,sender_id,sender_name,body,created_at');
        query.set('conversation_id', 'eq.' + conversationId);
        query.set('order', 'created_at.desc');
        query.set('limit', '100');
        var rows = await api('/staff_chat_messages?' + query.toString());
        var messages = Array.isArray(rows) ? rows.slice().reverse() : [];
        await loadMessageReceipts(conversationId);
        renderMessages(messages);
        await apiJson('/rpc/ent_mark_chat_read', { p_conversation_id: conversationId });
        await loadConversations();
    }

    async function openConversation(conversationId) {
        var item = conversations.find(function (conversation) {
            return conversation.conversation_id === conversationId;
        });
        if (!item) {
            await loadConversations();
            item = conversations.find(function (conversation) {
                return conversation.conversation_id === conversationId;
            });
        }
        if (!item) {
            notice('This conversation is not available to your account.', true);
            return;
        }

        currentId = conversationId;
        renderConversations();
        byId('threadEmpty').hidden = true;
        byId('threadActive').hidden = false;
        if (workspace) workspace.classList.add('has-open-thread');
        byId('threadTitle').textContent = item.title || 'Conversation';
        byId('threadSubtitle').textContent = item.kind === 'clinic'
            ? 'Clinic group chat · active clinic staff'
            : [item.peer_role, item.peer_clinic].filter(Boolean).join(' · ');
        byId('threadAvatar').textContent = initials(item.title);
        setConnection(navigator.onLine);
        notice('');

        try {
            if (currentChannel) {
                var client = window.EntSupabase.getClient();
                if (client && client.removeChannel) await client.removeChannel(currentChannel);
                currentChannel = null;
            }
            await loadMessages(conversationId);
            var supabase = window.EntSupabase.getClient();
            if (supabase && typeof supabase.channel === 'function') {
                currentChannel = supabase.channel('staff-chat-' + conversationId)
                    .on('postgres_changes', {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'staff_chat_messages',
                        filter: 'conversation_id=eq.' + conversationId
                    }, function () {
                        loadMessages(conversationId).catch(function (error) {
                            console.warn('[Messages] Could not refresh the conversation after a realtime update.', error);
                        });
                    })
                    .subscribe(function (status) {
                        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                            console.warn('[Messages] Realtime updates are unavailable; use refresh or wait for the next check.');
                        }
                    });
            }
        } catch (error) {
            console.error('[Messages] Could not load the conversation.', error);
            notice('Could not load this conversation. Check your connection and try again.', true);
        }
    }

    function renderStaff(rows) {
        var box = byId('staffSearchResults');
        if (!box) return;
        if (!rows.length) {
            var count = byId('onlineStaffCount');
            if (count) count.textContent = '';
            box.innerHTML = '<div class="messages-list-empty">No staff match that search.</div>';
            return;
        }
        var onlineCount = rows.filter(function (staff) {
            return presenceStatus(staff.last_seen_at).online;
        }).length;
        var count = byId('onlineStaffCount');
        if (count) count.textContent = onlineCount ? onlineCount + ' online' : '';
        box.innerHTML = rows.map(function (staff) {
            var presence = presenceStatus(staff.last_seen_at);
            var unread = unreadForStaff(staff.user_id);
            return '<button type="button" class="messages-staff-result"'
                + ' data-staff-id="' + esc(staff.user_id) + '">'
                + '<span class="messages-staff-avatar-wrap"><span class="messages-staff-avatar" aria-hidden="true">'
                + esc(initials(staff.full_name)) + '</span><i class="messages-avatar-presence '
                + (presence.online ? 'is-online' : '') + '" aria-hidden="true"></i></span>'
                + '<span class="messages-staff-copy"><span class="messages-staff-name"><strong>'
                + esc(staff.full_name || 'Clinic staff') + '</strong>'
                + (unread ? '<span class="messages-staff-unread" aria-label="' + unread + ' unread messages">'
                    + (unread > 99 ? '99+' : unread) + '</span>' : '')
                + '</span>'
                + '<small>' + esc([staff.role_name, staff.clinic_name].filter(Boolean).join(' · ')) + '</small>'
                + '<span class="messages-staff-presence ' + (presence.online ? 'is-online' : 'is-offline') + '">'
                + '<i aria-hidden="true"></i>' + esc(presence.label) + '</span></span>'
                + '<span class="messages-staff-action" aria-label="Start private chat">'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
                + ' stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8'
                + ' 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8'
                + ' 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg></span>'
                + '</button>';
        }).join('');
    }

    async function searchStaff(query, quiet) {
        var box = byId('staffSearchResults');
        var requestId = ++searchRequest;
        if (!quiet && box) box.innerHTML = '<span class="messages-search-hint">'
            + (query.trim() ? 'Searching staff…' : 'Loading active staff…') + '</span>';
        try {
            var rows = await apiJson('/rpc/ent_chat_staff_directory', { p_query: query.trim() || null });
            if (requestId !== searchRequest) return;
            directoryRows = Array.isArray(rows) ? rows : [];
            renderStaff(directoryRows);
        } catch (error) {
            if (requestId !== searchRequest) return;
            console.error('[Messages] Staff search failed.', error);
            if (box) box.innerHTML = '<span class="messages-search-hint is-error">Could not search staff. Try again.</span>';
        }
    }

    function setActiveList(listName) {
        activeList = listName === 'people' ? 'people' : 'chats';
        var people = activeList === 'people';
        byId('messagesChatListView').hidden = people;
        byId('staffDirectoryView').hidden = !people;
        byId('messagesChatsTab').classList.toggle('is-active', !people);
        byId('messagesPeopleTab').classList.toggle('is-active', people);
        byId('messagesChatsTab').setAttribute('aria-selected', people ? 'false' : 'true');
        byId('messagesPeopleTab').setAttribute('aria-selected', people ? 'true' : 'false');
        byId('staffSearch').placeholder = people ? 'Find a person by name' : 'Search conversations';
        byId('staffSearch').value = '';
        listQuery = '';
        renderConversations();
        if (people) {
            searchStaff('').catch(function (error) {
                console.error('[Messages] Staff directory could not load.', error);
                notice('Could not load active staff. Try again.', true);
            });
        }
    }

    async function startDirectMessage(userId) {
        if (!uuid(userId)) return;
        notice('');
        try {
            var result = await apiJson('/rpc/ent_get_or_create_direct_chat', { p_other_user: userId });
            var conversationId = typeof result === 'string'
                ? result
                : (Array.isArray(result) ? result[0] : '');
            if (!uuid(conversationId)) throw new Error('The server did not return a valid conversation.');
            await loadConversations();
            await openConversation(conversationId);
            renderStaff(directoryRows);
        } catch (error) {
            console.error('[Messages] Could not start a direct conversation.', error);
            notice('Could not start that direct message. The staff account may no longer be active.', true);
        }
    }

    async function sendMessage(event) {
        event.preventDefault();
        if (busy || !currentId || !navigator.onLine) {
            if (!navigator.onLine) notice('Reconnect to send a message.', true);
            return;
        }
        var input = byId('messageInput');
        var body = String(input && input.value || '').trim();
        if (!body) return;
        busy = true;
        setConnection(navigator.onLine);
        var sent = false;
        try {
            await api('/staff_chat_messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify([{ conversation_id: currentId, body: body }])
            });
            sent = true;
            input.value = '';
            await loadMessages(currentId);
            notice('');
        } catch (error) {
            if (sent) {
                console.error('[Messages] Message was sent, but the conversation could not refresh.', error);
                notice('Message sent, but its chat status could not refresh. Reopen the conversation to check.', true);
            } else {
                console.error('[Messages] Message send failed.', error);
                notice('Your message was not sent. Check the connection and try again.', true);
            }
        } finally {
            busy = false;
            setConnection(navigator.onLine);
        }
    }

    function wire() {
        document.addEventListener('ent:open-messages', function (event) {
            showWidget(event.detail && event.detail.conversationId);
        });
        document.addEventListener('ent:notifications-updated', function () {
            loadConversations().catch(function (error) {
                console.warn('[Messages] Could not refresh unread counts after notifications changed.', error);
            });
        });
        document.addEventListener('click', function (event) {
            var toggle = event.target.closest('[data-messages-toggle]');
            if (toggle) {
                event.preventDefault();
                if (widget.hidden) showWidget();
                else hideWidget();
            }
        });
        byId('messagesClose').addEventListener('click', hideWidget);
        byId('messagesStartChat').addEventListener('click', function () {
            setActiveList('people');
            byId('staffSearch').focus();
        });
        byId('messagesSidebar').addEventListener('click', function (event) {
            var tab = event.target.closest('[data-message-tab]');
            if (tab) setActiveList(tab.dataset.messageTab);
        });
        var search = byId('staffSearch');
        byId('staffSearchForm').addEventListener('submit', function (event) {
            event.preventDefault();
            window.clearTimeout(searchTimer);
            if (activeList === 'people') {
                searchStaff(search.value).catch(function (error) {
                    console.error('[Messages] Staff search failed.', error);
                    notice('Could not search staff. Try again.', true);
                });
            } else {
                listQuery = search.value;
                renderConversations();
            }
        });
        search.addEventListener('input', function () {
            window.clearTimeout(searchTimer);
            var query = search.value;
            searchTimer = window.setTimeout(function () {
                if (activeList === 'people') searchStaff(query);
                else {
                    listQuery = query;
                    renderConversations();
                }
            }, 200);
        });
        byId('staffSearchResults').addEventListener('click', function (event) {
            var button = event.target.closest('[data-staff-id]');
            if (button) startDirectMessage(button.dataset.staffId);
        });
        byId('conversationList').addEventListener('click', function (event) {
            var button = event.target.closest('[data-conversation-id]');
            if (button) openConversation(button.dataset.conversationId);
        });
        byId('messageForm').addEventListener('submit', sendMessage);
        byId('messageInput').addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            var form = byId('messageForm');
            if (typeof form.requestSubmit === 'function') {
                form.requestSubmit();
            } else {
                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
        });
        byId('messagesRefresh').addEventListener('click', function () {
            loadConversations().then(function () {
                var work = currentId ? loadMessages(currentId) : Promise.resolve();
                if (activeList === 'people') {
                    return work.then(function () { return searchStaff(byId('staffSearch').value); });
                }
                return work;
            }).catch(function (error) {
                console.error('[Messages] Refresh failed.', error);
                notice('Could not refresh messages. Try again.', true);
            });
        });
        byId('threadBack').addEventListener('click', function () {
            if (workspace) workspace.classList.remove('has-open-thread');
            currentId = '';
            byId('threadActive').hidden = true;
            byId('threadEmpty').hidden = false;
            if (activeList === 'people') {
                byId('staffSearch').focus();
                renderStaff(directoryRows);
            } else renderConversations();
        });
        widget.addEventListener('click', function (event) {
            if (event.target === widget) hideWidget();
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && widget && !widget.hidden) hideWidget();
        });
        window.addEventListener('online', function () { setConnection(true); });
        window.addEventListener('offline', function () { setConnection(false); });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
                loadConversations().catch(function (error) {
                    console.warn('[Messages] Could not refresh conversations after returning to the app.', error);
                });
                if (currentId) {
                    loadMessages(currentId).catch(function (error) {
                        console.warn('[Messages] Background refresh failed.', error);
                    });
                }
                if (widget && !widget.hidden && activeList === 'people') {
                    searchStaff(byId('staffSearch').value, true).catch(function (error) {
                        console.warn('[Messages] Presence refresh failed.', error);
                    });
                }
            }
        });
        window.setInterval(function () {
            if (!document.hidden && navigator.onLine) {
                loadConversations().catch(function (error) {
                    console.warn('[Messages] Periodic conversation refresh failed.', error);
                });
                if (widget && !widget.hidden && currentId) {
                    loadMessages(currentId).catch(function (error) {
                        console.warn('[Messages] Periodic refresh failed.', error);
                    });
                }
                if (widget && !widget.hidden && activeList === 'people') {
                    searchStaff(byId('staffSearch').value, true).catch(function (error) {
                        console.warn('[Messages] Presence refresh failed.', error);
                    });
                }
            }
        }, 60000);
    }

    async function boot() {
        mountWidget();
        var session = await Auth.guard();
        if (!session || !session.user) return;
        me = session.user;
        wire();
        setConnection(navigator.onLine);
        try {
            await loadConversations();
            await searchStaff('');
            setActiveList('chats');
        } catch (error) {
            console.error('[Messages] Could not load conversations.', error);
            notice('Could not load conversations. Check your connection and try again.', true);
            byId('conversationList').innerHTML = '<p class="messages-empty is-error">Could not load conversations.</p>';
        }
    }

    window.EntMessagesPage = {
        getUnreadCount: function () { return unreadMessageCount; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            boot().catch(function (error) {
                console.error('[Messages] Page startup failed.', error);
                notice('Messages could not start. Reload the page and try again.', true);
            });
        }, { once: true });
    } else {
        boot().catch(function (error) {
            console.error('[Messages] Page startup failed.', error);
            notice('Messages could not start. Reload the page and try again.', true);
        });
    }
})(window);
