/* ══════════════════════════════════════════════════════════════
   ClassicChat — Frontend Application (TypeScript)
══════════════════════════════════════════════════════════════ */
// ─── State ────────────────────────────────────────────────────
const API = '';
let currentUser = null;
let token = null;
let socket = null;
let currentRoom = null;
let currentDMId = null;
const myRooms = new Map();
const contacts = new Map();
let msgHasMore = false;
let msgLoading = false;
let msgBefore = null;
let pendingUpload = null;
let replyTo = null;
let editMsgId = null;
let typingTimer = null;
let isTyping = false;
const typingMap = new Map();
// ─── Helpers (defined first — used everywhere below) ──────────
function el(id) {
    const found = document.getElementById(id);
    if (!found)
        throw new Error(`Element #${id} not found`);
    return found;
}
function qsa(sel) {
    return document.querySelectorAll(sel);
}
function esc(str) {
    if (str == null)
        return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function truncate(str, len) {
    if (!str)
        return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
}
function formatTime(iso) {
    if (!iso)
        return '';
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) {
        return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return (d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
}
function formatFileSize(bytes) {
    if (!bytes)
        return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}
function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
}
function debounce(fn, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}
function showToast(msg, type = 'info') {
    const container = el('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity .3s';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}
async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token)
        headers['Authorization'] = 'Bearer ' + token;
    const opts = { method, headers };
    if (body)
        opts.body = JSON.stringify(body);
    const resp = await fetch(API + path, opts);
    const data = (await resp.json());
    if (!resp.ok)
        throw new Error(data.error ?? resp.statusText);
    return data;
}
// ─── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initAuthUI();
    initAppUI();
    autoLogin();
    trackActivity();
});
// ─── Auth UI ──────────────────────────────────────────────────
function initAuthUI() {
    qsa('.auth-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            qsa('.auth-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            el('login-form').classList.toggle('hidden', tab !== 'login');
            el('register-form').classList.toggle('hidden', tab !== 'register');
            el('login-error').textContent = '';
            el('register-error').textContent = '';
        });
    });
    el('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = el('login-email').value.trim();
        const password = el('login-password').value;
        el('login-error').textContent = '';
        const btn = e.target.querySelector('[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Signing in…';
        try {
            const data = await api('POST', '/api/auth/login', { email, password });
            doLogin(data.token, data.user);
        }
        catch (err) {
            el('login-error').textContent = err.message || 'Sign in failed';
        }
        finally {
            btn.disabled = false;
            btn.textContent = 'Sign In';
        }
    });
    el('reg-username').addEventListener('input', debounce(async (e) => {
        const hint = el('reg-username-hint');
        const val = e.target.value.trim();
        if (!val) {
            hint.textContent = '';
            hint.className = 'form-hint';
            return;
        }
        if (val.length < 3) {
            hint.textContent = 'Too short (min 3 chars)';
            hint.className = 'form-hint error';
            return;
        }
        if (!/^[a-zA-Z0-9_]+$/.test(val)) {
            hint.textContent = 'Letters, digits and _ only';
            hint.className = 'form-hint error';
            return;
        }
        try {
            const data = (await fetch('/api/auth/check-username/' + encodeURIComponent(val)).then(r => r.json()));
            if (data.available === true) {
                hint.textContent = '✓ Username available';
                hint.className = 'form-hint success';
            }
            else if (data.available === false) {
                hint.textContent = 'Username already taken';
                hint.className = 'form-hint error';
            }
            else {
                hint.textContent = '';
                hint.className = 'form-hint';
            }
        }
        catch {
            hint.textContent = '';
            hint.className = 'form-hint';
        }
    }, 500));
    const checkConfirm = () => {
        const hint = el('reg-confirm-hint');
        const pw = el('reg-password').value;
        const conf = el('reg-password-confirm').value;
        if (!conf) {
            hint.textContent = '';
            hint.className = 'form-hint';
            return;
        }
        if (pw !== conf) {
            hint.textContent = 'Passwords do not match';
            hint.className = 'form-hint error';
        }
        else {
            hint.textContent = '✓ Passwords match';
            hint.className = 'form-hint success';
        }
    };
    el('reg-password').addEventListener('input', checkConfirm);
    el('reg-password-confirm').addEventListener('input', checkConfirm);
    el('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = el('reg-email').value.trim();
        const username = el('reg-username').value.trim();
        const password = el('reg-password').value;
        const confirm = el('reg-password-confirm').value;
        el('register-error').textContent = '';
        if (password.length < 8) {
            el('register-error').textContent = 'Password must be at least 8 characters';
            return;
        }
        if (password !== confirm) {
            el('register-error').textContent = 'Passwords do not match';
            return;
        }
        const btn = e.target.querySelector('[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Creating account…';
        try {
            await api('POST', '/api/auth/register', { email, username, password });
            const data = await api('POST', '/api/auth/login', { email, password });
            doLogin(data.token, data.user);
        }
        catch (err) {
            el('register-error').textContent = err.message || 'Registration failed';
        }
        finally {
            btn.disabled = false;
            btn.textContent = 'Create Account';
        }
    });
}
async function autoLogin() {
    const savedToken = localStorage.getItem('token');
    if (!savedToken)
        return;
    try {
        token = savedToken;
        const data = await api('GET', '/api/auth/me');
        doLogin(savedToken, data.user);
    }
    catch {
        localStorage.removeItem('token');
    }
}
function doLogin(t, user) {
    token = t;
    currentUser = user;
    localStorage.setItem('token', t);
    showApp();
}
function showApp() {
    el('auth-screen').classList.add('hidden');
    el('app-screen').classList.remove('hidden');
    const myAv = el('my-avatar');
    myAv.className = 'avatar avatar-sm';
    myAv.style.background = currentUser.avatar_color ?? '#6366f1';
    myAv.textContent = currentUser.username[0].toUpperCase();
    el('my-username').textContent = currentUser.username;
    connectSocket();
    loadMyRooms();
    loadContacts();
}
// ─── App UI Bindings ──────────────────────────────────────────
function initAppUI() {
    el('btn-welcome-browse').addEventListener('click', () => openModal('modal-rooms'));
    el('btn-welcome-friends').addEventListener('click', () => openModal('modal-add-contact'));
    el('btn-browse-rooms').addEventListener('click', () => openModal('modal-rooms'));
    el('btn-add-contact').addEventListener('click', () => openModal('modal-add-contact'));
    el('btn-settings').addEventListener('click', () => { openModal('modal-settings'); loadSessions(); });
    el('btn-toggle-members').addEventListener('click', toggleMembersPanel);
    el('btn-room-settings').addEventListener('click', openRoomSettings);
    el('btn-invite-member').addEventListener('click', () => openModal('modal-invite'));
    el('load-more-btn').addEventListener('click', loadMoreMessages);
    el('btn-cancel-reply').addEventListener('click', clearReply);
    // Moved from module scope — must run after DOMContentLoaded
    el('btn-view-requests').addEventListener('click', () => { loadPendingRequests(); openModal('modal-requests'); });
    const textarea = el('message-input');
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
        handleTyping();
    });
    textarea.addEventListener('input', () => autoResize(textarea));
    el('btn-send').addEventListener('click', sendMessage);
    el('btn-upload').addEventListener('click', () => el('file-input').click());
    el('file-input').addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file)
            uploadFile(file);
        e.target.value = '';
    });
    el('btn-cancel-upload').addEventListener('click', cancelUpload);
    el('messages-area').addEventListener('dragover', (e) => { e.preventDefault(); });
    el('messages-area').addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files[0];
        if (file)
            uploadFile(file);
    });
    document.addEventListener('paste', (e) => {
        if (!currentRoom && !currentDMId)
            return;
        const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'));
        if (item) {
            const file = item.getAsFile();
            if (file)
                uploadFile(file);
        }
    });
    initEmojiPicker();
    document.addEventListener('click', (e) => {
        const target = e.target;
        const tab = target.closest('.modal-tab');
        if (tab) {
            tab.closest('.modal').querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            if (tabName === 'browse') {
                document.getElementById('rooms-browse-tab')?.classList.remove('hidden');
                document.getElementById('rooms-create-tab')?.classList.add('hidden');
            }
            if (tabName === 'create') {
                document.getElementById('rooms-browse-tab')?.classList.add('hidden');
                document.getElementById('rooms-create-tab')?.classList.remove('hidden');
            }
            if (tabName === 'edit') {
                document.getElementById('room-edit-tab')?.classList.remove('hidden');
                document.getElementById('room-admins-tab')?.classList.add('hidden');
                document.getElementById('room-bans-tab')?.classList.add('hidden');
            }
            if (tabName === 'admins') {
                document.getElementById('room-edit-tab')?.classList.add('hidden');
                document.getElementById('room-admins-tab')?.classList.remove('hidden');
                document.getElementById('room-bans-tab')?.classList.add('hidden');
                loadRoomAdmins();
                loadAddableMembers();
            }
            if (tabName === 'bans') {
                document.getElementById('room-edit-tab')?.classList.add('hidden');
                document.getElementById('room-admins-tab')?.classList.add('hidden');
                document.getElementById('room-bans-tab')?.classList.remove('hidden');
                loadRoomBans();
            }
        }
        if (target.classList.contains('modal-overlay'))
            closeModalEl(target);
        const closer = target.closest('.modal-close');
        if (closer?.dataset.modal)
            closeModal(closer.dataset.modal);
        if (!target.closest('.context-menu'))
            hideContextMenu();
    });
    el('room-search').addEventListener('input', debounce((e) => loadPublicRooms(e.target.value), 300));
    el('btn-browse-rooms').addEventListener('click', () => {
        document.getElementById('rooms-browse-tab')?.classList.remove('hidden');
        document.getElementById('rooms-create-tab')?.classList.add('hidden');
        qsa('.modal-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
        loadPublicRooms('');
    });
    el('create-room-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = el('room-name').value.trim();
        const description = el('room-description').value.trim();
        const visibility = el('room-visibility').value;
        el('create-room-error').textContent = '';
        try {
            const data = await api('POST', '/api/rooms', { name, description, visibility });
            showToast('Room created!', 'success');
            closeModal('modal-rooms');
            await loadMyRooms();
            selectRoom(data.room.id);
        }
        catch (err) {
            el('create-room-error').textContent = err.message;
        }
    });
    el('add-contact-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = el('contact-username').value.trim();
        const message = el('contact-message').value.trim();
        el('add-contact-error').textContent = '';
        try {
            await api('POST', '/api/contacts/request', { username, message });
            showToast('Friend request sent!', 'success');
            closeModal('modal-add-contact');
            el('contact-username').value = '';
            el('contact-message').value = '';
        }
        catch (err) {
            el('add-contact-error').textContent = err.message;
        }
    });
    el('change-password-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = el('current-password').value;
        const newPassword = el('new-password').value;
        el('change-password-error').textContent = '';
        el('change-password-success').textContent = '';
        try {
            await api('PUT', '/api/auth/password', { currentPassword, newPassword });
            el('change-password-success').textContent = 'Password updated!';
            el('current-password').value = '';
            el('new-password').value = '';
        }
        catch (err) {
            el('change-password-error').textContent = err.message;
        }
    });
    el('btn-logout').addEventListener('click', async () => {
        try {
            await api('POST', '/api/auth/logout');
        }
        catch { /* ignore */ }
        doLogout();
    });
    el('btn-delete-account').addEventListener('click', () => { closeModal('modal-settings'); openModal('modal-delete-account'); });
    el('delete-account-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = el('delete-account-password').value;
        el('delete-account-error').textContent = '';
        try {
            await api('DELETE', '/api/auth/account', { password });
            doLogout();
        }
        catch (err) {
            el('delete-account-error').textContent = err.message;
        }
    });
    el('edit-message-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const content = el('edit-message-content').value.trim();
        if (!content || !editMsgId)
            return;
        try {
            const path = currentDMId !== null ? '/api/personal-messages/' + editMsgId : '/api/messages/' + editMsgId;
            await api('PUT', path, { content });
            closeModal('modal-edit-message');
            editMsgId = null;
        }
        catch (err) {
            showToast(err.message, 'error');
        }
    });
    el('btn-delete-room').addEventListener('click', async () => {
        if (!currentRoom)
            return;
        if (!confirm('Delete this room permanently? All messages will be lost.'))
            return;
        try {
            await api('DELETE', '/api/rooms/' + currentRoom.id);
            closeModal('modal-room-settings');
        }
        catch (err) {
            el('edit-room-error').textContent = err.message;
        }
    });
    // Leave room — shown in chat header for non-owners
    document.addEventListener('click', async (e) => {
        if (e.target.id === 'btn-leave-room') {
            if (!currentRoom)
                return;
            if (!confirm('Leave this room?'))
                return;
            try {
                await api('POST', '/api/rooms/' + currentRoom.id + '/leave');
                myRooms.delete(currentRoom.id);
                leaveCurrentView();
                showToast('Left the room', 'info');
            }
            catch (err) {
                showToast(err.message, 'error');
            }
        }
    });
    el('edit-room-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentRoom)
            return;
        const name = el('edit-room-name').value.trim();
        const description = el('edit-room-description').value.trim();
        el('edit-room-error').textContent = '';
        try {
            await api('PUT', '/api/rooms/' + currentRoom.id, { name, description });
            showToast('Room updated', 'success');
            closeModal('modal-room-settings');
        }
        catch (err) {
            el('edit-room-error').textContent = err.message;
        }
    });
    el('invite-search').addEventListener('input', debounce(searchUsersForInvite, 300));
    el('btn-refresh-sessions').addEventListener('click', loadSessions);
}
// ─── Socket ───────────────────────────────────────────────────
function connectSocket() {
    socket = io();
    socket.on('connect', () => socket.emit('authenticate', token));
    socket.on('message', (msg) => {
        if (!currentRoom || currentRoom.id !== msg.room_id) {
            const room = myRooms.get(msg.room_id);
            if (room) {
                room.unread_count = (room.unread_count ?? 0) + 1;
                renderRoomsList();
            }
            return;
        }
        appendMessages([msg]);
        scrollToBottom();
    });
    socket.on('personal_message', (msg) => {
        const otherId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;
        if (currentDMId !== otherId) {
            const c = contacts.get(otherId);
            if (c) {
                c.unread_count = (c.unread_count ?? 0) + 1;
                renderContactsList();
            }
            return;
        }
        appendMessages([msg]);
        scrollToBottom();
    });
    socket.on('message_edited', (msg) => {
        const elem = document.querySelector(`[data-msg-id="${msg.id}"]`);
        if (elem)
            updateMessageEl(elem, msg);
    });
    socket.on('message_deleted', ({ id }) => {
        const elem = document.querySelector(`[data-msg-id="${id}"]`);
        if (elem) {
            const contentEl = elem.querySelector('.msg-content');
            if (contentEl) {
                contentEl.textContent = '(message deleted)';
                contentEl.classList.add('deleted');
            }
            elem.querySelector('.msg-actions')?.remove();
        }
    });
    socket.on('personal_message_edited', (msg) => {
        const elem = document.querySelector(`[data-msg-id="${msg.id}"]`);
        if (elem)
            updateMessageEl(elem, msg);
    });
    socket.on('personal_message_deleted', ({ id }) => {
        const elem = document.querySelector(`[data-msg-id="${id}"]`);
        if (elem) {
            const contentEl = elem.querySelector('.msg-content');
            if (contentEl) {
                contentEl.textContent = '(message deleted)';
                contentEl.classList.add('deleted');
            }
            elem.querySelector('.msg-actions')?.remove();
        }
    });
    socket.on('typing', ({ userId, roomId }) => {
        if (roomId && (!currentRoom || currentRoom.id !== roomId))
            return;
        if (!roomId && currentDMId !== userId)
            return;
        clearTimeout(typingMap.get(userId));
        typingMap.set(userId, setTimeout(() => { typingMap.delete(userId); updateTypingIndicator(); }, 3000));
        updateTypingIndicator();
    });
    socket.on('stop_typing', ({ userId }) => {
        clearTimeout(typingMap.get(userId));
        typingMap.delete(userId);
        updateTypingIndicator();
    });
    socket.on('member_joined', ({ username }) => {
        if (!currentRoom)
            return;
        showToast(username + ' joined the room', 'info');
        loadMembers(currentRoom.id);
    });
    socket.on('member_left', () => { if (currentRoom)
        loadMembers(currentRoom.id); });
    socket.on('member_banned', ({ userId }) => {
        if (!currentRoom)
            return;
        if (userId === currentUser.id) {
            showToast('You were banned from this room', 'error');
            leaveCurrentView();
        }
        else
            loadMembers(currentRoom.id);
    });
    socket.on('room_banned', ({ roomId }) => {
        showToast('You have been banned from a room', 'error');
        myRooms.delete(roomId);
        renderRoomsList();
        if (currentRoom?.id === roomId)
            leaveCurrentView();
    });
    socket.on('room_kicked', ({ roomId }) => {
        showToast('You were removed from a room', 'error');
        myRooms.delete(roomId);
        renderRoomsList();
        if (currentRoom?.id === roomId)
            leaveCurrentView();
    });
    socket.on('room_updated', (room) => {
        if (myRooms.has(room.id)) {
            Object.assign(myRooms.get(room.id), room);
            renderRoomsList();
        }
        if (currentRoom?.id === room.id) {
            currentRoom.name = room.name;
            el('chat-header-name').textContent = '# ' + room.name;
        }
    });
    socket.on('room_deleted', ({ id }) => {
        myRooms.delete(id);
        renderRoomsList();
        if (currentRoom?.id === id) {
            showToast('This room was deleted', 'error');
            leaveCurrentView();
        }
    });
    socket.on('friend_request', ({ username }) => {
        showToast(username + ' sent you a friend request', 'info');
        loadContacts();
    });
    socket.on('contact_accepted', ({ username }) => {
        showToast(username + ' accepted your friend request!', 'success');
        loadContacts();
    });
    socket.on('room_invitation', ({ roomName, invitedBy }) => {
        showToast(invitedBy + ' invited you to "' + roomName + '"', 'info');
        loadMyRooms();
    });
    socket.on('presence_update', ({ userId, status }) => {
        document.querySelectorAll(`[data-presence="${userId}"]`).forEach(dot => { dot.className = 'presence-dot ' + status; });
        document.querySelector(`[data-dm-user="${userId}"] .presence-dot`)?.setAttribute('class', 'presence-dot ' + status);
    });
    socket.on('error', ({ message }) => showToast(message, 'error'));
}
// ─── Load Data ────────────────────────────────────────────────
async function loadMyRooms() {
    try {
        const data = await api('GET', '/api/my-rooms');
        myRooms.clear();
        data.rooms?.forEach(r => myRooms.set(r.id, r));
        renderRoomsList();
    }
    catch { /* silent */ }
}
async function loadContacts() {
    try {
        const data = await api('GET', '/api/contacts');
        contacts.clear();
        let pendingCount = 0;
        data.contacts?.forEach(c => {
            contacts.set(c.user_id, c);
            if (c.status === 'pending' && c.direction === 'incoming')
                pendingCount++;
        });
        renderContactsList();
        const banner = el('pending-requests-banner');
        if (pendingCount > 0) {
            banner.classList.remove('hidden');
            el('pending-requests-count').textContent = String(pendingCount);
        }
        else
            banner.classList.add('hidden');
    }
    catch { /* silent */ }
}
// ─── Render Sidebar ───────────────────────────────────────────
function renderRoomsList() {
    const list = el('rooms-list');
    list.innerHTML = '';
    const isInRoom = !!currentRoom;
    myRooms.forEach(room => {
        const item = document.createElement('div');
        const unread = Number(room.unread_count) || 0;
        const isActive = currentRoom?.id === room.id;
        item.className = 'nav-item' + (isActive ? ' active' : '');
        item.dataset.roomId = String(room.id);
        item.innerHTML = `
      <span class="nav-item-icon">#</span>
      <span class="nav-item-name">${esc(room.name)}</span>
      ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
    `;
        item.addEventListener('click', () => selectRoom(room.id));
        list.appendChild(item);
    });
    // Apply accordion style when inside a room - collapse other rooms
    if (isInRoom) {
        list.classList.add('rooms-list-collapsed');
        const activeItem = list.querySelector('.nav-item.active');
        if (activeItem) {
            activeItem.classList.add('accordion-expanded');
        }
    }
    else {
        list.classList.remove('rooms-list-collapsed');
    }
    if (!myRooms.size)
        list.innerHTML = '<div class="empty-state">No rooms yet</div>';
}
function renderContactsList() {
    const list = el('contacts-list');
    list.innerHTML = '';
    const accepted = [...contacts.values()].filter(c => c.status === 'accepted');
    accepted.forEach(c => {
        const item = document.createElement('div');
        const unread = Number(c.unread_count) || 0;
        const status = c.online_status ?? 'offline';
        item.className = 'nav-item' + (currentDMId === c.user_id ? ' active' : '');
        item.dataset.dmUser = String(c.user_id);
        item.innerHTML = `
      <span class="presence-dot ${status}" data-presence="${c.user_id}"></span>
      <span class="nav-item-name">${esc(c.username)}</span>
      ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
    `;
        item.addEventListener('click', () => selectDM(c.user_id, c.username, c.avatar_color));
        list.appendChild(item);
    });
    if (!accepted.length)
        list.innerHTML = '<div class="empty-state">No friends yet</div>';
}
// ─── Navigation ───────────────────────────────────────────────
async function selectRoom(roomId) {
    if (currentRoom?.id === roomId)
        return;
    currentRoom = null;
    currentDMId = null;
    replyTo = null;
    pendingUpload = null;
    clearReplyUI();
    clearUploadPreviewUI();
    try {
        const data = await api('GET', '/api/rooms/' + roomId);
        if (!data.room)
            return;
        currentRoom = { id: roomId, name: data.room.name, role: data.room.user_role ?? '', visibility: data.room.visibility, ownerId: data.room.owner_id };
        socket.emit('join_room', roomId);
        el('welcome-panel').classList.add('hidden');
        el('chat-panel').classList.remove('hidden');
        el('btn-room-settings').style.display = currentRoom.role === 'admin' ? '' : 'none';
        el('chat-header-icon').innerHTML = '<span style="font-size:1.2rem;color:var(--text-muted)">#</span>';
        el('chat-header-name').textContent = '# ' + data.room.name;
        const memberCount = data.members?.length ?? 'N/A';
        el('chat-header-sub').textContent = memberCount + ' member' + (memberCount !== 1 ? 's' : '');
        // Show Leave button for non-owners
        const leaveBtn = document.getElementById('btn-leave-room');
        if (leaveBtn)
            leaveBtn.style.display = data.room.owner_id === currentUser.id ? 'none' : '';
        el('btn-toggle-members').style.display = '';
        renderMembers(data.members ?? []);
        const room = myRooms.get(roomId);
        if (room)
            room.unread_count = 0;
        renderRoomsList();
        msgBefore = null;
        msgHasMore = false;
        el('messages-container').innerHTML = '';
        await loadMessages();
    }
    catch (err) {
        showToast(err.message || 'Failed to open room', 'error');
    }
}
async function selectDM(userId, username, avatarColor) {
    if (currentDMId === userId)
        return;
    currentRoom = null;
    currentDMId = userId;
    replyTo = null;
    pendingUpload = null;
    clearReplyUI();
    clearUploadPreviewUI();
    const contact = contacts.get(userId);
    const uname = username ?? contact?.username ?? 'User';
    const color = avatarColor ?? contact?.avatar_color ?? '#6366f1';
    if (contact) {
        contact.unread_count = 0;
        renderContactsList();
    }
    el('welcome-panel').classList.add('hidden');
    el('chat-panel').classList.remove('hidden');
    el('btn-room-settings').style.display = 'none';
    el('btn-toggle-members').style.display = 'none';
    el('members-panel').classList.add('hidden');
    const av = document.createElement('div');
    av.className = 'avatar avatar-sm';
    av.style.background = color;
    av.textContent = uname[0].toUpperCase();
    const headerIcon = el('chat-header-icon');
    headerIcon.innerHTML = '';
    headerIcon.appendChild(av);
    el('chat-header-name').textContent = uname;
    const status = getPresenceStatus(userId);
    el('chat-header-sub').innerHTML = `<span class="presence-dot ${status}" style="display:inline-block;margin-right:5px" data-presence="${userId}"></span>${status}`;
    renderContactsList();
    msgBefore = null;
    msgHasMore = false;
    el('messages-container').innerHTML = '';
    await loadMessages();
}
function leaveCurrentView() {
    currentRoom = null;
    currentDMId = null;
    el('chat-panel').classList.add('hidden');
    el('welcome-panel').classList.remove('hidden');
    renderRoomsList();
    renderContactsList();
}
// ─── Members ──────────────────────────────────────────────────
async function loadMembers(roomId) {
    try {
        const data = await api('GET', '/api/rooms/' + roomId);
        renderMembers(data.members ?? []);
    }
    catch { /* silent */ }
}
function renderMembers(members) {
    const list = el('members-list');
    list.innerHTML = '';
    const renderSection = (title, subset) => {
        if (!subset.length)
            return;
        const lbl = document.createElement('div');
        lbl.className = 'members-section-label';
        lbl.textContent = `${title} — ${subset.length}`;
        list.appendChild(lbl);
        subset.forEach(m => {
            const item = document.createElement('div');
            item.className = 'member-item';
            item.dataset.userId = String(m.id);
            const status = m.status ?? getPresenceStatus(m.id);
            item.innerHTML = `
        <div class="member-avatar-wrap">
          <div class="avatar avatar-sm" style="background:${esc(m.avatar_color ?? '#6366f1')}">${esc(m.username[0].toUpperCase())}</div>
          <span class="presence-dot ${status}" data-presence="${m.id}"></span>
        </div>
        <div class="member-info">
          <div class="member-name">${esc(m.username)}</div>
          <div class="member-role ${m.role === 'admin' ? 'admin' : ''}">${m.role}</div>
        </div>
      `;
            item.addEventListener('click', () => openUserProfile(m.id, m.username, m.avatar_color));
            item.addEventListener('contextmenu', (e) => { e.preventDefault(); showMemberContextMenu(e, m); });
            list.appendChild(item);
        });
    };
    renderSection('Admins', members.filter(m => m.role === 'admin'));
    renderSection('Members', members.filter(m => m.role !== 'admin'));
}
function toggleMembersPanel() { el('members-panel').classList.toggle('hidden'); }
// ─── Messages ─────────────────────────────────────────────────
async function loadMessages() {
    if (msgLoading)
        return;
    msgLoading = true;
    try {
        const params = msgBefore ? '?before=' + encodeURIComponent(msgBefore) + '&limit=50' : '?limit=50';
        let data;
        if (currentRoom)
            data = await api('GET', '/api/rooms/' + currentRoom.id + '/messages' + params);
        else if (currentDMId)
            data = await api('GET', '/api/messages/personal/' + currentDMId + params);
        if (!data)
            return;
        const isFirst = !msgBefore;
        msgHasMore = data.has_more ?? false;
        el('load-more-btn').classList.toggle('hidden', !msgHasMore);
        if (data.messages?.length) {
            msgBefore = data.messages[0].created_at;
            if (isFirst) {
                renderAll(data.messages);
                setTimeout(scrollToBottom, 50);
            }
            else
                prependMessages(data.messages);
        }
    }
    catch (err) {
        showToast(err.message || 'Failed to load messages', 'error');
    }
    finally {
        msgLoading = false;
    }
}
async function loadMoreMessages() {
    if (!msgHasMore || msgLoading)
        return;
    const area = el('messages-area');
    const prevHeight = area.scrollHeight;
    await loadMessages();
    area.scrollTop = area.scrollHeight - prevHeight;
}
function renderAll(messages) {
    const container = el('messages-container');
    container.innerHTML = '';
    messages.forEach((msg, i) => container.appendChild(buildMsgEl(msg, messages[i - 1] ?? null)));
}
function prependMessages(messages) {
    const container = el('messages-container');
    const frag = document.createDocumentFragment();
    messages.forEach((msg, i) => frag.appendChild(buildMsgEl(msg, messages[i - 1] ?? null)));
    container.insertBefore(frag, container.firstChild);
}
function appendMessages(messages) {
    const container = el('messages-container');
    const lastEl = container.lastElementChild;
    const lastData = lastEl
        ? { sender_id: parseInt(lastEl.dataset.senderId ?? '0'), created_at: lastEl.dataset.createdAt }
        : null;
    messages.forEach((msg, i) => container.appendChild(buildMsgEl(msg, (i === 0 ? lastData : messages[i - 1]))));
}
function isContinued(msg, prev) {
    if (!prev || prev.sender_id !== msg.sender_id)
        return false;
    return new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60 * 1000;
}
function buildMsgEl(msg, prev) {
    const continued = isContinued(msg, prev);
    const div = document.createElement('div');
    div.className = 'msg-group' + (continued ? ' msg-continued' : '');
    div.dataset.msgId = String(msg.id);
    div.dataset.senderId = String(msg.sender_id);
    div.dataset.createdAt = msg.created_at;
    const timeLabel = formatTime(msg.created_at);
    const editedLabel = msg.edited_at ? '<span class="msg-edited">(edited)</span>' : '';
    const avatar = `<div class="avatar avatar-sm" style="background:${esc(msg.sender_color ?? '#6366f1')}">${esc((msg.sender_username ?? '?')[0].toUpperCase())}</div>`;
    const replyHTML = (msg.reply_to != null && msg.reply_content !== undefined)
        ? `<div class="msg-reply-preview"><span class="msg-reply-name">${esc(msg.reply_sender ?? '?')}</span>: ${esc(truncate(msg.reply_content, 80))}</div>`
        : '';
    const attHTML = (msg.attachments ?? []).map(att => att.is_image
        ? `<div class="msg-attachment"><img class="att-image" src="/uploads/${esc(att.filename)}?t=${token || ''}" alt="${esc(att.original_filename)}" loading="lazy" onclick="window.open(this.src)"></div>`
        : `<div class="msg-attachment"><a class="att-file" href="/uploads/${esc(att.filename)}?t=${token || ''}" target="_blank" download="${esc(att.original_filename)}"><span class="att-file-icon">📄</span><span class="att-file-name">${esc(att.original_filename)}</span><span class="att-file-size">${formatFileSize(att.size)}</span></a></div>`).join('');
    const canModify = msg.sender_id === currentUser.id;
    const canDelete = canModify || currentRoom?.role === 'admin';
    div.innerHTML = `
    <div class="msg-avatar">${continued ? `<span class="msg-time-inline">${timeLabel}</span>` : avatar}</div>
    <div class="msg-body">
      ${!continued ? `<div class="msg-meta"><span class="msg-author" data-user-id="${msg.sender_id}">${esc(msg.sender_username ?? '?')}</span><span class="msg-time">${timeLabel}</span></div>` : ''}
      ${replyHTML}
      <span class="msg-content">${esc(msg.content ?? '')}</span>${editedLabel}
      ${attHTML}
    </div>
    <div class="msg-actions">
      <button class="msg-action-btn" title="Reply" data-action="reply">↩</button>
      ${canModify ? `<button class="msg-action-btn" title="Edit" data-action="edit">✏</button>` : ''}
      ${canDelete ? `<button class="msg-action-btn danger" title="Delete" data-action="delete">🗑</button>` : ''}
    </div>
  `;
    div.querySelector('[data-action="reply"]')?.addEventListener('click', () => setReplyTo(msg));
    div.querySelector('[data-action="edit"]')?.addEventListener('click', () => openEditMessage(msg));
    div.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteMessage(msg));
    div.querySelector('.msg-author')?.addEventListener('click', () => openUserProfile(msg.sender_id, msg.sender_username, msg.sender_color));
    return div;
}
function updateMessageEl(elem, msg) {
    const contentEl = elem.querySelector('.msg-content');
    if (contentEl)
        contentEl.textContent = msg.content ?? '';
    if (msg.edited_at && !elem.querySelector('.msg-edited')) {
        contentEl?.insertAdjacentHTML('afterend', '<span class="msg-edited">(edited)</span>');
    }
}
function scrollToBottom(smooth = true) {
    const area = el('messages-area');
    area.scrollTo({ top: area.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}
// ─── Send Message ─────────────────────────────────────────────
function sendMessage() {
    const input = el('message-input');
    const content = input.value.trim();
    if (!content && !pendingUpload)
        return;
    if (!currentRoom && !currentDMId)
        return;
    if (currentRoom) {
        socket.emit('send_message', { roomId: currentRoom.id, content, replyTo: replyTo?.id ?? null, attachmentId: pendingUpload?.id ?? null });
    }
    else {
        socket.emit('send_personal_message', { receiverId: currentDMId, content, replyTo: replyTo?.id ?? null, attachmentId: pendingUpload?.id ?? null });
    }
    input.value = '';
    autoResize(input);
    clearReply();
    cancelUpload();
    stopTyping();
}
// ─── Typing ───────────────────────────────────────────────────
function handleTyping() {
    if (!socket || (!currentRoom && !currentDMId))
        return;
    if (!isTyping) {
        isTyping = true;
        const payload = { username: currentUser.username };
        if (currentRoom)
            payload.roomId = currentRoom.id;
        else
            payload.receiverId = currentDMId;
        socket.emit('typing', payload);
    }
    if (typingTimer)
        clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2000);
}
function stopTyping() {
    if (!isTyping || !socket)
        return;
    isTyping = false;
    const payload = {};
    if (currentRoom)
        payload.roomId = currentRoom.id;
    else
        payload.receiverId = currentDMId;
    socket.emit('stop_typing', payload);
}
function updateTypingIndicator() {
    const indicator = el('typing-indicator');
    const users = [...typingMap.keys()].filter(id => id !== currentUser.id);
    if (!users.length) {
        indicator.classList.add('hidden');
        return;
    }
    indicator.classList.remove('hidden');
    const names = users.map(uid => {
        const c = contacts.get(uid);
        const m = document.querySelector(`[data-user-id="${uid}"]`);
        return c?.username ?? m?.textContent ?? 'Someone';
    });
    indicator.textContent = names.join(', ') + (names.length === 1 ? ' is typing…' : ' are typing…');
}
// ─── Reply ────────────────────────────────────────────────────
function setReplyTo(msg) {
    replyTo = msg;
    el('reply-to-user').textContent = msg.sender_username ?? '?';
    el('reply-to-preview').textContent = truncate(msg.content ?? '[attachment]', 60);
    el('reply-bar').classList.remove('hidden');
    el('message-input').focus();
}
function clearReply() { replyTo = null; clearReplyUI(); }
function clearReplyUI() {
    el('reply-bar').classList.add('hidden');
    el('reply-to-user').textContent = '';
    el('reply-to-preview').textContent = '';
}
// ─── Delete / Edit ────────────────────────────────────────────
async function deleteMessage(msg) {
    if (!confirm('Delete this message?'))
        return;
    try {
        await api('DELETE', currentDMId !== null ? '/api/personal-messages/' + msg.id : '/api/messages/' + msg.id);
    }
    catch (err) {
        showToast(err.message, 'error');
    }
}
function openEditMessage(msg) {
    editMsgId = msg.id;
    el('edit-message-content').value = msg.content ?? '';
    openModal('modal-edit-message');
}
// ─── File Upload ──────────────────────────────────────────────
async function uploadFile(file) {
    if (!currentRoom && !currentDMId)
        return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const resp = await fetch(API + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: formData });
        const data = (await resp.json());
        if (!resp.ok)
            throw new Error(data.error ?? 'Upload failed');
        pendingUpload = data.attachment;
        showUploadPreview(data.attachment);
    }
    catch (err) {
        showToast(err.message, 'error');
    }
}
function showUploadPreview(att) {
    const inner = el('upload-preview-inner');
    inner.innerHTML = '';
    if (att.is_image) {
        const img = document.createElement('img');
        img.src = '/uploads/' + att.filename + '?t=' + (token || '');
        img.style.cssText = 'max-height:60px;max-width:80px;border-radius:6px;object-fit:cover';
        inner.appendChild(img);
    }
    else {
        inner.innerHTML = '<span style="font-size:1.4rem">📄</span>';
    }
    const info = document.createElement('div');
    info.innerHTML = `<div style="font-weight:600;font-size:.9rem">${esc(att.original_filename)}</div><div style="font-size:.78rem;color:var(--text-muted)">${formatFileSize(att.size)}</div>`;
    inner.appendChild(info);
    el('upload-preview').classList.remove('hidden');
}
function cancelUpload() { pendingUpload = null; clearUploadPreviewUI(); }
function clearUploadPreviewUI() { el('upload-preview').classList.add('hidden'); el('upload-preview-inner').innerHTML = ''; }
// ─── Emoji Picker ─────────────────────────────────────────────
const EMOJIS = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '👋', '✌️', '🤞', '🤙', '👍', '👎', '💪', '🙏', '🎉', '❤️', '💯', '🔥', '⭐', '✨', '🌟', '💥', '🎊', '🎈', '🎁'];
function initEmojiPicker() {
    const picker = el('emoji-picker');
    EMOJIS.forEach(emoji => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = emoji;
        btn.addEventListener('click', () => {
            const input = el('message-input');
            const pos = input.selectionStart ?? 0;
            input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
            input.selectionStart = input.selectionEnd = pos + emoji.length;
            input.focus();
        });
        picker.appendChild(btn);
    });
    el('btn-emoji').addEventListener('click', (e) => { e.stopPropagation(); el('emoji-picker').classList.toggle('hidden'); });
}
// ─── Public Rooms ─────────────────────────────────────────────
async function loadPublicRooms(search) {
    const cards = el('room-cards');
    cards.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
        const q = search ? '?search=' + encodeURIComponent(search) : '';
        const data = await api('GET', '/api/rooms' + q);
        cards.innerHTML = '';
        if (!data.rooms?.length) {
            cards.innerHTML = '<div class="empty-state">No rooms found</div>';
            return;
        }
        data.rooms.forEach(room => {
            const card = document.createElement('div');
            card.className = 'room-card';
            const isMember = !!room.is_member || myRooms.has(room.id);
            card.innerHTML = `
        <div class="room-card-icon">#</div>
        <div class="room-card-info">
          <div class="room-card-name">${esc(room.name)}</div>
          <div class="room-card-desc">${esc(room.description ?? 'No description')}</div>
          <div class="room-card-meta">${room.member_count} member${room.member_count !== 1 ? 's' : ''} · by ${esc(room.owner_username ?? '')}</div>
        </div>
        <button class="btn ${isMember ? 'btn-ghost' : 'btn-primary'} btn-sm">${isMember ? 'Open' : 'Join'}</button>
      `;
            card.querySelector('button').addEventListener('click', async () => {
                if (!isMember) {
                    try {
                        await api('POST', '/api/rooms/' + room.id + '/join');
                        showToast('Joined!', 'success');
                        await loadMyRooms();
                    }
                    catch (err) {
                        showToast(err.message, 'error');
                        return;
                    }
                }
                closeModal('modal-rooms');
                selectRoom(room.id);
            });
            cards.appendChild(card);
        });
    }
    catch (err) {
        cards.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
}
// ─── Room Settings ────────────────────────────────────────────
function openRoomSettings() {
    if (!currentRoom)
        return;
    if (currentRoom.role !== 'admin') {
        showToast('Admin access required', 'error');
        return;
    }
    el('room-settings-title').textContent = currentRoom.name + ' Settings';
    el('edit-room-name').value = currentRoom.name;
    el('edit-room-description').value = '';
    document.getElementById('room-edit-tab')?.classList.remove('hidden');
    document.getElementById('room-admins-tab')?.classList.add('hidden');
    document.getElementById('room-bans-tab')?.classList.add('hidden');
    openModal('modal-room-settings');
}
async function loadRoomBans() {
    if (!currentRoom)
        return;
    try {
        const data = await api('GET', '/api/rooms/' + currentRoom.id + '/bans');
        const list = el('bans-list');
        if (!data.bans?.length) {
            list.innerHTML = '<div class="empty-state">No users banned</div>';
            return;
        }
        list.innerHTML = data.bans.map(ban => `
      <div class="ban-item">
        <div>
          <div class="ban-name">${esc(ban.username)}</div>
          <div class="ban-meta">Banned by ${esc(ban.banned_by_username)} · ${formatTime(ban.created_at)}</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="unbanUser(${ban.user_id})">Unban</button>
      </div>
    `).join('');
    }
    catch (err) {
        el('bans-list').innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
}
async function loadRoomAdmins() {
    if (!currentRoom)
        return;
    try {
        const data = await api('GET', '/api/rooms/' + currentRoom.id + '/admins');
        const list = el('admins-list');
        // Handle both array response and {admins: []} response
        const admins = Array.isArray(data) ? data : (data.admins || []);
        if (!admins.length) {
            list.innerHTML = '<div class="empty-state">No admins found</div>';
            return;
        }
        const ownerId = currentRoom.ownerId;
        list.innerHTML = admins.map((admin) => `
      <div class="admin-item">
        <div class="avatar avatar-sm" style="background: ${esc(admin.avatar_color || '#6366f1')}">${esc(admin.username[0].toUpperCase())}</div>
        <div>
          <div class="admin-name">${esc(admin.username)}</div>
          <div class="admin-meta">Admin</div>
        </div>
        ${admin.user_id !== ownerId ? '<button class="btn btn-secondary btn-sm" onclick="removeAdmin(' + admin.user_id + ')">Remove</button>' : ''}
      </div>
    `).join('');
    }
    catch (err) {
        el('admins-list').innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
}
// Load non-admin members for adding as admin
async function loadAddableMembers() {
    if (!currentRoom)
        return;
    try {
        const members = await api('GET', '/api/rooms/' + currentRoom.id + '/members');
        const adminsRes = await api('GET', '/api/rooms/' + currentRoom.id + '/admins');
        const admins = Array.isArray(adminsRes) ? adminsRes : (adminsRes.admins || []);
        const adminIds = new Set(admins.map((a) => a.user_id));
        const ownerId = currentRoom.ownerId;
        const currentUserId = currentUser.id;
        // Filter out: current user (if not owner), owner, existing admins
        const memberList = members.members || [];
        const addable = memberList.filter((m) => (m.id !== currentUserId || ownerId === currentUserId) && m.id !== ownerId && !adminIds.has(m.id));
        const container = el('add-admin-members');
        if (!addable.length) {
            container.innerHTML = '<div class="empty-state">No members available to promote</div>';
            return;
        }
        container.innerHTML = addable.map(m => `
      <div class="member-add-item">
        <div class="avatar avatar-sm" style="background: ${esc(m.avatar_color || '#6366f1')}">${esc(m.username[0].toUpperCase())}</div>
        <div class="member-add-name">${esc(m.username)}</div>
        <button class="btn btn-primary btn-sm" onclick="promoteToAdmin(${m.id})">+ Add</button>
      </div>
    `).join('');
    }
    catch (err) {
        console.error(err);
    }
}
window.promoteToAdmin = async (userId) => {
    if (!currentRoom)
        return;
    try {
        await api('POST', '/api/rooms/' + currentRoom.id + '/promote', { userId });
        loadRoomAdmins();
        loadAddableMembers();
        showToast('User promoted to admin', 'success');
    }
    catch (err) {
        showToast(err.message, 'error');
    }
};
window.unbanUser = async (userId) => {
    if (!currentRoom)
        return;
    try {
        await api('POST', '/api/rooms/' + currentRoom.id + '/unban', { userId });
        loadRoomBans();
        showToast('User unbanned', 'success');
    }
    catch (err) {
        showToast(err.message, 'error');
    }
};
window.removeAdmin = async (userId) => {
    if (!currentRoom)
        return;
    try {
        await api('POST', '/api/rooms/' + currentRoom.id + '/remove-admin', { userId });
        loadRoomAdmins();
        showToast('Admin removed', 'success');
    }
    catch (err) {
        showToast(err.message, 'error');
    }
};
// ─── Invite ───────────────────────────────────────────────────
async function searchUsersForInvite() {
    const q = el('invite-search').value.trim();
    const results = el('invite-results');
    if (q.length < 2) {
        results.innerHTML = '';
        return;
    }
    try {
        const data = await api('GET', '/api/users/search?q=' + encodeURIComponent(q));
        if (!data.users?.length) {
            results.innerHTML = '<div class="empty-state">No users found</div>';
            return;
        }
        results.innerHTML = '';
        data.users.forEach(u => {
            const item = document.createElement('div');
            item.className = 'user-result-item';
            item.innerHTML = `
        <div class="user-result-info">
          <div class="avatar avatar-sm" style="background:${esc(u.avatar_color ?? '#6366f1')}">${esc(u.username[0].toUpperCase())}</div>
          <span class="user-result-name">${esc(u.username)}</span>
        </div>
        <button class="btn btn-primary btn-sm">Invite</button>
      `;
            item.querySelector('button').addEventListener('click', async () => {
                try {
                    await api('POST', '/api/rooms/' + currentRoom.id + '/invite', { userId: u.id });
                    showToast('Invitation sent to ' + u.username, 'success');
                }
                catch (err) {
                    showToast(err.message, 'error');
                }
            });
            results.appendChild(item);
        });
    }
    catch { /* silent */ }
}
// ─── User Profile ─────────────────────────────────────────────
async function openUserProfile(userId, username, avatarColor) {
    if (userId === currentUser.id) {
        openModal('modal-settings');
        loadSessions();
        return;
    }
    const avatar = el('profile-avatar-lg');
    avatar.className = 'avatar avatar-xl';
    avatar.style.background = avatarColor ?? '#6366f1';
    avatar.textContent = (username ?? '?')[0].toUpperCase();
    el('profile-username-display').textContent = username ?? '?';
    const status = getPresenceStatus(userId);
    const badge = el('profile-status-badge');
    badge.className = 'profile-status-badge ' + status;
    badge.textContent = status;
    const actions = el('profile-action-buttons');
    actions.innerHTML = '';
    const c = contacts.get(userId);
    if (c?.status === 'accepted') {
        const msgBtn = document.createElement('button');
        msgBtn.className = 'btn btn-primary';
        msgBtn.textContent = 'Send Message';
        msgBtn.addEventListener('click', () => { closeModal('modal-user-profile'); selectDM(userId, username, avatarColor); });
        actions.appendChild(msgBtn);
        const blockBtn = document.createElement('button');
        blockBtn.className = 'btn btn-outline-danger';
        blockBtn.textContent = 'Block';
        blockBtn.addEventListener('click', async () => {
            if (!confirm('Block ' + username + '? This will remove them from your contacts.'))
                return;
            try {
                await api('POST', '/api/blocks', { userId });
                showToast('User blocked', 'success');
                closeModal('modal-user-profile');
                contacts.delete(userId);
                renderContactsList();
            }
            catch (err) {
                showToast(err.message, 'error');
            }
        });
        actions.appendChild(blockBtn);
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn btn-ghost';
        removeBtn.textContent = 'Remove friend';
        removeBtn.addEventListener('click', async () => {
            if (!confirm('Remove ' + username + ' from friends?'))
                return;
            try {
                await api('DELETE', '/api/contacts/' + userId);
                showToast('Friend removed', 'success');
                closeModal('modal-user-profile');
                contacts.delete(userId);
                renderContactsList();
            }
            catch (err) {
                showToast(err.message, 'error');
            }
        });
        actions.appendChild(removeBtn);
    }
    else {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-primary';
        addBtn.textContent = 'Add Friend';
        addBtn.addEventListener('click', () => { closeModal('modal-user-profile'); el('contact-username').value = username ?? ''; openModal('modal-add-contact'); });
        actions.appendChild(addBtn);
    }
    if (currentRoom?.role === 'admin' && userId !== currentRoom.ownerId) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn btn-ghost btn-sm';
        kickBtn.textContent = 'Kick';
        kickBtn.addEventListener('click', async () => {
            if (!confirm('Kick ' + username + ' from room?'))
                return;
            try {
                await api('POST', '/api/rooms/' + currentRoom.id + '/kick', { userId });
                showToast('Member removed', 'success');
                closeModal('modal-user-profile');
                loadMembers(currentRoom.id);
            }
            catch (err) {
                showToast(err.message, 'error');
            }
        });
        actions.appendChild(kickBtn);
        const banBtn = document.createElement('button');
        banBtn.className = 'btn btn-danger btn-sm';
        banBtn.textContent = 'Ban';
        banBtn.addEventListener('click', async () => {
            if (!confirm('Ban ' + username + ' from room?'))
                return;
            try {
                await api('POST', '/api/rooms/' + currentRoom.id + '/ban', { userId });
                showToast('User banned', 'success');
                closeModal('modal-user-profile');
                loadMembers(currentRoom.id);
            }
            catch (err) {
                showToast(err.message, 'error');
            }
        });
        actions.appendChild(banBtn);
    }
    openModal('modal-user-profile');
}
// ─── Pending Requests ─────────────────────────────────────────
async function loadPendingRequests() {
    const list = el('requests-list');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
        const data = await api('GET', '/api/contacts');
        const pending = data.contacts?.filter(c => c.status === 'pending' && c.direction === 'incoming') ?? [];
        if (!pending.length) {
            list.innerHTML = '<div class="empty-state">No pending requests</div>';
            return;
        }
        list.innerHTML = '';
        pending.forEach(c => {
            const item = document.createElement('div');
            item.className = 'request-item';
            item.innerHTML = `
        <div class="avatar avatar-sm" style="background:${esc(c.avatar_color ?? '#6366f1')}">${esc(c.username[0].toUpperCase())}</div>
        <div class="request-info">
          <div class="request-name">${esc(c.username)}</div>
          ${c.request_message ? `<div class="request-message">"${esc(c.request_message)}"</div>` : ''}
        </div>
        <div class="request-actions">
          <button class="btn btn-primary btn-sm" data-action="accept">Accept</button>
          <button class="btn btn-ghost btn-sm" data-action="decline">Decline</button>
        </div>
      `;
            item.querySelector('[data-action="accept"]').addEventListener('click', async () => {
                try {
                    await api('PUT', '/api/contacts/request/' + c.id, { status: 'accepted' });
                    showToast('Friend request accepted!', 'success');
                    item.remove();
                    loadContacts();
                }
                catch (err) {
                    showToast(err.message, 'error');
                }
            });
            item.querySelector('[data-action="decline"]').addEventListener('click', async () => {
                try {
                    await api('PUT', '/api/contacts/request/' + c.id, { status: 'rejected' });
                    item.remove();
                    loadContacts();
                }
                catch (err) {
                    showToast(err.message, 'error');
                }
            });
            list.appendChild(item);
        });
    }
    catch (err) {
        list.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    }
}
// ─── Sessions ─────────────────────────────────────────────────
async function loadSessions() {
    const list = el('sessions-list');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
        const data = await api('GET', '/api/users/sessions');
        list.innerHTML = '';
        data.sessions?.forEach(s => {
            const item = document.createElement('div');
            item.className = 'session-item';
            const ua = s.user_agent ? s.user_agent.slice(0, 60) : 'Unknown client';
            item.innerHTML = `
        <div class="session-info">
          <div class="session-ua">${esc(ua)}</div>
          <div class="session-meta">IP: ${esc(s.ip_address ?? 'unknown')} · ${formatTime(s.created_at)}</div>
        </div>
        <button class="btn btn-ghost btn-sm">Revoke</button>
      `;
            item.querySelector('button').addEventListener('click', async () => {
                try {
                    await api('DELETE', '/api/users/sessions/' + s.id);
                    item.remove();
                    showToast('Session revoked', 'success');
                }
                catch { /* silent */ }
            });
            list.appendChild(item);
        });
        if (!data.sessions?.length)
            list.innerHTML = '<div class="empty-state">No active sessions</div>';
    }
    catch { /* silent */ }
}
// ─── Member Context Menu ──────────────────────────────────────
function showMemberContextMenu(e, member) {
    const items = [];
    if (member.id !== currentUser.id) {
        items.push({ label: '👤 View Profile', action: () => openUserProfile(member.id, member.username, member.avatar_color) });
        const c = contacts.get(member.id);
        if (c?.status === 'accepted')
            items.push({ label: '💬 Send Message', action: () => selectDM(member.id, member.username, member.avatar_color) });
    }
    if (currentRoom?.role === 'admin' && member.id !== currentRoom.ownerId) {
        items.push({ divider: true });
        items.push({ label: '🚫 Kick', action: async () => {
                if (!confirm('Kick ' + member.username + '?'))
                    return;
                try {
                    await api('POST', '/api/rooms/' + currentRoom.id + '/kick', { userId: member.id });
                    loadMembers(currentRoom.id);
                }
                catch (err) {
                    showToast(err.message, 'error');
                }
            } });
        items.push({ label: '⛔ Ban', danger: true, action: async () => {
                if (!confirm('Ban ' + member.username + '?'))
                    return;
                try {
                    await api('POST', '/api/rooms/' + currentRoom.id + '/ban', { userId: member.id });
                    loadMembers(currentRoom.id);
                }
                catch (err) {
                    showToast(err.message, 'error');
                }
            } });
        // Promote/demote — only room owner can do this
        if (currentUser.id === currentRoom.ownerId) {
            if (member.role !== 'admin') {
                items.push({ label: '⭐ Make admin', action: async () => {
                        try {
                            await api('POST', '/api/rooms/' + currentRoom.id + '/promote', { userId: member.id });
                            loadMembers(currentRoom.id);
                            showToast('User promoted to admin', 'success');
                        }
                        catch (err) {
                            showToast(err.message, 'error');
                        }
                    } });
            }
            else {
                items.push({ label: '⬇ Remove admin', action: async () => {
                        try {
                            await api('POST', '/api/rooms/' + currentRoom.id + '/demote', { userId: member.id });
                            loadMembers(currentRoom.id);
                            showToast('Admin removed', 'success');
                        }
                        catch (err) {
                            showToast(err.message, 'error');
                        }
                    } });
            }
        }
    }
    if (items.length)
        showContextMenu(e.clientX, e.clientY, items);
}
function showContextMenu(x, y, items) {
    const menu = el('context-menu');
    menu.innerHTML = '';
    items.forEach(item => {
        if (item.divider) {
            const d = document.createElement('div');
            d.className = 'context-divider';
            menu.appendChild(d);
        }
        else {
            const btn = document.createElement('button');
            btn.className = 'context-item' + (item.danger ? ' danger' : '');
            btn.textContent = item.label ?? '';
            btn.addEventListener('click', () => { hideContextMenu(); item.action?.(); });
            menu.appendChild(btn);
        }
    });
    menu.classList.remove('hidden');
    let lx = x, ly = y;
    if (x + 180 > window.innerWidth)
        lx = window.innerWidth - 190;
    if (y + menu.offsetHeight + 20 > window.innerHeight)
        ly = y - menu.offsetHeight - 4;
    menu.style.left = lx + 'px';
    menu.style.top = ly + 'px';
}
function hideContextMenu() { el('context-menu').classList.add('hidden'); }
// ─── Presence ─────────────────────────────────────────────────
function getPresenceStatus(userId) {
    const dot = document.querySelector(`[data-presence="${userId}"]`);
    if (dot?.classList.contains('online'))
        return 'online';
    if (dot?.classList.contains('afk'))
        return 'AFK';
    return 'offline';
}
function trackActivity() {
    const handler = debounce(() => { if (socket)
        socket.emit('activity'); }, 2000);
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => document.addEventListener(ev, handler, { passive: true }));
}
// ─── Modals ───────────────────────────────────────────────────
function openModal(id) {
    const elem = document.getElementById(id);
    if (!elem)
        return;
    elem.classList.remove('hidden');
    if (id === 'modal-rooms')
        loadPublicRooms(el('room-search').value);
}
function closeModal(id) { if (id)
    document.getElementById(id)?.classList.add('hidden'); }
function closeModalEl(elem) { elem.classList.add('hidden'); }
// ─── Logout ───────────────────────────────────────────────────
function doLogout() {
    token = null;
    currentUser = null;
    currentRoom = null;
    currentDMId = null;
    myRooms.clear();
    contacts.clear();
    localStorage.removeItem('token');
    socket?.disconnect();
    socket = null;
    el('app-screen').classList.add('hidden');
    el('auth-screen').classList.remove('hidden');
    el('login-email').value = '';
    el('login-password').value = '';
}
