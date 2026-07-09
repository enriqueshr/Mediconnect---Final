# Security & Compliance Policy

MediConnect handles Protected Health Information (PHI) and is designed to meet the technical safeguards required by **HIPAA**, the data-subject rights mandated by **GDPR**, and the consumer-privacy obligations of **CCPA** and **PDPA**. This document describes the threat model the platform defends against, the controls implemented in code, the limitations we are aware of, and the procedure for reporting suspected vulnerabilities.

---

## 1. Reporting a Vulnerability

If you believe you have found a security vulnerability in MediConnect, **please do not file a public GitHub issue**. Coordinated disclosure protects users while a fix is prepared.

- **Contact:** `dpo@mediconnect.com`
- **Expected first response:** within 72 hours of receipt
- **Coordinated disclosure window:** 90 days from acknowledgement, by default
- **Scope:** any vulnerability that affects confidentiality, integrity, or availability of patient data, authentication, payment processing, or audit integrity

Please include reproduction steps, affected endpoints or files, and the impact you have observed. We will credit reporters in the release notes for the fix release, with their consent.

---

## 2. Compliance Frameworks

MediConnect is implemented against the following regulatory baselines:

| Framework | Scope | Implementation reference |
|---|---|---|
| **HIPAA 45 CFR §164.312** | US — Technical Safeguards for ePHI | §§ 4 – 6 of this document |
| **GDPR (EU) 2016/679** | EU — Personal data rights and processing | §§ 7 – 8 of this document |
| **CCPA** | California — Consumer privacy rights | Treated as a strict subset of GDPR rights |
| **PDPA** | Singapore and similar jurisdictions | Treated as a strict subset of GDPR rights |
| **Nepal Electronic Transactions Act 2063** | Local — Electronic records and signatures | Applies to data localisation considerations |

All four frameworks are intentionally treated as additive: a control implemented for the strictest applicable regulation satisfies the weaker ones by construction.

---

## 3. Threat Model

The platform is designed to defend against the following threat classes:

1. **Database compromise** — an attacker obtains a copy of `mediconnect.db`. Mitigation: AES-256-GCM encryption of PHI fields with the key held outside the database (§ 4).
2. **Credential stuffing and brute-force** — automated guessing of valid email/password pairs. Mitigation: bcrypt cost 12, account lockout by both email and IP, tiered rate limiting (§ 5).
3. **Session hijacking** — an attacker obtains a JWT or refresh token. Mitigation: short-lived access tokens, single-use rotating refresh tokens (revocation on rotation detects theft), 15-minute idle auto-logoff with server-side revocation (§ 5).
4. **Tampering of PHI at rest** — an attacker modifies encrypted data in the database to subvert clinical decisions. Mitigation: GCM authentication tag detects any modification of the ciphertext on decrypt (§ 4).
5. **Insider access without audit** — a staff member or administrator accesses patient data without leaving evidence. Mitigation: every request to a PHI route writes an immutable audit log entry, retained for six years (§ 6).
6. **Payment-redirect spoofing** — a malicious party constructs a fake eSewa success redirect to mark an unpaid appointment as paid. Mitigation: server-side payment verification against eSewa's transaction status endpoint before the appointment is marked paid.
7. **Clickjacking and cross-origin abuse** — embedding the application inside a hostile iframe. Mitigation: `frame-ancestors 'none'` Content Security Policy and strict CORS allow-list.

Out-of-scope threats (defended against by infrastructure or operationally, not in code): physical attacks on hosting, DDoS at the network layer, malicious nation-state actors with arbitrary computation, and supply-chain compromise of upstream npm packages.

---

## 4. Cryptography

### 4.1 Encryption at Rest (HIPAA §164.312(a)(2)(iv))

