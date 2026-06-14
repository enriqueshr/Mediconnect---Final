/**
 * AES-256-GCM field-level encryption for PHI (Protected Health Information).
 * HIPAA requires encryption of PHI at rest.
 *
 * In production, set ENCRYPTION_KEY in environment to a securely generated value:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

// Derive a fixed 32-byte key using scrypt so any string input works safely
const RAW_KEY  = process.env.ENCRYPTION_KEY || 'mediconnect-default-dev-key-CHANGE-IN-PRODUCTION';
const SALT     = 'mediconnect-phi-salt-v1';
const KEY      = crypto.scryptSync(RAW_KEY, SALT, 32);
const ALGO     = 'aes-256-gcm';

// Prefix to identify encrypted values (prevents double-encrypt)
const PREFIX = 'enc:v1:';

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const text = String(plaintext);
  if (text.startsWith(PREFIX)) return text; // already encrypted

  const iv     = crypto.randomBytes(12);          // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();             // 128-bit auth tag

  return PREFIX + [
    iv.toString('hex'),
    enc.toString('hex'),
    tag.toString('hex'),
  ].join('.');
}

function decrypt(data) {
  if (data == null) return null;
  const str = String(data);
  if (!str.startsWith(PREFIX)) return str; // plaintext passthrough

  try {
    const payload = str.slice(PREFIX.length);
    const [ivHex, encHex, tagHex] = payload.split('.');
    const iv      = Buffer.from(ivHex, 'hex');
    const enc     = Buffer.from(encHex, 'hex');
    const tag     = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch {
    return '[decryption error]';
  }
}

// Decrypt all PHI fields in an object (in-place clone)
function decryptRecord(record, fields) {
  if (!record) return record;
  const out = { ...record };
  for (const f of fields) {
    if (out[f] != null) out[f] = decrypt(out[f]);
  }
  return out;
}

function decryptAll(records, fields) {
  return records.map(r => decryptRecord(r, fields));
}

module.exports = { encrypt, decrypt, decryptRecord, decryptAll };
