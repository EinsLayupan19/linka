# Linka — Project Plan

## 1. Project Overview

**Linka** is a scalable real-time messaging and communication platform focused on a clean, reliable experience for personal and group conversations.

The initial version will support:

- User registration and authentication
- 1:1 conversations
- Group conversations
- Real-time messaging
- Delivered and read states
- Online/presence indicators
- Typing indicators
- Message timestamps
- Message pagination/infinite scrolling
- Voice calls
- Video calls
- Call signaling
- User profiles
- Media/file sharing
- Responsive desktop and mobile UI

The architecture should be strong enough for portfolio-level production work while remaining simple enough to develop and maintain as a solo project.

---

## 2. Core Architecture Principle

Linka will use a layered architecture:

```text
UI
 ↓
Frontend Services
 ↓
Backend API / Supabase
 ↓
Database
```

Realtime communication will use:

```text
React UI
 ↓
Realtime Services
 ↓
Supabase Realtime
 ↓
PostgreSQL
```

Voice/video calls will use:

```text
React
 ↓
WebRTC
 ↓
Peer-to-peer media
```

Supabase Realtime will initially handle call signaling/events. WebRTC handles the actual audio/video stream.

Do not prematurely introduce microservices. Keep clear boundaries so individual services can be separated later if real scale requires it.

---

## 3. Tech Stack

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS

### Backend

- Node.js
- TypeScript
- Express

### Database

- PostgreSQL
- Drizzle ORM

### Authentication

- Supabase Auth

### Realtime

- Supabase Realtime

Used for:

- New message events
- Presence
- Typing indicators
- Read/delivery state updates
- Call signaling
- Conversation updates

### Storage

- Supabase Storage

Used for:

- Profile pictures
- Chat attachments
- Images
- Other user-uploaded media

### Voice / Video

- WebRTC

WebRTC handles the actual media connection.

Supabase Realtime is used for signaling rather than carrying the audio/video stream.

### Validation

- Zod

Use shared validation rules wherever practical.

### Testing

- Vitest
- React Testing Library
- Backend integration tests

### Deployment

- Vercel — frontend
- Render — backend
- Supabase — authentication, PostgreSQL, realtime and storage

### Package Manager

- npm

---

## 4. Repository Structure

```text
linka/
├── frontend/
│   ├── public/
│   └── src/
│       ├── components/
│       │   ├── ui/
│       │   ├── chat/
│       │   ├── calls/
│       │   ├── contacts/
│       │   └── layout/
│       │
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Register.tsx
│       │   ├── Chats.tsx
│       │   ├── Chat.tsx
│       │   ├── Contacts.tsx
│       │   ├── Profile.tsx
│       │   └── Settings.tsx
│       │
│       ├── hooks/
│       │
│       ├── lib/
│       │   ├── supabase.ts
│       │   ├── api.ts
│       │   └── webrtc.ts
│       │
│       ├── services/
│       │   ├── auth.ts
│       │   ├── messages.ts
│       │   ├── conversations.ts
│       │   ├── calls.ts
│       │   └── storage.ts
│       │
│       ├── types/
│       ├── utils/
│       ├── App.tsx
│       └── main.tsx
│
├── backend/
│   └── src/
│       ├── config/
│       ├── middleware/
│       │
│       ├── routes/
│       │   ├── auth.ts
│       │   ├── users.ts
│       │   ├── conversations.ts
│       │   ├── messages.ts
│       │   └── calls.ts
│       │
│       ├── controllers/
│       ├── services/
│       │
│       ├── db/
│       │   ├── schema/
│       │   ├── migrations/
│       │   └── client.ts
│       │
│       ├── validation/
│       ├── utils/
│       ├── app.ts
│       └── server.ts
│
├── shared/
│   └── src/
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   └── DEVELOPMENT_STATUS.md
│
├── frontend/.env.example
├── backend/.env.example
├── .gitignore
├── PLAN.md
├── README.md
└── package.json
```

### Repository notes

- **npm workspaces monorepo.** The root `package.json` defines three workspaces: `frontend/`, `backend/` and `shared/`. One `npm install` at the root installs all of them, and root scripts run dev, build, typecheck, test and lint across them.
- **Shared contracts.** `shared/` contains reusable Zod schemas and TypeScript contracts (request/response shapes, error codes) used by both the frontend and the backend.
- **Separate environment examples.**
  - `frontend/.env.example` contains only public `VITE_*` values, because everything with that prefix is bundled into the browser.
  - `backend/.env.example` contains server-side values such as `DATABASE_URL`, `CORS_ORIGIN`, `PORT` and Supabase server configuration.