- **Algorithm:** AES-256-GCM (authenticated encryption — provides both confidentiality and integrity)
- **Key derivation:** `crypto.scryptSync(ENCRYPTION_KEY, SALT, 32)` produces a 256-bit key from the environment secret. Direct use of the raw env value is prohibited; scrypt produces a uniformly random key regardless of the entropy of the input.
- **Initialization vector:** 96-bit random IV (`crypto.randomBytes(12)`), freshly generated for every encryption operation. IV reuse with the same key is prohibited and is impossible by construction in our code path.
- **Authentication tag:** 128-bit GCM authentication tag. Verified on every decrypt; modification of any byte of ciphertext, IV, or tag causes decryption to fail.
- **Storage format:** `enc:v1:<iv_hex>.<ciphertext_hex>.<tag_hex>`. The `enc:v1:` prefix is a version marker permitting future algorithm rotation; values lacking the prefix are passed through as plaintext, supporting migration from legacy data.
- **Double-encryption guard:** `encrypt()` checks for the version prefix and returns unchanged values that are already encrypted, preventing data corruption on accidental double-encryption.

### 4.2 Encrypted PHI Fields

The following fields are encrypted at rest:

| Table | Column | Source path |
|---|---|---|
| `appointments` | `reason` | `routes/appointments.js` (on booking) |
| `appointments` | `notes` | `routes/appointments.js` (on doctor note update) |
| `messages` | `content` | `server.js` Socket.io `send_message` handler |

Other PHI-adjacent identifiers (name, email, phone) are stored in plaintext for operational reasons and are erased rather than encrypted in response to GDPR Article 17 requests.

### 4.3 Encryption in Transit

- **HTTPS / TLS 1.2 or higher** is required for all production traffic
- **HSTS:** `max-age=63072000; includeSubDomains; preload` (two years)
- **WebRTC media:** DTLS-SRTP, mandatory per the WebRTC specification — applies to both video and audio streams
- **Socket.io:** WSS in production; the WebSocket connection inherits the TLS termination of the HTTPS endpoint

### 4.4 Password Hashing

- **Algorithm:** bcrypt (`bcryptjs`)
- **Cost factor:** 12 — approximately 300 ms per hash on commodity hardware, deliberately slow to make brute-force prohibitively expensive

---

## 5. Authentication, Authorization, and Session Management

### 5.1 JWT Access Tokens

- **Algorithm:** HS256
- **Lifetime:** 1 day (`JWT_EXPIRES_IN`)
- **Claims:** `id`, `role`, `name`, `email`, `iss=mediconnect`, `aud=mediconnect-client`
- **Verification:** issuer and audience are verified on every protected request

### 5.2 Refresh Tokens

- **Generation:** 384-bit random (`crypto.randomBytes(48)`)
- **Storage:** the raw token is returned to the client once; only the SHA-256 hash is persisted in `refresh_tokens`
- **Lifetime:** 7 days
- **Rotation:** every refresh revokes the old token and issues a new one. A refresh against an already-revoked token is treated as a potential compromise signal
- **Revocation triggers:** explicit logout, password change (revokes all tokens for the user), idle auto-logoff, and GDPR erasure

### 5.3 Account Lockout (HIPAA §164.312(a)(2)(iii))

- **Threshold:** 5 failed login attempts in 30 minutes
- **Tracking:** by both email AND IP address; the IP threshold is 3× the email threshold to prevent credential-stuffing from a single host without locking out legitimate shared-IP users
- **Lockout duration:** 30 minutes (configurable via `LOCKOUT_MINUTES`)
- **Failed attempts are logged** to `login_attempts` and counted toward the rolling window

### 5.4 Password Complexity

Minimum requirements at registration and password change:

- 8 characters minimum
- At least one uppercase letter
- At least one lowercase letter
- At least one digit
- At least one non-alphanumeric character

Password change additionally requires that the new password differs from the current password.

### 5.5 Role-Based Access Control

Three roles: `patient`, `doctor`, `admin`. Implemented in `middleware/auth.js` via the `requireRole(...roles)` factory. Every PHI route enforces role at the route level; resource-ownership checks (e.g. a patient may only access their own appointments) are applied inside the route handler.

