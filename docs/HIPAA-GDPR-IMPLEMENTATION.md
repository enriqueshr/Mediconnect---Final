# HIPAA & GDPR Implementation Map

This document maps each regulatory requirement covered by MediConnect to the specific files and lines of code that implement it. It is intended as a technical reference for code reviewers, security auditors, and compliance officers; for the higher-level posture statement, see [SECURITY.md](../SECURITY.md).

All file paths are relative to the repository root. Line numbers are accurate as of the current `main` branch.

---

## 1. HIPAA 45 CFR §164.312 — Technical Safeguards

### §164.312(a)(1) — Access Control (Required)

> *"Implement technical policies and procedures for electronic information systems that maintain electronic protected health information to allow access only to those persons or software programs that have been granted access rights."*

| Implementation | Location |
|---|---|
| JWT-authenticated requests on all PHI routes | `middleware/auth.js:10-25` |
| Role-based route guards (`requireRole`) | `middleware/auth.js:28-34` |
| Server-side socket authentication (Socket.io handshake) | `server.js:163-172` |
| Resource-ownership checks (patient sees own, doctor sees assigned) | `routes/appointments.js:152-157` |

### §164.312(a)(2)(i) — Unique User Identification (Required)

> *"Assign a unique name and/or number for identifying and tracking user identity."*

| Implementation | Location |
|---|---|
| Auto-incrementing primary key on every user | `db/index.js:15-23` |
| Unique email constraint | `db/index.js:18` |
| User ID embedded in JWT claims for stateless identification | `routes/auth.js:16-22` |

### §164.312(a)(2)(iii) — Automatic Logoff (Addressable)

> *"Implement electronic procedures that terminate an electronic session after a predetermined time of inactivity."*

| Implementation | Location |
|---|---|
| 15-minute idle threshold | `public/js/compliance.js:12-14` |
| 14-minute warning modal with countdown | `public/js/compliance.js:56-104` |
| Force-logout: server-side token revocation + client cleanup | `public/js/compliance.js:106-132` |
| Activity-event listeners that reset the idle timer | `public/js/compliance.js:27-29` |

### §164.312(a)(2)(iv) — Encryption and Decryption (Addressable)

> *"Implement a mechanism to encrypt and decrypt electronic protected health information."*

| Implementation | Location |
|---|---|
| AES-256-GCM authenticated encryption module | `utils/encryption.js:19-34` (encrypt) and `:36-53` (decrypt) |
| Versioned envelope format (`enc:v1:<iv>.<ct>.<tag>`) | `utils/encryption.js:17` |
| Key derivation via scrypt from `ENCRYPTION_KEY` | `utils/encryption.js:11-13` |
| Encryption of appointment reasons on booking | `routes/appointments.js:78` |
| Encryption of clinical notes on update | `routes/appointments.js:226` |
| Encryption of chat messages on send | `server.js:185` |

### §164.312(b) — Audit Controls (Required)

> *"Implement hardware, software, and/or procedural mechanisms that record and examine activity in information systems that contain or use electronic protected health information."*

| Implementation | Location |
|---|---|
| Express middleware that auto-logs every PHI request | `middleware/audit.js:68-117` |
| List of routes considered PHI for auto-logging | `middleware/audit.js:18-23` |
| Audit table schema | `db/index.js:116-128` |
| Audit entries written to both SQLite and Winston file | `middleware/audit.js:51-65` |
| Per-route explicit audit calls (`req.audit(action, ...)`) | `routes/appointments.js:98`, `routes/gdpr.js:94-100`, etc. |
| Admin audit-log viewer endpoint | `routes/admin.js:139-156` |

### §164.312(c)(1) — Integrity (Required)

> *"Implement policies and procedures to protect electronic protected health information from improper alteration or destruction."*

| Implementation | Location |
|---|---|
| GCM authentication tag verifies encrypted PHI has not been tampered with | `utils/encryption.js:47-49` |
| Audit log entries are append-only (no UPDATE/DELETE endpoints exposed) | `routes/admin.js:139-156` |
| Foreign-key enforcement (referential integrity) | `db/index.js:9` |

### §164.312(d) — Person or Entity Authentication (Required)

> *"Implement procedures to verify that a person or entity seeking access to electronic protected health information is the one claimed."*

| Implementation | Location |
|---|---|
| Password validation (bcrypt compare) | `routes/auth.js:169` |
| bcrypt hashing on registration (cost 12) | `routes/auth.js:70` |
| Password complexity policy | `routes/auth.js:29-36` |
| Account lockout after repeated failures | `middleware/auth.js:55-58`, `routes/auth.js:157-166` |
| JWT signature verification | `middleware/auth.js:16-19` |

### §164.312(e)(1) — Transmission Security (Required)

> *"Implement technical security measures to guard against unauthorized access to electronic protected health information that is being transmitted over an electronic communications network."*

| Implementation | Location |
|---|---|
| Helmet HSTS header (2-year max-age) | `server.js:47-51` |
| TLS 1.2+ required in production | Deployment configuration (out of code scope) |
| WebRTC media uses DTLS-SRTP by specification | (Mandatory per WebRTC spec) |
| Socket.io connection uses WSS in production | `server.js:150-156` |

