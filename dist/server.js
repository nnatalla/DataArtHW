"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http = __importStar(require("http"));
const socket_io_1 = require("socket.io");
const db_1 = require("./db");
const bcrypt = __importStar(require("bcryptjs"));
const jwt = __importStar(require("jsonwebtoken"));
const multer_1 = __importDefault(require("multer"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
const server = http.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_in_production_please';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '20971520');
const MAX_MSG_SIZE = 3072;
if (!fs.existsSync(UPLOAD_DIR))
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// ─── Middleware ───────────────────────────────────────────────
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// /uploads is NOT served statically — protected endpoint below handles access control
app.use(express_1.default.static(path.join(__dirname, '..', 'public')));
// ─── File Upload ──────────────────────────────────────────────
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, crypto.randomUUID() + ext);
    }
});
const upload = (0, multer_1.default)({ storage, limits: { fileSize: MAX_FILE_SIZE } });
// ─── SQLite datetime helper ───────────────────────────────────
// SQLite datetime('now') uses format "YYYY-MM-DD HH:MM:SS"
// JS .toISOString() gives "YYYY-MM-DDTHH:MM:SS.mmmZ" — incompatible!
function toSQLiteDate(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
// ─── Auth Middleware ──────────────────────────────────────────
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userResult = await db_1.pool.query('SELECT id, email, username, avatar_color FROM users WHERE id = $1', [decoded.userId]);
        if (!userResult.rows.length) {
            res.status(403).json({ error: 'User not found' });
            return;
        }
        // FIX: compare using strftime to match the stored format
        const sessionResult = await db_1.pool.query("SELECT id FROM sessions WHERE token = $1 AND expires_at > strftime('%Y-%m-%d %H:%M:%S', 'now')", [token]);
        if (!sessionResult.rows.length) {
            res.status(403).json({ error: 'Session expired' });
            return;
        }
        req.user = userResult.rows[0];
        req.token = token;
        next();
    }
    catch (err) {
        console.error('authenticateToken error:', err);
        res.status(403).json({ error: 'Invalid token' });
    }
}
// ─── Presence ─────────────────────────────────────────────────
const userToSockets = new Map();
const userLastActivity = new Map();
function addUserSocket(userId, socketId) {
    if (!userToSockets.has(userId))
        userToSockets.set(userId, new Set());
    userToSockets.get(userId).add(socketId);
    if (!userLastActivity.has(userId))
        userLastActivity.set(userId, Date.now());
}
function removeUserSocket(userId, socketId) {
    const sockets = userToSockets.get(userId);
    if (!sockets)
        return;
    sockets.delete(socketId);
    if (sockets.size === 0)
        userToSockets.delete(userId);
}
function getUserStatus(userId) {
    const sockets = userToSockets.get(userId);
    if (!sockets || sockets.size === 0)
        return 'offline';
    const last = userLastActivity.get(userId) ?? 0;
    return Date.now() - last > 60_000 ? 'afk' : 'online';
}
function emitToUser(userId, event, data) {
    io.to('user_' + userId).emit(event, data);
}
async function broadcastPresence(userId) {
    const status = getUserStatus(userId);
    try {
        const result = await db_1.pool.query("SELECT friend_id AS fid FROM contacts WHERE user_id = $1 AND status = 'accepted'" +
            " UNION SELECT user_id AS fid FROM contacts WHERE friend_id = $1 AND status = 'accepted'", [userId]);
        for (const row of result.rows) {
            emitToUser(row.fid, 'presence_update', { userId, status });
        }
    }
    catch { /* ignore */ }
}
setInterval(() => {
    for (const [userId] of userToSockets)
        broadcastPresence(userId);
}, 30_000);
// ─── Query Helpers ────────────────────────────────────────────
async function buildRoomMessage(messageId) {
    const result = await db_1.pool.query('SELECT m.*, u.username AS sender_username, u.avatar_color AS sender_color,' +
        ' rm.content AS reply_content, ru.username AS reply_sender' +
        ' FROM messages m' +
        ' LEFT JOIN users u  ON m.sender_id  = u.id' +
        ' LEFT JOIN messages rm ON m.reply_to = rm.id' +
        ' LEFT JOIN users ru ON rm.sender_id = ru.id' +
        ' WHERE m.id = $1 AND m.deleted_at IS NULL', [messageId]);
    const msg = result.rows[0];
    if (!msg)
        return null;
    const atts = await db_1.pool.query('SELECT id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE message_id = $1', [messageId]);
    msg.attachments = atts.rows;
    return msg;
}
async function buildPersonalMessage(messageId) {
    const result = await db_1.pool.query('SELECT pm.*, su.username AS sender_username, su.avatar_color AS sender_color,' +
        ' rm.content AS reply_content, ru.username AS reply_sender' +
        ' FROM personal_messages pm' +
        ' LEFT JOIN users su ON pm.sender_id = su.id' +
        ' LEFT JOIN personal_messages rm ON pm.reply_to = rm.id' +
        ' LEFT JOIN users ru ON rm.sender_id = ru.id' +
        ' WHERE pm.id = $1 AND pm.deleted_at IS NULL', [messageId]);
    const msg = result.rows[0];
    if (!msg)
        return null;
    const atts = await db_1.pool.query('SELECT id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE personal_message_id = $1', [messageId]);
    msg.attachments = atts.rows;
    return msg;
}
async function isUserBlocked(userId, otherId) {
    const r = await db_1.pool.query('SELECT id FROM blocks WHERE (user_id=$1 AND blocked_id=$2) OR (user_id=$2 AND blocked_id=$1)', [userId, otherId]);
    return r.rows.length > 0;
}
async function areFriends(userId, otherId) {
    const r = await db_1.pool.query("SELECT id FROM contacts WHERE ((user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)) AND status='accepted'", [userId, otherId]);
    return r.rows.length > 0;
}
async function canMessageUser(userId, otherId) {
    if (await isUserBlocked(userId, otherId))
        return false;
    return areFriends(userId, otherId);
}
io.on('connection', (socket) => {
    socket.on('authenticate', async (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.userId = decoded.userId;
            addUserSocket(decoded.userId, socket.id);
            socket.join('user_' + decoded.userId);
            broadcastPresence(decoded.userId);
            const rooms = await db_1.pool.query('SELECT room_id FROM room_members WHERE user_id = $1', [decoded.userId]);
            rooms.rows.forEach((r) => socket.join('room_' + r.room_id));
        }
        catch { /* invalid token — ignore */ }
    });
    socket.on('activity', () => {
        if (!socket.userId)
            return;
        const wasAfk = getUserStatus(socket.userId) === 'afk';
        userLastActivity.set(socket.userId, Date.now());
        if (wasAfk)
            broadcastPresence(socket.userId);
    });
    socket.on('join_room', (roomId) => { if (socket.userId)
        socket.join('room_' + roomId); });
    socket.on('leave_room', (roomId) => { if (socket.userId)
        socket.leave('room_' + roomId); });
    socket.on('send_message', async (data) => {
        if (!socket.userId)
            return;
        const { roomId, content, replyTo, attachmentId } = data;
        if (!content && !attachmentId)
            return;
        const text = (content ?? '').slice(0, MAX_MSG_SIZE);
        try {
            const mem = await db_1.pool.query('SELECT id FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, socket.userId]);
            if (!mem.rows.length)
                return;
            const msgResult = await db_1.pool.query('INSERT INTO messages (room_id, sender_id, content, reply_to) VALUES ($1,$2,$3,$4) RETURNING *', [roomId, socket.userId, text, replyTo ?? null]);
            const message = msgResult.rows[0];
            if (attachmentId) {
                await db_1.pool.query('UPDATE attachments SET message_id=$1 WHERE id=$2 AND uploader_id=$3 AND message_id IS NULL', [message.id, attachmentId, socket.userId]);
            }
            const full = await buildRoomMessage(message.id);
            io.to('room_' + roomId).emit('message', full);
        }
        catch (e) {
            console.error('send_message error:', e);
        }
    });
    socket.on('send_personal_message', async (data) => {
        if (!socket.userId)
            return;
        const { receiverId, content, replyTo, attachmentId } = data;
        if (!content && !attachmentId)
            return;
        const text = (content ?? '').slice(0, MAX_MSG_SIZE);
        try {
            if (!await canMessageUser(socket.userId, receiverId)) {
                socket.emit('error', { message: 'Cannot send message to this user' });
                return;
            }
            const msgResult = await db_1.pool.query('INSERT INTO personal_messages (sender_id, receiver_id, content, reply_to) VALUES ($1,$2,$3,$4) RETURNING *', [socket.userId, receiverId, text, replyTo ?? null]);
            const message = msgResult.rows[0];
            if (attachmentId) {
                await db_1.pool.query('UPDATE attachments SET personal_message_id=$1 WHERE id=$2 AND uploader_id=$3 AND personal_message_id IS NULL AND message_id IS NULL', [message.id, attachmentId, socket.userId]);
            }
            const full = await buildPersonalMessage(message.id);
            emitToUser(socket.userId, 'personal_message', full);
            emitToUser(receiverId, 'personal_message', full);
        }
        catch (e) {
            console.error('send_personal_message error:', e);
        }
    });
    socket.on('typing', (data) => {
        if (!socket.userId)
            return;
        if (data.roomId)
            socket.to('room_' + data.roomId).emit('typing', { userId: socket.userId, username: data.username, roomId: data.roomId });
        else if (data.receiverId)
            emitToUser(data.receiverId, 'typing', { userId: socket.userId, username: data.username });
    });
    socket.on('stop_typing', (data) => {
        if (!socket.userId)
            return;
        if (data.roomId)
            socket.to('room_' + data.roomId).emit('stop_typing', { userId: socket.userId });
        else if (data.receiverId)
            emitToUser(data.receiverId, 'stop_typing', { userId: socket.userId });
    });
    socket.on('disconnect', () => {
        if (socket.userId) {
            removeUserSocket(socket.userId, socket.id);
            broadcastPresence(socket.userId);
        }
    });
});
// ═════════════════════════════════════════════════════════════
// REST API Routes
// ═════════════════════════════════════════════════════════════
// ─── Auth ─────────────────────────────────────────────────────
app.get('/api/auth/check-username/:username', async (req, res) => {
    const { username } = req.params;
    if (!username || username.length < 3)
        return res.json({ available: false });
    try {
        const result = await db_1.pool.query('SELECT id FROM users WHERE username = $1', [username]);
        res.json({ available: result.rows.length === 0 });
    }
    catch {
        res.json({ available: null });
    }
});
app.post('/api/auth/register', async (req, res) => {
    const { email, password, username } = req.body;
    if (!email || !password || !username)
        return res.status(400).json({ error: 'Email, password and username are required' });
    if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
        return res.status(400).json({ error: 'Username: 3-30 chars, letters/digits/underscore only' });
    try {
        const hashed = await bcrypt.hash(password, 12);
        const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#8b5cf6'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        const result = await db_1.pool.query('INSERT INTO users (email, username, password_hash, avatar_color) VALUES ($1,$2,$3,$4) RETURNING id, email, username, avatar_color', [email.toLowerCase().trim(), username.trim(), hashed, color]);
        res.status(201).json({ user: result.rows[0] });
    }
    catch (err) {
        if (err.code === '23505') {
            const c = (err.constraint ?? '').toLowerCase();
            if (c.includes('email'))
                return res.status(400).json({ error: 'Email already registered' });
            if (c.includes('username'))
                return res.status(400).json({ error: 'Username already taken' });
        }
        console.error('register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Email and password required' });
    try {
        const result = await db_1.pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
        if (!result.rows.length)
            return res.status(401).json({ error: 'Invalid credentials' });
        const user = result.rows[0];
        if (!await bcrypt.compare(password, user.password_hash))
            return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        // FIX: store in SQLite-compatible format "YYYY-MM-DD HH:MM:SS"
        const expiresAt = toSQLiteDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
        await db_1.pool.query('INSERT INTO sessions (user_id, token, expires_at, user_agent, ip_address) VALUES ($1,$2,$3,$4,$5)', [user.id, token, expiresAt, req.headers['user-agent'] ?? '', req.ip ?? '']);
        res.json({ token, user: { id: user.id, email: user.email, username: user.username, avatar_color: user.avatar_color } });
    }
    catch (err) {
        console.error('login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    res.json({ user: req.user });
});
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        await db_1.pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
        res.json({ ok: true });
    }
    catch {
        res.json({ ok: true });
    }
});
app.put('/api/auth/password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
        return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8)
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
    try {
        const result = await db_1.pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        if (!await bcrypt.compare(currentPassword, result.rows[0].password_hash))
            return res.status(401).json({ error: 'Current password is incorrect' });
        const hashed = await bcrypt.hash(newPassword, 12);
        await db_1.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, req.user.id]);
        // invalidate all other sessions
        await db_1.pool.query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [req.user.id, req.token]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('password change error:', err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});
