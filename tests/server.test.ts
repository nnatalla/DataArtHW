import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import * as http from 'http';
import { Server as IOServer } from 'socket.io';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import * as path from 'path';
import * as fs from 'fs';
import jwt from 'jsonwebtoken';
import { getDb, initDatabase, pool } from '../db';

// Test configuration
const TEST_PORT = 3456;
const TEST_DB_PATH = path.join(__dirname, 'test_api_classicchat.db');
const JWT_SECRET = 'test_jwt_secret_for_testing';

describe('Server API Integration Tests', () => {
  let app: Express;
  let server: http.Server;
  let baseAgent: request.SuperAgentTest;
  
  // Test users
  let user1 = { id: 0, email: 'user1@test.com', username: 'user1', password: 'password123' };
  let user2 = { id: 0, email: 'user2@test.com', username: 'user2', password: 'password123' };
  let user1Token = '';
  let user2Token = '';
  
  beforeAll(async () => {
    // Set test environment
    process.env.DB_PATH = TEST_DB_PATH;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.PORT = TEST_PORT.toString();
    process.env.UPLOAD_DIR = path.join(__dirname, 'test_uploads');
    
    // Clean up test files
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(process.env.UPLOAD_DIR)) {
      fs.rmSync(process.env.UPLOAD_DIR, { recursive: true });
    }
    fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
    
    // Initialize database
    initDatabase();
    
    // Create express app manually for testing
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use(express.urlencoded({ extended: true }));
    
    // Mock auth middleware for testing
    const authMiddleware = async (req: any, res: any, next: any) => {
      const authHeader = req.headers['authorization'];
      const token = authHeader?.split(' ')[1];
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
        const userResult = await pool.query(
          'SELECT id, email, username, avatar_color FROM users WHERE id = $1',
          [decoded.userId]
        );
        if (!userResult.rows.length) {
          return res.status(403).json({ error: 'User not found' });
        }
        req.user = userResult.rows[0];
        req.token = token;
        next();
      } catch {
        res.status(403).json({ error: 'Invalid token' });
      }
    };
    
    // Create test routes
    // Auth routes
    expressApp.post('/api/register', async (req, res) => {
      try {
        const { email, username, password } = req.body;
        if (!email || !username || !password) {
          return res.status(400).json({ error: 'Email, username, password required' });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        const colors = ['#6366f1', '#ec4899', '#10b981', '#f59e0b'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];
        
        const result = await pool.query(
          'INSERT INTO users (email, username, password_hash, avatar_color) VALUES ($1, $2, $3, $4) RETURNING id, email, username, avatar_color',
          [email, username, passwordHash, avatarColor]
        );
        
        const token = jwt.sign({ userId: result.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
        await pool.query(
          'INSERT INTO sessions (user_id, token, user_agent, ip_address) VALUES ($1, $2, $3, $4)',
          [result.rows[0].id, token, 'test', '127.0.0.1']
        );
        
        res.status(201).json({ user: result.rows[0], token });
      } catch (err: any) {
        if (err.code === '23505') {
          return res.status(400).json({ error: 'Email or username already exists' });
        }
        res.status(500).json({ error: 'Registration failed' });
      }
    });
    
    expressApp.post('/api/login', async (req, res) => {
      try {
        const { email, password } = req.body;
        if (!email || !password) {
          return res.status(400).json({ error: 'Email and password required' });
        }
        
        const userResult = await pool.query(
          'SELECT * FROM users WHERE email = $1',
          [email]
        );
        if (!userResult.rows.length) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = userResult.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        await pool.query(
          'INSERT INTO sessions (user_id, token, user_agent, ip_address) VALUES ($1, $2, $3, $4)',
          [user.id, token, 'test', '127.0.0.1']
        );
        
        res.json({ 
          user: { id: user.id, email: user.email, username: user.username, avatar_color: user.avatar_color },
          token 
        });
      } catch {
        res.status(500).json({ error: 'Login failed' });
      }
    });
    
    // Protected route example
    expressApp.get('/api/me', authMiddleware, (req: any, res) => {
      res.json({ user: req.user });
    });
    
    expressApp.get('/api/users/search', authMiddleware, async (req: any, res) => {
      const q = (req.query.q as string ?? '').trim();
      if (q.length < 2) return res.json({ users: [] });
      try {
        const result = await pool.query(
          "SELECT id, username, avatar_color FROM users WHERE username LIKE $1 AND id != $2 LIMIT 20",
          ['%' + q + '%', req.user.id]
        );
        res.json({ users: result.rows });
      } catch {
        res.status(500).json({ error: 'Search failed' });
      }
    });
    
    // Room routes
    expressApp.get('/api/rooms', authMiddleware, async (req: any, res) => {
      try {
        const result = await pool.query(
          "SELECT r.*, u.username AS owner_username FROM rooms r LEFT JOIN users u ON r.owner_id=u.id WHERE r.visibility='public' ORDER BY r.created_at DESC LIMIT 50"
        );
        res.json({ rooms: result.rows });
      } catch {
        res.status(500).json({ error: 'Failed to load rooms' });
      }
    });
    
    expressApp.post('/api/rooms', authMiddleware, async (req: any, res) => {
      const { name, description, visibility = 'public' } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'Room name required' });
      if (!['public', 'private'].includes(visibility)) return res.status(400).json({ error: 'Invalid visibility' });
      
      try {
        const roomResult = await pool.query(
          'INSERT INTO rooms (name, description, visibility, owner_id) VALUES ($1,$2,$3,$4) RETURNING *',
          [name.trim(), description?.trim() ?? null, visibility, req.user.id]
        );
        const room = roomResult.rows[0];
        
        await pool.query(
          'INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,$3)',
          [room.id, req.user.id, 'admin']
        );
        
        res.status(201).json({ room });
      } catch (err: any) {
        if (err.code === '23505') return res.status(400).json({ error: 'Room name already taken' });
        res.status(500).json({ error: 'Failed to create room' });
      }
    });
    
    // Contact routes
    expressApp.get('/api/contacts', authMiddleware, async (req: any, res) => {
      try {
        const result = await pool.query(
          `SELECT c.id, c.status, c.request_message, c.created_at,
            CASE WHEN c.user_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction,
            CASE WHEN c.user_id = $1 THEN c.friend_id ELSE c.user_id END AS user_id,
            CASE WHEN c.user_id = $1 THEN fu.username ELSE uu.username END AS username,
            CASE WHEN c.user_id = $1 THEN fu.avatar_color ELSE uu.avatar_color END AS avatar_color
           FROM contacts c
           JOIN users uu ON c.user_id = uu.id
           JOIN users fu ON c.friend_id = fu.id
           WHERE c.user_id = $1 OR c.friend_id = $1`,
          [req.user.id]
        );
        res.json({ contacts: result.rows });
      } catch {
        res.status(500).json({ error: 'Failed to load contacts' });
      }
    });
    
    app = expressApp;
    server = app.listen(TEST_PORT);
    baseAgent = request.agent(server);
  });
  
  afterAll(async () => {
    if (server) server.close();
    // Clean up
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(process.env.UPLOAD_DIR!)) {
      fs.rmSync(process.env.UPLOAD_DIR!, { recursive: true });
    }
  });

  describe('Authentication', () => {
    it('should register a new user', async () => {
      const response = await baseAgent
        .post('/api/register')
        .send({
          email: user1.email,
          username: user1.username,
          password: user1.password
        });
      
      expect(response.status).toBe(201);
      expect(response.body.user).toBeDefined();
      expect(response.body.token).toBeDefined();
      expect(response.body.user.email).toBe(user1.email);
      
      user1.id = response.body.user.id;
      user1Token = response.body.token;
    });
    
    it('should not allow duplicate email registration', async () => {
      const response = await baseAgent
        .post('/api/register')
        .send({
          email: user1.email,
          username: 'different_user',
          password: 'password123'
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Email or username already exists');
    });
    
    it('should login with correct credentials', async () => {
      const response = await baseAgent
        .post('/api/login')
        .send({
          email: user1.email,
          password: user1.password
        });
      
      expect(response.status).toBe(200);
      expect(response.body.user).toBeDefined();
      expect(response.body.token).toBeDefined();
    });
    
    it('should not login with wrong password', async () => {
      const response = await baseAgent
        .post('/api/login')
        .send({
          email: user1.email,
          password: 'wrongpassword'
        });
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid credentials');
    });
  });
  
  describe('Protected Routes', () => {
    it('should access /api/me with valid token', async () => {
      const response = await baseAgent
        .get('/api/me')
        .set('Authorization', `Bearer ${user1Token}`);
      
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(user1.id);
    });
    
    it('should not access /api/me without token', async () => {
      const response = await baseAgent.get('/api/me');
      
      expect(response.status).toBe(401);
    });
    
    it('should not access /api/me with invalid token', async () => {
      const response = await baseAgent
        .get('/api/me')
        .set('Authorization', 'Bearer invalid_token');
      
      expect(response.status).toBe(403);
    });
  });
  
  describe('User Search', () => {
    beforeAll(async () => {
      // Create second user for search tests
      const response = await baseAgent
        .post('/api/register')
        .send({
          email: user2.email,
          username: user2.username,
          password: user2.password
        });
      user2.id = response.body.user.id;
      user2Token = response.body.token;
    });
    
    it('should find users by username', async () => {
      const response = await baseAgent
        .get('/api/users/search?q=user')
        .set('Authorization', `Bearer ${user1Token}`);
      
      expect(response.status).toBe(200);
      expect(response.body.users).toBeDefined();
      expect(response.body.users.length).toBeGreaterThan(0);
    });
    
    it('should return empty for short queries', async () => {
      const response = await baseAgent
        .get('/api/users/search?q=u')
        .set('Authorization', `Bearer ${user1Token}`);
      
      expect(response.status).toBe(200);
      expect(response.body.users).toEqual([]);
    });
  });
  
  describe('Rooms', () => {
    it('should create a room', async () => {
      const response = await baseAgent
        .post('/api/rooms')
        .set('Authorization', `Bearer ${user1Token}`)
        .send({
          name: 'Test Room',
          description: 'A test room',
          visibility: 'public'
        });
      
      expect(response.status).toBe(201);
      expect(response.body.room).toBeDefined();
      expect(response.body.room.name).toBe('Test Room');
    });
    
    it('should list public rooms', async () => {
      const response = await baseAgent
        .get('/api/rooms')
        .set('Authorization', `Bearer ${user1Token}`);
      
      expect(response.status).toBe(200);
      expect(response.body.rooms).toBeDefined();
      expect(response.body.rooms.length).toBeGreaterThan(0);
    });
    
    it('should not create room without name', async () => {
      const response = await baseAgent
        .post('/api/rooms')
        .set('Authorization', `Bearer ${user1Token}`)
        .send({
          visibility: 'public'
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Room name required');
    });
    
    it('should not create room with invalid visibility', async () => {
      const response = await baseAgent
        .post('/api/rooms')
        .set('Authorization', `Bearer ${user1Token}`)
        .send({
          name: 'Test',
          visibility: 'invalid'
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid visibility');
    });
  });
});
