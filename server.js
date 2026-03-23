const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { pool, initDatabase } = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_in_production_please';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '20971520');
const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE || '3145728');
const MAX_MSG_SIZE = 3072;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── File Upload ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT id, email, username, avatar_color FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (result.rows.length === 0) return res.status(403).json({ error: 'User not found' });
    const sessionResult = await pool.query(
      "SELECT id FROM sessions WHERE token = $1 AND expires_at > strftime('%Y-%m-%d %H:%M:%S', 'now')",
      [token]
    );
    if (sessionResult.rows.length === 0) return res.status(403).json({ error: 'Session expired' });
    req.user = result.rows[0];
    req.token = token;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// ─── Socket Presence Tracking (multi-tab) ────────────────────────────────────
const userToSockets = new Map(); // userId -> Set<socketId>
const userLastActivity = new Map(); // userId -> timestamp

function addUserSocket(userId, socketId) {
  if (!userToSockets.has(userId)) userToSockets.set(userId, new Set());
  userToSockets.get(userId).add(socketId);
  if (!userLastActivity.has(userId)) userLastActivity.set(userId, Date.now());
}

function removeUserSocket(userId, socketId) {
  const sockets = userToSockets.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) userToSockets.delete(userId);
}

function getUserStatus(userId) {
  const sockets = userToSockets.get(userId);
  if (!sockets || sockets.size === 0) return 'offline';
  const last = userLastActivity.get(userId) || 0;
  return (Date.now() - last > 60000) ? 'afk' : 'online';
}

function emitToUser(userId, event, data) {
  io.to('user_' + userId).emit(event, data);
}

async function broadcastPresence(userId) {
  const status = getUserStatus(userId);
  try {
    const result = await pool.query(
      "SELECT friend_id as fid FROM contacts WHERE user_id = $1 AND status = 'accepted'" +
      " UNION SELECT user_id as fid FROM contacts WHERE friend_id = $1 AND status = 'accepted'",
      [userId]
    );
    for (const row of result.rows) {
      emitToUser(row.fid, 'presence_update', { userId, status });
    }
  } catch (e) { /* ignore */ }
}

// AFK check every 30s
setInterval(() => {
  for (const [userId] of userToSockets) {
    broadcastPresence(userId);
  }
}, 30000);

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.userId;
      socket.userId = userId;
      addUserSocket(userId, socket.id);
      socket.join('user_' + userId);
      broadcastPresence(userId);
      // Auto-join all socket rooms the user is a member of
      const rooms = await pool.query('SELECT room_id FROM room_members WHERE user_id = $1', [userId]);
      rooms.rows.forEach(r => socket.join('room_' + r.room_id));
    } catch (e) { /* invalid token */ }
  });

  socket.on('activity', () => {
    if (socket.userId) {
      const wasAfk = getUserStatus(socket.userId) === 'afk';
      userLastActivity.set(socket.userId, Date.now());
      if (wasAfk) broadcastPresence(socket.userId);
    }
  });

  socket.on('join_room', (roomId) => {
    if (socket.userId) socket.join('room_' + roomId);
  });

  socket.on('leave_room', (roomId) => {
    if (socket.userId) socket.leave('room_' + roomId);
  });

  socket.on('send_message', async (data) => {
    if (!socket.userId) return;
    const { roomId, content, replyTo, attachmentId } = data;
    if (!content && !attachmentId) return;
    const text = (content || '').slice(0, MAX_MSG_SIZE);

    try {
      const mem = await pool.query(
        'SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, socket.userId]
      );
      if (!mem.rows.length) return;

      const msgResult = await pool.query(
        'INSERT INTO messages (room_id, sender_id, content, reply_to) VALUES ($1, $2, $3, $4) RETURNING *',
        [roomId, socket.userId, text, replyTo || null]
      );
      const message = msgResult.rows[0];

      if (attachmentId) {
        await pool.query(
          'UPDATE attachments SET message_id = $1 WHERE id = $2 AND uploader_id = $3 AND message_id IS NULL',
          [message.id, attachmentId, socket.userId]
        );
      }

      const full = await buildRoomMessage(message.id);
      io.to('room_' + roomId).emit('message', full);
    } catch (e) { console.error('send_message error:', e); }
  });

  socket.on('send_personal_message', async (data) => {
    if (!socket.userId) return;
    const { receiverId, content, replyTo, attachmentId } = data;
    if (!content && !attachmentId) return;
    const text = (content || '').slice(0, MAX_MSG_SIZE);

    try {
      const canMsg = await canMessageUser(socket.userId, receiverId);
      if (!canMsg) {
        socket.emit('error', { message: 'Cannot send message to this user' });
        return;
      }

      const msgResult = await pool.query(
        'INSERT INTO personal_messages (sender_id, receiver_id, content, reply_to) VALUES ($1, $2, $3, $4) RETURNING *',
        [socket.userId, receiverId, text, replyTo || null]
      );
      const message = msgResult.rows[0];

      if (attachmentId) {
        await pool.query(
          'UPDATE attachments SET personal_message_id = $1 WHERE id = $2 AND uploader_id = $3 AND personal_message_id IS NULL AND message_id IS NULL',
          [message.id, attachmentId, socket.userId]
        );
      }

      const full = await buildPersonalMessage(message.id);
      emitToUser(socket.userId, 'personal_message', full);
      emitToUser(receiverId, 'personal_message', full);
    } catch (e) { console.error('send_personal_message error:', e); }
  });

  socket.on('typing', (data) => {
    if (!socket.userId) return;
    if (data.roomId) {
      socket.to('room_' + data.roomId).emit('typing', { userId: socket.userId, username: data.username, roomId: data.roomId });
    } else if (data.receiverId) {
      emitToUser(data.receiverId, 'typing', { userId: socket.userId, username: data.username });
    }
  });

  socket.on('stop_typing', (data) => {
    if (!socket.userId) return;
    if (data.roomId) {
      socket.to('room_' + data.roomId).emit('stop_typing', { userId: socket.userId, roomId: data.roomId });
    } else if (data.receiverId) {
      emitToUser(data.receiverId, 'stop_typing', { userId: socket.userId });
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      removeUserSocket(socket.userId, socket.id);
      broadcastPresence(socket.userId);
    }
  });
});