---

## 2. HIPAA 45 CFR §164.316 — Policies, Procedures, and Documentation

### §164.316(b)(2)(i) — Retention (Required)

> *"Retain documentation required by paragraph (b)(1) of this section for 6 years from the date of its creation or the date when it last was in effect, whichever is later."*

| Implementation | Location |
|---|---|
| Winston audit-log file with 2200-rotation retention (~6 years) | `utils/logger.js:31-37` |
| Audit-log table never deleted from in any application code | `db/index.js:114-128` |
| Retention rationale documented in audit middleware comment | `middleware/audit.js:1-14` |

---

## 3. GDPR (EU) 2016/679 — Data Subject Rights

### Article 6 — Lawfulness of Processing

| Implementation | Location |
|---|---|
| Consent-based processing for non-essential operations | `public/js/compliance.js:136-194` |
| Vital-interest processing for medical records (HIPAA-justified) | `SECURITY.md` §7 |

### Article 7 — Conditions for Consent

> *"Where processing is based on consent, the controller shall be able to demonstrate that the data subject has consented to processing of his or her personal data."*

| Implementation | Location |
|---|---|
| Consent banner (first-visit cookie consent UI) | `public/js/compliance.js:148-179` |
| Consent recording endpoint | `routes/gdpr.js:168-178` |
| Consent recorded at registration | `routes/auth.js:75-78` |
| `consent_records` schema | `db/index.js:151-159` |

### Article 12 — Transparent Information

> *"The controller shall take appropriate measures to provide any information ... in a concise, transparent, intelligible and easily accessible form."*

| Implementation | Location |
|---|---|
| Privacy Policy page | `public/privacy.html` |
| Terms of Service page | `public/terms.html` |
| Data-request submission endpoint with 30-day commitment | `routes/gdpr.js:202-216` |

### Article 15 — Right of Access

> *"The data subject shall have the right to obtain from the controller confirmation as to whether or not personal data concerning him or her are being processed, and, where that is the case, access to the personal data."*

| Implementation | Location |
|---|---|
| User audit-trail endpoint (last 500 access entries) | `routes/gdpr.js:190-199` |
| Full data-export endpoint (also satisfies Art. 20) | `routes/gdpr.js:29-104` |

### Article 17 — Right to Erasure ("Right to be Forgotten")

> *"The data subject shall have the right to obtain from the controller the erasure of personal data concerning him or her without undue delay."*

| Implementation | Location |
|---|---|
| Erasure endpoint with confirmation string | `routes/gdpr.js:109-165` |
| Anonymisation transaction (5 tables updated atomically) | `routes/gdpr.js:125-145` |
| Frontend confirmation flow (double prompt) | `public/js/compliance.js:236-258` |
| Audit-trail entry for the erasure itself | `routes/gdpr.js:152-158` |

### Article 20 — Right to Data Portability

> *"The data subject shall have the right to receive the personal data concerning him or her, which he or she has provided to a controller, in a structured, commonly used and machine-readable format."*

| Implementation | Location |
|---|---|
| JSON export endpoint with downloadable Content-Disposition header | `routes/gdpr.js:29-104` |
| Frontend export trigger (`window.MediCompliance.exportData()`) | `public/js/compliance.js:221-234` |

### Recital 26 — Anonymous Information

> *"The principles of data protection should ... not apply to anonymous information ... [or] to personal data rendered anonymous in such a manner that the data subject is not or no longer identifiable."*

| Implementation | Location |
|---|---|
| Anonymisation flow used to resolve HIPAA-vs-GDPR retention conflict | `routes/gdpr.js:120-145` |
| Conflict resolution explicitly stated in user-facing response | `routes/gdpr.js:161-164` |
| Conflict resolution documented in the security policy | `SECURITY.md` §8 |

---

## 4. CCPA & PDPA

The California Consumer Privacy Act and Singapore's Personal Data Protection Act are both treated as strict subsets of GDPR. Every right granted by these regulations is satisfied by the GDPR endpoints above. No CCPA- or PDPA-specific endpoint is required.

---

## 5. Nepal Electronic Transactions Act 2063

The platform processes personal data inside Nepal where required (e.g. eSewa payment integration) and uses the AES-256-GCM encryption standard for protected fields. Data localisation considerations are noted in the deployment documentation.

---

## 6. Limitations Not Addressed in Code

The following items affect the compliance posture but are deployment-time concerns rather than code-level controls. They are tracked here for transparency and are also listed in `SECURITY.md` §9:

- **TURN relay server not deployed.** Affects video-call reachability for symmetric-NAT users; does not affect HIPAA/GDPR posture.
- **Development fallback encryption key.** `ENCRYPTION_KEY` MUST be set in production.
- **Seeded development credentials.** MUST be rotated before any production deployment.
- **Audit-log integrity at the OS level.** Production deployments should mirror audit logs to an external append-only store.

---

## 7. Document Maintenance

This implementation map is intended to be updated whenever the underlying code changes. When a file or line reference becomes stale, please file an issue or open a pull request updating the relevant row.

- **Owner:** Security & Compliance role (Swojan Karki)
- **Last reviewed:** 2026-06-18
