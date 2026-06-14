const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'mediconnect', version: '2.0.0' },
  transports: [
    new transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 90,              // 90 days of error logs
      tailable: true,
    }),
    new transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 50 * 1024 * 1024, // 50 MB
      maxFiles: 30,
      tailable: true,
    }),
    // Separate file for audit/PHI access — HIPAA requires 6-year retention
    new transports.File({
      filename: path.join(logDir, 'audit.log'),
      level: 'info',
      maxsize: 100 * 1024 * 1024, // 100 MB
      maxFiles: 2200,             // ~6 years at 1 file/day
      tailable: true,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new transports.Console({
    format: format.combine(
      format.colorize(),
      format.printf(({ timestamp, level, message, ...meta }) => {
        const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} [${level}] ${message}${extra}`;
      })
    ),
  }));
}

module.exports = logger;
