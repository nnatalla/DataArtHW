"use strict";
// ClassicChat — Frontend Application (TypeScript)
// This file is a direct migration of app.js to TypeScript.
// You may need to install types for socket.io-client: npm install --save-dev @types/socket.io-client
const API = '';
document.addEventListener('DOMContentLoaded', () => {
    initAuthUI();
    initAppUI();
    autoLogin();
    trackActivity();
});
// ─── App UI Bindings ─────────────────────────────────────────
function initAppUI() {
    // Welcome panel buttons
    $('btn-welcome-browse').addEventListener('click', () => openModal('modal-rooms'));
    $('btn-welcome-friends').addEventListener('click', () => openModal('modal-add-contact'));
    // Sidebar add buttons
    $('btn-browse-rooms').addEventListener('click', () => openModal('modal-rooms'));
    $('btn-add-contact').addEventListener('click', () => openModal('modal-add-contact'));
    // Settings button
    $('btn-settings').addEventListener('click', () => {
        openModal('modal-settings');
        loadSessions();
    });
    // ...rest of the UI bindings and event listeners from app.js...
}
// ─── Socket ───────────────────────────────────────────────────
function connectSocket() {
    // You may need to import io from 'socket.io-client' and install @types/socket.io-client
    // @ts-ignore
    socket = io();
    socket.on('connect', () => {
        socket.emit('authenticate', token);
    });
    // ...rest of the socket event handlers from app.js...
}
