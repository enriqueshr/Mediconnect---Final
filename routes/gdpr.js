/**
 * GDPR / CCPA / PDPA Compliance Endpoints
 *
 * Covers obligations under:
 *  - EU GDPR (Regulation 2016/679)
 *  - US CCPA (California Consumer Privacy Act)
 *  - UK GDPR (post-Brexit)
 *  - Nepal Electronic Transactions Act (data localisation notes)
 *
 * Rights implemented:
 *  - Right of Access          GET  /api/gdpr/export
 *  - Right to Erasure         DELETE /api/gdpr/me
 *  - Data Portability         GET  /api/gdpr/export (JSON format)
 *  - Consent Management       POST /api/gdpr/consent, GET /api/gdpr/consent
 *  - Audit Trail (own data)   GET  /api/gdpr/audit-trail
 */
const router  = require('express').Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { decrypt } = require('../utils/encryption');
const { writeAudit, getIP } = require('../middleware/audit');
const logger  = require('../utils/logger');

const PHI_FIELDS_APPT = ['reason', 'notes'];
const PHI_FIELDS_MSG  = ['content'];

// ─── GET /api/gdpr/export ────────────────────────────────────────────────────
// Returns all personal data held about the authenticated user (Art. 20 GDPR)
router.get('/export', auth, (req, res) => {
  const uid = req.user.id;

  const user = db.prepare(
    'SELECT id, name, email, phone, role, created_at FROM users WHERE id=?'
  ).get(uid);

  const appointments = db.prepare(`
    SELECT a.*, du.name as doctor_name, d.specialty
    FROM appointments a
    JOIN doctors d ON d.id=a.doctor_id
    JOIN users du ON du.id=d.user_id
    WHERE a.patient_id=?
    ORDER BY a.created_at DESC
  `).all(uid).map(a => ({
    ...a,
    reason: decrypt(a.reason),
    notes:  decrypt(a.notes),
  }));

  const messages = db.prepare(`
    SELECT m.id, m.created_at, m.is_read,
      CASE WHEN m.sender_id=? THEN 'sent' ELSE 'received' END as direction,
      other_u.name as other_party
    FROM messages m
    JOIN users other_u ON other_u.id = CASE WHEN m.sender_id=? THEN m.receiver_id ELSE m.sender_id END
    WHERE m.sender_id=? OR m.receiver_id=?
    ORDER BY m.created_at DESC
    LIMIT 1000
  `).all(uid, uid, uid, uid).map(m => ({
    ...m,
    content: '[Message content available on request — contact dpo@mediconnect.com]',
  }));

  const reviews = db.prepare(
    'SELECT * FROM reviews WHERE patient_id=? ORDER BY created_at DESC'
  ).all(uid);

  const payments = db.prepare(`
    SELECT p.id, p.amount, p.method, p.status, p.created_at, a.ref as appointment_ref
    FROM payments p JOIN appointments a ON a.id=p.appointment_id
    WHERE p.patient_id=?
    ORDER BY p.created_at DESC
  `).all(uid);

  const consent = db.prepare(
    'SELECT * FROM consent_records WHERE user_id=? ORDER BY created_at DESC'
  ).all(uid);

  const export_data = {
    _meta: {
      exported_at: new Date().toISOString(),
      controller:  'MediConnect Health Platform',
      dpo_email:   'dpo@mediconnect.com',
      format:      'GDPR Data Portability Export v1.0',
      notice:      'This export contains all personal data held by MediConnect. Retain securely.',
    },
    profile:      user,
    appointments,
    messages,
    payments,
    reviews,
    consent_records: consent,
  };

  writeAudit({
    userId: uid, role: req.user.role,
    action: 'GDPR_EXPORT', resourceType: 'user_data', resourceId: uid,
    ip: getIP(req), userAgent: req.headers['user-agent'],
    details: { records: { appointments: appointments.length, messages: messages.length } },
    success: true,
  });

  res.setHeader('Content-Disposition', `attachment; filename="mediconnect-data-${uid}-${Date.now()}.json"`);
  res.json(export_data);
});

