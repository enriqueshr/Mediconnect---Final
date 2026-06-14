# MediConnect v2.0 — Full Technical Documentation

> HIPAA · GDPR · CCPA · PDPA Compliant Digital Health Platform  
> Stack: Node.js · Express · SQLite · Socket.io · WebRTC · Vanilla JS

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack & Dependencies](#3-tech-stack--dependencies)
4. [Database Schema](#4-database-schema)
5. [Backend — API Reference](#5-backend--api-reference)
   - 5.1 Authentication
   - 5.2 Doctors
   - 5.3 Appointments
   - 5.4 Messages
   - 5.5 Payments
   - 5.6 Admin
   - 5.7 GDPR
6. [Middleware](#6-middleware)
7. [Utilities](#7-utilities)
8. [Frontend Pages](#8-frontend-pages)
9. [Real-time Features (Socket.io)](#9-real-time-features-socketio)
10. [WebRTC Video & Audio Calling](#10-webrtc-video--audio-calling)
11. [Security & Compliance](#11-security--compliance)
12. [Environment Variables](#12-environment-variables)
13. [Setup & Running](#13-setup--running)
14. [Default Credentials & Seed Data](#14-default-credentials--seed-data)

---

## 1. Project Overview

MediConnect is a full-stack digital health platform designed for Nepal, serving patients, doctors, and administrators. It enables online appointment booking, real-time encrypted doctor–patient messaging, video/audio consultations via WebRTC, AI-powered medical document analysis, BMI & nutrition tools, and eSewa payment integration.

### Core Features

| Feature | Description |
|---|---|
| Doctor Discovery | Browse and filter 8+ verified specialist doctors by specialty, availability, rating |
| Appointment Booking | Book physical or video consultations with time-slot selection and discount codes |
| Encrypted Messaging | Real-time AES-256 encrypted chat between patient and doctor via Socket.io |
| Video/Audio Calls | Peer-to-peer WebRTC calls with signaling through Socket.io |
| AI Medical Analysis | Upload medical documents/images for AI-powered clinical insights |
| BMI & Nutrition | BMI calculator with personalised Nepali recipe recommendations |
| eSewa Payments | Nepal's eSewa payment gateway integration for appointment fees |
| Admin Dashboard | Platform-wide statistics, user management, doctor verification, discount codes |
| Doctor Dashboard | Appointment management, patient chat, availability toggle |
| HIPAA/GDPR Compliance | Audit logging, session timeout, data export/erasure, cookie consent |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                     Browser                          │
│  index.html │ admin.html │ doctor.html               │
│  /js/api.js │ /js/chat.js │ /js/webrtc.js            │
│  /js/compliance.js │ /css/style.css                  │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / WebSocket
┌──────────────────────▼──────────────────────────────┐
│               Express Server (server.js)             │
│                                                      │
│  Helmet CSP · CORS · Compression · Rate Limiting     │
│  JWT Auth Middleware · HIPAA Audit Middleware        │
│                                                      │
│  REST API Routes:                                    │
│  /api/auth  /api/doctors  /api/appointments          │
│  /api/messages  /api/payments  /api/admin  /api/gdpr │
│                                                      │
│  Socket.io Server (real-time chat + WebRTC signals) │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│         SQLite Database (mediconnect.db)             │
│  WAL mode · Foreign Keys · AES-256 PHI encryption   │
│                                                      │
│  users · doctors · schedules · appointments          │
│  messages · reviews · payments · discount_codes      │
│  audit_logs · login_attempts · refresh_tokens        │
│  consent_records · data_requests                     │
└─────────────────────────────────────────────────────┘
```

### Request Flow

1. Browser sends HTTP request → Express middleware chain runs (Helmet → CORS → Rate Limiter → Body Parser → Request ID → HTTP Logger → HIPAA Audit)
2. Route handler validates JWT, processes business logic, reads/writes SQLite
3. PHI fields (appointment reason/notes, message content) are AES-256-GCM encrypted before storage
4. Response sent; HIPAA audit log entry written for PHI access

---

## 3. Tech Stack & Dependencies

### Backend

| Package | Version | Purpose |
|---|---|---|
| express | ^4.18.2 | HTTP server and routing |
| socket.io | ^4.6.1 | Real-time bidirectional communication |
| jsonwebtoken | ^9.0.0 | JWT access tokens (1 day) + refresh tokens (7 days) |
| bcryptjs | ^2.4.3 | Password hashing (bcrypt, cost factor 12) |
| helmet | ^7.1.0 | Security HTTP headers (CSP, HSTS, X-Frame) |
| cors | ^2.8.5 | Cross-Origin Resource Sharing |
| compression | ^1.7.4 | Gzip response compression |
| express-rate-limit | ^7.4.0 | Tiered rate limiting |
| validator | ^13.12.0 | Email validation and sanitisation |
| winston | ^3.11.0 | Structured logging with log rotation |
| dotenv | ^16.3.1 | Environment variable loading |
| node-fetch | ^2.7.0 | HTTP client (eSewa payment verification) |
| node:sqlite | built-in | SQLite via Node.js built-in module |
| node:crypto | built-in | AES-256-GCM encryption, token hashing |

### Frontend

| Technology | Purpose |
|---|---|
| Vanilla JavaScript (ES2020) | All frontend logic — no framework |
| Socket.io Client | Real-time chat and WebRTC signaling |
| WebRTC (RTCPeerConnection) | Peer-to-peer video/audio calling |
| CSS Variables + Flexbox/Grid | Responsive design system |
| Google Fonts | Plus Jakarta Sans + Lora typefaces |

---

## 4. Database Schema

Database: **SQLite** with WAL journal mode, foreign key enforcement, and 64 MB page cache.

### Table: `users`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto-increment |
| name | TEXT | Full name |
| email | TEXT UNIQUE | Normalised lowercase |
| phone | TEXT | Optional |
| password_hash | TEXT | bcrypt, cost 12 |
| role | TEXT | `patient` \| `doctor` \| `admin` |
| created_at | DATETIME | UTC |

### Table: `doctors`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| user_id | INTEGER FK → users | Cascade delete |
| specialty | TEXT | e.g. Cardiologist |
| hospital | TEXT | Affiliated hospital |
| nmc_number | TEXT UNIQUE | Nepal Medical Council registration |
| experience_years | INTEGER | |
| fee | INTEGER | Consultation fee in Rs. |
| bio | TEXT | Doctor biography |
| avatar | TEXT | Emoji avatar |
| online_status | INTEGER | 0 = offline, 1 = online |
| rating | REAL | Average rating 0–5 |
| total_reviews | INTEGER | Count of reviews |
| verified | INTEGER | 0 = pending, 1 = verified |

### Table: `schedules`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| doctor_id | INTEGER FK → doctors | |
| day_of_week | TEXT | Mon/Tue/Wed/Thu/Fri/Sat/Sun |
| time_slot | TEXT | e.g. "09:00 AM" |
| clinic_name | TEXT | Physical clinic name or "Online Video Consultation" |
| visit_type | TEXT | `physical` \| `video` |

Unique constraint: `(doctor_id, day_of_week, time_slot, visit_type)`

### Table: `appointments`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| ref | TEXT UNIQUE | Human-readable reference e.g. HNV-WY1X |
| patient_id | INTEGER FK → users | |
| doctor_id | INTEGER FK → doctors | |
| appointment_date | TEXT | YYYY-MM-DD |
| time_slot | TEXT | e.g. "09:00 AM" |
| type | TEXT | `physical` \| `video` |
| status | TEXT | `pending` \| `confirmed` \| `cancelled` \| `completed` |
| reason | TEXT | **AES-256-GCM encrypted** PHI |
| clinic_name | TEXT | |
| discount_code | TEXT | Applied promo code |
| original_fee | INTEGER | Pre-discount fee |
| discount_amount | INTEGER | Discount in Rs. |
| final_fee | INTEGER | Amount charged |
| payment_method | TEXT | `esewa` \| `cash` |
| payment_status | TEXT | `pending` \| `paid` |
| transaction_id | TEXT | eSewa transaction ID |
| notes | TEXT | **AES-256-GCM encrypted** PHI (doctor notes) |
| created_at | DATETIME | |

### Table: `messages`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| sender_id | INTEGER FK → users | |
| receiver_id | INTEGER FK → users | |
| content | TEXT | **AES-256-GCM encrypted** PHI |
| is_read | INTEGER | 0 = unread, 1 = read |
| created_at | DATETIME | |

### Table: `reviews`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| patient_id | INTEGER FK → users | |
| doctor_id | INTEGER FK → doctors | |
| appointment_id | INTEGER FK → appointments | |
| rating | INTEGER | 1–5 CHECK constraint |
| comment | TEXT | |
| created_at | DATETIME | |

### Table: `discount_codes`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| code | TEXT UNIQUE | Promo code string |
| discount_percent | INTEGER | 1–100 |
| max_uses | INTEGER | Usage limit |
| used_count | INTEGER | Current uses |
| active | INTEGER | 0/1 |

### Table: `payments`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| appointment_id | INTEGER FK → appointments | |
| patient_id | INTEGER FK → users | |
| amount | INTEGER | Rs. |
| method | TEXT | `esewa` \| `cash` |
| status | TEXT | `pending` \| `paid` |
| transaction_id | TEXT | |
| esewa_ref_id | TEXT | eSewa-issued reference |

### Table: `audit_logs` (HIPAA §164.312(b))

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| user_id | INTEGER | Who performed the action |
| role | TEXT | patient/doctor/admin |
| action | TEXT | LOGIN, LOGOUT, VIEW_APPOINTMENTS, SEND_MESSAGE, etc. |
| resource_type | TEXT | user/appointment/message/auth |
| resource_id | TEXT | ID of accessed resource |
| ip_address | TEXT | Client IP |
| user_agent | TEXT | Browser string |
| details | TEXT | JSON blob with extra context |
| success | INTEGER | 0/1 |
| created_at | DATETIME | |

Minimum 6-year retention per HIPAA §164.316(b)(2)(i).

### Table: `login_attempts`

Tracks failed logins per email+IP for brute-force protection (HIPAA §164.312(a)(2)(iii)).

### Table: `refresh_tokens`

Stores SHA-256 hash of refresh tokens. Raw token is sent to client only once; rotated on each use.

### Table: `consent_records` (GDPR Art. 7)

Records explicit consent at registration with IP, timestamp, and terms version.

### Table: `data_requests` (GDPR Art. 12-22)

Tracks user requests for data export, erasure, portability, and rectification.

---

## 5. Backend — API Reference

Base URL: `http://localhost:3000/api`

Authentication: `Authorization: Bearer <jwt_token>` header required for protected routes.

---

### 5.1 Authentication — `/api/auth`

Rate limit: **10 requests per 15 minutes** (auth tier)

#### `POST /api/auth/register`

Register a new patient account.

**Body:**
```json
{
  "name": "Ram Thapa",
  "email": "ram@example.com",
  "phone": "+977-9812345678",
  "password": "Patient@123",
  "consent_terms": true,
  "consent_privacy": true
}
```

**Password Rules:** Minimum 8 characters, at least one uppercase, one lowercase, one digit, one special character.

**Response 201:**
```json
{
  "token": "<jwt>",
  "refresh_token": "<raw_token>",
  "user": { "id": 10, "name": "Ram Thapa", "email": "...", "role": "patient" }
}
```

**Errors:** 400 (validation), 409 (email already exists)

---

#### `POST /api/auth/register-doctor`

Register a new doctor (status: pending verification).

**Body:** name, email, phone, password, specialty, hospital, nmc_number, experience_years, fee, bio, consent_terms, consent_privacy

- Unique constraint on `nmc_number`
- Creates default physical schedule (Mon–Fri, 6 slots) and video schedule (Mon–Sun, 6 slots)
- Doctor is unverified (`verified=0`) until admin approves

**Response 201:** `{ "message": "Doctor registration submitted. Awaiting admin verification." }`

---

#### `POST /api/auth/login`

Authenticate a user.

**Body:** `{ "email": "...", "password": "..." }`

**Lockout:** After 5 failed attempts within the lockout window (default 30 minutes), account is locked. Each failed response includes `attempts_remaining`.

**Response 200:**
```json
{
  "token": "<jwt — expires 1 day>",
  "refresh_token": "<raw — expires 7 days>",
  "user": { "id": ..., "name": ..., "role": "patient|doctor|admin" },
  "doctor": { ... } // only if role === 'doctor'
}
```

---

#### `POST /api/auth/refresh`

Rotate a refresh token and get a new access token.

**Body:** `{ "refresh_token": "<raw>" }`

- Old refresh token is revoked immediately (rotation)
- Issues new access token + new refresh token

---

#### `POST /api/auth/logout`

Revoke refresh token. Requires `Authorization` header.

**Body:** `{ "refresh_token": "<raw>" }` (optional)

---

#### `GET /api/auth/me`

Return the authenticated user's profile + doctor record (if doctor).

---

#### `PATCH /api/auth/me`

Update name and/or phone. Requires auth.

**Body:** `{ "name": "...", "phone": "..." }` (both optional)

---

#### `POST /api/auth/change-password`

Change password. Requires auth. Revokes ALL existing refresh tokens (forces re-login on all devices).

**Body:** `{ "oldPassword": "...", "newPassword": "..." }`

---

### 5.2 Doctors — `/api/doctors`

Rate limit: **200 requests per 15 minutes** (api tier)

#### `GET /api/doctors`

List all doctors with optional filters.

**Query params:**
- `q` — full-text search on name, specialty, hospital
- `specialty` — exact match
- `online_status` — `true` or `false`

**Response:** Array of doctor objects with full profile, schedule, and review summary.

---

#### `GET /api/doctors/:id`

Single doctor profile including schedule and reviews.

---

#### `GET /api/doctors/:id/slots`

Available time slots for a specific date.

**Query params:** `date` (YYYY-MM-DD), `type` (`physical` or `video`)

Returns slots that are not already booked.

---

#### `PATCH /api/doctors/:id`

Update doctor profile. Requires auth (own doctor account or admin).

---

#### `PATCH /api/doctors/:id/status`

Toggle online/offline status. Requires doctor auth.

**Body:** `{ "online": true }`

---

#### `POST /api/doctors/:id/reviews`

Leave a review. Requires patient auth with a completed appointment with this doctor.

**Body:** `{ "rating": 5, "comment": "...", "appointment_id": 1 }`

---

### 5.3 Appointments — `/api/appointments`

All PHI fields (reason, notes) are AES-256-GCM encrypted in the database.

#### `POST /api/appointments`

Book an appointment. Requires patient auth.

**Body:**
```json
{
  "doctor_id": 1,
  "appointment_date": "2026-06-15",
  "time_slot": "09:00 AM",
  "type": "physical",
  "reason": "Chest pain for 2 days",
  "clinic_name": "Bir Hospital",
  "payment_method": "esewa",
  "discount_code": "WELCOME20"
}
```

- Validates slot availability (no double-booking)
- Applies discount code if provided
- Generates unique reference (e.g. `HNV-WY1X`)

**Response 201:** Full appointment object with decrypted reason.

---

#### `GET /api/appointments`

List appointments. Patients see their own; doctors see their own; admins see all.

**Query params:** `status`, `doctor_id`, `patient_id`, `date`

---

#### `GET /api/appointments/:id`

Single appointment. Access controlled: patient sees own, doctor sees assigned, admin sees all.

---

#### `PATCH /api/appointments/:id/status`

Update appointment status. Requires doctor or admin auth.

**Body:** `{ "status": "confirmed|cancelled|completed", "notes": "..." }`

Notes are AES-256 encrypted before storage.

---

#### `PATCH /api/appointments/:id/notes`

Update clinical notes. Requires doctor auth. Encrypted in storage.

---

#### `DELETE /api/appointments/:id`

Cancel/delete an appointment. Patients can delete their own pending appointments.

---

### 5.4 Messages — `/api/messages`

All message content is AES-256-GCM encrypted in the database. Decrypted only on authorised access.

#### `GET /api/messages/conversations`

Return all unique conversation partners for the authenticated user, ordered by most recent message.

**Response:** Array of `{ other_id, other_name, other_role, last_message, last_time, unread_count, doctorInfo }`

---

#### `GET /api/messages/unread/count`

Return total unread message count for nav badge.

---

#### `GET /api/messages/:userId`

Full message history between the authenticated user and `userId`. Messages are decrypted before response.

---

#### `POST /api/messages`

Send a message via REST (fallback — Socket.io is the primary path).

**Body:** `{ "to": <userId>, "content": "..." }`

---

### 5.5 Payments — `/api/payments`

#### `POST /api/payments/esewa/initiate`

Initiate an eSewa payment for an appointment.

**Body:** `{ "appointment_id": 1 }`

**Response:** eSewa form fields:
```json
{
  "gateway_url": "https://rc-epay.esewa.com.np/...",
  "params": { "tAmt": 800, "amt": 800, "txAmt": 0, "psc": 0, "psd": 0, "scd": "...", "pid": "...", "su": "...", "fu": "..." }
}
```

---

#### `POST /api/payments/esewa/verify`

Called on payment success redirect. Verifies payment with eSewa and marks appointment as paid.

---

#### `POST /api/payments/cash/confirm`

Admin-only endpoint to mark a cash appointment as paid.

---

#### `POST /api/payments/validate-discount`

Validate a discount code before booking.

**Body:** `{ "code": "WELCOME20", "doctor_id": 1 }`

**Response:** `{ "valid": true, "percent": 20, "discount_amount": 160, "final_fee": 640 }`

---

### 5.6 Admin — `/api/admin`

All endpoints require `role === 'admin'`.

Rate limit: **200 requests per 15 minutes** (api tier)

#### `GET /api/admin/stats`

Platform overview statistics.

**Response:**
```json
{
  "users": 5,
  "doctors": 8,
  "online_doctors": 6,
  "appointments": 1,
  "today_appointments": 0,
  "revenue": 0,
  "pending_payments": 1
}
```

---

#### `GET /api/admin/users`

List all users with optional role filter and search.

---

#### `PATCH /api/admin/users/:id`

Update a user's role or status.

---

#### `GET /api/admin/appointments`

All appointments across the platform with full details.

---

#### `GET /api/admin/payments`

All payment records.

---

#### `GET /api/admin/audit-logs`

HIPAA audit trail. Paginated, filterable by user, action, date range.

---

#### `GET /api/admin/doctors`

All doctor records including verification status.

---

#### `PATCH /api/admin/doctors/:id/verify`

Verify or unverify a doctor.

**Body:** `{ "verified": true }`

---

#### `GET /api/admin/discount-codes`

List all discount codes.

---

#### `POST /api/admin/discount-codes`

Create a new discount code.

**Body:** `{ "code": "SAVE10", "discount_percent": 10, "max_uses": 500 }`

---

#### `DELETE /api/admin/discount-codes/:id`

Delete a discount code.

---

### 5.7 GDPR — `/api/gdpr`

Rate limit: **5 requests per 15 minutes** (strict tier)

#### `GET /api/gdpr/export`

**GDPR Article 20 — Data Portability.** Export all personal data as a JSON file download.

Returns: profile, appointments (decrypted), messages (decrypted), reviews, consent records, audit history.

---

#### `DELETE /api/gdpr/me`

**GDPR Article 17 — Right to Erasure.** Anonymise all personal data.

**Body:** `{ "confirm": "DELETE MY ACCOUNT" }` (exact string required)

- Name replaced with "Deleted User"
- Email replaced with `deleted_<random>@deleted.mediconnect`
- Phone cleared
- Medical records retained in de-identified form (legal obligation)
- All refresh tokens revoked
- Returns reference number for the erasure request

---

#### `POST /api/gdpr/consent`

Record a consent decision (analytics or essential-only).

**Body:** `{ "consent_type": "analytics|essential_only", "granted": true }`

---

## 6. Middleware

### `middleware/auth.js`

- `auth(req, res, next)` — Verifies JWT from `Authorization: Bearer <token>` header. Attaches `req.user` on success.
- `requireRole(...roles)` — Factory for role-based access control. Returns 403 if user's role is not in the allowed list.
- `isLockedOut(email, ip)` — Returns true if the account has exceeded failed login attempts within the lockout window. Checked per email AND per IP.
- `recordAttempt(email, ip, success)` — Writes a login attempt record.
- `lockoutInfo(email, ip)` — Returns `{ attempts_remaining, lockout_minutes }`.

**Lockout settings** (via environment variables):
- `MAX_LOGIN_ATTEMPTS` — default 5
- `LOCKOUT_MINUTES` — default 30

---

### `middleware/audit.js`

HIPAA §164.312(b) — Hardware, software, and procedural mechanisms that record and examine activity in information systems containing PHI.

- `auditMiddleware(req, res, next)` — Automatically logs all accesses to PHI routes (`/api/appointments/*`, `/api/messages/*`, `/api/auth/me`, `/api/gdpr/*`) after response finishes.
- `writeAudit({ userId, role, action, resourceType, resourceId, ip, userAgent, details, success })` — Write a structured audit entry to both SQLite (`audit_logs` table) and the `logs/audit.log` file.
- `getIP(req)` — Extracts real client IP from `X-Forwarded-For` (behind proxy/nginx) or `req.socket.remoteAddress`.

---

### `middleware/rateLimiter.js`

Four rate-limiting tiers:

| Tier | Limit | Window | Applied To |
|---|---|---|---|
| `auth` | 10 requests | 15 minutes | `/api/auth` |
| `strict` | 5 requests | 15 minutes | `/api/gdpr` |
| `api` | 200 requests | 15 minutes | All other `/api/*` |
| `public` | 60 requests | 1 minute | Public/static routes |

All return `429 Too Many Requests` with JSON `{ "error": "...", "retryAfter": <seconds> }` and `Retry-After` header.

---

## 7. Utilities

### `utils/encryption.js`

AES-256-GCM field-level encryption for Protected Health Information (PHI).

- **Algorithm:** AES-256-GCM (authenticated encryption — provides confidentiality + integrity)
- **Key derivation:** `crypto.scryptSync(ENCRYPTION_KEY, salt, 32)` — deriving a 256-bit key from the environment secret
- **IV:** 96-bit random nonce per encryption operation
- **Auth tag:** 128-bit GCM authentication tag
- **Format:** `enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`
- **Double-encryption guard:** `encrypt()` checks for the `enc:v1:` prefix and returns unchanged if already encrypted

```javascript
encrypt(plaintext)  // → "enc:v1:..." string
decrypt(ciphertext) // → original plaintext string
```

Fields encrypted: `appointments.reason`, `appointments.notes`, `messages.content`

---

### `utils/logger.js`

Winston logger with the following transports:

| Transport | File | Max Size | Retention |
|---|---|---|---|
| Error log | `logs/error.log` | 10 MB | 90 days |
| Combined log | `logs/combined.log` | 50 MB | 30 days |
| Console | stdout | — | — |

Log format: `{ timestamp, service: "mediconnect", version: "2.0.0", level, message, ...meta }`

Usage: `logger.info('HTTP', { method, path, status, ms })` / `logger.error(...)` / `logger.warn(...)`

---

## 8. Frontend Pages

### `public/index.html` — Patient Portal

The main single-page application. No framework — pure JavaScript with a page-switching pattern (`showPage(name)`).

**Pages within index.html:**

| Page ID | Nav Link | Description |
|---|---|---|
| `page-home` | Home | Hero, doctor previews, features, testimonials, FAQ |
| `page-doctors` | Find Doctors | Full doctor listing with search/filter, specialist grid |
| `page-profile` | (doctor card click) | Doctor profile, schedule, reviews, booking form |
| `page-appointments` | My Appointments | Appointment list with status, cancel, Join Call button |
| `page-chat` | Messages | Real-time encrypted chat with doctor |
| `page-bmi` | BMI & Nutrition | BMI calculator, goal selector, ingredient picker, recipe engine |
| `page-ai` | AI Analysis | File upload for AI-powered medical document analysis |
| `page-account` | (user menu) | Profile settings, password change, GDPR controls, audit trail |

**Key JavaScript modules (inline script):**

- `Auth` — localStorage helpers for `mc_token`, `mc_user`, `mc_refresh_token`
- `API` — Fetch wrapper for all API calls with JWT header injection
- `showPage(p)` — SPA page router
- `openModal(id)` / `closeModal(id)` — Modal show/hide
- `doLogin()` / `doSignup()` — Form submit handlers
- `updateNavForUser(user)` — Renders user chip with role-appropriate menu (Admin Panel / Doctor Panel links)
- `loadDoctors()` / `renderDoctors()` — Doctor grid rendering
- `openProfile(id)` — Loads and renders doctor profile page
- `openChat(userId, name, avatar, role)` — Opens chat with message history
- `loadConversations(autoOpen)` — Loads sidebar; if `autoOpen=true` and no chat is open, auto-selects first conversation
- `sendMsg()` — Sends via Socket.io with REST fallback
- `callDoctor(doctorId, type)` — Initiates WebRTC call from appointment

---

### `public/admin.html` — Admin Dashboard

Separate page, requires `role === 'admin'`. Redirects to `/` if unauthorised.

**Panels:**

| Panel | Description |
|---|---|
| Overview | Stats grid (patients, doctors, appointments, revenue), recent appointments, active discount codes |
| Doctors | Full doctor list, verify/unverify, toggle online status |
| Patients | All registered users |
| Appointments | All bookings with status management |
| Payments | Payment records and totals |
| Discount Codes | Create and delete promo codes |

**Navigation:** `← Main Site` button in topbar links back to `/`.

---

### `public/doctor.html` — Doctor Dashboard

Separate page, requires `role === 'doctor'`. Redirects to `/` if unauthorised.

**Features:**
- Appointment list (pending, confirmed, completed) with notes editor
- Patient chat panel (same Socket.io-backed chat with WebRTC calling)
- Online/offline status toggle
- Profile and schedule management

---

### `public/js/api.js`

Shared between all pages. Exports:
- `API` — All REST API methods
- `Auth` — Token/user localStorage management
- `showToast(msg, type)` — Notification toast
- `timeAgo(dt)` — Human-readable timestamps
- `formatDate(dt)` — Date formatting

---

### `public/js/chat.js`

- `ChatManager` class — Wraps Socket.io socket; handles `new_message`, `user_status`, `typing`, `messages_read` events
- `initChat(token, user)` — Creates global `Chat` instance and connects
- `renderMessage(msg, currentUserId)` — Returns HTML for a single message bubble
- `escHtml(s)` — XSS-safe HTML escaping
- `scrollChatToBottom(el)` — Scrolls message container

---

### `public/js/webrtc.js`

Self-contained IIFE exporting `WebRTCCall` object. See [Section 10](#10-webrtc-video--audio-calling).

---

### `public/js/compliance.js`

HIPAA/GDPR compliance module. See [Section 11](#11-security--compliance).

---

### Other Pages

| File | Description |
|---|---|
| `public/privacy.html` | GDPR-compliant Privacy Policy |
| `public/terms.html` | Terms of Service |
| `public/payment-success.html` | eSewa payment success redirect handler |
| `public/payment-fail.html` | eSewa payment failure page |

---

## 9. Real-time Features (Socket.io)

The Socket.io server runs on the same HTTP server as Express.

### Authentication

Every socket connection requires a valid JWT in the handshake:
```javascript
io({ auth: { token: localStorage.getItem('mc_token') } })
```
The server verifies the token with `jwt.verify()` before allowing the connection. Unauthenticated connections are rejected.

### Online Users Map

`onlineUsers: Map<userId, socketId>` — tracks which users are currently connected.

On connect: `io.emit('user_status', { userId, online: true })` broadcast to all clients.  
On disconnect: removes from map, broadcasts `online: false`.

### Chat Events

| Event | Direction | Payload | Description |
|---|---|---|---|
| `send_message` | Client → Server | `{ to, content }` | Send a message. Encrypted and stored; delivered to recipient if online |
| `new_message` | Server → Client | Full message object | Received by both sender and recipient |
| `mark_read` | Client → Server | `{ from }` | Mark all messages from `from` as read |
| `messages_read` | Server → Client | `{ by }` | Notifies sender their messages were read |
| `typing` | Client → Server | `{ to }` | User is typing |
| `typing` | Server → Client | `{ from, name }` | Forwarded to recipient |
| `stop_typing` | Client → Server | `{ to }` | User stopped typing |
| `stop_typing` | Server → Client | `{ from }` | Forwarded to recipient |

### WebRTC Signaling Events

| Event | Direction | Description |
|---|---|---|
| `call:offer` | Client → Server | Caller sends SDP offer; server forwards to recipient as `call:incoming` |
| `call:answer` | Client → Server | Callee answers; forwarded as `call:answered` |
| `call:ice-candidate` | Bidirectional | ICE candidates forwarded between peers |
| `call:reject` | Client → Server | Call declined; forwarded as `call:rejected` |
| `call:end` | Client → Server | Call ended; forwarded as `call:ended` |
| `call:unavailable` | Server → Caller | Recipient is offline |

---

## 10. WebRTC Video & Audio Calling

File: `public/js/webrtc.js`

### Exported API

```javascript
WebRTCCall.init(socket, user)          // Attach to Socket.io socket, inject UI
WebRTCCall.start(userId, name, avatar, type) // type: 'video'|'audio' — initiate call
WebRTCCall.endCall()                   // End active call
WebRTCCall.toggleMic()                 // Mute/unmute microphone
WebRTCCall.toggleCam()                 // Turn camera on/off
WebRTCCall._acceptCall()               // Accept incoming call
WebRTCCall._rejectCall()               // Decline incoming call
```

### Call Flow

**Outgoing call (caller):**
1. `start()` called → `getUserMedia()` for camera/mic
2. Create `RTCPeerConnection` with 3 STUN servers
3. Add local stream tracks to peer connection
4. `createOffer()` → `setLocalDescription()` → emit `call:offer` to server
5. Server forwards to recipient via `call:incoming`
6. Receive `call:answered` → `setRemoteDescription(answer)`
7. ICE candidates exchanged via `call:ice-candidate`

**Incoming call (callee):**
1. Receive `call:incoming` → show incoming call modal (auto-reject after 35 seconds)
2. `_acceptCall()` → `getUserMedia()` → create `RTCPeerConnection`
3. `setRemoteDescription(offer)` → `createAnswer()` → `setLocalDescription()` → emit `call:answer`
4. ICE candidates exchanged

### STUN Servers

- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`
- `stun:stun2.l.google.com:19302`

### UI Overlays

Two `position:fixed` overlays injected into `document.body` on `init()`:

- `#wrtc-incoming` — Incoming call modal with Accept (green) and Decline (red) buttons, 35-second auto-reject
- `#wrtc-overlay` — Active call overlay: remote video (full-screen), local PiP video (bottom-right), call timer, mic/camera/end controls

Both overlays have `display:none` inline style and are shown/hidden programmatically.

### Where Calling Is Wired Up

- **Patient chat header** (index.html) — 🎵 Audio and 📹 Video buttons per open conversation
- **Doctor chat header** (doctor.html) — Same buttons for the patient side
- **My Appointments** (index.html) — "Join Call" button on confirmed appointments calls `callDoctor(doctorId, 'video')`

---

## 11. Security & Compliance

### Content Security Policy (Helmet)

```
default-src 'self'
script-src  'self' 'unsafe-inline'
script-src-attr 'unsafe-inline'      ← required for onclick/onchange handlers
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com
font-src    'self' https://fonts.gstatic.com
img-src     'self' data: https:
connect-src 'self' ws: wss:
frame-ancestors 'none'               ← prevents clickjacking
```

### HSTS

`max-age=63072000; includeSubDomains; preload` (2 years)

### HIPAA Technical Safeguards (45 CFR §164.312)

| Safeguard | Implementation |
|---|---|
| Access Control (a)(1) | JWT authentication + role-based route protection |
| Unique User ID (a)(2)(i) | Each user has unique ID; shared accounts not possible |
| Automatic Logoff (a)(2)(iii) | 15-minute idle session timeout in compliance.js |
| Encryption (a)(2)(iv) / (e)(2)(ii) | AES-256-GCM for PHI at rest; HTTPS for PHI in transit |
| Audit Controls (b) | All PHI access logged to audit_logs table and audit.log file |
| Integrity (c)(1) | GCM authentication tag verifies data has not been altered |
| Authentication (d) | JWT signed with HS256; refresh token rotation |
| Transmission Security (e)(1) | TLS 1.2+ enforced in production |

### GDPR / CCPA / PDPA Compliance

| Right | Implementation |
|---|---|
| Right to Access (Art. 15) | `GET /api/gdpr/export` — full data export |
| Right to Erasure (Art. 17) | `DELETE /api/gdpr/me` — anonymisation |
| Right to Portability (Art. 20) | JSON export with all personal data |
| Consent (Art. 6/7) | Explicit checkbox at registration; consent_records table; cookie consent banner |
| Data Minimisation (Art. 5) | Only necessary fields collected |
| DPO Contact | `dpo@mediconnect.com` in `/api/compliance/info` |

### `public/js/compliance.js` Module

| Feature | Detail |
|---|---|
| Session timeout warning | Shows modal at 14 minutes of inactivity |
| Forced logout | At 15 minutes idle — revokes refresh token, clears localStorage, redirects |
| Activity tracking | `mousedown`, `mousemove`, `keydown`, `scroll`, `touchstart`, `click` events reset the timer |
| Cookie consent banner | Shown on first visit; records `essential_only` or `all` to `mc_consent_v1` in localStorage and POST to `/api/gdpr/consent` |
| Session expired notice | Toast shown on redirect back after auto-logout (`?session_expired=1`) |

### Password Security

- bcrypt with cost factor **12** (~300ms per hash — resistant to brute force)
- Minimum 8 chars, uppercase, lowercase, digit, special character
- Old/new passwords compared — prevents password reuse
- Account lockout: 5 failed attempts → 30-minute lockout (configurable)

### Token Security

- Access tokens: JWT HS256, 1-day expiry
- Refresh tokens: 384-bit random, stored as SHA-256 hash, 7-day expiry, single-use (rotated)
- On password change: all refresh tokens revoked

---

## 12. Environment Variables

Create a `.env` file at the project root:

```env
# Server
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000

# JWT (use a long random string in production)
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=1d
JWT_REFRESH_EXPIRES_IN=7d

# Encryption (32+ character random string for AES-256 key derivation)
ENCRYPTION_KEY=your-32-char-minimum-encryption-key

# Auth lockout
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_MINUTES=30

# eSewa payment gateway
ESEWA_SCD=EPAYTEST             # Merchant code (use real code in production)
ESEWA_GATEWAY=https://rc-epay.esewa.com.np/api/epay/main/v2/form
ESEWA_VERIFY_URL=https://rc-epay.esewa.com.np/api/epay/transaction/status/
APP_URL=http://localhost:3000

# GDPR
DPO_EMAIL=dpo@mediconnect.com
TERMS_VERSION=1.0
```

---

## 13. Setup & Running

### Prerequisites

- Node.js v22+ (uses `node:sqlite` built-in module)
- Windows / macOS / Linux

### Installation

```bash
cd Mediconnect
npm install
```

### First Run (seeds database automatically)

```bash
node server.js
# or for development with auto-restart:
npx nodemon server.js
```

The database is created and seeded on first run:
- 1 admin account
- 8 specialist doctors with schedules
- 1 test patient
- 5 discount codes

### Running on Windows (background process)

```powershell
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "C:\Users\Hp\Mediconnect" -WindowStyle Hidden
```

### Stopping the Server

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Health Check

```
GET http://localhost:3000/health
→ { "status": "ok", "ts": "...", "version": "2.0.0" }
```

### Compliance Info

```
GET http://localhost:3000/api/compliance/info
→ { "frameworks": ["HIPAA","GDPR","CCPA","PDPA"], "encryption": "AES-256-GCM", ... }
```

---

## 14. Default Credentials & Seed Data

> **For development and testing only. Change all passwords in production.**

### Login Accounts

| Role | Email | Password | Access |
|---|---|---|---|
| Admin | admin@mediconnect.com | Admin@123 | /admin.html — full platform management |
| Doctor | rajesh@mediconnect.com | Doctor@123 | /doctor.html — appointments, chat, profile |
| Patient | ram@example.com | Patient@123 | /index.html — booking, chat, history |

All 8 seeded doctors share the password `Doctor@123`:

| Doctor | Specialty | Hospital |
|---|---|---|
| Dr. Rajesh Sharma | Cardiologist | Bir Hospital |
| Dr. Priya Gurung | Dermatologist | Teaching Hospital |
| Dr. Anish Thapa | Neurologist | BPKIHS |
| Dr. Sita Maharjan | Gynecologist | Maternity Hospital |
| Dr. Ram Bahadur KC | Pediatrician | Kanti Children Hospital |
| Dr. Meena Poudel | Psychiatrist | Patan Hospital |
| Dr. Suresh Shrestha | Orthopedist | Nepal Police Hospital |
| Dr. Kamala Tamang | Ophthalmologist | Nepal Eye Hospital |

### Discount Codes

| Code | Discount | Uses Allowed |
|---|---|---|
| WELCOME20 | 20% | 1,000 |
| HEALTH30 | 30% | 500 |
| FIRST50 | 50% | 200 |
| NEWYEAR15 | 15% | 300 |
| ADMIN100 | 100% | 10 |

---

*MediConnect v2.0.0 — Built for Nepal's digital health ecosystem*  
*Compliance: HIPAA 45 CFR §164.312 · GDPR (EU) 2016/679 · CCPA · Nepal ETA 2063*


Login credentials:

Role	Email	Password
Admin	  admin@mediconnect.com	  Admin@123
Doctor	rajesh@mediconnect.com	Doctor@123
Patient	ram@example.com	Patient@123

(All 8 doctors share Doctor@123 — priya@, anish@, sita@, ram.kc@, meena@, suresh@, kamala@mediconnect.com)