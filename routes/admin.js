const router = require('express').Router();
const db     = require('../db');
const bcrypt = require('bcryptjs');
const { requireRole } = require('../middleware/auth');

router.use(...requireRole('admin'));

// Platform stats
router.get('/stats', (req, res) => {
  res.json({
    users:        db.prepare("SELECT COUNT(*) as c FROM users WHERE role='patient'").get().c,
    doctors:      db.prepare("SELECT COUNT(*) as c FROM doctors").get().c,
    online:       db.prepare("SELECT COUNT(*) as c FROM doctors WHERE online_status=1").get().c,
    appointments: db.prepare("SELECT COUNT(*) as c FROM appointments").get().c,
    today:        db.prepare("SELECT COUNT(*) as c FROM appointments WHERE appointment_date=date('now')").get().c,
    revenue:      db.prepare("SELECT COALESCE(SUM(final_fee),0) as r FROM appointments WHERE payment_status='completed'").get().r,
    pending_pay:  db.prepare("SELECT COUNT(*) as c FROM appointments WHERE payment_status='pending' AND status='confirmed'").get().c,
    messages:     db.prepare("SELECT COUNT(*) as c FROM messages").get().c,
  });
});

// All users
router.get('/users', (req, res) => {
  const { role, q } = req.query;
  let sql = "SELECT id,name,email,phone,role,created_at FROM users WHERE 1=1";
  const p = [];
  if (role) { sql += ' AND role=?'; p.push(role); }
  if (q)    { sql += ' AND (name LIKE ? OR email LIKE ?)'; p.push(`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...p));
});

// Delete user
router.delete('/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id=? AND role != "admin"').run(req.params.id);
  res.json({ message: 'User deleted' });
});

// All doctors with their user info
router.get('/doctors', (req, res) => {
  res.json(db.prepare(`
    SELECT d.*, u.name, u.email, u.phone, u.created_at
    FROM doctors d JOIN users u ON u.id=d.user_id
    ORDER BY d.verified ASC, u.created_at DESC
  `).all());
});

// Verify / unverify doctor
router.patch('/doctors/:id/verify', (req, res) => {
  db.prepare('UPDATE doctors SET verified=? WHERE id=?').run(req.body.verified ? 1 : 0, req.params.id);
  res.json({ message: 'Doctor verification updated' });
});

// Add a doctor from admin panel
router.post('/doctors', (req, res) => {
  const { name, email, phone, password='Doctor@123', specialty, hospital, nmc_number, experience_years=0, fee, bio='' } = req.body;
  if (!name||!email||!specialty||!hospital||!nmc_number||!fee) return res.status(400).json({ error: 'Missing fields' });

  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (exists) return res.status(409).json({ error: 'Email already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const uid  = db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'doctor')`).run(name,email,phone||null,hash).lastInsertRowid;
  const did  = db.prepare(`INSERT INTO doctors (user_id,specialty,hospital,nmc_number,experience_years,fee,bio,verified) VALUES (?,?,?,?,?,?,?,1)`).run(uid,specialty,hospital,nmc_number,experience_years,fee,bio).lastInsertRowid;

  const physSlots  = ['09:00 AM','10:30 AM','12:00 PM','02:00 PM','03:30 PM','05:00 PM'];
  const videoSlots = ['09:00 AM','11:00 AM','01:00 PM','04:00 PM','06:00 PM','08:00 PM'];
  const ins = db.prepare(`INSERT OR IGNORE INTO schedules (doctor_id,day_of_week,time_slot,clinic_name,visit_type) VALUES (?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const day of ['Mon','Tue','Wed','Thu','Fri']) for (const s of physSlots)  ins.run(did,day,s,hospital,'physical');
    for (const day of ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']) for (const s of videoSlots) ins.run(did,day,s,'Online Video Consultation','video');
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }

  res.json({ message: 'Doctor created', doctor_id: did });
});

// All appointments
router.get('/appointments', (req, res) => {
  const { status, date, q } = req.query;
  let sql = `
    SELECT a.*, u.name as patient_name, du.name as doctor_name, d.specialty
    FROM appointments a
    JOIN users u ON u.id=a.patient_id
    JOIN doctors d ON d.id=a.doctor_id
    JOIN users du ON du.id=d.user_id
    WHERE 1=1
  `;
  const p = [];
  if (status) { sql += ' AND a.status=?'; p.push(status); }
  if (date)   { sql += ' AND a.appointment_date=?'; p.push(date); }
  if (q)      { sql += ' AND (u.name LIKE ? OR du.name LIKE ? OR a.ref LIKE ?)'; p.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY a.created_at DESC LIMIT 200';
  res.json(db.prepare(sql).all(...p));
});

// All payments
router.get('/payments', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, u.name as patient_name, a.ref as appt_ref, du.name as doctor_name
    FROM payments p
    JOIN users u ON u.id=p.patient_id
    JOIN appointments a ON a.id=p.appointment_id
    JOIN doctors d ON d.id=a.doctor_id
    JOIN users du ON du.id=d.user_id
    ORDER BY p.created_at DESC LIMIT 200
  `).all());
});