// ─── Query Helpers ────────────────────────────────────────────────────────────

async function buildRoomMessage(messageId) {
  const result = await pool.query(
    'SELECT m.*, u.username as sender_username, u.avatar_color as sender_color,' +
    ' rm.content as reply_content, ru.username as reply_sender' +
    ' FROM messages m' +
    ' LEFT JOIN users u ON m.sender_id = u.id' +
    ' LEFT JOIN messages rm ON m.reply_to = rm.id' +
    ' LEFT JOIN users ru ON rm.sender_id = ru.id' +
    ' WHERE m.id = $1',
    [messageId]
  );
  const msg = result.rows[0];
  if (!msg) return null;
  const atts = await pool.query(
    'SELECT id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE message_id = $1',
    [messageId]
  );
  msg.attachments = atts.rows;
  return msg;
}

async function buildPersonalMessage(messageId) {
  const result = await pool.query(
    'SELECT pm.*, su.username as sender_username, su.avatar_color as sender_color,' +
    ' rm.content as reply_content, ru.username as reply_sender' +
    ' FROM personal_messages pm' +
    ' LEFT JOIN users su ON pm.sender_id = su.id' +
    ' LEFT JOIN personal_messages rm ON pm.reply_to = rm.id' +
    ' LEFT JOIN users ru ON rm.sender_id = ru.id' +
    ' WHERE pm.id = $1',
    [messageId]
  );
  const msg = result.rows[0];
  if (!msg) return null;
  const atts = await pool.query(
    'SELECT id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE personal_message_id = $1',
    [messageId]
  );
  msg.attachments = atts.rows;
  return msg;
}

async function isUserBlocked(userId, otherUserId) {
  const result = await pool.query(
    'SELECT id FROM blocks WHERE (user_id = $1 AND blocked_id = $2) OR (user_id = $2 AND blocked_id = $1)',
    [userId, otherUserId]
  );
  return result.rows.length > 0;
}

async function areFriends(userId, otherUserId) {
  const result = await pool.query(
    "SELECT id FROM contacts WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)) AND status = 'accepted'",
    [userId, otherUserId]
  );
  return result.rows.length > 0;
}