app.delete('/api/auth/account', authenticateToken, async (req, res) => {
    const { password } = req.body;
    if (!password)
        return res.status(400).json({ error: 'Password required' });
    try {
        const result = await db_1.pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
        if (!await bcrypt.compare(password, result.rows[0].password_hash))
            return res.status(401).json({ error: 'Incorrect password' });
        // Delete physical files from owned rooms
        const ownedRooms = await db_1.pool.query('SELECT id FROM rooms WHERE owner_id=$1', [req.user.id]);
        for (const room of ownedRooms.rows) {
            const atts = await db_1.pool.query('SELECT a.filename FROM attachments a JOIN messages m ON a.message_id=m.id WHERE m.room_id=$1', [room.id]);
            for (const att of atts.rows) {
                const fp = path.join(UPLOAD_DIR, att.filename);
                if (fs.existsSync(fp))
                    fs.unlinkSync(fp);
            }
            io.to('room_' + room.id).emit('room_deleted', { id: room.id });
        }
        // CASCADE in DB handles rooms, members, messages, sessions
        await db_1.pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('delete account error:', err);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});
// ─── Sessions ─────────────────────────────────────────────────
app.get('/api/users/sessions', authenticateToken, async (req, res) => {
    try {
        const result = await db_1.pool.query('SELECT id, user_agent, ip_address, created_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json({ sessions: result.rows });
    }
    catch {
        res.status(500).json({ error: 'Failed to load sessions' });
    }
});
app.delete('/api/users/sessions/:id', authenticateToken, async (req, res) => {
    try {
        await db_1.pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        res.json({ ok: true });
    }
    catch {
        res.status(500).json({ error: 'Failed to revoke session' });
    }
});
// ─── Users ────────────────────────────────────────────────────
app.get('/api/users/search', authenticateToken, async (req, res) => {
    const q = (req.query.q ?? '').trim();
    if (q.length < 2)
        return res.json({ users: [] });
    try {
        const result = await db_1.pool.query("SELECT id, username, avatar_color FROM users WHERE username LIKE $1 AND id != $2 LIMIT 20", ['%' + q + '%', req.user.id]);
        res.json({ users: result.rows });
    }
    catch {
        res.status(500).json({ error: 'Search failed' });
    }
});
// ─── Contacts ─────────────────────────────────────────────────
app.get('/api/contacts', authenticateToken, async (req, res) => {
    try {
        const result = await db_1.pool.query(`SELECT c.id, c.status, c.request_message, c.created_at,
        CASE WHEN c.user_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction,
        CASE WHEN c.user_id = $1 THEN c.friend_id ELSE c.user_id END AS user_id,
        CASE WHEN c.user_id = $1 THEN fu.username ELSE uu.username END AS username,
        CASE WHEN c.user_id = $1 THEN fu.avatar_color ELSE uu.avatar_color END AS avatar_color
       FROM contacts c
       JOIN users uu ON c.user_id    = uu.id
       JOIN users fu ON c.friend_id  = fu.id
       WHERE c.user_id = $1 OR c.friend_id = $1`, [req.user.id]);
        res.json({ contacts: result.rows });
    }
    catch (err) {
        console.error('contacts error:', err);
        res.status(500).json({ error: 'Failed to load contacts' });
    }
});
app.post('/api/contacts/request', authenticateToken, async (req, res) => {
    const { username, message } = req.body;
    if (!username)
        return res.status(400).json({ error: 'Username required' });
    try {
        const target = await db_1.pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (!target.rows.length)
            return res.status(404).json({ error: 'User not found' });
        const friendId = target.rows[0].id;
        if (friendId === req.user.id)
            return res.status(400).json({ error: 'Cannot add yourself' });
        const existing = await db_1.pool.query('SELECT id FROM contacts WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.user.id, friendId]);
        if (existing.rows.length)
            return res.status(400).json({ error: 'Contact already exists' });
        const result = await db_1.pool.query('INSERT INTO contacts (user_id, friend_id, status, request_message) VALUES ($1,$2,$3,$4) RETURNING id', [req.user.id, friendId, 'pending', message ?? null]);
        emitToUser(friendId, 'friend_request', { userId: req.user.id, username: req.user.username, avatar_color: req.user.avatar_color, message });
        res.status(201).json({ id: result.rows[0].id });
    }
    catch (err) {
        console.error('contact request error:', err);
        res.status(500).json({ error: 'Failed to send request' });
    }
});
app.put('/api/contacts/request/:id', authenticateToken, async (req, res) => {
    const { status } = req.body;
    if (!['accepted', 'rejected'].includes(status))
        return res.status(400).json({ error: 'Invalid status' });
    try {
        const contact = await db_1.pool.query('SELECT * FROM contacts WHERE id = $1 AND friend_id = $2 AND status = $3', [req.params.id, req.user.id, 'pending']);
        if (!contact.rows.length)
            return res.status(404).json({ error: 'Request not found' });
        await db_1.pool.query('UPDATE contacts SET status = $1 WHERE id = $2', [status, req.params.id]);
        if (status === 'accepted') {
            emitToUser(contact.rows[0].user_id, 'contact_accepted', { userId: req.user.id, username: req.user.username });
        }
        res.json({ ok: true });
    }
    catch (err) {
        console.error('contact update error:', err);
        res.status(500).json({ error: 'Failed to update request' });
    }
});
// ─── Blocks ───────────────────────────────────────────────────
app.post('/api/blocks', authenticateToken, async (req, res) => {
    const { userId: blockId } = req.body;
    if (!blockId)
        return res.status(400).json({ error: 'userId required' });
    try {
        await db_1.pool.query('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES ($1,$2)', [req.user.id, blockId]);
        // remove contact relationship
        await db_1.pool.query('DELETE FROM contacts WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.user.id, blockId]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('block error:', err);
        res.status(500).json({ error: 'Failed to block user' });
    }
});
// ─── Rooms ────────────────────────────────────────────────────
app.get('/api/rooms', authenticateToken, async (req, res) => {
    const search = (req.query.search ?? '').trim();
    try {
        const q = search
            ? "SELECT r.*, u.username AS owner_username, (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count, EXISTS(SELECT 1 FROM room_members WHERE room_id=r.id AND user_id=$2) AS is_member FROM rooms r LEFT JOIN users u ON r.owner_id=u.id WHERE r.visibility='public' AND r.name LIKE $1 ORDER BY r.created_at DESC LIMIT 50"
            : "SELECT r.*, u.username AS owner_username, (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count, EXISTS(SELECT 1 FROM room_members WHERE room_id=r.id AND user_id=$1) AS is_member FROM rooms r LEFT JOIN users u ON r.owner_id=u.id WHERE r.visibility='public' ORDER BY r.created_at DESC LIMIT 50";
        const params = search ? ['%' + search + '%', req.user.id] : [req.user.id];
        const result = await db_1.pool.query(q, params);
        res.json({ rooms: result.rows });
    }
    catch (err) {
        console.error('rooms list error:', err);
        res.status(500).json({ error: 'Failed to load rooms' });
    }
});
app.get('/api/my-rooms', authenticateToken, async (req, res) => {
    try {
        const result = await db_1.pool.query(`SELECT r.*, rm.role AS user_role,
        (SELECT COUNT(*) FROM room_messages WHERE room_id=r.id AND created_at > COALESCE((SELECT last_read_at FROM room_reads WHERE user_id=$1 AND room_id=r.id), '1970-01-01') AND sender_id != $1) AS unread_count
       FROM rooms r
       JOIN room_members rm ON r.id = rm.room_id
       WHERE rm.user_id = $1
       ORDER BY r.name`, [req.user.id]);
        res.json({ rooms: result.rows });
    }
    catch {
        // fallback without unread count if view doesn't exist
        try {
            const result = await db_1.pool.query('SELECT r.*, rm.role AS user_role, 0 AS unread_count FROM rooms r JOIN room_members rm ON r.id=rm.room_id WHERE rm.user_id=$1 ORDER BY r.name', [req.user.id]);
            res.json({ rooms: result.rows });
        }
        catch (err) {
            console.error('my-rooms error:', err);
            res.status(500).json({ error: 'Failed to load rooms' });
        }
    }
});
app.post('/api/rooms', authenticateToken, async (req, res) => {
    const { name, description, visibility = 'public' } = req.body;
    if (!name?.trim())
        return res.status(400).json({ error: 'Room name required' });
    if (!['public', 'private'].includes(visibility))
        return res.status(400).json({ error: 'Invalid visibility' });
    try {
        const roomResult = await db_1.pool.query('INSERT INTO rooms (name, description, visibility, owner_id) VALUES ($1,$2,$3,$4) RETURNING *', [name.trim(), description?.trim() ?? null, visibility, req.user.id]);
        const room = roomResult.rows[0];
        // creator becomes admin member
        await db_1.pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,$3)', [room.id, req.user.id, 'admin']);
        res.status(201).json({ room });
    }
    catch (err) {
        if (err.code === '23505')
            return res.status(400).json({ error: 'Room name already taken' });
        console.error('create room error:', err);
        res.status(500).json({ error: 'Failed to create room' });
    }
});
app.get('/api/rooms/:id', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const roomResult = await db_1.pool.query(`SELECT r.*, u.username AS owner_username,
        (SELECT role FROM room_members WHERE room_id=r.id AND user_id=$2) AS user_role
       FROM rooms r LEFT JOIN users u ON r.owner_id=u.id WHERE r.id=$1`, [roomId, req.user.id]);
        if (!roomResult.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        const room = roomResult.rows[0];
        // check ban
        const ban = await db_1.pool.query('SELECT id FROM room_bans WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (ban.rows.length)
            return res.status(403).json({ error: 'You are banned from this room' });
        const members = await db_1.pool.query('SELECT u.id, u.username, u.avatar_color, rm.role FROM room_members rm JOIN users u ON rm.user_id=u.id WHERE rm.room_id=$1 ORDER BY rm.role DESC, u.username', [roomId]);
        res.json({ room, members: members.rows });
    }
    catch (err) {
        console.error('get room error:', err);
        res.status(500).json({ error: 'Failed to load room' });
    }
});
app.put('/api/rooms/:id', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { name, description } = req.body;
    try {
        const mem = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!mem.rows.length || mem.rows[0].role !== 'admin')
            return res.status(403).json({ error: 'Admin access required' });
        const result = await db_1.pool.query('UPDATE rooms SET name=$1, description=$2 WHERE id=$3 RETURNING *', [name?.trim(), description?.trim() ?? null, roomId]);
        io.to('room_' + roomId).emit('room_updated', result.rows[0]);
        res.json({ room: result.rows[0] });
    }
    catch (err) {
        if (err.code === '23505')
            return res.status(400).json({ error: 'Room name already taken' });
        res.status(500).json({ error: 'Failed to update room' });
    }
});
app.delete('/api/rooms/:id', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const room = await db_1.pool.query('SELECT owner_id FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        if (room.rows[0].owner_id !== req.user.id)
            return res.status(403).json({ error: 'Only the owner can delete this room' });
        // Delete physical files before deleting DB records
        const atts = await db_1.pool.query('SELECT a.filename FROM attachments a JOIN messages m ON a.message_id=m.id WHERE m.room_id=$1', [roomId]);
        for (const att of atts.rows) {
            const fp = path.join(UPLOAD_DIR, att.filename);
            if (fs.existsSync(fp))
                fs.unlinkSync(fp);
        }
        await db_1.pool.query('DELETE FROM rooms WHERE id=$1', [roomId]);
        io.to('room_' + roomId).emit('room_deleted', { id: roomId });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('delete room error:', err);
        res.status(500).json({ error: 'Failed to delete room' });
    }
});
app.post('/api/rooms/:id/join', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const room = await db_1.pool.query('SELECT * FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        if (room.rows[0].visibility !== 'public')
            return res.status(403).json({ error: 'This room is private' });
        const ban = await db_1.pool.query('SELECT id FROM room_bans WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (ban.rows.length)
            return res.status(403).json({ error: 'You are banned from this room' });
        await db_1.pool.query('INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES ($1,$2,$3)', [roomId, req.user.id, 'member']);
        io.to('room_' + roomId).emit('member_joined', { userId: req.user.id, username: req.user.username, avatar_color: req.user.avatar_color });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('join room error:', err);
        res.status(500).json({ error: 'Failed to join room' });
    }
});
app.post('/api/rooms/:id/invite', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { userId: inviteeId } = req.body;
    try {
        const mem = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!mem.rows.length)
            return res.status(403).json({ error: 'You are not a member of this room' });
        const room = await db_1.pool.query('SELECT name FROM rooms WHERE id=$1', [roomId]);
        await db_1.pool.query('INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES ($1,$2,$3)', [roomId, inviteeId, 'member']);
        emitToUser(inviteeId, 'room_invitation', { roomId, roomName: room.rows[0]?.name, invitedBy: req.user.username });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('invite error:', err);
        res.status(500).json({ error: 'Failed to invite user' });
    }
});
app.post('/api/rooms/:id/kick', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { userId: kickId } = req.body;
    try {
        const mem = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!mem.rows.length || mem.rows[0].role !== 'admin')
            return res.status(403).json({ error: 'Admin access required' });
        await db_1.pool.query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, kickId]);
        emitToUser(kickId, 'room_kicked', { roomId });
        io.to('room_' + roomId).emit('member_left', { userId: kickId });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('kick error:', err);
        res.status(500).json({ error: 'Failed to kick user' });
    }
});
app.post('/api/rooms/:id/ban', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { userId: banId } = req.body;
    try {
        const mem = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!mem.rows.length || mem.rows[0].role !== 'admin')
            return res.status(403).json({ error: 'Admin access required' });
        await db_1.pool.query('INSERT OR IGNORE INTO room_bans (room_id, user_id, banned_by) VALUES ($1,$2,$3)', [roomId, banId, req.user.id]);
        await db_1.pool.query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, banId]);
        emitToUser(banId, 'room_banned', { roomId });
        io.to('room_' + roomId).emit('member_banned', { userId: banId, bannedBy: req.user.id });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('ban error:', err);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});
