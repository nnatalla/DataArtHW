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
exports.pool = void 0;
exports.getDb = getDb;
exports.initDatabase = initDatabase;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'classicchat.db');
let db = null;
// Initialize and get database instance (synchronous — better-sqlite3 is sync by design)
function getDb() {
    if (db)
        return db;
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // better-sqlite3 opens/creates the file automatically — no manual read needed
    db = new better_sqlite3_1.default(DB_PATH);
    // Essential PRAGMAs — must be set before any queries
    db.pragma('journal_mode = WAL'); // better read/write concurrency
    db.pragma('foreign_keys = ON'); // enforce FK constraints (OFF by default in SQLite)
    db.pragma('synchronous = NORMAL'); // safe with WAL, faster than FULL
    db.pragma('busy_timeout = 5000'); // wait up to 5s if db is locked
    return db;
}
// Wrapper providing a pg-compatible async query interface
exports.pool = {
    query: async (sql, params = []) => {
        const database = getDb();
        // Convert Postgres-style $1..$N placeholders to SQLite ?
        // Handles out-of-order and repeated references correctly
        const usedIndices = [];
        const sqliteSql = sql.replace(/\$(\d+)/g, (_match, n) => {
            usedIndices.push(parseInt(n, 10) - 1);
            return '?';
        });
        const sqliteParams = usedIndices.map(i => params[i]);
        // Determine statement type to pick the right better-sqlite3 API
        const trimmed = sql.trimStart().toUpperCase();
        const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.includes('RETURNING');
        try {
            if (isSelect) {
                const stmt = database.prepare(sqliteSql);
                const rows = stmt.all(...sqliteParams);
                return { rows };
            }
            else {
                const stmt = database.prepare(sqliteSql);
                const info = stmt.run(...sqliteParams);
                return {
                    rows: [],
                    changes: info.changes,
                    lastInsertRowid: info.lastInsertRowid,
                };
            }
        }
        catch (err) {
            // Remap SQLite unique constraint error to pg-compatible error code
            if (err.message?.includes('UNIQUE constraint failed')) {
                err.code = '23505';
                const match = err.message.match(/UNIQUE constraint failed: (\w+\.\w+)/);
                if (match)
                    err.constraint = match[1];
            }
            throw err;
        }
    },
    // Minimal connect() shim for code that calls pool.connect()
    connect: async () => ({
        query: async (sql, params) => exports.pool.query(sql, params),
        release: () => { },
    }),
};
// Initialize all tables and indexes inside a single transaction
function initDatabase() {
    const database = getDb();
    const init = database.transaction(() => {
        // Users
        database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        email        TEXT    UNIQUE NOT NULL,
        username     TEXT    UNIQUE NOT NULL,
        password_hash TEXT   NOT NULL,
        avatar_color TEXT    NOT NULL DEFAULT '#6366f1',
        created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // Sessions
        database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT    UNIQUE NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        user_agent TEXT,
        ip_address TEXT
      )
    `);
        // Contacts
        database.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status          TEXT    NOT NULL DEFAULT 'pending',
        request_message TEXT,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, friend_id)
      )
    `);
        // Blocks
        database.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, blocked_id)
      )
    `);
        // Rooms
        database.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    UNIQUE NOT NULL,
        description TEXT,
        visibility  TEXT    NOT NULL DEFAULT 'public',
        owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // Room members
        database.exec(`
      CREATE TABLE IF NOT EXISTS room_members (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role      TEXT    NOT NULL DEFAULT 'member',
        joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, user_id)
      )
    `);
        // Room bans
        database.exec(`
      CREATE TABLE IF NOT EXISTS room_bans (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        banned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, user_id)
      )
    `);
        // Messages
        database.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sender_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        content    TEXT    NOT NULL,
        reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        edited_at  DATETIME,
        deleted_at DATETIME
      )
    `);
        // Personal messages
        database.exec(`
      CREATE TABLE IF NOT EXISTS personal_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        receiver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        content     TEXT    NOT NULL,
        reply_to    INTEGER REFERENCES personal_messages(id) ON DELETE SET NULL,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        edited_at   DATETIME,
        deleted_at  DATETIME
      )
    `);
        // Attachments
        database.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id          INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        personal_message_id INTEGER REFERENCES personal_messages(id) ON DELETE CASCADE,
        uploader_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        filename            TEXT    NOT NULL,
        original_filename   TEXT,
        size                INTEGER NOT NULL,
        mimetype            TEXT,
        is_image            INTEGER NOT NULL DEFAULT 0,
        created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // Room reads (tracks last-read timestamp per user per room)
        database.exec(`
      CREATE TABLE IF NOT EXISTS room_reads (
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_id      INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        last_read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, room_id)
      )
    `);
        // DM reads
        database.exec(`
      CREATE TABLE IF NOT EXISTS dm_reads (
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        other_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, other_user_id)
      )
    `);
        // Room invitations
        database.exec(`
      CREATE TABLE IF NOT EXISTS room_invitations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, user_id)
      )
    `);
        // Indexes
        database.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_room        ON messages(room_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created     ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_personal_msgs_users  ON personal_messages(sender_id, receiver_id);
      CREATE INDEX IF NOT EXISTS idx_room_members_room    ON room_members(room_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token       ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_attachments_message  ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_pm       ON attachments(personal_message_id);
    `);
    });
    init();
    // Migracje — dodaj brakujące kolumny do istniejących baz
    try {
        database.exec(`ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#6366f1'`);
    }
    catch { /* już istnieje */ }
    try {
        database.exec(`ALTER TABLE messages ADD COLUMN deleted_at DATETIME`);
    }
    catch { /* już istnieje */ }
    try {
        database.exec(`ALTER TABLE messages ADD COLUMN edited_at DATETIME`);
    }
    catch { /* już istnieje */ }
    try {
        database.exec(`ALTER TABLE personal_messages ADD COLUMN deleted_at DATETIME`);
    }
    catch { /* już istnieje */ }
    try {
        database.exec(`ALTER TABLE personal_messages ADD COLUMN edited_at DATETIME`);
    }
    catch { /* już istnieje */ }
    console.log('Database initialized successfully');
}
// Graceful shutdown — better-sqlite3 flushes WAL automatically on close
function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
process.on('exit', closeDb);
process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
