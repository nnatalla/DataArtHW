# ClassicChat - Web Chat Application

A classic web-based chat application with rooms, personal messaging, file sharing, and presence indicators.

## Features

- **User Authentication**: Registration, login, password management, account deletion
- **Chat Rooms**: Public and private rooms with admin controls
- **Personal Messaging**: One-to-one chats with friends
- **Contacts/Friends**: Send requests, accept/reject, block users
- **File Sharing**: Upload images (max 3MB) and files (max 20MB)
- **Presence System**: Online/AFK/Offline status with multi-tab support
- **Real-time Messaging**: Socket.io powered instant messaging

## Technology Stack

- **Backend**: Node.js + Express + Socket.io
- **Database**: PostgreSQL
- **Frontend**: Vanilla HTML/CSS/JS
- **Container**: Docker + Docker Compose

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Port 3000 and 5432 available

### Run with Docker Compose

```bash
docker compose up -d
```

The application will be available at http://localhost:3000

### Manual Setup

1. Install dependencies:
```bash
npm install
```

2. Set up PostgreSQL database

3. Run the server:
```bash
node server.js
```

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string
- `PORT`: Server port (default: 3000)
- `JWT_SECRET`: JWT signing secret
- `UPLOAD_DIR`: Upload directory path
- `MAX_FILE_SIZE`: Max file size in bytes (default: 20MB)
- `MAX_IMAGE_SIZE`: Max image size in bytes (default: 3MB)

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `DELETE /api/auth/account` - Delete account
- `GET /api/auth/me` - Get current user

### Users
- `GET /api/users/:username` - Get user by username
- `GET /api/users/sessions` - Get active sessions
- `DELETE /api/users/sessions/:id` - Delete session

### Contacts
- `GET /api/contacts` - Get contacts
- `POST /api/contacts/request` - Send friend request
- `PUT /api/contacts/request/:id` - Accept/reject request
- `DELETE /api/contacts/:id` - Remove contact

### Rooms
- `GET /api/rooms` - Get public rooms
- `POST /api/rooms` - Create room
- `GET /api/rooms/:id` - Get room details
- `PUT /api/rooms/:id` - Update room
- `DELETE /api/rooms/:id` - Delete room
- `POST /api/rooms/:id/join` - Join room
- `POST /api/rooms/:id/leave` - Leave room
- `POST /api/rooms/:id/ban` - Ban user
- `POST /api/rooms/:id/unban` - Unban user

### Messages
- `GET /api/rooms/:id/messages` - Get room messages
- `POST /api/rooms/:id/messages` - Send room message
- `PUT /api/messages/:id` - Edit message
- `DELETE /api/messages/:id` - Delete message
- `GET /api/messages/personal/:userId` - Get personal messages
- `POST /api/upload` - Upload file

## WebSocket Events

### Client → Server
- `authenticate` - Authenticate socket connection
- `join_room` - Join a room
- `leave_room` - Leave a room
- `send_message` - Send room message
- `send_personal_message` - Send personal message
- `activity` - User activity (prevents AFK)

### Server → Client
- `message` - New room message
- `personal_message` - New personal message
- `message_edited` - Message edited
- `message_deleted` - Message deleted
- `presence_update` - User presence changed

## License

MIT