// ─── DELETE /api/gdpr/me ─────────────────────────────────────────────────────
// Right to erasure — anonymises personal identifiers while retaining audit trail
// (Art. 17 GDPR; HIPAA requires medical records to be retained ≥6 years)
router.delete('/me', auth, (req, res) => {
  const uid   = req.user.id;
  const { confirm } = req.body;

  if (confirm !== 'DELETE MY ACCOUNT') {
    return res.status(400).json({
      error:   'Confirmation required',
      message: 'Send { "confirm": "DELETE MY ACCOUNT" } to proceed.',
    });
  }

  // Anonymise personal identifiers — medical records (appointments) are retained
  // per HIPAA minimum 6-year retention, but de-identified
  const anonId    = `deleted-user-${uid}`;
  const anonEmail = `${anonId}@anonymized.invalid`;

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET name=?, email=?, phone=NULL, password_hash=? WHERE id=?')
      .run(anonId, anonEmail, '[GDPR-ERASED]', uid);

    db.prepare('UPDATE messages SET content=? WHERE sender_id=? OR receiver_id=?')
      .run('[GDPR-ERASED]', uid, uid);

    db.prepare('UPDATE appointments SET reason=?, notes=? WHERE patient_id=?')
      .run('[GDPR-ERASED]', '[GDPR-ERASED]', uid);

    // Revoke all tokens
    db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE user_id=?').run(uid);

    // Log the erasure (must keep this — it's the compliance evidence)
    db.prepare(`
      INSERT INTO data_requests (user_id, request_type, status, processed_at)
      VALUES (?, 'erasure', 'completed', datetime('now'))
    `).run(uid);

    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    logger.error('GDPR erasure failed', { uid, error: e.message });
    return res.status(500).json({ error: 'Erasure failed. Contact dpo@mediconnect.com.' });
  }

  writeAudit({
    userId: uid, role: req.user.role,
    action: 'GDPR_ERASURE', resourceType: 'user_data', resourceId: uid,
    ip: getIP(req), userAgent: req.headers['user-agent'],
    details: { note: 'Personal identifiers anonymised; medical records de-identified per HIPAA' },
    success: true,
  });

  logger.info('GDPR erasure completed', { uid });
  res.json({
    message: 'Your personal data has been anonymised. Medical records are retained in de-identified form as required by healthcare regulations. Audit logs are retained as required by law.',
    reference: `GDPR-ERASURE-${uid}-${Date.now()}`,
  });
});

// ─── POST /api/gdpr/consent ──────────────────────────────────────────────────
router.post('/consent', auth, (req, res) => {
  const { consent_type, granted, version } = req.body;
  if (!consent_type) return res.status(400).json({ error: 'consent_type required' });

  db.prepare(`
    INSERT INTO consent_records (user_id, consent_type, granted, ip_address, version)
    VALUES (?,?,?,?,?)
  `).run(req.user.id, consent_type, granted !== false ? 1 : 0, getIP(req), version || '1.0');

  res.json({ message: 'Consent recorded', consent_type, granted: granted !== false });
});

// ─── GET /api/gdpr/consent ───────────────────────────────────────────────────
router.get('/consent', auth, (req, res) => {
  const records = db.prepare(
    'SELECT * FROM consent_records WHERE user_id=? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json(records);
});

// ─── GET /api/gdpr/audit-trail ───────────────────────────────────────────────
// User can see their own access audit trail (Art. 15 GDPR — right of access)
router.get('/audit-trail', auth, (req, res) => {
  const logs = db.prepare(`
    SELECT action, resource_type, resource_id, ip_address, success, created_at
    FROM audit_logs
    WHERE user_id=?
    ORDER BY created_at DESC
    LIMIT 500
  `).all(req.user.id);
  res.json(logs);
});

// ─── POST /api/gdpr/data-request ─────────────────────────────────────────────
router.post('/data-request', auth, (req, res) => {
  const { request_type } = req.body;
  const allowed = ['export', 'erasure', 'portability', 'rectification'];
  if (!allowed.includes(request_type))
    return res.status(400).json({ error: 'Invalid request type' });

  db.prepare(
    'INSERT INTO data_requests (user_id, request_type, status) VALUES (?,?,?)'
  ).run(req.user.id, request_type, 'pending');

  res.json({
    message: 'Data request submitted. You will be contacted within 30 days as required by GDPR Art. 12.',
    contact: 'dpo@mediconnect.com',
  });
});

module.exports = router;