- **Database migrations.** Drizzle owns all database schema migrations (`backend/src/db/migrations`), including custom SQL migrations for RLS policies.
- **Hosted Supabase.** Development and production use a hosted Supabase project. There is no local Supabase or database setup.
- **No Supabase-managed migrations.** A `supabase/` folder is not part of the architecture. Add one only if a future feature specifically requires Supabase-managed SQL or Edge Functions.

---

## 5. Database Foundation

The database should be designed around conversations rather than individual chat screens.

### Main entities

```text
users
profiles
conversations
conversation_members
messages
message_attachments
calls
call_participants
```

Potential supporting entities:

```text
user_devices
notifications
blocked_users
```

These should only be added when their use case is actually implemented.

### Conversations

A conversation represents a chat.

It should support:

- 1:1 conversations
- Group conversations
- Conversation metadata
- Created/updated timestamps

### Conversation Members

Membership should be separate from conversations.

This allows:

- Multiple users in a group
- Per-user read state
- Per-user delivery state
- Membership roles
- Future mute/archive settings

Recommended member state includes:

```text
conversation_id
user_id
role
joined_at
last_delivered_at
last_read_at
```

### Messages

Messages should belong to a conversation.

Recommended fields:

```text
id
conversation_id
sender_id
content
created_at
edited_at
deleted_at
```

Messages should be indexed by:

```text
conversation_id
created_at
```

This is important for efficient message pagination.

---

## 6. Message State Model

Linka should distinguish between:

### Sending

The client has created the message locally but the server has not confirmed it.

### Sent

The server has successfully stored the message.

### Delivered

The recipient's client has received/acknowledged messages up to a particular point.

### Read

The recipient has opened the conversation and acknowledged messages up to a particular point.

Use per-member markers such as:

```text
last_delivered_at
last_read_at
```

instead of creating a separate database row for every read event unless future requirements make that necessary.

This keeps read/delivery tracking scalable.

---

## 7. Realtime Messaging

Messages should not require constant polling.

Flow:

```text
User sends message
        ↓
Backend validates/authenticates
        ↓
Message stored in PostgreSQL
        ↓
Realtime event emitted
        ↓
Other connected clients receive event
        ↓
UI updates
```

The client should also handle:

- Reconnection
- Duplicate events
- Temporary connection loss
- Message ordering
- Optimistic sending state
- Failed sends
- Retry

Never assume a realtime connection is permanently available.

---

## 8. Message Pagination

Do not load an entire conversation history at once.

Use cursor-based pagination.

Example concept:

```text
Latest 50 messages
       ↓
Load older messages
       ↓
Use oldest message ID/timestamp as cursor
       ↓
Fetch next page
```

This prevents large conversations from creating unnecessarily large requests.

---

## 9. Presence

Presence should show useful states such as:

- Online
- Offline
- Last seen

Presence should be treated as ephemeral state.

Do not continuously write "online" records to PostgreSQL.

Supabase Realtime Presence should handle the live state where practical.

---

## 10. Typing Indicators

Typing indicators should be realtime events rather than database records.

Example:

```text
User starts typing
        ↓
Realtime event
        ↓
Recipient sees "typing..."
        ↓
User stops typing
        ↓
Realtime event expires/stops
```

Do not persist every typing event.

---

# 11. Voice Calls

Linka will support voice calls using WebRTC.

Basic flow:

```text
Caller
  ↓
Create RTCPeerConnection
  ↓
Create offer
  ↓
Send signaling data
  ↓
Supabase Realtime
  ↓
Recipient
  ↓
Create answer
  ↓
Exchange ICE candidates
  ↓
WebRTC connection
  ↓
Audio stream
```

The actual audio must travel through WebRTC, not through the application server.

The backend should handle:

- Authentication
- Call authorization
- Call metadata
- Call lifecycle
- Signaling authorization

It should not proxy the audio stream.

---

# 12. Video Calls

Video calls use the same WebRTC foundation as voice calls.

The main difference is media tracks:

```text
Audio track
+
Video track
```

The call system should support:

- Camera on/off
- Microphone mute/unmute
- End call
- Incoming call UI
- Accept/reject
- Call duration
- Connection state
- Reconnection handling

Keep the WebRTC implementation isolated so it can evolve independently from the chat UI.

---

# 13. Signaling

Supabase Realtime will initially be used for signaling.