async function canMessageUser(userId, otherUserId) {
  if (await isUserBlocked(userId, otherUserId)) return false;
  return areFriends(userId, otherUserId);
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.get('/api/auth/check-username/:username', async (req, res) => {
  const { username } = req.params;
  if (!username || username.length < 3) return res.json({ available: false });
  try {
    const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    res.json({ available: result.rows.length === 0 });
  } catch {
    res.json({ available: null });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username)
    return res.status(400).json({ error: 'Email, password, and username are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
    return res.status(400).json({ error: 'Username: 3-30 characters, letters/digits/underscore only' });

  try {
    const hashed = await bcrypt.hash(password, 12);
    const colors = ['#6366f1','#ec4899','#14b8a6','#f59e0b','#ef4444','#22c55e','#3b82f6','#8b5cf6'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const result = await pool.query(
      'INSERT INTO users (email, username, password_hash, avatar_color) VALUES ($1, $2, $3, $4) RETURNING id, email, username, avatar_color',
      [email.toLowerCase().trim(), username.trim(), hashed, color]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      const c = (error.constraint || '').toLowerCase();
      if (c.includes('email')) return res.status(400).json({ error: 'Email already registered' });
      if (c.includes('username')) return res.status(400).json({ error: 'Username already taken' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    await pool.query(
      'INSERT INTO sessions (user_id, token, expires_at, user_agent, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [user.id, token, expiresAt, req.headers['user-agent'] || '', req.ip || '']
    );
    res.json({ token, user: { id: user.id, email: user.email, username: user.username, avatar_color: user.avatar_color } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
    res.json({ message: 'Logged out' });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

app.put('/api/auth/password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!await bcrypt.compare(currentPassword, result.rows[0].password_hash))
      return res.status(400).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, req.user.id]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [req.user.id, req.token]);
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.delete('/api/auth/account', authenticateToken, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required to confirm deletion' });

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!await bcrypt.compare(password, result.rows[0].password_hash))
      return res.status(400).json({ error: 'Incorrect password' });

    // Delete files from owned rooms
    const rooms = await pool.query('SELECT id FROM rooms WHERE owner_id = $1', [req.user.id]);
    for (const room of rooms.rows) {
      const atts = await pool.query(
        'SELECT filename FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE room_id = $1)',
        [room.id]
      );
      for (const att of atts.rows) {
        const fp = path.join(UPLOAD_DIR, att.filename);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { /* ignore */ }
      }
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    res.json({ message: 'Account deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

// ─── User Routes ──────────────────────────────────────────────────────────────

// Specific routes BEFORE parameterized /:username
app.get('/api/users/sessions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, user_agent, ip_address, created_at, expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ sessions: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

app.delete('/api/users/sessions/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Session removed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove session' });
  }
});

app.get('/api/users/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  try {
    const result = await pool.query(
      'SELECT id, username, avatar_color FROM users WHERE username LIKE $1 AND id != $2 LIMIT 20',
      ['%' + q + '%', req.user.id]
    );
    const users = result.rows.map(u => ({ ...u, status: getUserStatus(u.id) }));
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/users/:username', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, avatar_color FROM users WHERE username = $1',
      [req.params.username]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = { ...result.rows[0], status: getUserStatus(result.rows[0].id) };
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ─── Contact Routes ───────────────────────────────────────────────────────────

app.get('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT c.id, c.status, c.request_message, c.created_at,' +
      '       u.id as user_id, u.username, u.avatar_color,' +
      "       CASE WHEN c.user_id = $1 THEN 'outgoing' ELSE 'incoming' END as direction," +
      '       (SELECT COUNT(*) FROM personal_messages pm' +
      '        LEFT JOIN dm_reads dr ON dr.user_id = $1 AND dr.other_user_id = u.id' +
      '        WHERE pm.sender_id = u.id AND pm.receiver_id = $1 AND pm.deleted_at IS NULL' +
      '          AND (dr.last_read_at IS NULL OR pm.created_at > dr.last_read_at)) as unread_count' +
      ' FROM contacts c' +
      ' JOIN users u ON (c.user_id = $1 AND c.friend_id = u.id) OR (c.friend_id = $1 AND c.user_id = u.id)' +
      ' WHERE c.user_id = $1 OR c.friend_id = $1' +
      ' ORDER BY u.username',
      [req.user.id]
    );
    const contacts = result.rows.map(c => ({ ...c, online_status: getUserStatus(c.user_id) }));
    res.json({ contacts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

app.post('/api/contacts/request', authenticateToken, async (req, res) => {
  const { username, message } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });

    const friendId = userResult.rows[0].id;
    if (friendId === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
    if (await isUserBlocked(req.user.id, friendId))
      return res.status(400).json({ error: 'Cannot add this user' });

    // Auto-accept if reverse pending request exists
    const reverse = await pool.query(
      "SELECT id FROM contacts WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'",
      [friendId, req.user.id]
    );
    if (reverse.rows.length) {
      await pool.query("UPDATE contacts SET status = 'accepted' WHERE id = $1", [reverse.rows[0].id]);
      emitToUser(friendId, 'contact_accepted', { userId: req.user.id, username: req.user.username });
      return res.json({ message: 'Friend request accepted (they already sent you one)' });
    }

    await pool.query(
      'INSERT INTO contacts (user_id, friend_id, status, request_message) VALUES ($1, $2, $3, $4)',
      [req.user.id, friendId, 'pending', message || null]
    );
    emitToUser(friendId, 'friend_request', {
      userId: req.user.id,
      username: req.user.username,
      avatar_color: req.user.avatar_color,
      message: message || null
    });
    res.json({ message: 'Friend request sent' });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Request already sent' });
    res.status(500).json({ error: 'Failed to send request' });
  }
});

app.put('/api/contacts/request/:id', authenticateToken, async (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'rejected'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  try {
    const result = await pool.query(
      "UPDATE contacts SET status = $1 WHERE id = $2 AND friend_id = $3 AND status = 'pending' RETURNING *",
      [status, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Request not found' });
    if (status === 'accepted') {
      emitToUser(result.rows[0].user_id, 'contact_accepted', { userId: req.user.id, username: req.user.username });
    }
    res.json({ message: 'Request ' + status });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update request' });
  }
});

app.delete('/api/contacts/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM contacts WHERE id = $1 AND (user_id = $2 OR friend_id = $2)',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Contact removed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove contact' });
  }
});

app.post('/api/blocks', authenticateToken, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    await pool.query('INSERT INTO blocks (user_id, blocked_id) VALUES ($1, $2)', [req.user.id, userId]);
    await pool.query(
      'DELETE FROM contacts WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.user.id, userId]
    );
    res.json({ message: 'User blocked' });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Already blocked' });
    res.status(500).json({ error: 'Failed to block user' });
  }
});

app.delete('/api/blocks/:userId', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM blocks WHERE user_id = $1 AND blocked_id = $2', [req.user.id, req.params.userId]);
    res.json({ message: 'User unblocked' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// ─── Room Routes ──────────────────────────────────────────────────────────────

app.get('/api/rooms', authenticateToken, async (req, res) => {
  const { search } = req.query;
  try {
    let query =
      'SELECT r.id, r.name, r.description, r.visibility, r.created_at,' +
      '       (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as member_count,' +
      '       (SELECT username FROM users WHERE id = r.owner_id) as owner_username,' +
      '       (SELECT id FROM room_members WHERE room_id = r.id AND user_id = $1) as is_member' +
      " FROM rooms r WHERE r.visibility = 'public'";
    const params = [req.user.id];
    if (search) {
      params.push('%' + search + '%');
      query += ' AND (r.name LIKE $' + params.length + ' OR r.description LIKE $' + params.length + ')';
    }
    query += ' ORDER BY member_count DESC, r.name';
    const result = await pool.query(query, params);
    res.json({ rooms: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get rooms' });
  }
});

app.get('/api/my-rooms', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT r.id, r.name, r.description, r.visibility, rm.role,' +
      '       (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as member_count,' +
      '       (SELECT COUNT(*) FROM messages m' +
      '        LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = $1' +
      '        WHERE m.room_id = r.id AND m.deleted_at IS NULL' +
      '          AND (rr.last_read_at IS NULL OR m.created_at > rr.last_read_at)) as unread_count' +
      ' FROM room_members rm JOIN rooms r ON rm.room_id = r.id' +
      ' WHERE rm.user_id = $1 ORDER BY r.name',
      [req.user.id]
    );
    res.json({ rooms: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get rooms' });
  }
});

app.post('/api/rooms', authenticateToken, async (req, res) => {
  const { name, description, visibility } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name required' });
  if (name.length > 50) return res.status(400).json({ error: 'Room name too long (50 chars max)' });

  try {
    const result = await pool.query(
      'INSERT INTO rooms (name, description, visibility, owner_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), description || '', visibility === 'private' ? 'private' : 'public', req.user.id]
    );
    const room = result.rows[0];
    await pool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)',
      [room.id, req.user.id, 'admin']
    );
    res.status(201).json({ room });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Room name already taken' });
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.get('/api/rooms/:id', authenticateToken, async (req, res) => {
  try {
    const roomResult = await pool.query(
      'SELECT r.*, (SELECT username FROM users WHERE id = r.owner_id) as owner_username,' +
      '       (SELECT role FROM room_members WHERE room_id = r.id AND user_id = $2) as user_role' +
      ' FROM rooms r WHERE r.id = $1',
      [req.params.id, req.user.id]
    );
    if (!roomResult.rows.length) return res.status(404).json({ error: 'Room not found' });
    const room = roomResult.rows[0];

    const ban = await pool.query('SELECT id FROM room_bans WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (ban.rows.length) return res.status(403).json({ error: 'You are banned from this room' });

    if (!room.user_role && room.visibility === 'private')
      return res.status(403).json({ error: 'Not a member' });

    const membersResult = await pool.query(
      'SELECT u.id, u.username, u.avatar_color, rm.role FROM room_members rm' +
      ' JOIN users u ON rm.user_id = u.id' +
      ' WHERE rm.room_id = $1 ORDER BY rm.role DESC, u.username',
      [req.params.id]
    );
    const members = membersResult.rows.map(m => ({ ...m, status: getUserStatus(m.id) }));
    res.json({ room, members });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get room' });
  }
});

app.put('/api/rooms/:id', authenticateToken, async (req, res) => {
  const { name, description } = req.body;
  try {
    const roomResult = await pool.query('SELECT owner_id FROM rooms WHERE id = $1', [req.params.id]);
    if (!roomResult.rows.length) return res.status(404).json({ error: 'Room not found' });
    if (roomResult.rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Owner only' });

    const result = await pool.query(
      'UPDATE rooms SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3 RETURNING *',
      [name || null, description !== undefined ? description : null, req.params.id]
    );
    io.to('room_' + req.params.id).emit('room_updated', result.rows[0]);
    res.json({ room: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Room name already taken' });
    res.status(500).json({ error: 'Failed to update room' });
  }
});

app.delete('/api/rooms/:id', authenticateToken, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT owner_id FROM rooms WHERE id = $1', [req.params.id]);
    if (!roomResult.rows.length) return res.status(404).json({ error: 'Room not found' });
    if (roomResult.rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Owner only' });

    const atts = await pool.query(
      'SELECT filename FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE room_id = $1)',
      [req.params.id]
    );
    for (const att of atts.rows) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, att.filename)); } catch (e) { /* ignore */ }
    }
    await pool.query('DELETE FROM rooms WHERE id = $1', [req.params.id]);
    io.to('room_' + req.params.id).emit('room_deleted', { id: parseInt(req.params.id) });
    res.json({ message: 'Room deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

app.post('/api/rooms/:id/join', authenticateToken, async (req, res) => {
  try {
    const roomResult = await pool.query('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
    if (!roomResult.rows.length) return res.status(404).json({ error: 'Room not found' });
    const room = roomResult.rows[0];

    const ban = await pool.query('SELECT id FROM room_bans WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (ban.rows.length) return res.status(403).json({ error: 'You are banned from this room' });

    const existing = await pool.query('SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (existing.rows.length) return res.json({ message: 'Already a member' });

    if (room.visibility === 'private') {
      const inv = await pool.query('SELECT id FROM room_invitations WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (!inv.rows.length) return res.status(403).json({ error: 'Invitation required' });
    }

    await pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [req.params.id, req.user.id, 'member']);
    io.to('room_' + req.params.id).emit('member_joined', { userId: req.user.id, username: req.user.username, avatar_color: req.user.avatar_color });
    // Join socket room for all user's sockets
    const userSocks = userToSockets.get(req.user.id);
    if (userSocks) userSocks.forEach(sid => io.sockets.sockets.get(sid)?.join('room_' + req.params.id));
    res.json({ message: 'Joined successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to join room' });
  }
});

app.post('/api/rooms/:id/leave', authenticateToken, async (req, res) => {
  try {
    const room = await pool.query('SELECT owner_id FROM rooms WHERE id = $1', [req.params.id]);
    if (!room.rows.length) return res.status(404).json({ error: 'Room not found' });
    if (room.rows[0].owner_id === req.user.id)
      return res.status(400).json({ error: 'Owner cannot leave — delete the room instead' });

    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    io.to('room_' + req.params.id).emit('member_left', { userId: req.user.id, username: req.user.username });
    res.json({ message: 'Left room' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to leave room' });
  }
});

app.post('/api/rooms/:id/ban', authenticateToken, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const myMem = await pool.query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!myMem.rows.length || myMem.rows[0].role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });

    const room = await pool.query('SELECT owner_id FROM rooms WHERE id = $1', [req.params.id]);
    if (room.rows[0].owner_id === parseInt(userId)) return res.status(400).json({ error: 'Cannot ban room owner' });

    await pool.query('INSERT INTO room_bans (room_id, user_id, banned_by) VALUES ($1, $2, $3)', [req.params.id, userId, req.user.id]);
    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, userId]);
    emitToUser(parseInt(userId), 'room_banned', { roomId: parseInt(req.params.id) });
    io.to('room_' + req.params.id).emit('member_banned', { userId: parseInt(userId), bannedBy: req.user.username });
    res.json({ message: 'User banned' });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Already banned' });
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

app.post('/api/rooms/:id/unban', authenticateToken, async (req, res) => {
  const { userId } = req.body;
  try {
    const myMem = await pool.query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!myMem.rows.length || myMem.rows[0].role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });

    await pool.query('DELETE FROM room_bans WHERE room_id = $1 AND user_id = $2', [req.params.id, userId]);
    res.json({ message: 'User unbanned' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

app.get('/api/rooms/:id/bans', authenticateToken, async (req, res) => {
  try {
    const myMem = await pool.query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!myMem.rows.length || myMem.rows[0].role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });

    const result = await pool.query(
      'SELECT rb.id, rb.created_at, u.id as user_id, u.username,' +
      '       (SELECT username FROM users WHERE id = rb.banned_by) as banned_by_username' +
      ' FROM room_bans rb JOIN users u ON rb.user_id = u.id WHERE rb.room_id = $1',
      [req.params.id]
    );
    res.json({ bans: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get bans' });
  }
});

app.post('/api/rooms/:id/kick', authenticateToken, async (req, res) => {
  const { userId } = req.body;
  try {
    const myMem = await pool.query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!myMem.rows.length || myMem.rows[0].role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });

    const room = await pool.query('SELECT owner_id FROM rooms WHERE id = $1', [req.params.id]);
    if (room.rows[0].owner_id === parseInt(userId)) return res.status(400).json({ error: 'Cannot kick room owner' });

    await pool.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, userId]);
    emitToUser(parseInt(userId), 'room_kicked', { roomId: parseInt(req.params.id) });
    io.to('room_' + req.params.id).emit('member_left', { userId: parseInt(userId) });
    res.json({ message: 'Member removed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

app.post('/api/rooms/:id/admins', authenticateToken, async (req, res) => {
  const { userId, action } = req.body;
  try {
    const room = await pool.query('SELECT owner_id FROM rooms WHERE id = $1', [req.params.id]);
    if (room.rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Owner only' });
    if (parseInt(userId) === req.user.id) return res.status(400).json({ error: 'Cannot change own role' });

    const role = action === 'add' ? 'admin' : 'member';
    await pool.query('UPDATE room_members SET role = $1 WHERE room_id = $2 AND user_id = $3', [role, req.params.id, userId]);
    res.json({ message: 'Admin updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update admin' });
  }
});

app.post('/api/rooms/:id/invite', authenticateToken, async (req, res) => {
  const { userId } = req.body;
  try {
    const mem = await pool.query('SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!mem.rows.length) return res.status(403).json({ error: 'Not a member' });

    const existing = await pool.query('SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, userId]);
    if (existing.rows.length) return res.status(400).json({ error: 'User is already a member' });

    await pool.query(
      'INSERT INTO room_invitations (room_id, user_id, invited_by) VALUES ($1, $2, $3)',
      [req.params.id, userId, req.user.id]
    );
    const roomResult = await pool.query('SELECT name FROM rooms WHERE id = $1', [req.params.id]);
    emitToUser(parseInt(userId), 'room_invitation', {
      roomId: parseInt(req.params.id),
      roomName: roomResult.rows[0]?.name,
      invitedBy: req.user.username
    });
    res.json({ message: 'Invitation sent' });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Already invited' });
    res.status(500).json({ error: 'Failed to invite' });
  }
});

// ─── Message Routes ───────────────────────────────────────────────────────────

app.get('/api/rooms/:id/messages', authenticateToken, async (req, res) => {
  const { before, limit = 50 } = req.query;
  const pageSize = Math.min(parseInt(limit) || 50, 100);

  try {
    const mem = await pool.query('SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!mem.rows.length) return res.status(403).json({ error: 'Not a member' });

    let query =
      'SELECT m.id, m.room_id, m.sender_id, m.content, m.reply_to, m.created_at, m.edited_at,' +
      '       u.username as sender_username, u.avatar_color as sender_color,' +
      '       rm.content as reply_content, ru.username as reply_sender' +
      ' FROM messages m' +
      ' LEFT JOIN users u ON m.sender_id = u.id' +
      ' LEFT JOIN messages rm ON m.reply_to = rm.id' +
      ' LEFT JOIN users ru ON rm.sender_id = ru.id' +
      ' WHERE m.room_id = $1 AND m.deleted_at IS NULL';
    const params = [req.params.id];

    if (before) {
      params.push(before);
      query += ' AND m.created_at < $' + params.length;
    }
    params.push(pageSize);
    query += ' ORDER BY m.created_at DESC LIMIT $' + params.length;

    const result = await pool.query(query, params);
    const messages = result.rows.reverse();

    // Batch-load attachments
    if (messages.length) {
      const ids = messages.map(m => m.id);
      const qs = ids.map((_, i) => '$' + (i + 1)).join(',');
      const atts = await pool.query(
        'SELECT id, message_id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE message_id IN (' + qs + ')',
        ids
      );
      const attMap = {};
      atts.rows.forEach(a => { (attMap[a.message_id] = attMap[a.message_id] || []).push(a); });
      messages.forEach(m => { m.attachments = attMap[m.id] || []; });
    }

    // Mark as read
    await pool.query(
      "INSERT INTO room_reads (user_id, room_id, last_read_at) VALUES ($1, $2, datetime('now'))" +
      " ON CONFLICT(user_id, room_id) DO UPDATE SET last_read_at = datetime('now')",
      [req.user.id, req.params.id]
    );

    res.json({ messages, has_more: result.rows.length === pageSize });
  } catch (error) {
    console.error('get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

app.put('/api/messages/:id', authenticateToken, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });

  try {
    const result = await pool.query(
      "UPDATE messages SET content = $1, edited_at = datetime('now') WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL RETURNING *",
      [content.slice(0, MAX_MSG_SIZE), req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    const full = await buildRoomMessage(parseInt(req.params.id));
    io.to('room_' + result.rows[0].room_id).emit('message_edited', full);
    res.json({ message: full });
  } catch (error) {
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
  try {
    const msgResult = await pool.query('SELECT sender_id, room_id FROM messages WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found' });
    const msg = msgResult.rows[0];

    let canDelete = msg.sender_id === req.user.id;
    if (!canDelete) {
      const mem = await pool.query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [msg.room_id, req.user.id]);
      canDelete = mem.rows.length && mem.rows[0].role === 'admin';
    }
    if (!canDelete) return res.status(403).json({ error: 'Cannot delete this message' });

    await pool.query("UPDATE messages SET deleted_at = datetime('now') WHERE id = $1", [req.params.id]);
    io.to('room_' + msg.room_id).emit('message_deleted', { id: parseInt(req.params.id) });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ─── Personal Message Routes ──────────────────────────────────────────────────

app.get('/api/messages/personal/:userId', authenticateToken, async (req, res) => {
  const { before, limit = 50 } = req.query;
  const otherUserId = parseInt(req.params.userId);
  const pageSize = Math.min(parseInt(limit) || 50, 100);

  try {
    const friends = await areFriends(req.user.id, otherUserId);
    const blocked = await isUserBlocked(req.user.id, otherUserId);
    if (!friends && !blocked) return res.status(403).json({ error: 'Cannot view messages' });

    let query =
      'SELECT pm.id, pm.sender_id, pm.receiver_id, pm.content, pm.reply_to, pm.created_at, pm.edited_at,' +
      '       su.username as sender_username, su.avatar_color as sender_color,' +
      '       rm.content as reply_content, ru.username as reply_sender' +
      ' FROM personal_messages pm' +
      ' LEFT JOIN users su ON pm.sender_id = su.id' +
      ' LEFT JOIN personal_messages rm ON pm.reply_to = rm.id' +
      ' LEFT JOIN users ru ON rm.sender_id = ru.id' +
      ' WHERE ((pm.sender_id = $1 AND pm.receiver_id = $2) OR (pm.sender_id = $2 AND pm.receiver_id = $1))' +
      '   AND pm.deleted_at IS NULL';
    const params = [req.user.id, otherUserId];

    if (before) {
      params.push(before);
      query += ' AND pm.created_at < $' + params.length;
    }
    params.push(pageSize);
    query += ' ORDER BY pm.created_at DESC LIMIT $' + params.length;

    const result = await pool.query(query, params);
    const messages = result.rows.reverse();

    if (messages.length) {
      const ids = messages.map(m => m.id);
      const qs = ids.map((_, i) => '$' + (i + 1)).join(',');
      const atts = await pool.query(
        'SELECT id, personal_message_id, filename, original_filename, size, mimetype, is_image FROM attachments WHERE personal_message_id IN (' + qs + ')',
        ids
      );
      const attMap = {};
      atts.rows.forEach(a => { (attMap[a.personal_message_id] = attMap[a.personal_message_id] || []).push(a); });
      messages.forEach(m => { m.attachments = attMap[m.id] || []; });
    }

    await pool.query(
      "INSERT INTO dm_reads (user_id, other_user_id, last_read_at) VALUES ($1, $2, datetime('now'))" +
      " ON CONFLICT(user_id, other_user_id) DO UPDATE SET last_read_at = datetime('now')",
      [req.user.id, otherUserId]
    );

    res.json({ messages, has_more: result.rows.length === pageSize, is_frozen: blocked });
  } catch (error) {
    console.error('get personal messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

app.put('/api/personal-messages/:id', authenticateToken, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });

  try {
    const result = await pool.query(
      "UPDATE personal_messages SET content = $1, edited_at = datetime('now') WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL RETURNING *",
      [content.slice(0, MAX_MSG_SIZE), req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    const full = await buildPersonalMessage(parseInt(req.params.id));
    const other = result.rows[0].receiver_id === req.user.id ? result.rows[0].sender_id : result.rows[0].receiver_id;
    emitToUser(other, 'personal_message_edited', full);
    emitToUser(req.user.id, 'personal_message_edited', full);
    res.json({ message: full });
  } catch (error) {
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.delete('/api/personal-messages/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE personal_messages SET deleted_at = datetime('now') WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL RETURNING *",
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    emitToUser(result.rows[0].receiver_id, 'personal_message_deleted', { id: parseInt(req.params.id) });
    emitToUser(req.user.id, 'personal_message_deleted', { id: parseInt(req.params.id) });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ─── File Routes ──────────────────────────────────────────────────────────────

app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const isImage = IMAGE_EXTS.includes(ext);

  if (isImage && req.file.size > MAX_IMAGE_SIZE) {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    return res.status(400).json({ error: 'Image exceeds 3 MB limit' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO attachments (uploader_id, filename, original_filename, size, mimetype, is_image) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.user.id, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, isImage ? 1 : 0]
    );
    res.json({ attachment: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save attachment record' });
  }
}, (error, req, res, next) => {
  res.status(400).json({ error: error.message });
});

// Protected file serving
app.get('/uploads/:filename', authenticateToken, async (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\'))
    return res.status(400).json({ error: 'Invalid filename' });

  try {
    const attResult = await pool.query('SELECT * FROM attachments WHERE filename = $1', [filename]);
    if (!attResult.rows.length) return res.status(404).json({ error: 'File not found' });

    const att = attResult.rows[0];
    let hasAccess = att.uploader_id === req.user.id;

    if (!hasAccess && att.message_id) {
      const msgResult = await pool.query('SELECT room_id FROM messages WHERE id = $1', [att.message_id]);
      if (msgResult.rows.length) {
        const mem = await pool.query('SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2', [msgResult.rows[0].room_id, req.user.id]);
        hasAccess = mem.rows.length > 0;
      }
    } else if (!hasAccess && att.personal_message_id) {
      const pmResult = await pool.query('SELECT sender_id, receiver_id FROM personal_messages WHERE id = $1', [att.personal_message_id]);
      if (pmResult.rows.length) {
        hasAccess = pmResult.rows[0].sender_id === req.user.id || pmResult.rows[0].receiver_id === req.user.id;
      }
    }

    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Disposition', 'inline; filename="' + (att.original_filename || filename) + '"');
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// ─── Misc Routes ──────────────────────────────────────────────────────────────

app.get('/api/presence/:userId', authenticateToken, (req, res) => {
  res.json({ status: getUserStatus(parseInt(req.params.userId)) });
});

app.post('/api/rooms/:id/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO room_reads (user_id, room_id, last_read_at) VALUES ($1, $2, datetime('now'))" +
      " ON CONFLICT(user_id, room_id) DO UPDATE SET last_read_at = datetime('now')",
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/messages/personal/:userId/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO dm_reads (user_id, other_user_id, last_read_at) VALUES ($1, $2, datetime('now'))" +
      " ON CONFLICT(user_id, other_user_id) DO UPDATE SET last_read_at = datetime('now')",
      [req.user.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => console.log('ClassicChat running on port ' + PORT));

initDatabase().catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});
