import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import * as path from 'path';
import * as fs from 'fs';
import { getDb, initDatabase, pool } from '../db';

// Test with a temporary database
const TEST_DB_PATH = path.join(__dirname, 'test_classicchat.db');

describe('Database Module', () => {
  // Set test environment before importing db
  beforeEach(() => {
    process.env.DB_PATH = TEST_DB_PATH;
    // Delete test DB if exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // Re-initialize with test DB
    initDatabase();
  });

  afterEach(() => {
    // Clean up test DB
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('Database Initialization', () => {
    it('should initialize database with correct schema', () => {
      const db = getDb();
      
      // Check tables exist
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all() as { name: string }[];
      
      const tableNames = tables.map(t => t.name).sort();
      
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('contacts');
      expect(tableNames).toContain('rooms');
      expect(tableNames).toContain('room_members');
      expect(tableNames).toContain('messages');
      expect(tableNames).toContain('personal_messages');
      expect(tableNames).toContain('attachments');
      expect(tableNames).toContain('blocks');
    });

    it('should create indexes', () => {
      const db = getDb();
      
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index'"
      ).all() as { name: string }[];
      
      expect(indexes.length).toBeGreaterThan(0);
    });
  });

  describe('User Operations', () => {
    it('should create a new user', async () => {
      const passwordHash = await bcrypt.hash('testpassword123', 10);
      
      const result = await pool.query(
        'INSERT INTO users (email, username, password_hash, avatar_color) VALUES ($1, $2, $3, $4) RETURNING *',
        ['test@example.com', 'testuser', passwordHash, '#6366f1']
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].email).toBe('test@example.com');
      expect(result.rows[0].username).toBe('testuser');
      expect(result.rows[0].password_hash).toBe(passwordHash);
    });

    it('should not allow duplicate emails', async () => {
      const passwordHash = await bcrypt.hash('testpassword123', 10);
      
      await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)',
        ['test@example.com', 'testuser', passwordHash]
      );
      
      await expect(
        pool.query(
          'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)',
          ['test@example.com', 'testuser2', passwordHash]
        )
      ).rejects.toThrow();
    });

    it('should not allow duplicate usernames', async () => {
      const passwordHash = await bcrypt.hash('testpassword123', 10);
      
      await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)',
        ['test1@example.com', 'testuser', passwordHash]
      );
      
      await expect(
        pool.query(
          'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)',
          ['test2@example.com', 'testuser', passwordHash]
        )
      ).rejects.toThrow();
    });

    it('should authenticate user with correct password', async () => {
      const passwordHash = await bcrypt.hash('correctpassword', 10);
      
      await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)',
        ['test@example.com', 'testuser', passwordHash]
      );
      
      const result = await pool.query(
        'SELECT password_hash FROM users WHERE username = $1',
        ['testuser']
      );
      
      const isValid = await bcrypt.compare('correctpassword', result.rows[0].password_hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const passwordHash = await bcrypt.hash('correctpassword', 10);
      
      await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)',
        ['test@example.com', 'testuser', passwordHash]
      );
      
      const result = await pool.query(
        'SELECT password_hash FROM users WHERE username = $1',
        ['testuser']
      );
      
      const isValid = await bcrypt.compare('wrongpassword', result.rows[0].password_hash);
      expect(isValid).toBe(false);
    });
  });

  describe('Room Operations', () => {
    it('should create a room', async () => {
      // Create a user first
      const passwordHash = await bcrypt.hash('password', 10);
      const userResult = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['owner@example.com', 'owner', passwordHash]
      );
      const ownerId = userResult.rows[0].id;
      
      // Create room
      const roomResult = await pool.query(
        'INSERT INTO rooms (name, description, visibility, owner_id) VALUES ($1, $2, $3, $4) RETURNING *',
        ['Test Room', 'A test room', 'public', ownerId]
      );
      
      expect(roomResult.rows[0].name).toBe('Test Room');
      expect(roomResult.rows[0].visibility).toBe('public');
    });

    it('should add user to room as member', async () => {
      // Create user and room
      const passwordHash = await bcrypt.hash('password', 10);
      const userResult = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user@example.com', 'user', passwordHash]
      );
      const userId = userResult.rows[0].id;
      
      const roomResult = await pool.query(
        'INSERT INTO rooms (name, visibility, owner_id) VALUES ($1, $2, $3) RETURNING id',
        ['Test Room', 'public', userId]
      );
      const roomId = roomResult.rows[0].id;
      
      // Add user to room
      await pool.query(
        'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)',
        [roomId, userId, 'admin']
      );
      
      const members = await pool.query(
        'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, userId]
      );
      
      expect(members.rows).toHaveLength(1);
      expect(members.rows[0].role).toBe('admin');
    });
  });

  describe('Message Operations', () => {
    it('should create a room message', async () => {
      // Create user and room
      const passwordHash = await bcrypt.hash('password', 10);
      const userResult = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user@example.com', 'user', passwordHash]
      );
      const userId = userResult.rows[0].id;
      
      const roomResult = await pool.query(
        'INSERT INTO rooms (name, visibility, owner_id) VALUES ($1, $2, $3) RETURNING id',
        ['Test Room', 'public', userId]
      );
      const roomId = roomResult.rows[0].id;
      
      // Add user to room
      await pool.query(
        'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)',
        [roomId, userId, 'admin']
      );
      
      // Create message
      const msgResult = await pool.query(
        'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
        [roomId, userId, 'Hello, world!']
      );
      
      expect(msgResult.rows[0].content).toBe('Hello, world!');
      expect(msgResult.rows[0].sender_id).toBe(userId);
      expect(msgResult.rows[0].room_id).toBe(roomId);
    });

    it('should create a personal message', async () => {
      // Create two users
      const passwordHash = await bcrypt.hash('password', 10);
      const user1Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user1@example.com', 'user1', passwordHash]
      );
      const user1Id = user1Result.rows[0].id;
      
      const user2Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user2@example.com', 'user2', passwordHash]
      );
      const user2Id = user2Result.rows[0].id;
      
      // Create personal message
      const msgResult = await pool.query(
        'INSERT INTO personal_messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING *',
        [user1Id, user2Id, 'Hello friend!']
      );
      
      expect(msgResult.rows[0].content).toBe('Hello friend!');
      expect(msgResult.rows[0].sender_id).toBe(user1Id);
      expect(msgResult.rows[0].receiver_id).toBe(user2Id);
    });
  });

  describe('Contact Operations', () => {
    it('should create a contact request', async () => {
      // Create two users
      const passwordHash = await bcrypt.hash('password', 10);
      const user1Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user1@example.com', 'user1', passwordHash]
      );
      const user1Id = user1Result.rows[0].id;
      
      const user2Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user2@example.com', 'user2', passwordHash]
      );
      const user2Id = user2Result.rows[0].id;
      
      // Create contact request
      const contactResult = await pool.query(
        'INSERT INTO contacts (user_id, friend_id, status, request_message) VALUES ($1, $2, $3, $4) RETURNING *',
        [user1Id, user2Id, 'pending', 'Hello, let\'s be friends!']
      );
      
      expect(contactResult.rows[0].status).toBe('pending');
      expect(contactResult.rows[0].request_message).toBe('Hello, let\'s be friends!');
    });

    it('should accept a contact request', async () => {
      // Create users and pending contact
      const passwordHash = await bcrypt.hash('password', 10);
      const user1Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user1@example.com', 'user1', passwordHash]
      );
      const user1Id = user1Result.rows[0].id;
      
      const user2Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user2@example.com', 'user2', passwordHash]
      );
      const user2Id = user2Result.rows[0].id;
      
      await pool.query(
        'INSERT INTO contacts (user_id, friend_id, status) VALUES ($1, $2, $3)',
        [user1Id, user2Id, 'pending']
      );
      
      // Accept contact
      await pool.query(
        'UPDATE contacts SET status = $1 WHERE user_id = $2 AND friend_id = $3',
        ['accepted', user1Id, user2Id]
      );
      
      const contact = await pool.query(
        'SELECT status FROM contacts WHERE user_id = $1 AND friend_id = $2',
        [user1Id, user2Id]
      );
      
      expect(contact.rows[0].status).toBe('accepted');
    });
  });

  describe('Block Operations', () => {
    it('should block a user', async () => {
      // Create two users
      const passwordHash = await bcrypt.hash('password', 10);
      const user1Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user1@example.com', 'user1', passwordHash]
      );
      const user1Id = user1Result.rows[0].id;
      
      const user2Result = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['user2@example.com', 'user2', passwordHash]
      );
      const user2Id = user2Result.rows[0].id;
      
      // Block user
      await pool.query(
        'INSERT INTO blocks (user_id, blocked_id) VALUES ($1, $2)',
        [user1Id, user2Id]
      );
      
      const block = await pool.query(
        'SELECT * FROM blocks WHERE user_id = $1 AND blocked_id = $2',
        [user1Id, user2Id]
      );
      
      expect(block.rows).toHaveLength(1);
    });
  });
});