Signaling messages may contain:

```text
offer
answer
ice-candidate
call-state
```

Signaling data must be authenticated and scoped to the appropriate users/conversation.

Never expose another user's signaling channel to unauthorized users.

---

# 14. TURN / NAT Traversal

WebRTC will initially attempt direct peer-to-peer connections.

For users behind restrictive NATs/firewalls, a TURN server may eventually be required.

Architecture should therefore allow:

```text
WebRTC
 ├── Direct peer connection
 └── TURN relay when required
```

Do not build a custom TURN implementation.

Use a proper TURN provider when production requirements justify it.

---

# 15. File and Media Sharing

Supabase Storage will handle uploaded media.

Potential supported files:

- Images
- Documents
- Other safe attachments

Rules:

- Validate file type
- Validate file size
- Authenticate uploads
- Scope access to conversation membership
- Never trust client-provided MIME types alone
- Generate safe storage paths
- Avoid exposing private files publicly

Large media should not pass through the Express server unnecessarily.

Prefer direct authenticated uploads to storage.

---

# 16. Authentication

Supabase Auth handles identity.

The application should support:

- Registration
- Login
- Logout
- Password reset
- Session persistence
- Session refresh

The backend must verify authentication for protected operations.

Never trust a user ID supplied by the frontend without verifying the authenticated session.

---

# 17. Authorization

Authentication answers:

> Who are you?

Authorization answers:

> Are you allowed to perform this action?

Examples:

- A user can read conversations they belong to.
- A user can send messages only to conversations they belong to.
- A user cannot modify another user's profile.
- A group member can only perform actions allowed by their role.
- Call signaling is restricted to authorized call participants.

Use database-level protections where possible in addition to backend checks.

---

# 18. API Design

Example API groups:

```text
/api/auth/*
/api/users/*
/api/conversations/*
/api/messages/*
/api/calls/*
/api/uploads/*
```

Example endpoints:

```text
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages

POST   /api/calls
GET    /api/calls/:id
POST   /api/calls/:id/end
```

Keep API routes thin.

Business logic belongs in services rather than directly inside route handlers.

---

# 19. Frontend Service Layer

React components should not contain large amounts of database/API logic.

Prefer:

```text
Component
   ↓
Hook
   ↓
Service
   ↓
API / Supabase
```

For example:

```text
Chat.tsx
   ↓
useMessages()
   ↓
messages.ts
   ↓
API
```

This makes the application easier to test and change.

---

# 20. Error Handling

Every network/realtime operation should have a defined failure state.

Examples:

- Failed message
- Reconnecting
- Call connection failed
- Upload failed
- Authentication failed
- Session expired
- Server unavailable

Do not silently swallow errors.

User-facing errors should be understandable without exposing internal stack traces or secrets.

---

# 21. Security

Minimum security requirements:

- Environment variables for secrets
- No secrets in frontend bundles
- Authenticated protected API routes
- Authorization checks
- Database RLS where appropriate
- Input validation with Zod
- File validation
- Rate limiting on sensitive endpoints
- Secure HTTP headers
- Safe CORS configuration
- No sensitive information in logs
- Proper session handling
- No trusting client-supplied ownership fields

Never commit:

```text
.env
.env.local
service-role keys
API keys
private credentials
```

Only commit:

```text
.env.example
```

---

# 22. Scalability Strategy

Linka should start as a modular monolith rather than microservices.

Initial architecture:

```text
             ┌──────────────┐
             │   React      │
             │   Frontend   │
             └──────┬───────┘
                    │
             ┌──────▼───────┐
             │   Express    │
             │    API       │
             └──────┬───────┘
                    │
        ┌───────────┼───────────┐
        ↓           ↓           ↓
 PostgreSQL     Supabase     Storage
               Realtime
                    │
                    ↓
                 WebRTC
```

Keep modules independent enough that they can later be separated if needed.

Possible future scaling path:

```text
Phase 1
Modular monolith
      ↓
Phase 2
Redis / external pub-sub
      ↓
Phase 3
Dedicated realtime infrastructure
      ↓
Phase 4
Separate media/notification/background services
```

Do not introduce these systems before they solve an actual bottleneck.

---

# 23. Performance

Important performance practices:

- Cursor-based message pagination
- Database indexes
- Lazy loading
- Code splitting
- Optimistic UI where appropriate
- Efficient realtime subscriptions
- Avoid unnecessary database writes
- Compress/resize uploaded images
- Avoid loading entire conversation histories
- Virtualize extremely long message lists if needed

