/**
 * HIPAA Audit Logging Middleware
 *
 * 45 CFR §164.312(b) — Access controls, audit controls, integrity controls.
 * Every access to or modification of PHI must be logged with:
 *   - Who accessed (user_id, role)
 *   - What was accessed (resource type + ID)
 *   - When (timestamp)
 *   - From where (IP, user-agent)
 *   - Outcome (success/fail)
 *
 * Logs are written to both the database (for querying) and Winston audit.log.
 * Audit records must be retained for a minimum of 6 years (HIPAA §164.316(b)(2)).
 */
const db     = require('../db');
const logger = require('../utils/logger');

const PHI_ROUTES = [
  '/api/appointments',
  '/api/messages',
  '/api/auth/me',
  '/api/gdpr',
];

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function isPHI(path) {
  return PHI_ROUTES.some(r => path.startsWith(r));
}

// Lightweight audit log writer (does not block the response)
function writeAudit({ userId, role, action, resourceType, resourceId, ip, userAgent, details, success }) {
  const entry = {
    user_id:       userId || null,
    role:          role   || 'anonymous',
    action,
    resource_type: resourceType || null,
    resource_id:   resourceId   || null,
    ip_address:    ip,
    user_agent:    (userAgent || '').slice(0, 300),
    details:       details ? JSON.stringify(details) : null,
    success:       success ? 1 : 0,
  };

  try {
    db.prepare(`
      INSERT INTO audit_logs
        (user_id, role, action, resource_type, resource_id, ip_address, user_agent, details, success)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      entry.user_id, entry.role, entry.action, entry.resource_type,
      entry.resource_id, entry.ip_address, entry.user_agent, entry.details, entry.success
    );
  } catch (e) {
    logger.error('Audit DB write failed', { error: e.message });
  }

  logger.info('AUDIT', entry);
}

// Express middleware — attaches audit() helper to req, logs PHI access
function auditMiddleware(req, res, next) {
  const ip        = getIP(req);
  const userAgent = req.headers['user-agent'];
  const start     = Date.now();

  // Attach a callable audit helper for explicit logging in route handlers
  req.audit = function(action, resourceType, resourceId, details) {
    writeAudit({
      userId:       req.user?.id,
      role:         req.user?.role,
      action,
      resourceType,
      resourceId,
      ip,
      userAgent,
      details,
      success: true,
    });
  };

  // Auto-log PHI route access after response is sent
  if (isPHI(req.path)) {
    res.on('finish', () => {
      const success = res.statusCode < 400;
      const method  = req.method;
      const path    = req.path;
      const resourceId = req.params?.id || req.params?.userId || null;

      let resourceType = null;
      if (path.startsWith('/api/appointments')) resourceType = 'appointment';
      else if (path.startsWith('/api/messages'))  resourceType = 'message';
      else if (path.startsWith('/api/auth/me'))   resourceType = 'user_profile';
      else if (path.startsWith('/api/gdpr'))      resourceType = 'gdpr_data';

      writeAudit({
        userId:       req.user?.id,
        role:         req.user?.role,
        action:       `${method} ${path}`,
        resourceType,
        resourceId,
        ip,
        userAgent,
        details:      { status: res.statusCode, ms: Date.now() - start },
        success,
      });
    });
  }

  next();
}

module.exports = { auditMiddleware, writeAudit, getIP };
