const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const v       = require('validator');
const db      = require('../db');
const { auth, isLockedOut, recordAttempt, lockoutInfo } = require('../middleware/auth');
const { writeAudit, getIP } = require('../middleware/audit');
const logger  = require('../utils/logger');

const SECRET          = process.env.JWT_SECRET;
const EXPIRES_IN      = process.env.JWT_EXPIRES_IN      || '1d';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sign(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    SECRET,
    { expiresIn: EXPIRES_IN, issuer: 'mediconnect', audience: 'mediconnect-client' }
  );
}

function safe(u) {
  const { password_hash, ...rest } = u;
  return rest;
}

function validatePassword(pw) {
  if (!pw || pw.length < 8)            return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw))               return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(pw))               return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(pw))               return 'Password must contain at least one number';
  if (!/[^A-Za-z0-9]/.test(pw))        return 'Password must contain at least one special character';
  return null;
}

function issueRefreshToken(userId, ip) {
  const raw       = crypto.randomBytes(48).toString('hex');
  const hash      = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address)
    VALUES (?,?,?,?)
  `).run(userId, hash, expiresAt, ip || 'unknown');

  return raw; // Return raw token to client (hash is stored)
}

// ─── POST /api/auth/register ─────────────────────────────────────────────────
router.post('/register', (req, res) => {
  const { name, email, phone, password, consent_terms, consent_privacy } = req.body;

  if (!name  || typeof name !== 'string' || name.trim().length < 2)
    return res.status(400).json({ error: 'Full name is required (min 2 chars)' });
  if (!email || !v.isEmail(String(email)))
    return res.status(400).json({ error: 'Valid email address is required' });
  if (!consent_terms || !consent_privacy)
    return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy to register' });

  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const cleanEmail = v.normalizeEmail(String(email));
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (exists) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = bcrypt.hashSync(password, 12);
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'patient')`
  ).run(name.trim(), cleanEmail, phone ? v.trim(String(phone)) : null, hash);

  // Record consent (GDPR Art. 7)
  const ip = getIP(req);
  db.prepare(`INSERT INTO consent_records (user_id,consent_type,granted,ip_address,version) VALUES (?,?,1,?,?)`)
    .run(id, 'terms_and_privacy', ip, process.env.TERMS_VERSION || '1.0');

  const user    = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token   = sign(user);
  const refresh = issueRefreshToken(id, ip);

  writeAudit({
    userId: id, role: 'patient',
    action: 'REGISTER', resourceType: 'user', resourceId: id,
    ip, userAgent: req.headers['user-agent'],
    details: { email: cleanEmail }, success: true,
  });

  res.status(201).json({ token, refresh_token: refresh, user: safe(user) });
});