### 5.6 Idle Auto-Logoff

- **Trigger:** 15 minutes without activity (mouse, keyboard, scroll, touch, click)
- **Warning:** displayed at 14 minutes with a live countdown
- **Behaviour on timeout:** revokes the refresh token server-side, clears all client-side storage, redirects to the appropriate login page with `session_expired=1`
- **Implementation:** `public/js/compliance.js`

### 5.7 Rate Limiting

Four tiers, applied per route family:

| Tier | Limit | Window | Applied to |
|---|---|---|---|
| `auth` | 10 | 15 min | `/api/auth/*` |
| `strict` | 5 | 15 min | `/api/gdpr/*` |
| `api` | 200 | 15 min | All other authenticated API routes |
| `public` | 60 | 1 min | Unauthenticated public endpoints |

Admin role bypasses the `api` tier. Responses use `Retry-After` headers and the IETF draft-7 standard rate-limit headers.

### 5.8 HTTP Security Headers

Set by `helmet`:

- **Content Security Policy:** `default-src 'self'`, `frame-ancestors 'none'` (clickjacking prevention)
- **HSTS:** 2-year max-age, includeSubDomains, preload
- **Referrer-Policy:** `strict-origin-when-cross-origin`
- **X-Frame-Options / X-Content-Type-Options:** managed by helmet defaults
- **Permissions-Policy:** restricts microphone and camera to `self`, denies geolocation, payment, USB, magnetometer, gyroscope

---

## 6. Audit Logging (HIPAA §164.312(b))

Every request to a PHI route is automatically logged after the response is sent. PHI routes are:

- `/api/appointments`
- `/api/messages`
- `/api/auth/me`
- `/api/gdpr`

Each audit entry captures:

- `user_id`, `role` — who performed the action
- `action` — the HTTP method and path, or a semantic action name (e.g. `CREATE_APPOINTMENT`, `GDPR_EXPORT`)
- `resource_type`, `resource_id` — what was touched
- `ip_address`, `user_agent` — origin (the X-Forwarded-For header is honoured when the application is deployed behind a trusted reverse proxy)
- `success` — outcome
- `created_at` — UTC timestamp

Audit entries are written to two destinations: the `audit_logs` SQLite table (for queryable inspection via the admin dashboard) and the `audit.log` Winston file (for immutable long-term retention).

### Retention (HIPAA §164.316(b)(2)(i))

- **Audit logs:** retained for a minimum of 6 years. Winston file rotation is configured for 100 MB files with 2200 rotations, satisfying the retention requirement at a rough rate of one rotation per day.
- **Refresh tokens:** retained for 7 days plus a brief tombstone period after revocation, for incident-response correlation.
- **Login attempts:** retained for the duration needed to enforce the lockout policy.

---

## 7. GDPR Data-Subject Rights

| Article | Right | Endpoint | Implementation summary |
|---|---|---|---|
| Art. 15 | Right of Access | `GET /api/gdpr/audit-trail` | Returns the user's last 500 audit entries |
| Art. 17 | Right to Erasure | `DELETE /api/gdpr/me` | Anonymisation flow — see § 8 |
| Art. 20 | Right to Portability | `GET /api/gdpr/export` | JSON download of all the user's personal data |
| Art. 7 | Conditions for Consent | `POST /api/gdpr/consent` | Records consent decisions with IP and version |
| Art. 12 | Transparent communication | `POST /api/gdpr/data-request` | Catch-all request endpoint with 30-day response commitment |

Cookie consent is collected on first visit via a non-blocking banner, recorded locally in `mc_consent_v1` and (for authenticated users) persisted to the `consent_records` table for legal evidence of the consent transaction.

---

## 8. HIPAA / GDPR Retention Conflict Resolution