The application should remain responsive on mobile devices.

---

# 24. Testing Strategy

### Unit tests

Test:

- Validation
- Utility functions
- Message state logic
- Call state logic
- Permission checks

### Frontend tests

Test:

- Login
- Conversation list
- Message sending
- Read/delivery state
- Error states
- Call UI
- Responsive behavior

### Backend tests

Test:

- Authentication
- Authorization
- Conversation creation
- Membership rules
- Message creation
- Pagination
- Call authorization
- Upload authorization

### Integration tests

Verify complete flows such as:

```text
Register
  ↓
Login
  ↓
Create conversation
  ↓
Send message
  ↓
Receive realtime message
  ↓
Mark as read
```

---

# 25. Development Workflow

Development should follow small, verifiable milestones.

For each feature:

```text
Plan
 ↓
Implement
 ↓
Test
 ↓
Type check
 ↓
Build
 ↓
Review diff
 ↓
Commit
 ↓
Push
```

Use meaningful commits.

Examples:

```text
feat: add conversation persistence
feat: add realtime messaging
feat: add message read states
feat: add voice call signaling
feat: add video call controls
fix: handle realtime reconnects
test: cover conversation authorization
```

Do not bundle unrelated changes into one commit.

---

# 26. Milestones

## Milestone 1 — Foundation

- Repository setup
- React/Vite frontend
- Express/TypeScript backend
- Environment configuration
- Supabase connection
- PostgreSQL connection
- Base architecture

## Milestone 2 — Authentication

- Registration
- Login
- Logout
- Session persistence
- Password reset
- Protected routes

## Milestone 3 — User Profiles

- Profile page
- Profile picture
- Basic user information
- Storage integration

## Milestone 4 — Conversations

- 1:1 conversations
- Group conversations
- Conversation membership
- Conversation list

## Milestone 5 — Messaging

- Send messages
- Receive messages
- Message timestamps
- Sending/sent/failed states
- Pagination
- Realtime updates

## Milestone 6 — Message State

- Delivered state
- Read state
- Unread counts
- Last-read markers
- Reconnection handling

## Milestone 7 — Presence

- Online/offline
- Last seen
- Typing indicators

## Milestone 8 — Media

- Image uploads
- File attachments
- Storage authorization
- Upload progress

## Milestone 9 — Voice Calls

- Call creation
- Incoming call UI
- WebRTC audio
- Signaling
- Accept/reject
- End call

## Milestone 10 — Video Calls

- Camera support
- Microphone controls
- Video preview
- WebRTC video
- Connection states
- Call controls

## Milestone 11 — Reliability

- Error handling
- Reconnection
- Rate limiting
- Authorization review
- Security review
- Performance review

## Milestone 12 — Deployment

- Production environment
- Vercel frontend
- Render backend
- Supabase production configuration
- Storage configuration
- Environment variables
- Production smoke tests

---

# 27. Definition of Done

A feature is not considered complete until:

- It works locally.
- The relevant tests pass.
- Type checking passes.
- Production build passes.
- Error states are handled.
- Authorization is verified.
- No secrets are exposed.
- The implementation is reasonably reusable.
- The diff has been reviewed.
- The change has a meaningful commit.

---

# 28. Non-Goals

Do not build these initially unless they become necessary:

- Microservices
- Custom authentication system
- Custom WebSocket infrastructure
- Custom TURN server
- End-to-end encryption implementation
- Complex recommendation algorithms
- Cryptocurrency/payment features
- Large-scale notification infrastructure
- Advanced moderation systems

The goal is a strong, maintainable messaging platform first.

---

# 29. Long-Term Architecture

The architecture should make it possible to eventually support:

- Large group chats
- High message volume
- Multiple devices per account
- Push notifications
- Message search
- Message reactions
- Reply/thread support
- Message editing/deletion
- Voice/video call history
- Screen sharing
- File previews
- Read receipts
- User blocking
- Notifications
- Background jobs
- Analytics

These should be added incrementally rather than implemented prematurely.

---

# 30. Final Principle

**Build Linka as a modular monolith with clear boundaries.**

The first version should be simple enough to finish, but every major subsystem should have a clean responsibility:

```text
Auth
Profiles
Conversations
Messages
Realtime
Calls
Storage
API
Database
UI
```

Avoid premature complexity.

Prioritize:

1. Correctness
2. Security
3. Reliability
4. Maintainability
5. Scalability
6. User experience

Build the foundation first, then add complexity only when the product actually needs it.
