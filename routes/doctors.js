const router = require('express').Router();
const db     = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const BASE_QUERY = `
  SELECT d.*, u.name, u.email, u.phone, u.role
  FROM doctors d
  JOIN users u ON u.id = d.user_id
`;

// List all doctors (with filters)
router.get('/', (req, res) => {
  const { q, specialty, online } = req.query;
  let sql = BASE_QUERY + ' WHERE d.verified = 1';
  const params = [];

  if (q) {
    sql += ` AND (u.name LIKE ? OR d.specialty LIKE ? OR d.hospital LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (specialty) { sql += ` AND d.specialty = ?`; params.push(specialty); }
  if (online === 'true')  { sql += ` AND d.online_status = 1`; }
  if (online === 'false') { sql += ` AND d.online_status = 0`; }
  sql += ` ORDER BY d.rating DESC, d.total_reviews DESC`;

  res.json(db.prepare(sql).all(...params));
});

// Get single doctor profile
router.get('/:id', (req, res) => {
  const doc = db.prepare(BASE_QUERY + ' WHERE d.id = ? AND d.verified = 1').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Doctor not found' });

  // Get schedule
  const schedule = db.prepare('SELECT * FROM schedules WHERE doctor_id = ? ORDER BY id').all(doc.id);
  // Get reviews
  const reviews = db.prepare(`
    SELECT r.*, u.name as patient_name
    FROM reviews r JOIN users u ON u.id = r.patient_id
    WHERE r.doctor_id = ? ORDER BY r.created_at DESC LIMIT 10
  `).all(doc.id);

  res.json({ ...doc, schedule, reviews });
});

// Get available slots for a doctor on a given date
router.get('/:id/slots', (req, res) => {
  const { date, type } = req.query; // date = 'YYYY-MM-DD' or 'Mon'/'Tue' etc.
  const doctorId = req.params.id;

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let dayOfWeek = date;
  let fullDate  = null;

  // If date looks like YYYY-MM-DD, extract the day abbreviation
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fullDate  = date;
    dayOfWeek = DAYS[new Date(date).getDay()];
  }

  let sql = 'SELECT * FROM schedules WHERE doctor_id = ?';
  const params = [doctorId];
  if (type)       { sql += ' AND visit_type = ?';   params.push(type); }
  if (dayOfWeek)  { sql += ' AND day_of_week = ?';  params.push(dayOfWeek); }

  const slots = db.prepare(sql).all(...params);

  // Mark which slots are already booked on the specific calendar date
  const bookedSlots = fullDate ? db.prepare(`
    SELECT time_slot FROM appointments
    WHERE doctor_id = ? AND appointment_date = ? AND status NOT IN ('cancelled') AND type = ?
  `).all(doctorId, fullDate, type || 'physical') : [];

  const bookedTimes = new Set(bookedSlots.map(b => b.time_slot));
  res.json(slots.map(s => ({ ...s, available: !bookedTimes.has(s.time_slot) })));
});

// Update doctor profile (doctor themselves or admin)
router.patch('/:id', auth, (req, res) => {
  const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Doctor not found' });
  if (req.user.role !== 'admin' && doc.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });

  const { bio, fee, hospital } = req.body;
  db.prepare('UPDATE doctors SET bio=COALESCE(?,bio), fee=COALESCE(?,fee), hospital=COALESCE(?,hospital) WHERE id=?')
    .run(bio||null, fee||null, hospital||null, doc.id);
  res.json({ message: 'Profile updated' });
});

// Toggle online status (doctor only)
router.patch('/:id/status', auth, (req, res) => {
  const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Doctor not found' });
  if (doc.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  const { online } = req.body;
  db.prepare('UPDATE doctors SET online_status=? WHERE id=?').run(online ? 1 : 0, doc.id);
  res.json({ online_status: online ? 1 : 0 });
});

// Add a schedule slot (doctor or admin)
router.post('/:id/schedule', auth, (req, res) => {
  const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Doctor not found' });
  if (doc.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });

  const { day_of_week, time_slot, visit_type, clinic_name } = req.body;
  const validDays  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const validTypes = ['physical','video'];

  if (!validDays.includes(day_of_week))  return res.status(400).json({ error: 'Invalid day of week' });
  if (!validTypes.includes(visit_type))  return res.status(400).json({ error: 'visit_type must be physical or video' });
  if (!time_slot || !String(time_slot).trim()) return res.status(400).json({ error: 'time_slot required' });

  try {
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO schedules (doctor_id, day_of_week, time_slot, clinic_name, visit_type) VALUES (?,?,?,?,?)'
    ).run(doc.id, day_of_week, String(time_slot).trim(),
      clinic_name || (visit_type === 'video' ? 'Online Video Consultation' : doc.hospital),
      visit_type);
    res.status(201).json({ message: 'Slot added', id });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE'))
      return res.status(409).json({ error: 'This slot already exists' });
    throw e;
  }
});

// Remove a schedule slot (doctor or admin)
router.delete('/:id/schedule/:slotId', auth, (req, res) => {
  const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Doctor not found' });
  if (doc.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });

  const result = db.prepare('DELETE FROM schedules WHERE id=? AND doctor_id=?')
    .run(req.params.slotId, doc.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Slot not found' });
  res.json({ message: 'Slot removed' });
});

// Leave a review (patient only)
router.post('/:id/reviews', auth, (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ error: 'Only patients can leave reviews' });
  const { rating, comment, appointment_id } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

  db.prepare(`INSERT INTO reviews (patient_id,doctor_id,appointment_id,rating,comment) VALUES (?,?,?,?,?)`)
    .run(req.user.id, req.params.id, appointment_id||null, rating, comment||'');

  // Recalculate average rating
  const agg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE doctor_id=?').get(req.params.id);
  db.prepare('UPDATE doctors SET rating=?, total_reviews=? WHERE id=?').run(+(agg.avg).toFixed(1), agg.cnt, req.params.id);

  res.json({ message: 'Review submitted' });
});

module.exports = router;
