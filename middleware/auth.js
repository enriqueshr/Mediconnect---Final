const jwt    = require('jsonwebtoken');
const db     = require('../db');
const logger = require('../utils/logger');

const SECRET           = process.env.JWT_SECRET;
const MAX_ATTEMPTS     = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5');
const LOCKOUT_MINUTES  = parseInt(process.env.LOCKOUT_MINUTES    || '30');

// ─── JWT Authentication ───────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = jwt.verify(header.slice(7), SECRET, {
      issuer:   'mediconnect',
      audience: 'mediconnect-client',
    });
    next();
  } catch (e) {
    const msg = e.name === 'TokenExpiredError' ? 'Session expired — please log in again' : 'Invalid token';
    res.status(401).json({ error: msg });
  }
}

// ─── Role Guard ───────────────────────────────────────────────────────────────
function requireRole(...roles) {
  return [auth, (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  }];
}

// ─── Account Lockout Helpers (HIPAA §164.312(a)(2)(iii)) ─────────────────────
function getRecentFailures(email, ip) {
  const windowAgo = new Date(Date.now() - LOCKOUT_MINUTES * 60000)
    .toISOString().replace('T', ' ').slice(0, 19);

  // Lock by email OR by IP (prevents credential-stuffing from single IP)
  const byEmail = db.prepare(`
    SELECT COUNT(*) as cnt FROM login_attempts
    WHERE email=? AND success=0 AND created_at >= ?
  `).get(email, windowAgo).cnt;

  const byIP = db.prepare(`
    SELECT COUNT(*) as cnt FROM login_attempts
    WHERE ip_address=? AND success=0 AND created_at >= ?
  `).get(ip || 'unknown', windowAgo).cnt;

  return { byEmail, byIP };
}

function isLockedOut(email, ip) {
  const { byEmail, byIP } = getRecentFailures(email, ip);
  return byEmail >= MAX_ATTEMPTS || byIP >= MAX_ATTEMPTS * 3;
}

function recordAttempt(email, ip, success) {
  try {
    db.prepare('INSERT INTO login_attempts (email,ip_address,success) VALUES (?,?,?)')
      .run(email, ip || 'unknown', success ? 1 : 0);
  } catch (e) {
    logger.error('Failed to record login attempt', { error: e.message });
  }
}

function lockoutInfo(email, ip) {
  const { byEmail } = getRecentFailures(email, ip);
  const remaining   = MAX_ATTEMPTS - byEmail;
  return {
    attempts_remaining: Math.max(0, remaining),
    lockout_minutes:    LOCKOUT_MINUTES,
  };
}

module.exports = { auth, requireRole, isLockedOut, recordAttempt, lockoutInfo };