// ─── POST /api/auth/register-doctor ──────────────────────────────────────────
router.post('/register-doctor', (req, res) => {
  const { name, email, phone, password, specialty, hospital, nmc_number, experience_years, fee, bio, consent_terms, consent_privacy } = req.body;

  if (!name || !email || !password || !specialty || !hospital || !nmc_number || !fee)
    return res.status(400).json({ error: 'All required fields must be provided' });
  if (!v.isEmail(String(email)))
    return res.status(400).json({ error: 'Valid email required' });
  if (!consent_terms || !consent_privacy)
    return res.status(400).json({ error: 'Terms and Privacy Policy acceptance required' });

  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const cleanEmail = v.normalizeEmail(String(email));
  const exists   = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const nmcExists = db.prepare('SELECT id FROM doctors WHERE nmc_number = ?').get(nmc_number);
  if (nmcExists) return res.status(409).json({ error: 'NMC number already registered' });

  const hash = bcrypt.hashSync(password, 12);
  const uid  = Number(db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'doctor')`).run(name.trim(), cleanEmail, phone||null, hash).lastInsertRowid);
  const did  = Number(db.prepare(`INSERT INTO doctors (user_id,specialty,hospital,nmc_number,experience_years,fee,bio,verified) VALUES (?,?,?,?,?,?,?,0)`)
    .run(uid, specialty, hospital, nmc_number, Number(experience_years)||0, Number(fee), bio||'').lastInsertRowid);

  const ip = getIP(req);
  db.prepare(`INSERT INTO consent_records (user_id,consent_type,granted,ip_address,version) VALUES (?,?,1,?,?)`)
    .run(uid, 'terms_and_privacy', ip, process.env.TERMS_VERSION || '1.0');

  // Seed default schedule
  const physSlots  = ['09:00 AM','10:30 AM','12:00 PM','02:00 PM','03:30 PM','05:00 PM'];
  const videoSlots = ['09:00 AM','11:00 AM','01:00 PM','04:00 PM','06:00 PM','08:00 PM'];
  const ins = db.prepare(`INSERT OR IGNORE INTO schedules (doctor_id,day_of_week,time_slot,clinic_name,visit_type) VALUES (?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const day of ['Mon','Tue','Wed','Thu','Fri']) for (const s of physSlots)  ins.run(did,day,s,hospital,'physical');
    for (const day of ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']) for (const s of videoSlots) ins.run(did,day,s,'Online Video Consultation','video');
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }

  writeAudit({
    userId: uid, role: 'doctor',
    action: 'REGISTER_DOCTOR', resourceType: 'user', resourceId: uid,
    ip, userAgent: req.headers['user-agent'],
    details: { nmc_number, specialty }, success: true,
  });

  res.status(201).json({ message: 'Doctor registration submitted. Awaiting admin verification.' });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const ip = getIP(req);

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required' });
  if (!v.isEmail(String(email)))
    return res.status(400).json({ error: 'Invalid email format' });

  const cleanEmail = v.normalizeEmail(String(email));

  // Account lockout check (HIPAA §164.312(a)(2)(iii))
  if (isLockedOut(cleanEmail, ip)) {
    writeAudit({
      userId: null, action: 'LOGIN_BLOCKED', resourceType: 'auth',
      ip, userAgent: req.headers['user-agent'],
      details: { email: cleanEmail, reason: 'account_locked' }, success: false,
    });
    return res.status(429).json({
      error: `Account temporarily locked due to too many failed attempts. Try again in ${process.env.LOCKOUT_MINUTES || 30} minutes.`,
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  const valid = user && bcrypt.compareSync(password, user.password_hash);

  recordAttempt(cleanEmail, ip, valid);

  if (!valid) {
    const info = lockoutInfo(cleanEmail, ip);
    writeAudit({
      userId: user?.id, action: 'LOGIN_FAILED', resourceType: 'auth',
      ip, userAgent: req.headers['user-agent'],
      details: { email: cleanEmail, attempts_remaining: info.attempts_remaining }, success: false,
    });

    const msg = info.attempts_remaining === 0
      ? `Account locked for ${info.lockout_minutes} minutes.`
      : `Invalid email or password. ${info.attempts_remaining} attempt(s) remaining.`;

    return res.status(401).json({ error: msg, attempts_remaining: info.attempts_remaining });
  }

  let doctor = null;
  if (user.role === 'doctor') {
    doctor = db.prepare('SELECT * FROM doctors WHERE user_id = ?').get(user.id);
  }

  const token   = sign(user);
  const refresh = issueRefreshToken(user.id, ip);

  writeAudit({
    userId: user.id, role: user.role,
    action: 'LOGIN', resourceType: 'auth', resourceId: user.id,
    ip, userAgent: req.headers['user-agent'],
    details: { email: cleanEmail }, success: true,
  });

  logger.info('User login', { userId: user.id, role: user.role, ip });

  res.json({ token, refresh_token: refresh, user: safe(user), doctor });
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

  const hash = crypto.createHash('sha256').update(String(refresh_token)).digest('hex');
  const now  = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const stored = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE token_hash=? AND revoked=0 AND expires_at > ?
  `).get(hash, now);

  if (!stored) return res.status(401).json({ error: 'Invalid or expired refresh token' });

  // Rotate: revoke old, issue new
  db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE id=?').run(stored.id);
  const user    = db.prepare('SELECT * FROM users WHERE id=?').get(stored.user_id);
  if (!user)    return res.status(401).json({ error: 'User not found' });

  const newAccess  = sign(user);
  const newRefresh = issueRefreshToken(user.id, getIP(req));

  res.json({ token: newAccess, refresh_token: newRefresh });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', auth, (req, res) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    const hash = crypto.createHash('sha256').update(String(refresh_token)).digest('hex');
    db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE token_hash=? AND user_id=?')
      .run(hash, req.user.id);
  }

  writeAudit({
    userId: req.user.id, role: req.user.role,
    action: 'LOGOUT', resourceType: 'auth',
    ip: getIP(req), userAgent: req.headers['user-agent'],
    details: {}, success: true,
  });

  res.json({ message: 'Logged out successfully' });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let doctor = null;
  if (user.role === 'doctor') doctor = db.prepare('SELECT * FROM doctors WHERE user_id = ?').get(user.id);
  res.json({ user: safe(user), doctor });
});

// ─── PATCH /api/auth/me ───────────────────────────────────────────────────────
router.patch('/me', auth, (req, res) => {
  const { name, phone } = req.body;
  if (name && (typeof name !== 'string' || name.trim().length < 2))
    return res.status(400).json({ error: 'Name must be at least 2 characters' });

  db.prepare('UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone) WHERE id=?')
    .run(name?.trim() || null, phone?.trim() || null, req.user.id);

  writeAudit({
    userId: req.user.id, role: req.user.role,
    action: 'UPDATE_PROFILE', resourceType: 'user', resourceId: req.user.id,
    ip: getIP(req), userAgent: req.headers['user-agent'],
    details: { fields_updated: Object.keys(req.body) }, success: true,
  });

  res.json({ message: 'Profile updated' });
});

// ─── POST /api/auth/change-password ──────────────────────────────────────────
router.post('/change-password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(oldPassword, user.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect' });

  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });

  if (oldPassword === newPassword)
    return res.status(400).json({ error: 'New password must be different from current password' });

  db.prepare('UPDATE users SET password_hash=? WHERE id=?')
    .run(bcrypt.hashSync(newPassword, 12), req.user.id);

  // Revoke all refresh tokens (force re-login everywhere)
  db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE user_id=?').run(req.user.id);

  writeAudit({
    userId: req.user.id, role: req.user.role,
    action: 'CHANGE_PASSWORD', resourceType: 'user', resourceId: req.user.id,
    ip: getIP(req), userAgent: req.headers['user-agent'],
    details: { tokens_revoked: true }, success: true,
  });

  res.json({ message: 'Password changed successfully. Please log in again on all devices.' });
});

module.exports = router;
