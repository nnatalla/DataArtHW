# Classic Web Chat Application Specification

## 1. Project Overview
- **Project Name**: ClassicChat
- **Type**: Full-stack web application
- **Core Functionality**: Real-time web-based chat with rooms, personal messaging, file sharing, and presence indicators
- **Target Users**: General users seeking classic chat room experience with modern features

## 2. Technology Stack
- **Backend**: Node.js + Express + Socket.io
- **Database**: PostgreSQL
- **Frontend**: Vanilla HTML/CSS/JS (classic web chat style)
- **Container**: Docker + Docker Compose
- **File Storage**: Local file system

## 3. UI/UX Specification

### 3.1 Layout Structure
- **Header**: Top menu with user info, notifications, settings
- **Sidebar (Left)**: Room list and contacts accordion
- **Main Area**: Chat messages with infinite scroll
- **Right Panel**: Room members or chat info (compact)
- **Input Area**: Bottom text input with attachments

### 3.2 Visual Design
- **Primary Color**: #2c3e50 (dark blue-gray)
- **Secondary Color**: #34495e (lighter blue-gray)
- **Accent Color**: #3498db (bright blue)
- **Success Color**: #27ae60 (green)
- **Warning Color**: #e74c3c (red)
- **Background**: #ecf0f1 (light gray)
- **Text Primary**: #2c3e50
- **Text Secondary**: #7f8c8d

### 3.3 Typography
- **Font Family**: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif
- **Headings**: 24px (h1), 20px (h2), 16px (h3)
- **Body Text**: 14px
- **Small Text**: 12px

### 3.4 Components
- **Message Bubble**: Rounded corners, sender name, timestamp, edited indicator
- **Room Item**: Name, unread badge, member count
- **Contact Item**: Avatar placeholder, name, presence indicator (green/yellow/gray dot)
- **Buttons**: Rounded, 8px padding, hover effects
- **Input Fields**: 12px padding, border-radius 4px, focus glow

## 4. Functional Specification

### 4.1 Authentication
- Registration: email, password, unique username
- Login: email + password with persistent sessions
- Password reset via email
- Account deletion

### 4.2 Presence System
- **Online**: Green indicator - user has active tab
- **AFK**: Yellow indicator - no activity for 1+ minute
- **Offline**: Gray indicator - all tabs closed
- Multi-tab support with shared state

### 4.3 Chat Rooms
- Create public/private rooms
- Room properties: name (unique), description, visibility
- Owner + admin roles
- Ban system for rooms
- Invite users to private rooms

### 4.4 Messaging
- Text messages (max 3KB)
- Emoji support
- Reply to messages
- Edit own messages
- Delete messages (self or admin)
- Infinite scroll history

### 4.5 Contacts/Friends
- Send friend requests by username
- Accept/reject requests
- Remove friends
- Block/banned users

### 4.6 File Sharing
- Upload images (max 3MB) and files (max 20MB)
- Copy-paste support
- Original filename preserved
- Access control per room/chat

### 4.7 Notifications
- Unread message badges
- Low-latency presence updates

## 5. Database Schema

### Tables
- **users**: id, email, username, password_hash, created_at
- **sessions**: id, user_id, token, created_at, expires_at
- **contacts**: id, user_id, friend_id, status, created_at
- **rooms**: id, name, description, visibility, owner_id, created_at
- **room_members**: id, room_id, user_id, role, joined_at
- **room_bans**: id, room_id, user_id, banned_by, created_at
- **messages**: id, room_id, sender_id, content, reply_to, created_at, edited_at, deleted_at
- **personal_messages**: id, sender_id, receiver_id, content, created_at, edited_at, deleted_at
- **attachments**: id, message_id, filename, filepath, size, type, created_at
- **unread_items**: id, user_id, room_id, last_read_at

## 6. API Endpoints

### Auth
- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/logout
- POST /api/auth/password-reset
- DELETE /api/auth/account

### Users
- GET /api/users/:username
- GET /api/users/sessions
- DELETE /api/users/sessions/:id

### Contacts
- GET /api/contacts
- POST /api/contacts/request
- PUT /api/contacts/request/:id
- DELETE /api/contacts/:id

### Rooms
- GET /api/rooms (public catalog)
- POST /api/rooms
- GET /api/rooms/:id
- PUT /api/rooms/:id
- DELETE /api/rooms/:id
- POST /api/rooms/:id/join
- POST /api/rooms/:id/leave
- POST /api/rooms/:id/ban
- POST /api/rooms/:id/unban

### Messages
- GET /api/rooms/:id/messages
- POST /api/rooms/:id/messages
- PUT /api/messages/:id
- DELETE /api/messages/:id

### Personal Messages
- GET /api/messages/:userId
- POST /api/messages
- PUT /api/personal-messages/:id
- DELETE /api/personal-messages/:id

### Files
- POST /api/upload
- GET /api/files/:id

## 7. WebSocket Events

### Client → Server
- join_room
- leave_room
- send_message
- edit_message
- delete_message
- user_activity (typing, etc.)

### Server → Client
- message
- message_edited
- message_deleted
- user_joined
- user_left
- presence_update
- room_updated

## 8. Acceptance Criteria

### Must Work
- [ ] User can register and login
- [ ] User can create and join public rooms
- [ ] User can send and receive messages in real-time
- [ ] User can create private rooms and invite users
- [ ] User can add friends and send personal messages
- [ ] User can upload and download files
- [ ] Presence indicators work correctly
- [ ] Messages persist across sessions
- [ ] Docker compose up works without errors

### Performance
- [ ] Message delivery < 3 seconds
- [ ] Presence updates < 2 seconds
- [ ] Support 300 simultaneous users
- [ ] Handle 10,000+ message history

### Reliability
- [ ] Multi-tab support works
- [ ] Session persistence across browser close
- [ ] Proper access control for files