// Discount codes
router.get('/discounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC').all());
});

router.post('/discounts', (req, res) => {
  const { code, discount_percent, max_uses } = req.body;
  if (!code||!discount_percent) return res.status(400).json({ error: 'code and discount_percent required' });
  const exists = db.prepare('SELECT id FROM discount_codes WHERE code=?').get(code.toUpperCase());
  if (exists) return res.status(409).json({ error: 'Code already exists' });
  db.prepare('INSERT INTO discount_codes (code,discount_percent,max_uses) VALUES (?,?,?)').run(code.toUpperCase(), discount_percent, max_uses||100);
  res.json({ message: 'Code created' });
});

router.patch('/discounts/:id', (req, res) => {
  const { active, max_uses } = req.body;
  db.prepare('UPDATE discount_codes SET active=COALESCE(?,active), max_uses=COALESCE(?,max_uses) WHERE id=?').run(
    active !== undefined ? (active ? 1 : 0) : null, max_uses||null, req.params.id
  );
  res.json({ message: 'Updated' });
});

router.delete('/discounts/:id', (req, res) => {
  db.prepare('DELETE FROM discount_codes WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ─── Audit Logs (HIPAA §164.312(b)) ──────────────────────────────────────────
router.get('/audit-logs', (req, res) => {
  const { user_id, action, resource_type, from_date, to_date, limit = 200 } = req.query;
  let sql = `
    SELECT a.*, u.name as user_name, u.email as user_email
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE 1=1
  `;
  const p = [];
  if (user_id)       { sql += ' AND a.user_id=?';       p.push(user_id); }
  if (action)        { sql += ' AND a.action LIKE ?';    p.push(`%${action}%`); }
  if (resource_type) { sql += ' AND a.resource_type=?';  p.push(resource_type); }
  if (from_date)     { sql += ' AND a.created_at >= ?';  p.push(from_date); }
  if (to_date)       { sql += ' AND a.created_at <= ?';  p.push(to_date + ' 23:59:59'); }
  sql += ' ORDER BY a.created_at DESC LIMIT ?';
  p.push(Math.min(Number(limit) || 200, 1000));
  res.json(db.prepare(sql).all(...p));
});

// ─── GDPR Data Requests ───────────────────────────────────────────────────────
router.get('/data-requests', (req, res) => {
  res.json(db.prepare(`
    SELECT dr.*, u.name as user_name, u.email as user_email
    FROM data_requests dr JOIN users u ON u.id=dr.user_id
    ORDER BY dr.created_at DESC
  `).all());
});

router.patch('/data-requests/:id', (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE data_requests SET status=?, processed_at=datetime('now') WHERE id=?")
    .run(status, req.params.id);
  res.json({ message: 'Updated' });
});

// ─── Platform compliance summary ──────────────────────────────────────────────
router.get('/compliance-summary', (req, res) => {
  const last24h = new Date(Date.now() - 86400000).toISOString().replace('T',' ').slice(0,19);
  res.json({
    audit_events_24h:   db.prepare('SELECT COUNT(*) as c FROM audit_logs WHERE created_at >= ?').get(last24h).c,
    login_failures_24h: db.prepare("SELECT COUNT(*) as c FROM login_attempts WHERE success=0 AND created_at >= ?").get(last24h).c,
    pending_data_requests: db.prepare("SELECT COUNT(*) as c FROM data_requests WHERE status='pending'").get().c,
    active_refresh_tokens:  db.prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE revoked=0').get().c,
    consent_records:    db.prepare('SELECT COUNT(*) as c FROM consent_records').get().c,
    phi_access_today:   db.prepare("SELECT COUNT(*) as c FROM audit_logs WHERE resource_type IN ('appointment','message') AND created_at >= date('now')").get().c,
  });
});

module.exports = router;
