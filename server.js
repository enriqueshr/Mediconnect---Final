/**
 * MediConnect — Production Server
 *
 * Security baseline:
 *  - HIPAA Technical Safeguards (45 CFR §164.312)
 *  - GDPR Technical Measures (Art. 25, 32)
 *  - OWASP Top 10 mitigations
 *  - Nepal Electronic Transactions Act 2063 (data handling)
 */
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const helmet     = require('helmet');
const cors       = require('cors');
const compression = require('compression');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const crypto     = require('crypto');

const logger     = require('./utils/logger');
const { encrypt, decrypt } = require('./utils/encryption');
const { auditMiddleware, writeAudit, getIP } = require('./middleware/audit');
const limiter    = require('./middleware/rateLimiter');

const app    = express();
const server = http.createServer(app);
const SECRET = process.env.JWT_SECRET;

// ─── Trust proxy (for correct IP behind nginx/ALB) ───────────────────────────
app.set('trust proxy', 1);

// ─── Security Headers (HIPAA §164.312(a)(2)(iv), OWASP) ─────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"], // TODO: move to nonce-based in v3
      styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:       ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:        ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["'none'"],                   // Prevents clickjacking
      scriptSrcAttr:  ["'unsafe-inline'"],          // Allow onclick/onchange handlers
    },
  },
  hsts: {
    maxAge:            63072000, // 2 years
    includeSubDomains: true,
    preload:           true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  crossOriginEmbedderPolicy: false, // socket.io needs this off
}));

// Permissions-Policy — restrict sensitive browser features
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self), payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)');
  next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods:     ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
}));

// ─── Compression ──────────────────────────────────────────────────────────────
app.use(compression());

// ─── Body parsing with size limits ───────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ─── Request ID (for tracing) ────────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ─── HTTP Request Logging ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('HTTP', {
      method:   req.method,
      path:     req.path,
      status:   res.statusCode,
      ms:       Date.now() - start,
      ip:       getIP(req),
      reqId:    req.id,
    });
  });
  next();
});

// ─── HIPAA Audit Middleware ───────────────────────────────────────────────────
app.use(auditMiddleware);

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag:   true,
}));

// ─── Health & Readiness Endpoints ────────────────────────────────────────────
app.get('/health', (req, res) => {
  const db = require('./db');
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', ts: new Date().toISOString(), version: '2.0.0' });
  } catch (e) {
    res.status(503).json({ status: 'error', message: 'Database unreachable' });
  }
});

