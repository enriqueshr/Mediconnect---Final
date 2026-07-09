/**
 * Tests for utils/encryption.js — AES-256-GCM PHI encryption module.
 *
 * Uses Node.js built-in test runner (node:test).
 * Run with: node --test tests/encryption.test.js
 *
 * These tests verify the security-critical properties that the encryption
 * module is relied upon for:
 *   - Confidentiality (round-trip correctness, ciphertext differs from plaintext)
 *   - Integrity (tampering is detected and decryption fails)
 *   - IV uniqueness (no IV reuse with the same key)
 *   - Versioned envelope format (`enc:v1:` prefix)
 *   - Idempotent encryption (double-encrypt guard)
 *   - Graceful plaintext passthrough on decrypt
 *   - Null safety
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { encrypt, decrypt, decryptRecord, decryptAll } = require('../utils/encryption');

describe('encrypt()', () => {
  test('produces ciphertext that decrypts back to the original plaintext', () => {
    const plaintext = 'Patient reports chest pain for 2 days.';
    const ciphertext = encrypt(plaintext);
    assert.notStrictEqual(ciphertext, plaintext);
    assert.strictEqual(decrypt(ciphertext), plaintext);
  });

  test('prefixes ciphertext with the versioned envelope marker', () => {
    const ciphertext = encrypt('any value');
    assert.match(ciphertext, /^enc:v1:/);
  });

  test('produces a different ciphertext each time for the same plaintext (IV uniqueness)', () => {
    const plaintext = 'Identical input';
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    const c3 = encrypt(plaintext);
    assert.notStrictEqual(c1, c2);
    assert.notStrictEqual(c2, c3);
    assert.notStrictEqual(c1, c3);
    // ... but all three still decrypt to the same plaintext
    assert.strictEqual(decrypt(c1), plaintext);
    assert.strictEqual(decrypt(c2), plaintext);
    assert.strictEqual(decrypt(c3), plaintext);
  });

  test('is idempotent — encrypting an already-encrypted value returns it unchanged', () => {
    const ciphertext = encrypt('hello');
    const doubleEncrypted = encrypt(ciphertext);
    assert.strictEqual(doubleEncrypted, ciphertext);
  });

  test('returns null for null input', () => {
    assert.strictEqual(encrypt(null), null);
    assert.strictEqual(encrypt(undefined), null);
  });

  test('coerces non-string input to string before encrypting', () => {
    const ciphertext = encrypt(12345);
    assert.strictEqual(decrypt(ciphertext), '12345');
  });

  test('handles long content (chat-message-sized strings)', () => {
    const longText = 'A'.repeat(5000);
    const ciphertext = encrypt(longText);
    assert.strictEqual(decrypt(ciphertext), longText);
  });

  test('handles Unicode and emoji content', () => {
    const message = 'Hello नमस्ते 🩺 — symptoms include fever';
    assert.strictEqual(decrypt(encrypt(message)), message);
  });
});

describe('decrypt()', () => {
  test('returns plaintext unchanged when input is not encrypted', () => {
    // Legacy data and unencrypted fields should pass through untouched
    assert.strictEqual(decrypt('plain text'), 'plain text');
    assert.strictEqual(decrypt('not encrypted'), 'not encrypted');
  });

  test('returns null for null input', () => {
    assert.strictEqual(decrypt(null), null);
    assert.strictEqual(decrypt(undefined), null);
  });

  test('detects tampering with the ciphertext (GCM integrity check)', () => {
    const ciphertext = encrypt('original message');
    const parts = ciphertext.slice('enc:v1:'.length).split('.');
    const [ivHex, ctHex, tagHex] = parts;

    // Flip the last byte of the ciphertext
    const flippedByte = (parseInt(ctHex.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0');
    const tampered = `enc:v1:${ivHex}.${ctHex.slice(0, -2)}${flippedByte}.${tagHex}`;

    // Decryption must fail loudly (returns the error sentinel, not garbage)
    assert.strictEqual(decrypt(tampered), '[decryption error]');
  });

  test('detects tampering with the authentication tag', () => {
    const ciphertext = encrypt('original message');
    const parts = ciphertext.slice('enc:v1:'.length).split('.');
    const [ivHex, ctHex, tagHex] = parts;

    // Flip the last byte of the auth tag
    const flippedByte = (parseInt(tagHex.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0');
    const tampered = `enc:v1:${ivHex}.${ctHex}.${tagHex.slice(0, -2)}${flippedByte}`;

    assert.strictEqual(decrypt(tampered), '[decryption error]');
  });

  test('detects tampering with the IV', () => {
    const ciphertext = encrypt('original message');
    const parts = ciphertext.slice('enc:v1:'.length).split('.');
    const [ivHex, ctHex, tagHex] = parts;

    // Flip the last byte of the IV
    const flippedByte = (parseInt(ivHex.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0');
    const tampered = `enc:v1:${ivHex.slice(0, -2)}${flippedByte}.${ctHex}.${tagHex}`;

    assert.strictEqual(decrypt(tampered), '[decryption error]');
  });

  test('returns the error sentinel for a malformed envelope', () => {
    assert.strictEqual(decrypt('enc:v1:not-valid-hex'), '[decryption error]');
    assert.strictEqual(decrypt('enc:v1:abc.def'), '[decryption error]');
  });
});

describe('decryptRecord()', () => {
  test('decrypts the listed PHI fields in a record', () => {
    const record = {
      id: 1,
      patient_id: 42,
      reason: encrypt('Chest pain'),
      notes: encrypt('Prescribed aspirin'),
      created_at: '2026-06-18',
    };

    const decrypted = decryptRecord(record, ['reason', 'notes']);

    assert.strictEqual(decrypted.reason, 'Chest pain');
    assert.strictEqual(decrypted.notes, 'Prescribed aspirin');
    // Non-PHI fields untouched
    assert.strictEqual(decrypted.id, 1);
    assert.strictEqual(decrypted.patient_id, 42);
    assert.strictEqual(decrypted.created_at, '2026-06-18');
  });

  test('does not mutate the input record', () => {
    const reasonCipher = encrypt('Chest pain');
    const record = { reason: reasonCipher };
    decryptRecord(record, ['reason']);
    assert.strictEqual(record.reason, reasonCipher);
  });

  test('handles null PHI fields without crashing', () => {
    const record = { reason: null, notes: encrypt('only notes') };
    const decrypted = decryptRecord(record, ['reason', 'notes']);
    assert.strictEqual(decrypted.reason, null);
    assert.strictEqual(decrypted.notes, 'only notes');
  });

  test('returns the record unchanged when the record itself is null', () => {
    assert.strictEqual(decryptRecord(null, ['reason']), null);
    assert.strictEqual(decryptRecord(undefined, ['reason']), undefined);
  });
});

describe('decryptAll()', () => {
  test('decrypts PHI fields across an array of records', () => {
    const records = [
      { id: 1, reason: encrypt('A'), notes: encrypt('a') },
      { id: 2, reason: encrypt('B'), notes: encrypt('b') },
      { id: 3, reason: null, notes: encrypt('c') },
    ];

    const decrypted = decryptAll(records, ['reason', 'notes']);

    assert.strictEqual(decrypted.length, 3);
    assert.strictEqual(decrypted[0].reason, 'A');
    assert.strictEqual(decrypted[0].notes, 'a');
    assert.strictEqual(decrypted[1].reason, 'B');
    assert.strictEqual(decrypted[1].notes, 'b');
    assert.strictEqual(decrypted[2].reason, null);
    assert.strictEqual(decrypted[2].notes, 'c');
  });
});
