/**
 * Rate Limiting — defence against brute-force, DDoS, and scraping.
 *
 * Tiers:
 *  - auth:    10 requests / 15 min  (login, register, password reset)
 *  - strict:  5  requests / 15 min  (OTP, MFA, sensitive ops)
 *  - api:     200 requests / 15 min (general authenticated API)
 *  - public:  60  requests / 1 min  (unauthenticated public endpoints)
 */
const rateLimit = require('express-rate-limit');

function json429(req, res) {
  res.status(429).json({
    error:       'Too many requests',
    message:     'Rate limit exceeded. Please wait before retrying.',
    retryAfter:  res.getHeader('Retry-After'),
  });
}

const auth = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              10,
  standardHeaders:  'draft-7',
  legacyHeaders:    false,
  handler:          json429,
  skipSuccessfulRequests: false,
});

const strict = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      5,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  handler:  json429,
});

const api = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  handler:  json429,
  skip: (req) => req.user?.role === 'admin', // admins are not rate-limited
});

const publicEndpoint = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max:      60,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  handler:  json429,
});

module.exports = { auth, strict, api, publicEndpoint };
