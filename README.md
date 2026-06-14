# MediConnect — Digital Health Platform

> Nepal's trusted digital health platform connecting patients with verified doctors for online and in-person appointments.

## Features

### For Patients
- Browse and filter verified specialist doctors by specialty, rating, and availability
- Book physical or video appointments with a date picker and time slot selection
- Real-time encrypted messaging with doctors (Socket.io)
- Video/audio consultations via WebRTC (peer-to-peer)
- View clinical notes left by doctors after each appointment
- Pay via eSewa, Khalti, or cash — discount codes supported
- Leave doctor reviews and ratings
- GDPR data export, erasure, and audit trail

### For Doctors
- Dashboard with today's appointments, total patients, rating, **total revenue**, and **this month's revenue**
- Manage personal availability schedule — add or remove time slots by day, time, and type (physical/video)
- Write clinical notes per appointment (visible to patients)
- Real-time messaging with patients
- Toggle online/offline status
- Change profile, fee, hospital, and bio

### For Admins
- Platform-wide statistics (users, doctors, appointments, revenue)
- Doctor verification/approval workflow
- Manage users, appointments, payments, and discount codes
- HIPAA audit log viewer
- GDPR data request management

### Real-time & Communication
- Socket.io bidirectional messaging with typing indicators and read receipts
- WebRTC video/audio calls — when a call is missed or declined, a **📞 Missed call** message appears in chat for both parties
- Online/offline status tracking

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Real-time | Socket.io |
| Video Calls | WebRTC (RTCPeerConnection) |
| Database | SQLite (node:sqlite, WAL mode) |
| Authentication | JWT (access + refresh tokens) |
| Encryption | AES-256-GCM (PHI fields) |
| Password Hashing | bcryptjs (cost 12) |
| Security Headers | Helmet.js |
| Rate Limiting | express-rate-limit |
| Payments | eSewa gateway integration |
| Frontend | Vanilla JS, Socket.io client |
| Logging | Winston |

## Security & Compliance

- **HIPAA** §164.312 — AES-256-GCM encryption for all PHI, immutable audit log, access controls, account lockout
- **GDPR** Art. 7/15/17/20 — consent records, right of access, erasure, and data portability endpoints
- **CCPA / PDPA** — data handling aligned with international privacy standards
- **OWASP Top 10** mitigations — CSP, HSTS, rate limiting, input validation, no stack trace leakage
- JWT refresh token rotation — old tokens revoked on each refresh
- Brute-force protection — 5 failed logins → 30-minute lockout per email/IP

## Getting Started

### Prerequisites
- Node.js 22+
- npm

### Installation

```bash
git clone https://github.com/enriqueshr/Mediconnect---Final.git
cd Mediconnect---Final
npm install
```

### Environment Variables

Create a `.env` file in the root directory:

```env
PORT=3000
NODE_ENV=development
JWT_SECRET=your_long_random_hex_secret
ENCRYPTION_KEY=your_32_byte_hex_key
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_MINUTES=30
ALLOWED_ORIGINS=http://localhost:3000
ESEWA_MERCHANT_CODE=your_merchant_code
ESEWA_GATEWAY_URL=https://rc-epay.esewa.com.np/api/epay/main/v2/form
ESEWA_VERIFY_URL=https://rc-epay.esewa.com.np/api/epay/transaction/status/
DPO_EMAIL=dpo@mediconnect.com
PRIVACY_POLICY_VERSION=1.0
TERMS_VERSION=1.0
```

### Run

```bash
npm start
# or for development with auto-restart:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Test Credentials (development only)

| Role | Email | Password |
|---|---|---|
| Admin | admin@mediconnect.com | Admin@123 |
| Doctor | rajesh@mediconnect.com | Doctor@123 |
| Patient | ram@example.com | Patient@123 |

## Project Structure

```
Mediconnect/
├── db/
│   └── index.js          # SQLite schema, migrations, seed data
├── middleware/
│   ├── auth.js           # JWT validation, role guards, account lockout
│   ├── audit.js          # HIPAA audit logging
│   └── rateLimiter.js    # Tiered rate limiting
├── routes/
│   ├── auth.js           # Register, login, password management
│   ├── doctors.js        # Doctor profiles, schedule management, reviews
│   ├── appointments.js   # Booking, status, clinical notes
│   ├── messages.js       # Encrypted messaging REST endpoints
│   ├── payments.js       # eSewa / Khalti / cash flows
│   ├── admin.js          # Admin dashboard APIs
│   └── gdpr.js           # Data export, erasure, consent, audit trail
├── public/
│   ├── index.html        # Patient portal SPA
│   ├── doctor.html       # Doctor dashboard
│   ├── admin.html        # Admin console
│   ├── css/style.css     # Design system
│   └── js/
│       ├── api.js        # REST API client + auth state
│       ├── chat.js       # Socket.io ChatManager
│       ├── webrtc.js     # WebRTC video/audio calling
│       └── compliance.js # GDPR consent UI
├── utils/
│   ├── encryption.js     # AES-256-GCM PHI encryption
│   └── logger.js         # Winston structured logging
├── server.js             # Express app + Socket.io server + WebRTC signaling
└── package.json
```

## API Overview

| Method | Endpoint | Description |
|---|---|---|
| POST | /api/auth/register | Patient signup |
| POST | /api/auth/login | Login (returns JWT) |
| GET | /api/doctors | List verified doctors |
| GET | /api/doctors/:id | Doctor profile + schedule + reviews |
| POST | /api/doctors/:id/schedule | Add availability slot (doctor) |
| DELETE | /api/doctors/:id/schedule/:slotId | Remove availability slot |
| POST | /api/appointments | Book appointment |
| PATCH | /api/appointments/:id/notes | Add clinical notes (doctor) |
| GET | /api/messages/conversations | List conversations |
| POST | /api/payments/esewa/initiate | Initiate eSewa payment |
| GET | /api/admin/stats | Platform statistics (admin) |
| GET | /api/gdpr/export | GDPR data export |

## License

This project is for educational and demonstration purposes.

---

Built with by the MediConnect team.
