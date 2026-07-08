# MediConnect — JavaScript Codebase Documentation
### Complete reference for every JS file: what it does, how it works, how it is used

---

## TABLE OF CONTENTS

| # | File | Type | Purpose |
|---|---|---|---|
| 1 | [server.js](#1-serverjs) | Entry Point | Express + Socket.io server setup |
| 2 | [middleware/auth.js](#2-middlewareauthjs) | Middleware | JWT verification, role guard, account lockout |
| 3 | [middleware/rateLimiter.js](#3-middlewareratelimiterjs) | Middleware | Tiered rate limiting |
| 4 | [utils/encryption.js](#4-utilsencryptionjs) | Utility | AES-256-GCM field-level encryption |
| 5 | [utils/logger.js](#5-utilsloggerjs) | Utility | Winston structured logging |
| 6 | [routes/auth.js](#6-routesauthjs) | Route | Login, register, JWT refresh, password change |
| 7 | [routes/doctors.js](#7-routesdoctorsjs) | Route | Doctor profiles, schedules, reviews |
| 8 | [routes/appointments.js](#8-routesappointmentsjs) | Route | Booking, status updates, clinical notes |
| 9 | [routes/messages.js](#9-routesmessagesjs) | Route | Chat history, send REST fallback |
| 10 | [routes/payments.js](#10-routespaymentsjs) | Route | eSewa, Khalti, cash, discount codes |
| 11 | [routes/admin.js](#11-routesadminjs) | Route | Platform management, audit, GDPR |
| 12 | [public/js/api.js](#12-publicjsapijs) | Frontend | REST API client + Auth state + helpers |
| 13 | [public/js/chat.js](#13-publicjschatjs) | Frontend | Socket.io ChatManager + message rendering |
| 14 | [public/js/webrtc.js](#14-publicjswebrtcjs) | Frontend | WebRTC video/audio calls |

---

## 1. `server.js`

**Type:** Node.js entry point — run with `node server.js`
**Size:** ~370 lines
**Purpose:** Boots the entire application. Creates the Express app, wires all middleware in the correct order, mounts all route files, sets up Socket.io with JWT auth, and handles graceful shutdown.

---

### How it is structured

#### 1.1 Imports and setup
```js
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const helmet     = require('helmet');
// ... other imports
const app    = express();
const server = http.createServer(app);  // raw HTTP server (needed for Socket.io)
const SECRET = process.env.JWT_SECRET;
```
The `app` (Express) is wrapped in an `http.Server` so that Socket.io can share the same port.

---

#### 1.2 Middleware chain (applied in this exact order)
Every incoming HTTP request passes through these layers before reaching any route:

| Order | Middleware | What it does |
|---|---|---|
| 1 | `app.set('trust proxy', 1)` | Reads real client IP from `X-Forwarded-For` (needed behind Nginx/load balancer) |
| 2 | `helmet(...)` | Sets 15+ security response headers (CSP, HSTS, X-Frame-Options, etc.) |
| 3 | Custom Permissions-Policy | Disables geolocation, payment; allows mic/camera for WebRTC |
| 4 | `cors(...)` | Only allows origins listed in `ALLOWED_ORIGINS` env var |
| 5 | `compression()` | Gzip compresses all responses |
| 6 | `express.json({ limit: '100kb' })` | Parses JSON bodies, rejects anything over 100 KB |
| 7 | `express.urlencoded(...)` | Parses form bodies |
| 8 | Request ID middleware | Attaches `req.id` (UUID) and `X-Request-ID` response header for tracing |
| 9 | HTTP request logger | Logs every request (method, path, status, duration, IP) via Winston |
| 10 | `auditMiddleware` | Attaches `req.audit()` helper; auto-logs PHI route access |
| 11 | `express.static(...)` | Serves `/public` folder (HTML, CSS, JS, images) |

---

#### 1.3 Route mounting
```js
app.use('/api/auth',         limiter.auth,   require('./routes/auth'));
app.use('/api/doctors',      limiter.api,    require('./routes/doctors'));
app.use('/api/appointments', limiter.api,    require('./routes/appointments'));
app.use('/api/messages',     limiter.api,    require('./routes/messages'));
app.use('/api/payments',     limiter.api,    require('./routes/payments'));
app.use('/api/admin',        limiter.api,    require('./routes/admin'));
app.use('/api/gdpr',         limiter.strict, require('./routes/gdpr'));
```
Each route file is loaded with a rate-limiter applied before any handler in that file runs.

---

#### 1.4 Socket.io setup
```js
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'] },
  maxHttpBufferSize: 5e6,   // 5 MB — supports base64 image/audio messages
});

const onlineUsers = new Map();  // userId → socketId — tracks who is online
app.set('io', io);              // shared with route files via req.app.get('io')
app.set('onlineUsers', onlineUsers);
```

**JWT auth for socket connections:**
```js
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  socket.user = jwt.verify(token, SECRET);  // sets socket.user = { id, role, name }
  next();
});
```

**Socket event handlers:**

| Event received | What the server does |
|---|---|
| `send_message` | Encrypts content → saves to DB → emits `new_message` to recipient and sender |
| `mark_read` | Sets `is_read=1` in DB for all messages from `from` to current user |
| `typing` | Relays `typing` event to recipient's socket |
| `stop_typing` | Relays `stop_typing` event to recipient's socket |
| `call:offer` | Relays SDP offer to recipient; if offline → stores missed call message |
| `call:answer` | Relays SDP answer back to caller |
| `call:ice-candidate` | Relays ICE candidate to the other peer |
| `call:reject` | Relays rejection; stores missed call message in DB for both parties |
| `call:end` | Relays call ended event to other party |
| `disconnect` | Removes user from `onlineUsers` map; broadcasts `user_status` offline |

---

#### 1.5 Error handler and SPA catch-all
```js
// Global error handler — never leaks stack traces to the client
app.use((err, req, res, next) => {
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
    reqId: req.id,
  });
});

// SPA fallback — sends index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

---

#### 1.6 Graceful shutdown
```js
function shutdown(signal) {
  server.close(() => process.exit(0));        // stop accepting new connections
  setTimeout(() => process.exit(1), 10000);   // force exit after 10s
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => { logger.error(...); shutdown('uncaughtException'); });
process.on('unhandledRejection', (e) => { logger.error(...); });
```

---

## 2. `middleware/auth.js`

**Purpose:** JWT token verification, role-based access control, and brute-force login protection (account lockout).
**Exports:** `auth`, `requireRole`, `isLockedOut`, `recordAttempt`, `lockoutInfo`

---

### Functions

#### `auth(req, res, next)`
Used on every protected route. Reads the `Authorization: Bearer <token>` header, verifies it with `JWT_SECRET`, and injects `req.user` if valid.

```js
function auth(req, res, next) {
  const header = req.headers.authorization;
  // Must start with "Bearer "
  req.user = jwt.verify(header.slice(7), SECRET, {
    issuer:   'mediconnect',
    audience: 'mediconnect-client',
  });
  // req.user now contains: { id, role, name, email, iat, exp }
  next();
}
```

**Returns:**
- `401` — header missing or token invalid/expired
- Calls `next()` — valid token, `req.user` is populated

---

#### `requireRole(...roles)`
Middleware factory. Returns an array `[auth, roleCheck]` so you use it with spread:

```js
// Only doctors and admins can access this route:
router.patch('/:id/notes', ...requireRole('doctor', 'admin'), handler);
```

Internally:
```js
function requireRole(...roles) {
  return [auth, (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  }];
}
```

---

#### `isLockedOut(email, ip)` → boolean
Queries `login_attempts` table for failures in the last `LOCKOUT_MINUTES` minutes.

Locks by **email** (5 failures) OR by **IP** (15 failures — 3× the email threshold to block credential-stuffing from one IP across many emails).

```js
function isLockedOut(email, ip) {
  const { byEmail, byIP } = getRecentFailures(email, ip);
  return byEmail >= MAX_ATTEMPTS || byIP >= MAX_ATTEMPTS * 3;
}
```

**Used in:** `routes/auth.js` — `POST /api/auth/login`

---

#### `recordAttempt(email, ip, success)`
Inserts one row into `login_attempts`. Called on every login attempt (both success and failure).

---

#### `lockoutInfo(email, ip)` → `{ attempts_remaining, lockout_minutes }`
Returns how many attempts remain before lockout. Used to build the error message shown to the user (e.g. "2 attempt(s) remaining").

---

## 3. `middleware/rateLimiter.js`

**Purpose:** Prevents brute-force attacks, DDoS, and API abuse by limiting requests per IP per time window.
**Exports:** `auth`, `strict`, `api`, `publicEndpoint`

All limiters use `express-rate-limit` with `draft-7` standard headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`) and return JSON on rejection.

```js
function json429(req, res) {
  res.status(429).json({
    error:      'Too many requests',
    message:    'Rate limit exceeded. Please wait before retrying.',
    retryAfter: res.getHeader('Retry-After'),
  });
}
```

### The four tiers

| Export | Routes applied to | Limit | Window | Notes |
|---|---|---|---|---|
| `auth` | `/api/auth` | 10 requests | 15 min | Login, register, password reset |
| `strict` | `/api/gdpr` | 5 requests | 15 min | Sensitive data operations |
| `api` | All other `/api/*` routes | 200 requests | 15 min | Admin users are exempt (`skip: req.user?.role === 'admin'`) |
| `publicEndpoint` | Unauthenticated GET | 60 requests | 1 min | Not currently wired in server.js but available |

**Admin bypass:**
```js
const api = rateLimit({
  skip: (req) => req.user?.role === 'admin',  // admins never hit the 200/15min limit
});
```

---

## 4. `utils/encryption.js`

**Purpose:** AES-256-GCM authenticated encryption for all Protected Health Information (PHI) stored in the database. Required by HIPAA §164.312(a)(2)(iv).
**Exports:** `encrypt`, `decrypt`, `decryptRecord`, `decryptAll`

---

### How the key is derived
```js
const RAW_KEY = process.env.ENCRYPTION_KEY;     // any string from .env
const SALT    = 'mediconnect-phi-salt-v1';       // fixed application salt
const KEY     = crypto.scryptSync(RAW_KEY, SALT, 32);  // always 32 bytes regardless of input length
```
`scrypt` ensures the key is always exactly 32 bytes even if the env var is short or long.

---

### `encrypt(plaintext)` → string
```js
// Input:  "Patient has hypertension"
// Output: "enc:v1:a1b2c3.ciphertext_hex.authtag_hex"

const iv     = crypto.randomBytes(12);          // new random 96-bit IV each time
const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
const tag    = cipher.getAuthTag();             // 128-bit authentication tag

return 'enc:v1:' + [iv.hex, enc.hex, tag.hex].join('.');
```

The `enc:v1:` prefix prevents double-encryption (calling encrypt on already-encrypted data is a no-op).

---

### `decrypt(data)` → string
Parses the three parts (IV, ciphertext, auth tag), reconstructs them as Buffers, and decrypts. If the auth tag doesn't match (tampered data or wrong key), returns `'[decryption error]'` instead of throwing.

Strings that do NOT start with `enc:v1:` are returned as-is (plaintext passthrough — backwards compatible with non-encrypted legacy data).

---

### `decryptRecord(record, fields)` → object
Decrypts specific fields of a DB row object:
```js
// Usage:
const appt = decryptRecord(rawAppt, ['reason', 'notes']);
// appt.reason and appt.notes are now plaintext
```

---

### `decryptAll(records, fields)` → array
Maps `decryptRecord` over an array of rows — used for list endpoints.

---

### Where encryption is used

| Field | Table | Encrypted by |
|---|---|---|
| `reason` | appointments | `routes/appointments.js` on book/update |
| `notes` | appointments | `routes/appointments.js` on notes update |
| `content` | messages | `routes/messages.js` and `server.js` socket handler |
| Missed call messages | messages | `server.js` socket `call:offer` / `call:reject` handlers |

---

## 5. `utils/logger.js`

**Purpose:** Centralized structured logging for the entire application using the Winston library.
**Exports:** a single Winston logger instance

---

### Log transports (output destinations)

| File | Level | Max Size | Max Files | Purpose |
|---|---|---|---|---|
| `logs/error.log` | ERROR only | 10 MB | 90 files | Exceptions, crashes, DB errors |
| `logs/combined.log` | INFO + WARN + ERROR | 50 MB | 30 files | All application events |
| `logs/audit.log` | INFO + above | 100 MB | 2,200 files | PHI access log (~6 years of HIPAA retention) |
| Console (stdout) | All | — | — | Development only — colorized, human-readable |

Files rotate automatically when they reach `maxsize`; old files are deleted when `maxFiles` is exceeded (`tailable: true` keeps the latest file as the primary name).

---

### Log format
Every log entry is JSON with these fields:
```json
{
  "timestamp": "2026-06-17T08:30:00.000+05:45",
  "level": "info",
  "message": "HTTP",
  "method": "POST",
  "path": "/api/auth/login",
  "status": 200,
  "ms": 45,
  "ip": "127.0.0.1",
  "reqId": "abc123",
  "service": "mediconnect",
  "version": "2.0.0"
}
```

---

### Usage throughout the codebase
```js
const logger = require('./utils/logger');

logger.info('User login', { userId: 3, role: 'patient', ip: '127.0.0.1' });
logger.warn('HTTP', { method: 'GET', path: '/api/doctors', status: 429 });
logger.error('Unhandled error', { error: e.message, stack: e.stack });
```

In `server.js`, every HTTP response is logged automatically with status, duration, and IP.

---

## 6. `routes/auth.js`

**Mounted at:** `/api/auth`
**Rate limit:** `limiter.auth` (10 req / 15 min)
**Purpose:** All user identity operations — registration, login, token management, profile, password.

---

### Internal helpers (not exported — only used within this file)

#### `sign(user)` → JWT string
Creates an access token with 1-day expiry:
```js
jwt.sign(
  { id: user.id, role: user.role, name: user.name, email: user.email },
  SECRET,
  { expiresIn: '1d', issuer: 'mediconnect', audience: 'mediconnect-client' }
)
```

#### `safe(user)` → user object without password_hash
Strips `password_hash` before sending any user object to the client. Always used before `res.json({ user: safe(u) })`.

#### `validatePassword(pw)` → error string | null
Checks all password rules server-side:
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 digit
- At least 1 special character (anything not A-Z, a-z, 0-9)

Returns an error message string if invalid, `null` if OK.

#### `issueRefreshToken(userId, ip)` → raw token string
Generates 48 cryptographically random bytes as hex (96-char string), hashes it with SHA-256, and stores only the hash in `refresh_tokens` table. Returns the raw token to send to the client. The raw token is never stored — only the hash is.

---

### Routes

#### `POST /api/auth/register`
1. Validates name, email (via `validator.isEmail`), consent flags, password strength
2. Normalizes email (`validator.normalizeEmail`) — lowercases, removes dots from Gmail, etc.
3. Checks for duplicate email in `users` table
4. Hashes password with `bcrypt` (cost factor 12)
5. Inserts user with `role = 'patient'`
6. Records GDPR consent in `consent_records`
7. Issues access token + refresh token
8. Writes audit log (`REGISTER`)
9. Returns `{ token, refresh_token, user }`

#### `POST /api/auth/register-doctor`
Same flow as register, plus:
- Checks `nmc_number` uniqueness in `doctors` table
- Inserts into `doctors` table with `verified = 0` (needs admin approval)
- Seeds default schedule slots in a DB transaction (Mon–Fri physical, Mon–Sun video)
- Returns `{ message: 'Doctor registration submitted. Awaiting admin verification.' }` — no token issued

#### `POST /api/auth/login`
1. Validates email format
2. Calls `isLockedOut(email, ip)` — returns 429 if locked
3. Fetches user from DB, calls `bcrypt.compareSync`
4. Calls `recordAttempt(email, ip, success)` — always, win or lose
5. On failure: calls `lockoutInfo` to tell user how many attempts remain; returns 401
6. On success: issues token + refresh token; writes `LOGIN` audit; returns `{ token, refresh_token, user, doctor }`

#### `POST /api/auth/refresh`
1. SHA-256 hashes the submitted refresh token
2. Looks up the hash in `refresh_tokens` where `revoked=0` and `expires_at > now`
3. Revokes the old token (sets `revoked=1`)
4. Issues a brand-new access token and refresh token (rotation)
5. Returns `{ token, refresh_token }`

#### `POST /api/auth/logout` *(auth required)*
Revokes the submitted refresh token in the DB. The access token itself cannot be revoked (stateless JWT) but expires in 1 day.

#### `GET /api/auth/me` *(auth required)*
Returns the current user's profile. For doctors, also returns the `doctors` record.

#### `PATCH /api/auth/me` *(auth required)*
Updates `name` and/or `phone` using `COALESCE` — only provided fields are changed.

#### `POST /api/auth/change-password` *(auth required)*
1. Verifies current password with bcrypt
2. Validates new password strength
3. Rejects if new == old
4. Updates `password_hash` with new bcrypt hash
5. Revokes ALL refresh tokens for this user (`UPDATE refresh_tokens SET revoked=1 WHERE user_id=?`) — forces re-login on all devices

---

## 7. `routes/doctors.js`

**Mounted at:** `/api/doctors`
**Rate limit:** `limiter.api` (200 req / 15 min)
**Purpose:** Doctor profiles, availability slots, schedule management, and patient reviews.

---

### Internal helpers

#### `BASE_QUERY`
A reusable SQL string that joins `doctors` with `users` to get the doctor's name, email, phone alongside their doctor fields. All GET endpoints build on this base.

---

### Routes

#### `GET /api/doctors` (public)
Returns all doctors where `verified = 1`. Supports three query parameters:
- `q` — searches across `u.name`, `d.specialty`, `d.hospital` with `LIKE %q%`
- `specialty` — exact match filter
- `online` — `'true'` or `'false'` to filter by `online_status`

Results ordered by `rating DESC, total_reviews DESC` so the best-rated doctors appear first.

#### `GET /api/doctors/:id` (public)
Returns a single doctor profile plus:
- Their full `schedules` array (all time slots)
- Their 10 most recent `reviews` (with patient names)

Returns 404 if doctor not found or not verified.

#### `GET /api/doctors/:id/slots`
Accepts `?date=YYYY-MM-DD&type=physical|video`. If `date` is a full calendar date, it:
1. Converts it to a day abbreviation (Mon, Tue, etc.) using `new Date(date).getDay()`
2. Fetches all schedule slots for that doctor on that day + visit type
3. Queries `appointments` table for already-booked slots on that specific date
4. Returns each slot with `available: true/false`

This is how the booking UI knows which slots are still open.

#### `PATCH /api/doctors/:id` *(auth: doctor or admin)*
Checks ownership (`doc.user_id === req.user.id`) or admin role. Updates `bio`, `fee`, `hospital` using COALESCE.

#### `PATCH /api/doctors/:id/status` *(auth: doctor or admin)*
Toggles `online_status` between 0 and 1. This status is shown as the green/grey dot on the doctor's card.

#### `POST /api/doctors/:id/schedule` *(auth: doctor or admin)*
Validates `day_of_week` (must be Mon/Tue/Wed/Thu/Fri/Sat/Sun) and `visit_type` (must be `physical` or `video`). Inserts into `schedules`. Returns 409 if the slot already exists (UNIQUE constraint on `doctor_id, day_of_week, time_slot, visit_type`).

#### `DELETE /api/doctors/:id/schedule/:slotId` *(auth: doctor or admin)*
Deletes a single slot from `schedules`. Returns 404 if the slot doesn't belong to that doctor.

#### `POST /api/doctors/:id/reviews` *(auth: patient only)*
Inserts a review. After inserting, immediately recalculates the doctor's average rating:
```js
const agg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE doctor_id=?').get(id);
db.prepare('UPDATE doctors SET rating=?, total_reviews=? WHERE id=?').run(agg.avg.toFixed(1), agg.cnt, id);
```

---

## 8. `routes/appointments.js`

**Mounted at:** `/api/appointments`
**Rate limit:** `limiter.api` (200 req / 15 min)
**Purpose:** Create, read, update, and delete appointments. Handles PHI encryption/decryption for `reason` and `notes` fields.

---

### Internal helpers

#### `PHI_FIELDS = ['reason', 'notes']`
Constant array used with `decryptRecord` / `decryptAll` so these two fields are always decrypted before sending to clients.

#### `genRef()` → string
Generates a human-readable booking reference like `MC-MQEXB8MN-7GHZ`:
```js
'MC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase()
```

#### `getAppt(id)` → appointment row
Private SQL helper that fetches a single appointment with all JOINed fields (patient name, doctor name, specialty, hospital). Used by `GET /:id` and `POST /`.

---

### Routes

#### `POST /api/appointments` *(auth: patient or doctor)*
Booking flow:
1. Validates required fields (`doctor_id`, `appointment_date`, `time_slot`, `type`)
2. Validates date format with `validator.isDate`; rejects past dates
3. Checks doctor exists and is verified
4. Checks for slot conflicts (same doctor, date, time, type, status not cancelled)
5. If `discount_code` provided: validates it exists, is active, and hasn't hit `max_uses`
6. Wraps discount increment + appointment insert in a **SQLite transaction** (prevents race conditions where two users apply the same code simultaneously)
7. Encrypts `reason` before storing
8. If `payment_method === 'cash'`: immediately sets status to `confirmed`
9. **Auto-sends a confirmation message** from the doctor to the patient via the `messages` table (so the patient sees the conversation immediately in their chat)
10. Returns `{ appointment, ref }`

#### `GET /api/appointments` *(auth required)*
Role-based filtering:
- `patient` → only sees their own appointments
- `doctor` → only sees appointments for their doctor record
- `admin` → sees all appointments

Additional filters via query params: `?status=confirmed`, `?date=2026-06-20`

Decrypts `reason` and `notes` in the results before returning.

#### `GET /api/appointments/:id` *(auth required)*
Enforces ownership: patients only see their own, doctors only see their patients'. Decrypts PHI fields.

#### `PATCH /api/appointments/:id/status` *(auth required)*
Role-based status transition rules enforced server-side:
```js
const allowed = {
  patient: ['cancelled'],
  doctor:  ['confirmed', 'cancelled', 'completed'],
  admin:   ['confirmed', 'cancelled', 'completed', 'pending'],
};
```
Optionally accepts `notes` to update clinical notes at the same time.

#### `DELETE /api/appointments/:id` *(auth: patient or admin)*
Patients can only delete their own `cancelled` or `completed` appointments. Doctors cannot delete appointments (returns 403). Admins can delete any.

#### `PATCH /api/appointments/:id/notes` *(auth: doctor or admin)*
Saves encrypted clinical notes. Doctors can only update notes for their own patients' appointments. This is the endpoint used by the "📝 Notes" button in the doctor panel.

---

## 9. `routes/messages.js`

**Mounted at:** `/api/messages`
**Rate limit:** `limiter.api` (200 req / 15 min)
**Purpose:** REST API for chat history and message sending. The Socket.io path in `server.js` is the primary real-time channel; this file serves as the REST fallback and history loader.

---

### Internal helpers

#### `decMsg(m)` and `decMsgs(arr)`
Shorthand wrappers that decrypt the `content` field of one message or an array of messages.

---

### Routes

#### `GET /api/messages/conversations` *(auth required)*
Returns one row per unique conversation partner. Uses a subquery to get the latest message per conversation:
```sql
SELECT other_id, other_name, other_role,
       last_message, last_time,
       SUM(unread) as unread_count
FROM (
  SELECT
    CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END as other_id,
    ...
    CASE WHEN receiver_id=? AND is_read=0 THEN 1 ELSE 0 END as unread
  FROM messages m
  JOIN users su ON su.id=m.sender_id
  JOIN users ru ON ru.id=m.receiver_id
  WHERE sender_id=? OR receiver_id=?
)
GROUP BY other_id
ORDER BY last_time DESC
```
After fetching, it decrypts `last_message` and truncates to 80 characters for the sidebar preview. For doctor partners, also fetches the `doctors` record for specialty and avatar.

#### `GET /api/messages/unread/count` *(auth required)*
Simple count query: `SELECT COUNT(*) FROM messages WHERE receiver_id=? AND is_read=0`. Returns `{ count: N }`. Polled every 15 seconds by the frontend.

#### `GET /api/messages/:userId` *(auth required)*
Fetches the full message history between the current user and `:userId` (max 500 messages, ordered oldest-first). Also immediately marks all messages from that user as read (`UPDATE messages SET is_read=1 WHERE sender_id=? AND receiver_id=?`).

Returns decrypted messages including `sender_name` and `sender_role` for rendering.

#### `POST /api/messages` *(auth required)*
REST fallback for when Socket.io is not connected:
1. Validates `to` and `content`
2. Checks recipient exists
3. Encrypts content and saves to DB
4. If recipient is online (checks `onlineUsers` Map via `req.app.get('onlineUsers')`), emits `new_message` to their socket
5. Returns the message object with decrypted content

---

## 10. `routes/payments.js`

**Mounted at:** `/api/payments`
**Rate limit:** `limiter.api` (200 req / 15 min)
**Purpose:** Handles eSewa payment initiation and callback, Khalti placeholder, cash confirmation, and discount code validation.

---

### Environment variables used
```
ESEWA_MERCHANT_CODE  — 'EPAYTEST' (sandbox) or your production code
ESEWA_GATEWAY_URL    — https://uat.esewa.com.np/epay/main (sandbox)
ESEWA_VERIFY_URL     — https://uat.esewa.com.np/epay/transrec
BASE_URL             — http://localhost:3000 (used for callback URLs)
```

---

### Routes

#### `POST /api/payments/esewa/initiate` *(auth required)*
1. Finds the appointment (must belong to the requesting patient)
2. Checks it hasn't already been paid
3. Returns the fields needed to POST to eSewa's gateway form:
```json
{
  "gateway_url": "https://uat.esewa.com.np/epay/main",
  "fields": { "tAmt": 1350, "amt": 1350, "pid": "MC-XXXX", "scd": "EPAYTEST", "su": "...", "fu": "..." }
}
```
The frontend creates a hidden `<form>` with these fields and submits it, redirecting the user to eSewa's payment page.

#### `GET /api/payments/esewa/success`
eSewa redirects here after successful payment with `?oid=MC-XXXX&amt=1350&refId=ABC123`:
1. Verifies with eSewa's verification API using `node-fetch` (`/epay/transrec?oid=...&amt=...&scd=...&rid=...`)
2. eSewa returns an XML response containing "Success" on valid payment
3. Updates `appointments` row: `payment_status='completed'`, `status='confirmed'`, `transaction_id=refId`
4. Inserts into `payments` table with method `esewa`, status `completed`
5. Redirects to `/payment-success.html?ref=...&refId=...&amount=...`

#### `GET /api/payments/esewa/fail`
eSewa redirects here on failure. Redirects to `/payment-fail.html`.

#### `POST /api/payments/khalti/initiate` *(auth required)*
Currently a mock implementation — returns a fake `pidx` and Khalti test URL. Real Khalti SDK integration is stubbed out here for future use.

#### `POST /api/payments/cash/confirm` *(auth: doctor or admin)*
Marks the appointment as `confirmed` and `payment_status='completed'`. Creates a `payments` record with `method='cash'`. Patients cannot call this — only the doctor or admin confirms cash receipt.

#### `POST /api/payments/validate-discount` *(auth required)*
Used by the booking UI to show the discounted price before the patient confirms:
1. Looks up the code in `discount_codes` where `active=1`
2. Checks `used_count < max_uses`
3. Calculates saving as `Math.round(fee * discount_percent / 100)`
4. Returns `{ valid, code, discount_percent, saving, final_fee }`

Note: this does NOT increment `used_count` — that only happens when the appointment is actually booked.

---

## 11. `routes/admin.js`

**Mounted at:** `/api/admin`
**Rate limit:** `limiter.api` (200 req / 15 min) — but admins are exempt from rate limiting
**Auth guard:** All routes require `role = 'admin'` via `requireRole('admin')`
**Purpose:** Full platform management — users, doctors, appointments, payments, discounts, audit logs, and GDPR data requests.

---

### Routes overview

#### `GET /api/admin/stats`
Runs several COUNT/SUM queries in parallel and returns:
```json
{
  "total_users": 45,
  "total_doctors": 8,
  "online_doctors": 3,
  "total_appointments": 120,
  "revenue_total": 67500,
  "pending_appointments": 12,
  "total_messages": 340
}
```
Used by the admin dashboard overview panel.

#### `GET /api/admin/users`
Lists all users. Supports `?role=patient|doctor|admin` and `?q=search` (searches name and email). Never returns `password_hash`.

#### `DELETE /api/admin/users/:id`
Deletes a user. Two guards: cannot delete yourself (same user_id), cannot delete another admin.

#### `GET /api/admin/doctors`
All doctor records joined with user info + verification status. Includes unverified doctors (unlike the public `/api/doctors` endpoint).

#### `PATCH /api/admin/doctors/:id/verify`
Toggles `verified` field between 0 and 1. When set to 1, the doctor appears in public search.

#### `POST /api/admin/doctors`
Creates a new doctor account from the admin panel (not a registration form). Accepts all doctor fields + user fields. Hashes password with bcrypt. Inserts into both `users` and `doctors` tables. Sets `verified = 1` immediately (admin-created doctors don't need approval).

#### `POST /api/admin/patients`
Creates a new patient account. Accepts `{ name, email, phone, password }`. Default password is `Patient@123` if not provided. Used when admin wants to manually add a patient.

#### `GET /api/admin/appointments`
All appointments across all doctors and patients. Supports filters: `?status=`, `?date=`, `?q=` (search by patient name, doctor name, or ref code).

#### `GET /api/admin/payments`
All payment transaction records joined with patient name, doctor name, and appointment reference.

#### `GET /api/admin/discounts` / `POST` / `PATCH /:id` / `DELETE /:id`
Full CRUD for discount codes. POST requires `{ code, discount_percent, max_uses }`. PATCH can update `active` and `max_uses`. DELETE removes the code entirely.

#### `GET /api/admin/audit-logs`
Returns HIPAA audit log entries from the `audit_logs` table. Supports filters:
- `?user_id=` — filter by user
- `?action=LOGIN_FAILED` — filter by action type
- `?resource_type=appointment` — filter by what was accessed
- `?from_date=` and `?to_date=` — date range
- `?limit=100` — result limit (default 100, max 1000)

#### `GET /api/admin/compliance-summary`
Returns a summary for the compliance dashboard:
- Total audit events in the last 30 days
- Login failures in the last 24 hours
- Pending GDPR data requests
- Total consent records
- PHI access events (messages + appointments) in the last 7 days

#### `GET /api/admin/data-requests` / `PATCH /data-requests/:id`
Lists GDPR data requests (export, erasure, portability, rectification) and allows marking them as `processed`.

---

## 12. `public/js/api.js`

**Type:** Frontend browser script — loaded by all three HTML pages
**Purpose:** Central REST API client, authentication state management, toast notifications, and date formatting helpers. Every API call in the entire frontend goes through this file.

---

### `API` object — REST client

The core is a generic `_req` method:
```js
async _req(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = 'Bearer ' + localStorage.getItem('mc_token');
  const r = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}
```

Shorthand methods built on top:
```js
get:   (path, auth)       => API._req('GET',    path, null, auth),
post:  (path, body, auth) => API._req('POST',   path, body, auth),
patch: (path, body)       => API._req('PATCH',  path, body),
del:   (path)             => API._req('DELETE', path),
```

All 35+ domain-specific methods are simple one-liners calling these:
```js
// Examples:
doctors:         (params) => API.get('/doctors?' + new URLSearchParams(params)),
bookAppointment: (data)   => API.post('/appointments', data),
sendMsg:         (to, c)  => API.post('/messages', { to, content: c }),
esewaInitiate:   (id)     => API.post('/payments/esewa/initiate', { appointment_id: id }),
adminVerifyDoc:  (id, v)  => API.patch('/admin/doctors/' + id + '/verify', { verified: v }),
```

**Automatic token refresh** is NOT handled in api.js — token refresh is handled at the point of 401 responses in each page's login flow. When the stored token is expired, the user is prompted to log in again.

---

### `Auth` object — localStorage state manager

```js
const Auth = {
  getUser()    // Parses JSON from localStorage 'mc_user'
  getToken()   // Returns string from 'mc_token'
  getRefresh() // Returns string from 'mc_refresh_token'
  isLoggedIn() // Boolean — token exists
  save(token, user, refreshToken)  // Writes all three to localStorage
  logout()     // Removes mc_token, mc_refresh_token, mc_user
}
```

All three keys used:
- `mc_token` — JWT access token (sent with every API request)
- `mc_refresh_token` — refresh token (sent only to `/api/auth/refresh`)
- `mc_user` — JSON-stringified user object (used to show name, role in UI without an API call)

---

### `showToast(msg, type)` — notification UI
Creates a `<div id="toast">` if it doesn't exist and shows it for 3.5 seconds. `type` controls CSS class: `'success'` (green), `'error'` (red), `''` (neutral).

---

### Date/time helpers
```js
timeAgo(dt)  // "just now", "5m ago", "2h ago", "Jun 17, 2026"
fmtDate(d)   // "Jun 17, 2026" — human-readable date
fmtTime(t)   // Returns time slot string or '-'
```

---

## 13. `public/js/chat.js`

**Type:** Frontend browser script — loaded by `index.html` and `doctor.html`
**Purpose:** Manages the Socket.io connection for real-time messaging, plus all chat UI helpers shared between the patient portal and doctor panel.

---

### `ChatManager` class

One instance is created after login and stored in the global `Chat` variable.

```js
class ChatManager {
  constructor(token, currentUser)
  connect()          // Creates socket with JWT: io({ auth: { token } })
  send(to, content)  // Emits 'send_message' via socket; returns false if disconnected
  markRead(from)     // Emits 'mark_read'
  emitTyping(to)     // Emits 'typing', auto-stops after 2 seconds
  isOnline(userId)   // Checks internal onlineUsers Set
  disconnect()       // Closes socket
}
```

**Properties set by the page (not the class):**
- `Chat.onMessage = (msg) => { ... }` — callback fired on every incoming `new_message` event
- `Chat.onStatus = (uid, online) => { ... }` — callback fired on `user_status` events
- `Chat.activeConvo` — currently open conversation's userId (used to decide whether to render incoming messages)

---

### Socket event handling (inside `connect()`)

| Socket event | What ChatManager does |
|---|---|
| `new_message` | Calls `this.onMessage(msg)` — page decides what to do |
| `user_status` | Updates `this.onlineUsers` Set, calls `this.onStatus` callback |
| `typing` | Finds `#typing-indicator` element, sets text if from active convo |
| `stop_typing` | Clears `#typing-indicator` text |
| `messages_read` | Available for read receipt UI (currently no-op) |
| `connect_error` | Silently ignored — socket will auto-reconnect |

---

### Typing debounce
```js
emitTyping(to) {
  this.socket.emit('typing', { to });
  clearTimeout(this.typingTimer);
  this.typingTimer = setTimeout(() => this.socket.emit('stop_typing', { to }), 2000);
}
```
The `stop_typing` event is automatically emitted 2 seconds after the last keystroke. This prevents the typing indicator from staying on forever if the user stops typing without pressing Enter.

---

### `renderMessage(msg, currentUserId)` → HTML string
The core rendering function used by both patient portal and doctor panel:

```js
function renderMessage(msg, currentUserId) {
  const mine = msg.sender_id === currentUserId;
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const c    = msg.content || '';

  let body;
  if (c.startsWith('data:image/')) {
    // Renders as a clickable image (click to expand to full width)
    body = `<img src="${c}" style="max-width:220px;..." onclick="this.style.maxWidth=..." />`;
  } else if (c.startsWith('data:audio/')) {
    // Renders as an inline audio player
    body = `<audio controls style="max-width:240px"><source src="${c}"></audio>`;
  } else {
    // Plain text — XSS-escaped
    body = escHtml(c);
  }

  return `<div class="msg ${mine ? 'msg-out' : 'msg-in'}">${body}<div class="msg-time">${time}</div></div>`;
}
```

The `.msg-out` class (blue bubble, right-aligned) is applied for the current user's messages; `.msg-in` (white bubble, left-aligned) for received messages.

---

### `escHtml(s)` — XSS prevention
Replaces `&`, `<`, `>`, `"` with HTML entities so user-typed content can never inject HTML or scripts into the page.

---

### `scrollChatToBottom(el)`
Sets `el.scrollTop = el.scrollHeight` to jump to the newest message.

---

### `setupScrollButton(msgsEl, btnId)`
Adds a scroll event listener to the messages container. Shows the `↓` scroll button when the user has scrolled up more than 80px from the bottom, hides it when near the bottom.

---

### Global initialization
```js
let Chat = null;

function initChat(token, user) {
  Chat = new ChatManager(token, user);
  Chat.connect();
}
```
Called from each page after a successful login or on page load if already logged in.

---

## 14. `public/js/webrtc.js`

**Type:** Frontend browser script — loaded by `index.html` and `doctor.html`
**Purpose:** Handles the complete WebRTC peer-to-peer video and audio call lifecycle — UI injection, media capture, peer connection, SDP offer/answer exchange, ICE candidates, and call controls.

Implemented as an **IIFE** (Immediately Invoked Function Expression) returning a public API, so the internals are private.

---

### STUN configuration
```js
const STUN_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};
```
Google's free public STUN servers. Used for NAT traversal on the same network. Cross-network calls require adding TURN servers.

---

### Private state variables
```js
let socket        // Socket.io socket (shared from initChat)
let pc            // RTCPeerConnection instance (null when not in a call)
let localStream   // MediaStream from getUserMedia
let callType      // 'audio' | 'video'
let isCaller      // boolean — true if this user initiated the call
let remoteUserId  // number — the other party's user ID
let pendingOffer  // RTCSessionDescription — stored when incoming call arrives
let isMuted       // boolean — mic mute state
let isCamOff      // boolean — camera off state
let timerInterval // setInterval handle for call duration timer
let autoRejectTimer // setTimeout — auto-reject after 35 seconds
```

---

### `injectUI()` — called once
On first use, inserts two HTML blocks into `<body>`:
1. **Incoming call modal** (`#wrtc-incoming`) — shows avatar, name, call type, Accept/Decline buttons
2. **Active call overlay** (`#wrtc-overlay`) — full-screen dark UI with remote video, local PiP video, top bar (name + timer), bottom controls (mic, camera, end)

Also injects `<style>` block with keyframe animations (slide-in, ring-pulse on accept button).

---

### `getMedia(type)` → Promise\<MediaStream\>
```js
const constraints = type === 'audio'
  ? { audio: true, video: false }
  : { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } };
return navigator.mediaDevices.getUserMedia(constraints);
```
Requests microphone only for audio calls, microphone + front-facing camera for video calls.

---

### `createPC()` — creates RTCPeerConnection
Sets up the three critical event handlers:

```js
pc.onicecandidate = ({ candidate }) => {
  // Send our ICE candidate to the other party via socket
  socket.emit('call:ice-candidate', { to: remoteUserId, candidate });
};

pc.ontrack = (e) => {
  // Remote stream arrived — attach to <video> element
  remoteVideo.srcObject = e.streams[0];
  remoteVideo.style.display = callType === 'video' ? 'block' : 'none';
  startTimer();  // Start the call duration counter
};

pc.onconnectionstatechange = () => {
  // If connection drops, clean up the call
  if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') cleanup();
};
```

---

### `start(targetUserId, name, avatar, type)` — initiate a call
Called when the user clicks 📞 or 📹 in the chat header:

1. Checks socket is connected and no call is already in progress
2. Checks browser supports `navigator.mediaDevices.getUserMedia`
3. Sets state variables, injects UI, shows overlay
4. Calls `getMedia(callType)` to get camera/mic — shows error toast if denied
5. Attaches local stream to `<video id="wrtc-local-video">` (PiP)
6. Creates `RTCPeerConnection`, adds all local tracks
7. Creates SDP offer, sets it as local description
8. Emits `call:offer` via socket to the server (which relays to recipient)

---

### `_acceptCall()` — accept an incoming call
Called when user clicks the green Accept button:

1. Hides incoming modal
2. Gets media (camera/mic) — if denied, emits `call:reject` with reason `media_error`
3. Creates `RTCPeerConnection`, adds local tracks
4. Sets remote description from `pendingOffer` (the stored SDP offer)
5. Creates SDP answer, sets it as local description
6. Emits `call:answer` via socket (relayed to caller)

---

### `_rejectCall()` — decline a call
Hides modal, emits `call:reject` to server, calls `cleanup()`.

---

### Call controls

| Function | What it does |
|---|---|
| `toggleMic()` | Flips `isMuted`, enables/disables all audio tracks on `localStream`, updates button icon |
| `toggleCam()` | Flips `isCamOff`, enables/disables all video tracks, hides/shows local PiP |
| `endCall()` | Emits `call:end`, calls `cleanup()`, shows "Call ended" toast |

---

### `cleanup()` — always called to end a call
- Stops the call duration timer
- Stops all local media tracks (releases camera/mic)
- Closes the `RTCPeerConnection`
- Clears video element `srcObject`s
- Hides both overlay and incoming modal
- Resets all state variables to their initial values

---

### Socket signal handlers (set up in `init()`)

| Event received | What WebRTCCall does |
|---|---|
| `call:incoming` | Stores offer in `pendingOffer`, populates modal, shows incoming call UI, starts 35-second auto-reject timer |
| `call:answered` | Sets remote description on caller's PC (the SDP answer from callee) |
| `call:ice-candidate` | Calls `pc.addIceCandidate(new RTCIceCandidate(candidate))` |
| `call:rejected` | Calls `cleanup()`, shows reason toast (declined / busy / media_error) |
| `call:ended` | Calls `cleanup()`, shows "Call ended by other party" toast |
| `call:unavailable` | Calls `cleanup()`, shows "User is offline" toast |

---

### `init(socket, user)` — called after login
```js
WebRTCCall.init(Chat.socket, data.user);
```
Stores the socket reference and calls `injectUI()` so the call overlay HTML is ready before any call is made.

---

### Public API (what the HTML pages can call)
```js
return { init, start, endCall, toggleMic, toggleCam, _acceptCall, _rejectCall };
```

`_acceptCall` and `_rejectCall` are prefixed with `_` to indicate they are meant to be called by the injected HTML buttons only, not from general application code.

---

*MediConnect v2.0.0 — Documentation generated 2026-06-17*