GDPR Article 17 grants users a right to deletion of personal data on request. HIPAA §164.316(b)(2)(i) requires medical records to be retained for a minimum of six years. These rules directly contradict each other when a patient requests erasure.

MediConnect resolves this conflict via **anonymisation**, relying on GDPR Recital 26:

> "The principles of data protection should ... not apply to anonymous information ... [or] to personal data rendered anonymous in such a manner that the data subject is not or no longer identifiable."

On an Article 17 erasure request, the platform:

1. Replaces the user's name with `deleted-user-<id>` and the email with a placeholder in the `anonymized.invalid` domain
2. Clears the phone number
3. Sets the password hash to a non-recoverable sentinel
4. Replaces all message contents involving the user with `[GDPR-ERASED]`
5. Replaces the `reason` and `notes` fields of the user's appointments with `[GDPR-ERASED]`, while leaving the structural appointment record (date, doctor, fee) intact
6. Revokes all refresh tokens for the user
7. Records a completed erasure entry in `data_requests`

The resulting medical record exists for HIPAA's six-year retention period but can no longer be linked to a specific individual; it is therefore no longer "personal data" under GDPR and is no longer subject to the erasure right. A single transaction satisfies both regulators.

The user is informed of the boundary of the erasure in the response message: *"Your personal data has been anonymised. Medical records are retained in de-identified form as required by healthcare regulations. Audit logs are retained as required by law."*

---

## 9. Known Limitations

The following are intentionally documented and out of scope for the current implementation:

- **TURN relay server not deployed.** WebRTC video calls rely on STUN for NAT traversal (three Google STUN servers). Users behind symmetric NAT (common in some corporate networks, hotels, and mobile carriers) will not be able to establish a direct peer connection. Deploying a TURN relay is the standard remediation but was excluded from the current implementation on cost grounds.
- **Development fallback encryption key.** When `ENCRYPTION_KEY` is not set, `utils/encryption.js` falls back to a non-secret development default. Production deployments MUST set `ENCRYPTION_KEY` to a 32-character minimum cryptographically random value.
- **Seeded credentials.** The development database is seeded with predictable passwords (`Admin@123`, `Doctor@123`, `Patient@123`) to enable local testing. These MUST be rotated before any production deployment.
- **Audit log integrity.** Audit logs are stored in SQLite and on the local filesystem. A privileged attacker with shell access to the host could in principle tamper with both. Production deployments should ship audit logs to a separate append-only store (such as a SIEM or a write-once cloud bucket).
- **No automated dependency scanning is currently configured.** Production deployments should integrate a tool such as Snyk, GitHub Dependabot, or `npm audit` in CI.

---

## 10. Deployment Security Checklist

Operators preparing a production deployment of MediConnect should confirm the following:

- [ ] `ENCRYPTION_KEY` is set to a 32-character minimum cryptographically random value, generated via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] `JWT_SECRET` is set to a 32-character minimum cryptographically random value
- [ ] `NODE_ENV=production`
- [ ] `ALLOWED_ORIGINS` is configured to the production domain(s) only
- [ ] HTTPS is terminated at the edge with TLS 1.2 or higher
- [ ] The application is deployed behind a reverse proxy that sets `X-Forwarded-For`
- [ ] Seeded development credentials have been rotated
- [ ] Audit logs are mirrored to an external append-only store
- [ ] Database backups are taken and tested for restore
- [ ] Dependency scanning is configured in CI
- [ ] An incident-response runbook is maintained, including the contact path for `dpo@mediconnect.com`
- [ ] Encryption key rotation is scheduled (the `enc:v1:` versioned format supports future algorithm or key migrations)

---

## 11. Document Maintenance

This policy reflects the security and compliance posture of the MediConnect codebase. It is intended to be updated alongside the implementation it describes.

- **Owner:** Security & Compliance role (currently maintained by Swojan Karki)
- **Frameworks tracked:** HIPAA, GDPR, CCPA, PDPA, Nepal ETA 2063
- **Last reviewed:** 2026-06-18