app.post('/api/rooms/:id/unban', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { userId: unbanId } = req.body;
    try {
        const mem = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!mem.rows.length || mem.rows[0].role !== 'admin')
            return res.status(403).json({ error: 'Admin access required' });
        await db_1.pool.query('DELETE FROM room_bans WHERE room_id=$1 AND user_id=$2', [roomId, unbanId]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('unban error:', err);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});
app.get('/api/rooms/:id/bans', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const mem = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!mem.rows.length || mem.rows[0].role !== 'admin')
            return res.status(403).json({ error: 'Admin access required' });
        const result = await db_1.pool.query('SELECT rb.user_id, u.username, bu.username AS banned_by_username, rb.created_at FROM room_bans rb JOIN users u ON rb.user_id=u.id LEFT JOIN users bu ON rb.banned_by=bu.id WHERE rb.room_id=$1', [roomId]);
        res.json({ bans: result.rows });
    }
    catch (err) {
        console.error('bans error:', err);
        res.status(500).json({ error: 'Failed to load bans' });
    }
});
// ─── Messages ─────────────────────────────────────────────────
app.get('/api/rooms/:id/messages', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const before = req.query.before;
    const limit = Math.min(parseInt(req.query.limit ?? '50'), 100);
    try {
        const mem = await db_1.pool.query('SELECT id FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!mem.rows.length)
            return res.status(403).json({ error: 'Not a member of this room' });
        const params = [roomId, limit + 1];
        const whereClause = before ? 'AND m.created_at < $3' : '';
        if (before)
            params.push(before);
        const result = await db_1.pool.query(`SELECT m.*, u.username AS sender_username, u.avatar_color AS sender_color,
        rm.content AS reply_content, ru.username AS reply_sender
       FROM messages m
       LEFT JOIN users u  ON m.sender_id  = u.id
       LEFT JOIN messages rm ON m.reply_to = rm.id
       LEFT JOIN users ru ON rm.sender_id = ru.id
       WHERE m.room_id=$1 AND m.deleted_at IS NULL ${whereClause}
       ORDER BY m.created_at DESC LIMIT $2`, params);
        const has_more = result.rows.length > limit;
        const messages = result.rows.slice(0, limit).reverse();
        // attach attachments
        for (const msg of messages) {
            const atts = await db_1.pool.query('SELECT id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE message_id=$1', [msg.id]);
            msg.attachments = atts.rows;
        }
        // update read position
        await db_1.pool.query("INSERT INTO room_reads (user_id, room_id, last_read_at) VALUES ($1,$2,strftime('%Y-%m-%d %H:%M:%S','now')) ON CONFLICT(user_id, room_id) DO UPDATE SET last_read_at=excluded.last_read_at", [req.user.id, roomId]);
        res.json({ messages, has_more });
    }
    catch (err) {
        console.error('messages error:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});
app.put('/api/messages/:id', authenticateToken, async (req, res) => {
    const { content } = req.body;
    if (!content?.trim())
        return res.status(400).json({ error: 'Content required' });
    try {
        const result = await db_1.pool.query("UPDATE messages SET content=$1, edited_at=strftime('%Y-%m-%d %H:%M:%S','now') WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING *", [content.trim().slice(0, MAX_MSG_SIZE), req.params.id, req.user.id]);
        if (!result.rows.length)
            return res.status(404).json({ error: 'Message not found' });
        const full = await buildRoomMessage(result.rows[0].id);
        io.to('room_' + result.rows[0].room_id).emit('message_edited', full);
        res.json({ message: full });
    }
    catch (err) {
        console.error('edit message error:', err);
        res.status(500).json({ error: 'Failed to edit message' });
    }
});
app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
    try {
        const msg = await db_1.pool.query('SELECT * FROM messages WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
        if (!msg.rows.length)
            return res.status(404).json({ error: 'Message not found' });
        const m = msg.rows[0];
        const mem = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [m.room_id, req.user.id]);
        const isAdmin = mem.rows[0]?.role === 'admin';
        const isOwner = m.sender_id === req.user.id;
        if (!isOwner && !isAdmin)
            return res.status(403).json({ error: 'Cannot delete this message' });
        await db_1.pool.query("UPDATE messages SET deleted_at=strftime('%Y-%m-%d %H:%M:%S','now'), content='[deleted]' WHERE id=$1", [req.params.id]);
        io.to('room_' + m.room_id).emit('message_deleted', { id: m.id });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('delete message error:', err);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});
// ─── Personal Messages ────────────────────────────────────────
app.get('/api/messages/personal/:userId', authenticateToken, async (req, res) => {
    const otherId = parseInt(req.params.userId);
    const before = req.query.before;
    const limit = Math.min(parseInt(req.query.limit ?? '50'), 100);
    try {
        const params = [req.user.id, otherId, limit + 1];
        const whereClause = before ? 'AND pm.created_at < $4' : '';
        if (before)
            params.push(before);
        const result = await db_1.pool.query(`SELECT pm.*, su.username AS sender_username, su.avatar_color AS sender_color,
        rm.content AS reply_content, ru.username AS reply_sender
       FROM personal_messages pm
       LEFT JOIN users su ON pm.sender_id = su.id
       LEFT JOIN personal_messages rm ON pm.reply_to = rm.id
       LEFT JOIN users ru ON rm.sender_id = ru.id
       WHERE ((pm.sender_id=$1 AND pm.receiver_id=$2) OR (pm.sender_id=$2 AND pm.receiver_id=$1))
         AND pm.deleted_at IS NULL ${whereClause}
       ORDER BY pm.created_at DESC LIMIT $3`, params);
        const has_more = result.rows.length > limit;
        const messages = result.rows.slice(0, limit).reverse();
        for (const msg of messages) {
            const atts = await db_1.pool.query('SELECT id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE personal_message_id=$1', [msg.id]);
            msg.attachments = atts.rows;
        }
        await db_1.pool.query("INSERT INTO dm_reads (user_id, other_user_id, last_read_at) VALUES ($1,$2,strftime('%Y-%m-%d %H:%M:%S','now')) ON CONFLICT(user_id, other_user_id) DO UPDATE SET last_read_at=excluded.last_read_at", [req.user.id, otherId]);
        res.json({ messages, has_more });
    }
    catch (err) {
        console.error('personal messages error:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});
app.put('/api/personal-messages/:id', authenticateToken, async (req, res) => {
    const { content } = req.body;
    if (!content?.trim())
        return res.status(400).json({ error: 'Content required' });
    try {
        const result = await db_1.pool.query("UPDATE personal_messages SET content=$1, edited_at=strftime('%Y-%m-%d %H:%M:%S','now') WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING *", [content.trim().slice(0, MAX_MSG_SIZE), req.params.id, req.user.id]);
        if (!result.rows.length)
            return res.status(404).json({ error: 'Message not found' });
        const full = await buildPersonalMessage(result.rows[0].id);
        emitToUser(result.rows[0].sender_id, 'personal_message_edited', full);
        emitToUser(result.rows[0].receiver_id, 'personal_message_edited', full);
        res.json({ message: full });
    }
    catch (err) {
        console.error('edit personal message error:', err);
        res.status(500).json({ error: 'Failed to edit message' });
    }
});
app.delete('/api/personal-messages/:id', authenticateToken, async (req, res) => {
    try {
        const msg = await db_1.pool.query('SELECT * FROM personal_messages WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
        if (!msg.rows.length)
            return res.status(404).json({ error: 'Message not found' });
        const m = msg.rows[0];
        if (m.sender_id !== req.user.id)
            return res.status(403).json({ error: 'Cannot delete this message' });
        await db_1.pool.query("UPDATE personal_messages SET deleted_at=strftime('%Y-%m-%d %H:%M:%S','now'), content='[deleted]' WHERE id=$1", [req.params.id]);
        emitToUser(m.sender_id, 'personal_message_deleted', { id: m.id });
        emitToUser(m.receiver_id, 'personal_message_deleted', { id: m.id });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('delete personal message error:', err);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});
// ─── File Upload ──────────────────────────────────────────────
app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: 'No file provided' });
    try {
        const ext = path.extname(req.file.originalname).toLowerCase();
        const is_image = IMAGE_EXTS.includes(ext) ? 1 : 0;
        const result = await db_1.pool.query('INSERT INTO attachments (uploader_id, filename, original_filename, size, mimetype, is_image) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [req.user.id, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, is_image]);
        res.json({ attachment: result.rows[0] });
    }
    catch (err) {
        console.error('upload error:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});
// ─── Leave Room ───────────────────────────────────────────────
app.post('/api/rooms/:id/leave', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const room = await db_1.pool.query('SELECT owner_id FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        if (room.rows[0].owner_id === req.user.id)
            return res.status(400).json({ error: 'Owner cannot leave. Delete the room instead.' });
        await db_1.pool.query('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        io.to('room_' + roomId).emit('member_left', { userId: req.user.id });
        res.json({ ok: true });
    }
    catch (err) {
        console.error('leave room error:', err);
        res.status(500).json({ error: 'Failed to leave room' });
    }
});
// ─── Admin Management ─────────────────────────────────────────
// Get list of room admins
app.get('/api/rooms/:id/admins', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const room = await db_1.pool.query('SELECT id FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        const admins = await db_1.pool.query('SELECT rm.user_id, u.username, u.avatar_color FROM room_members rm JOIN users u ON rm.user_id = u.id WHERE rm.room_id = $1 AND rm.role = $2', [roomId, 'admin']);
        res.json({ admins: admins.rows });
    }
    catch (err) {
        console.error('get admins error:', err);
        res.status(500).json({ error: 'Failed to get admins' });
    }
});
// Get room members
app.get('/api/rooms/:id/members', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const room = await db_1.pool.query('SELECT id FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        const members = await db_1.pool.query('SELECT u.id, u.username, u.avatar_color, rm.role FROM room_members rm JOIN users u ON rm.user_id=u.id WHERE rm.room_id=$1 ORDER BY rm.role DESC, u.username', [roomId]);
        res.json({ members: members.rows });
    }
    catch (err) {
        console.error('get members error:', err);
        res.status(500).json({ error: 'Failed to get members' });
    }
});
// Remove admin (demote to member)
app.post('/api/rooms/:id/remove-admin', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { userId: targetId } = req.body;
    try {
        const room = await db_1.pool.query('SELECT owner_id FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        // Check if user is owner or admin
        const member = await db_1.pool.query('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.id]);
        if (!member.rows.length)
            return res.status(403).json({ error: 'You are not a member of this room' });
        const isOwner = room.rows[0].owner_id === req.user.id;
        const isAdmin = member.rows[0].role === 'admin';
        if (!isOwner && !isAdmin)
            return res.status(403).json({ error: 'Admin access required' });
        if (room.rows[0].owner_id === targetId)
            return res.status(400).json({ error: 'Cannot remove the owner' });
        await db_1.pool.query('UPDATE room_members SET role=$1 WHERE room_id=$2 AND user_id=$3', ['member', roomId, targetId]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('remove admin error:', err);
        res.status(500).json({ error: 'Failed to remove admin' });
    }
});
app.post('/api/rooms/:id/promote', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { userId: targetId } = req.body;
    try {
        const room = await db_1.pool.query('SELECT owner_id FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        if (room.rows[0].owner_id !== req.user.id)
            return res.status(403).json({ error: 'Only the owner can promote admins' });
        await db_1.pool.query('UPDATE room_members SET role=$1 WHERE room_id=$2 AND user_id=$3', ['admin', roomId, targetId]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('promote error:', err);
        res.status(500).json({ error: 'Failed to promote user' });
    }
});
app.post('/api/rooms/:id/demote', authenticateToken, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { userId: targetId } = req.body;
    try {
        const room = await db_1.pool.query('SELECT owner_id FROM rooms WHERE id=$1', [roomId]);
        if (!room.rows.length)
            return res.status(404).json({ error: 'Room not found' });
        if (room.rows[0].owner_id !== req.user.id)
            return res.status(403).json({ error: 'Only the owner can demote admins' });
        if (room.rows[0].owner_id === targetId)
            return res.status(400).json({ error: 'Cannot demote the owner' });
        await db_1.pool.query('UPDATE room_members SET role=$1 WHERE room_id=$2 AND user_id=$3', ['member', roomId, targetId]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('demote error:', err);
        res.status(500).json({ error: 'Failed to demote user' });
    }
});
// ─── Remove Friend ────────────────────────────────────────────
app.delete('/api/contacts/:userId', authenticateToken, async (req, res) => {
    const friendId = parseInt(req.params.userId);
    try {
        await db_1.pool.query('DELETE FROM contacts WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.user.id, friendId]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error('remove friend error:', err);
        res.status(500).json({ error: 'Failed to remove friend' });
    }
});
// ─── Protected File Access ────────────────────────────────────
app.get('/uploads/:filename', async (req, res) => {
    const filename = req.params.filename;
    const queryToken = req.query.t;
    const headerToken = req.headers['authorization']?.split(' ')[1];
    const token = queryToken || headerToken;
    // Prevent path traversal attacks
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    // Authenticate using token from query param or header
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userResult = await db_1.pool.query('SELECT id, email, username, avatar_color FROM users WHERE id = $1', [decoded.userId]);
        if (!userResult.rows.length) {
            return res.status(403).json({ error: 'User not found' });
        }
        req.user = userResult.rows[0];
        req.token = token;
        const userId = req.user.id;
        const access = await db_1.pool.query(`SELECT a.id FROM attachments a
       LEFT JOIN messages m ON a.message_id = m.id
       LEFT JOIN room_members rm ON m.room_id = rm.room_id AND rm.user_id = $2
       LEFT JOIN personal_messages pm ON a.personal_message_id = pm.id
       WHERE a.filename = $1
         AND (rm.user_id = $2 OR pm.sender_id = $2 OR pm.receiver_id = $2 OR a.uploader_id = $2)
       LIMIT 1`, [filename, userId]);
        if (!access.rows.length)
            return res.status(403).json({ error: 'Access denied' });
        const filePath = path.resolve(UPLOAD_DIR, filename);
        if (!fs.existsSync(filePath))
            return res.status(404).json({ error: 'File not found' });
        res.sendFile(filePath);
    }
    catch (err) {
        console.error('file access error:', err);
        res.status(500).json({ error: 'Failed to serve file' });
    }
});
// ─── Start ────────────────────────────────────────────────────
async function start() {
    try {
        (0, db_1.initDatabase)();
        server.listen(PORT, () => console.log(`ClassicChat running on port ${PORT}`));
    }
    catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}
start();
