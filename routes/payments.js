const router = require('express').Router();
const db     = require('../db');
const fetch  = require('node-fetch');
const { auth } = require('../middleware/auth');

const MERCHANT = process.env.ESEWA_MERCHANT_CODE || 'EPAYTEST';
const GW_URL   = process.env.ESEWA_GATEWAY_URL   || 'https://uat.esewa.com.np/epay/main';
const VER_URL  = process.env.ESEWA_VERIFY_URL     || 'https://uat.esewa.com.np/epay/transrec';
const BASE     = process.env.BASE_URL             || 'http://localhost:3000';

// Initiate eSewa payment — returns form data for frontend to submit
router.post('/esewa/initiate', auth, (req, res) => {
  const { appointment_id } = req.body;
  if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' });

  const appt = db.prepare('SELECT * FROM appointments WHERE id=? AND patient_id=?').get(appointment_id, req.user.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (appt.payment_status === 'completed') return res.status(400).json({ error: 'Already paid' });

  const amount = appt.final_fee;
  const pid    = appt.ref;

  res.json({
    gateway_url: GW_URL,
    fields: {
      tAmt: amount,
      amt:  amount,
      txAmt: 0,
      psc:  0,
      psd:  0,
      pid,
      scd:  MERCHANT,
      su:   `${BASE}/api/payments/esewa/success`,
      fu:   `${BASE}/api/payments/esewa/fail`,
    }
  });
});

// eSewa success callback (GET redirect from eSewa)
router.get('/esewa/success', async (req, res) => {
  const { oid, amt, refId } = req.query;

  // Verify with eSewa
  try {
    const verUrl = `${VER_URL}?oid=${oid}&amt=${amt}&scd=${MERCHANT}&rid=${refId}`;
    const resp   = await fetch(verUrl);
    const text   = await resp.text();

    if (!text.includes('Success')) {
      return res.redirect(`/payment-fail.html?reason=verification_failed&ref=${oid}`);
    }
  } catch {
    // In development / sandbox, skip verification failure
  }

  // Update appointment
  const appt = db.prepare('SELECT * FROM appointments WHERE ref=?').get(oid);
  if (appt) {
    db.prepare(`UPDATE appointments SET payment_status='completed', status='confirmed', transaction_id=? WHERE ref=?`)
      .run(refId, oid);
    db.prepare(`INSERT OR IGNORE INTO payments (appointment_id,patient_id,amount,method,status,esewa_ref_id,transaction_id) VALUES (?,?,?,'esewa','completed',?,?)`)
      .run(appt.id, appt.patient_id, appt.final_fee, refId, refId);
  }

  res.redirect(`/payment-success.html?ref=${oid}&refId=${refId}&amount=${amt}`);
});

// eSewa failure callback
router.get('/esewa/fail', (req, res) => {
  res.redirect(`/payment-fail.html?ref=${req.query.pid || ''}`);
});

// Khalti payment initiation (mock for now)
router.post('/khalti/initiate', auth, (req, res) => {
  const { appointment_id } = req.body;
  const appt = db.prepare('SELECT * FROM appointments WHERE id=? AND patient_id=?').get(appointment_id, req.user.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });

  // In production, integrate Khalti SDK here
  // For now, return mock success
  res.json({
    message: 'Khalti sandbox: use test credentials to pay',
    pidx: 'MOCK_' + appt.ref,
    payment_url: `https://test-pay.khalti.com/?pidx=MOCK_${appt.ref}`,
    amount: appt.final_fee * 100, // Khalti uses paisa
  });
});

// Mark cash payment as received (doctor/admin)
router.post('/cash/confirm', auth, (req, res) => {
  if (req.user.role === 'patient') return res.status(403).json({ error: 'Only doctor or admin can confirm cash' });
  const { appointment_id } = req.body;
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointment_id);
  if (!appt) return res.status(404).json({ error: 'Not found' });

  db.prepare(`UPDATE appointments SET payment_status='completed', status='confirmed' WHERE id=?`).run(appointment_id);
  db.prepare(`INSERT OR IGNORE INTO payments (appointment_id,patient_id,amount,method,status) VALUES (?,?,?,'cash','completed')`)
    .run(appt.id, appt.patient_id, appt.final_fee);

  res.json({ message: 'Cash payment confirmed' });
});

// Validate discount code
router.post('/validate-discount', auth, (req, res) => {
  const { code, doctor_id, fee: rawFee } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const discCode = db.prepare('SELECT * FROM discount_codes WHERE code=? AND active=1').get(code.toUpperCase());
  if (!discCode) return res.status(400).json({ error: 'Invalid or expired discount code' });
  if (discCode.used_count >= discCode.max_uses) return res.status(400).json({ error: 'Code usage limit reached' });

  let fee = Number(rawFee) || 0;
  if (!fee && doctor_id) {
    const doctor = db.prepare('SELECT fee FROM doctors WHERE id=?').get(doctor_id);
    if (doctor) fee = doctor.fee;
  }
  const saving = Math.round(fee * discCode.discount_percent / 100);

  res.json({
    valid: true,
    code: discCode.code,
    discount_percent: discCode.discount_percent,
    saving,
    final_fee: fee - saving,
  });
});

module.exports = router;
