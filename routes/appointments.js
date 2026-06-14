const router = require('express').Router();
const db     = require('../db');
const v      = require('validator');
const { auth, requireRole } = require('../middleware/auth');
const { encrypt, decrypt, decryptRecord, decryptAll } = require('../utils/encryption');
const { getIP } = require('../middleware/audit');

const PHI_FIELDS = ['reason', 'notes'];

function genRef() {
  return 'MC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
}

function decryptAppt(a) { return decryptRecord(a, PHI_FIELDS); }
function decryptAppts(arr) { return decryptAll(arr, PHI_FIELDS); }

// ─── POST /api/appointments ───────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins cannot book appointments' });

  const { doctor_id, appointment_date, time_slot, type, reason, clinic_name, discount_code, payment_method } = req.body;

  if (!doctor_id || !appointment_date || !time_slot || !type)
    return res.status(400).json({ error: 'doctor_id, appointment_date, time_slot, type are required' });
  if (!['physical','video'].includes(type))
    return res.status(400).json({ error: 'type must be physical or video' });
  if (!v.isDate(String(appointment_date), { format: 'YYYY-MM-DD', strictMode: true }))
    return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD required)' });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (new Date(appointment_date) < today)
    return res.status(400).json({ error: 'Appointment date cannot be in the past' });

  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctor_id);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  if (!doctor.verified) return res.status(400).json({ error: 'Doctor is pending verification' });

  // Slot conflict check
  const conflict = db.prepare(`
    SELECT id FROM appointments
    WHERE doctor_id=? AND appointment_date=? AND time_slot=? AND type=? AND status NOT IN ('cancelled')
  `).get(doctor_id, appointment_date, time_slot, type);
  if (conflict) return res.status(409).json({ error: 'This slot is already booked. Please select another time.' });

  // Validate discount code before entering transaction
  let discountAmount = 0;
  let cleanCode = null;
  if (discount_code) {
    cleanCode = String(discount_code).toUpperCase();
    const code = db.prepare('SELECT * FROM discount_codes WHERE code=? AND active=1').get(cleanCode);
    if (!code) return res.status(400).json({ error: 'Invalid or expired discount code' });
    if (code.used_count >= code.max_uses) return res.status(400).json({ error: 'Discount code usage limit reached' });
    discountAmount = Math.round(doctor.fee * code.discount_percent / 100);
  }

  const finalFee = doctor.fee - discountAmount;
  const ref      = genRef();

  // Wrap insert + discount increment in a transaction to prevent race conditions
  let apptId;
  try {
    db.exec('BEGIN');
    try {
      if (cleanCode) {
        const result = db.prepare(
          'UPDATE discount_codes SET used_count=used_count+1 WHERE code=? AND active=1 AND used_count < max_uses'
        ).run(cleanCode);
        if (result.changes === 0) throw Object.assign(new Error('Discount code usage limit reached'), { status: 400 });
      }

      apptId = db.prepare(`
        INSERT INTO appointments
          (ref,patient_id,doctor_id,appointment_date,time_slot,type,reason,clinic_name,
           discount_code,original_fee,discount_amount,final_fee,payment_method,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        ref, req.user.id, doctor_id, appointment_date, time_slot, type,
        reason ? encrypt(reason) : null,
        clinic_name || null,
        cleanCode,
        doctor.fee, discountAmount, finalFee,
        payment_method || 'cash',
        'pending'
      ).lastInsertRowid;

      if (payment_method === 'cash') {
        db.prepare(`UPDATE appointments SET status='confirmed' WHERE id=?`).run(apptId);
      }
      db.exec('COMMIT');
    } catch (inner) {
      db.exec('ROLLBACK');
      throw inner;
    }
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  req.audit('CREATE_APPOINTMENT', 'appointment', apptId, { ref, doctor_id, date: appointment_date });

  // Auto-message from doctor so the patient sees the conversation immediately
  try {
    const docUser = db.prepare('SELECT user_id FROM doctors WHERE id=?').get(doctor_id);
    if (docUser) {
      const greeting = encrypt(
        `Hi! Your appointment on ${appointment_date} at ${time_slot} (${type === 'video' ? 'Video Consultation' : 'Physical Visit'}) is confirmed. Ref: ${ref}. Feel free to message me with any questions beforehand.`
      );
      db.prepare('INSERT INTO messages (sender_id,receiver_id,content) VALUES (?,?,?)')
        .run(docUser.user_id, req.user.id, greeting);
    }
  } catch {}

  res.status(201).json({ appointment: decryptAppt(getAppt(apptId)), ref });
});

// ─── GET /api/appointments ────────────────────────────────────────────────────
router.get('/', auth, (req, res) => {
  let sql = `
    SELECT a.*,
      u.name as patient_name, u.phone as patient_phone,
      d.specialty, d.hospital, d.fee as doc_fee,
      du.name as doctor_name, du.email as doctor_email
    FROM appointments a
    JOIN users u  ON u.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN users du ON du.id = d.user_id
    WHERE 1=1
  `;
  const params = [];

  if (req.user.role === 'patient') {
    sql += ' AND a.patient_id = ?'; params.push(req.user.id);
  } else if (req.user.role === 'doctor') {
    const doc = db.prepare('SELECT id FROM doctors WHERE user_id=?').get(req.user.id);
    if (!doc) return res.json([]);
    sql += ' AND a.doctor_id = ?'; params.push(doc.id);
  }

  const { status, date } = req.query;
  if (status) { sql += ' AND a.status=?'; params.push(status); }
  if (date)   { sql += ' AND a.appointment_date=?'; params.push(date); }
  sql += ' ORDER BY a.appointment_date DESC, a.created_at DESC';

  req.audit('LIST_APPOINTMENTS', 'appointment', null, { role: req.user.role });
  res.json(decryptAppts(db.prepare(sql).all(...params)));
});

// ─── GET /api/appointments/:id ────────────────────────────────────────────────
router.get('/:id', auth, (req, res) => {
  const appt = getAppt(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'patient' && appt.patient_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'doctor') {
    const doc = db.prepare('SELECT id FROM doctors WHERE user_id=?').get(req.user.id);
    if (!doc || appt.doctor_id !== doc.id) return res.status(403).json({ error: 'Forbidden' });
  }

  req.audit('READ_APPOINTMENT', 'appointment', appt.id, {});
  res.json(decryptAppt(appt));
});

// ─── PATCH /api/appointments/:id/status ──────────────────────────────────────
router.patch('/:id/status', auth, (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });

  const { status, notes } = req.body;
  const allowed = {
    patient: ['cancelled'],
    doctor:  ['confirmed','cancelled','completed'],
    admin:   ['confirmed','cancelled','completed','pending'],
  };
  if (!allowed[req.user.role]?.includes(status))
    return res.status(403).json({ error: 'Not allowed to set this status' });

  if (req.user.role === 'patient' && appt.patient_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'doctor') {
    const doc = db.prepare('SELECT id FROM doctors WHERE user_id=?').get(req.user.id);
    if (!doc || appt.doctor_id !== doc.id) return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('UPDATE appointments SET status=?, notes=COALESCE(?,notes) WHERE id=?')
    .run(status, notes ? encrypt(notes) : null, appt.id);

  req.audit('UPDATE_APPOINTMENT_STATUS', 'appointment', appt.id, { status, prev: appt.status });
  res.json({ message: `Appointment ${status}` });
});

// ─── DELETE /api/appointments/:id ────────────────────────────────────────────
// Patients can remove their own cancelled/completed appointments from their list.
// Admins can delete any appointment.
router.delete('/:id', auth, (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  if (req.user.role === 'patient') {
    if (appt.patient_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    if (!['cancelled','completed'].includes(appt.status))
      return res.status(400).json({ error: 'Only cancelled or completed appointments can be removed' });
  } else if (req.user.role === 'doctor') {
    return res.status(403).json({ error: 'Doctors cannot delete appointments' });
  }

  db.prepare('DELETE FROM appointments WHERE id=?').run(appt.id);
  req.audit('DELETE_APPOINTMENT', 'appointment', appt.id, { ref: appt.ref, status: appt.status });
  res.json({ message: 'Appointment removed' });
});

// ─── PATCH /api/appointments/:id/notes ───────────────────────────────────────
router.patch('/:id/notes', ...requireRole('doctor','admin'), (req, res) => {
  const { notes } = req.body;
  if (!notes) return res.status(400).json({ error: 'notes required' });

  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'doctor') {
    const doc = db.prepare('SELECT id FROM doctors WHERE user_id=?').get(req.user.id);
    if (!doc || appt.doctor_id !== doc.id) return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('UPDATE appointments SET notes=? WHERE id=?')
    .run(encrypt(notes), appt.id);

  req.audit('UPDATE_APPOINTMENT_NOTES', 'appointment', appt.id, {});
  res.json({ message: 'Clinical notes saved' });
});

function getAppt(id) {
  return db.prepare(`
    SELECT a.*,
      u.name as patient_name, u.phone as patient_phone,
      d.specialty, d.hospital, d.avatar as doc_avatar,
      du.name as doctor_name, du.email as doctor_email
    FROM appointments a
    JOIN users u  ON u.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN users du ON du.id = d.user_id
    WHERE a.id=?
  `).get(id);
}

module.exports = router;