app.get('/api/compliance/info', (req, res) => {
  res.json({
    frameworks: ['HIPAA', 'GDPR', 'CCPA', 'PDPA'],
    encryption: 'AES-256-GCM (PHI fields)',
    tls:        'Enforced in production (TLS 1.2+)',
    audit_log:  'All PHI access logged',
    retention:  '6 years (HIPAA minimum)',
    dpo:        process.env.DPO_EMAIL || 'dpo@mediconnect.com',
    privacy:    '/privacy.html',
    terms:      '/terms.html',
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
// Rate limiting applied per route category
app.use('/api/auth',         limiter.auth,   require('./routes/auth'));
app.use('/api/doctors',      limiter.api,    require('./routes/doctors'));
app.use('/api/appointments', limiter.api,    require('./routes/appointments'));
app.use('/api/messages',     limiter.api,    require('./routes/messages'));
app.use('/api/payments',     limiter.api,    require('./routes/payments'));
app.use('/api/admin',        limiter.api,    require('./routes/admin'));
app.use('/api/gdpr',         limiter.strict, require('./routes/gdpr'));

// ─── Socket.io Setup ──────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET','POST'],
  },
  maxHttpBufferSize: 5e6, // 5 MB (supports image/voice messages)
});

const onlineUsers = new Map();
app.set('io', io);
app.set('onlineUsers', onlineUsers);

// JWT auth for socket connections
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, SECRET);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  const uid = socket.user.id;
  onlineUsers.set(uid, socket.id);
  io.emit('user_status', { userId: uid, online: true });

  socket.on('send_message', ({ to, content }) => {
    try {
      if (!to || !content || typeof content !== 'string') return;
      if (content.length > 2000000) return socket.emit('error', { message: 'Message too long' });

      const db = require('./db');
      const encContent = encrypt(content.trim());
      const { lastInsertRowid: msgId } = db.prepare(
        'INSERT INTO messages (sender_id,receiver_id,content) VALUES (?,?,?)'
      ).run(uid, to, encContent);

      const msg = db.prepare(`
        SELECT m.id, m.sender_id, m.receiver_id, m.is_read, m.created_at,
               u.name as sender_name, u.role as sender_role
        FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
      `).get(msgId);

      const deliverMsg = { ...msg, content: content.trim() };

      const rSock = onlineUsers.get(Number(to));
      if (rSock) io.to(rSock).emit('new_message', deliverMsg);
      socket.emit('new_message', deliverMsg);

      writeAudit({
        userId: uid, role: socket.user.role,
        action: 'SEND_MESSAGE', resourceType: 'message', resourceId: msgId,
        ip: socket.handshake.address, userAgent: socket.handshake.headers['user-agent'],
        details: { to }, success: true,
      });
    } catch (e) { logger.error('socket send_message error', { error: e.message, uid }); }
  });

  socket.on('mark_read', ({ from }) => {
    try {
      const db = require('./db');
      db.prepare('UPDATE messages SET is_read=1 WHERE sender_id=? AND receiver_id=?').run(from, uid);
      const rSock = onlineUsers.get(Number(from));
      if (rSock) io.to(rSock).emit('messages_read', { by: uid });
    } catch (e) { logger.error('socket mark_read error', { error: e.message, uid }); }
  });

  socket.on('typing', ({ to }) => {
    try {
      const rSock = onlineUsers.get(Number(to));
      if (rSock) io.to(rSock).emit('typing', { from: uid, name: socket.user.name });
    } catch {}
  });

  socket.on('stop_typing', ({ to }) => {
    try {
      const rSock = onlineUsers.get(Number(to));
      if (rSock) io.to(rSock).emit('stop_typing', { from: uid });
    } catch {}
  });

  // ─── WebRTC Signaling ──────────────────────────────────────────────────────
  socket.on('call:offer', ({ to, offer, callType }) => {
    try {
      const rSock = onlineUsers.get(Number(to));
      if (rSock) {
        io.to(rSock).emit('call:incoming', { from: uid, fromName: socket.user.name, offer, callType });
      } else {
        socket.emit('call:unavailable', { to });
        // Store missed call notification as a message visible to both parties
        try {
          const db = require('./db');
          const missedContent = `📞 Missed ${callType || 'video'} call from ${socket.user.name} (user was offline)`;
          const encContent = encrypt(missedContent);
          const { lastInsertRowid: msgId } = db.prepare(
            'INSERT INTO messages (sender_id,receiver_id,content) VALUES (?,?,?)'
          ).run(uid, Number(to), encContent);
          socket.emit('new_message', {
            id: msgId, sender_id: uid, receiver_id: Number(to),
            content: missedContent, is_read: 0,
            created_at: new Date().toISOString(), sender_name: socket.user.name,
          });
        } catch {}
      }
    } catch {}
  });

  socket.on('call:answer', ({ to, answer }) => {
    try {
      const rSock = onlineUsers.get(Number(to));
      if (rSock) io.to(rSock).emit('call:answered', { from: uid, answer });
    } catch {}
  });

  socket.on('call:ice-candidate', ({ to, candidate }) => {
    try {
      const rSock = onlineUsers.get(Number(to));
      if (rSock) io.to(rSock).emit('call:ice-candidate', { from: uid, candidate });
    } catch {}
  });

  socket.on('call:reject', ({ to, reason }) => {
    try {
      const rSock = onlineUsers.get(Number(to));
      if (rSock) io.to(rSock).emit('call:rejected', { from: uid, reason: reason || 'declined' });
      // Store missed call notification for both parties
      try {
        const db = require('./db');
        const callerRow = db.prepare('SELECT name FROM users WHERE id=?').get(Number(to));
        const callerName = callerRow?.name || 'Unknown';
        const missedContent = `📞 Missed call from ${callerName}`;
        const encContent = encrypt(missedContent);
        const { lastInsertRowid: msgId } = db.prepare(
          'INSERT INTO messages (sender_id,receiver_id,content) VALUES (?,?,?)'
        ).run(Number(to), uid, encContent);
        const msgPayload = {
          id: msgId, sender_id: Number(to), receiver_id: uid,
          content: missedContent, is_read: 0,
          created_at: new Date().toISOString(), sender_name: callerName,
        };
        if (rSock) io.to(rSock).emit('new_message', msgPayload);
        socket.emit('new_message', msgPayload);
      } catch {}
    } catch {}
  });

  socket.on('call:end', ({ to }) => {
    try {
      const rSock = onlineUsers.get(Number(to));
      if (rSock) io.to(rSock).emit('call:ended', { from: uid });
    } catch {}
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(uid);
    io.emit('user_status', { userId: uid, online: false });
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  logger.error('Unhandled error', {
    error:  err.message,
    stack:  err.stack,
    path:   req.path,
    method: req.method,
    reqId:  req.id,
    ip:     getIP(req),
  });

  // Never leak stack traces to clients
  res.status(status).json({
    error:   status >= 500 ? 'Internal server error' : err.message,
    reqId:   req.id,
  });
});

// ─── Catch-all SPA ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forced exit after 10s');
    process.exit(1);
  }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => { logger.error('Uncaught exception',  { error: e.message, stack: e.stack }); shutdown('uncaughtException'); });
process.on('unhandledRejection', (e) => { logger.error('Unhandled rejection', { error: String(e) }); });

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info('MediConnect started', { port: PORT, env: process.env.NODE_ENV });
  if (process.env.NODE_ENV !== 'production') {
    console.log('\n🏥  MediConnect v2.0 — HIPAA/GDPR Compliant\n');
    console.log(`🌐  http://localhost:${PORT}`);
    console.log(`🔒  Security: Helmet + CSP + Rate Limiting + AES-256 PHI encryption`);
    console.log(`📋  Audit:    HIPAA §164.312(b) logging active\n`);
    console.log('─── Test Credentials ───────────────────────');
    console.log('👤  Admin  : admin@mediconnect.com / Admin@123');
    console.log('👨‍⚕️  Doctor : rajesh@mediconnect.com / Doctor@123');
    console.log('🧑  Patient: ram@example.com / Patient@123');
    console.log('────────────────────────────────────────────\n');
  }
});
