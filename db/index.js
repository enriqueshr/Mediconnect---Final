require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path   = require('path');
const bcrypt = require('bcryptjs');

const db = new DatabaseSync(path.join(__dirname, '..', 'mediconnect.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA cache_size = -64000');
db.exec('PRAGMA temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('patient','doctor','admin')) DEFAULT 'patient',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS doctors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    specialty TEXT NOT NULL,
    hospital TEXT NOT NULL,
    nmc_number TEXT UNIQUE NOT NULL,
    experience_years INTEGER DEFAULT 0,
    fee INTEGER NOT NULL DEFAULT 500,
    bio TEXT,
    avatar TEXT DEFAULT '👨‍⚕️',
    online_status INTEGER DEFAULT 0,
    rating REAL DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    verified INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    day_of_week TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    clinic_name TEXT DEFAULT 'Main Clinic',
    visit_type TEXT DEFAULT 'physical',
    UNIQUE(doctor_id, day_of_week, time_slot, visit_type)
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    doctor_id INTEGER NOT NULL REFERENCES doctors(id),
    appointment_date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    type TEXT CHECK(type IN ('physical','video')) DEFAULT 'physical',
    status TEXT CHECK(status IN ('pending','confirmed','cancelled','completed')) DEFAULT 'pending',
    reason TEXT,
    clinic_name TEXT,
    discount_code TEXT,
    original_fee INTEGER,
    discount_amount INTEGER DEFAULT 0,
    final_fee INTEGER,
    payment_method TEXT,
    payment_status TEXT DEFAULT 'pending',
    transaction_id TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    receiver_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL REFERENCES users(id),
    doctor_id INTEGER NOT NULL REFERENCES doctors(id),
    appointment_id INTEGER REFERENCES appointments(id),
    rating INTEGER CHECK(rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS discount_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    discount_percent INTEGER NOT NULL,
    max_uses INTEGER DEFAULT 100,
    used_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id),
    patient_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    transaction_id TEXT,
    esewa_ref_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- HIPAA §164.312(b): Audit controls — immutable PHI access log
  -- Minimum 6-year retention per HIPAA §164.316(b)(2)(i)
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    role TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    details TEXT,
    success INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Brute-force & account lockout tracking
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ip_address TEXT,
    success INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- JWT refresh tokens (stored as hash)
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    revoked INTEGER DEFAULT 0,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- GDPR Art. 7 / CCPA consent records
  CREATE TABLE IF NOT EXISTS consent_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    consent_type TEXT NOT NULL,
    granted INTEGER DEFAULT 1,
    ip_address TEXT,
    version TEXT DEFAULT '1.0',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- GDPR Art. 12-22 data subject requests
  CREATE TABLE IF NOT EXISTS data_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_type TEXT CHECK(request_type IN ('export','erasure','portability','rectification')),
    status TEXT DEFAULT 'pending',
    processed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Performance indexes
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_audit_user     ON audit_logs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_logs(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_email    ON login_attempts(email, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens ON refresh_tokens(user_id, revoked);
  CREATE INDEX IF NOT EXISTS idx_appt_patient   ON appointments(patient_id, appointment_date DESC);
  CREATE INDEX IF NOT EXISTS idx_appt_doctor    ON appointments(doctor_id, appointment_date DESC);
  CREATE INDEX IF NOT EXISTS idx_msgs_conv      ON messages(sender_id, receiver_id, created_at);
`);

// Transaction helper
function txn(fn) {
  db.exec('BEGIN');
  try { fn(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function seed() {
  if (process.env.NODE_ENV === 'production') return;
  const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (adminExists) return;

  const adminHash = bcrypt.hashSync('Admin@123', 10);
  db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)`)
    .run('System Admin', 'admin@mediconnect.com', '+977-9800000000', adminHash, 'admin');

  const docHash = bcrypt.hashSync('Doctor@123', 10);
  const docData = [
    { name:'Dr. Rajesh Sharma',   email:'rajesh@mediconnect.com',  phone:'+977-9841000001', spec:'Cardiologist',    hospital:'Bir Hospital',           nmc:'NMC-12345', exp:12, fee:800,  bio:'Senior Cardiologist with expertise in interventional cardiology. MBBS, MD from BPKIHS.',       avatar:'👨‍⚕️', online:1, rating:4.9, reviews:234 },
    { name:'Dr. Priya Gurung',    email:'priya@mediconnect.com',   phone:'+977-9841000002', spec:'Dermatologist',   hospital:'Teaching Hospital',        nmc:'NMC-23456', exp:8,  fee:600,  bio:'Specialist in cosmetic dermatology, acne, eczema and skin cancer screening.',                 avatar:'👩‍⚕️', online:1, rating:4.8, reviews:189 },
    { name:'Dr. Anish Thapa',     email:'anish@mediconnect.com',   phone:'+977-9841000003', spec:'Neurologist',     hospital:'BPKIHS',                   nmc:'NMC-34567', exp:15, fee:1000, bio:'Expert in epilepsy, migraine and stroke management.',                                         avatar:'👨‍⚕️', online:0, rating:4.7, reviews:156 },
    { name:'Dr. Sita Maharjan',   email:'sita@mediconnect.com',    phone:'+977-9841000004', spec:'Gynecologist',    hospital:'Maternity Hospital',        nmc:'NMC-45678', exp:10, fee:700,  bio:"Women's health specialist focusing on reproductive health.",                                  avatar:'👩‍⚕️', online:1, rating:4.9, reviews:312 },
    { name:'Dr. Ram Bahadur KC',  email:'ram.kc@mediconnect.com',  phone:'+977-9841000005', spec:'Pediatrician',    hospital:'Kanti Children Hospital',  nmc:'NMC-56789', exp:11, fee:500,  bio:'Pediatric specialist with extensive experience in childhood diseases.',                      avatar:'👨‍⚕️', online:1, rating:4.8, reviews:278 },
    { name:'Dr. Meena Poudel',    email:'meena@mediconnect.com',   phone:'+977-9841000006', spec:'Psychiatrist',    hospital:'Patan Hospital',           nmc:'NMC-67890', exp:7,  fee:900,  bio:'Mental health expert specializing in anxiety, depression and CBT.',                          avatar:'👩‍⚕️', online:0, rating:4.6, reviews:98  },
    { name:'Dr. Suresh Shrestha', email:'suresh@mediconnect.com',  phone:'+977-9841000007', spec:'Orthopedist',     hospital:'Nepal Police Hospital',    nmc:'NMC-78901', exp:14, fee:800,  bio:'Orthopedic surgeon with expertise in joint replacement and sports injuries.',                avatar:'👨‍⚕️', online:1, rating:4.7, reviews:203 },
    { name:'Dr. Kamala Tamang',   email:'kamala@mediconnect.com',  phone:'+977-9841000008', spec:'Ophthalmologist', hospital:'Nepal Eye Hospital',       nmc:'NMC-89012', exp:9,  fee:650,  bio:'Eye specialist in cataract surgery, LASIK, and pediatric ophthalmology.',                    avatar:'👩‍⚕️', online:1, rating:4.8, reviews:145 },
  ];

  const insertUser   = db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'doctor')`);
  const insertDoctor = db.prepare(`INSERT INTO doctors (user_id,specialty,hospital,nmc_number,experience_years,fee,bio,avatar,online_status,rating,total_reviews,verified) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`);
  const insertSched  = db.prepare(`INSERT OR IGNORE INTO schedules (doctor_id,day_of_week,time_slot,clinic_name,visit_type) VALUES (?,?,?,?,?)`);

  const physSlots  = ['09:00 AM','10:30 AM','12:00 PM','02:00 PM','03:30 PM','05:00 PM'];
  const videoSlots = ['09:00 AM','11:00 AM','01:00 PM','04:00 PM','06:00 PM','08:00 PM'];
  const physDays   = ['Mon','Tue','Wed','Thu','Fri'];
  const allDays    = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  txn(() => {
    for (const d of docData) {
      const uid = Number(insertUser.run(d.name, d.email, d.phone, docHash).lastInsertRowid);
      const did = Number(insertDoctor.run(uid, d.spec, d.hospital, d.nmc, d.exp, d.fee, d.bio, d.avatar, d.online, d.rating, d.reviews).lastInsertRowid);
      for (const day of physDays)  for (const slot of physSlots)  insertSched.run(did, day, slot, d.hospital, 'physical');
      for (const day of allDays)   for (const slot of videoSlots) insertSched.run(did, day, slot, 'Online Video Consultation', 'video');
    }
  });

  const patHash = bcrypt.hashSync('Patient@123', 10);
  db.prepare(`INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'patient')`).run('Ram Thapa','ram@example.com','+977-9812345678',patHash);

  const insertCode = db.prepare(`INSERT OR IGNORE INTO discount_codes (code,discount_percent,max_uses) VALUES (?,?,?)`);
  [['WELCOME20',20,1000],['HEALTH30',30,500],['FIRST50',50,200],['NEWYEAR15',15,300],['ADMIN100',100,10]].forEach(([c,p,m]) => insertCode.run(c,p,m));

  if (process.env.NODE_ENV !== 'production') console.log('✅ Database seeded with 8 doctors, 1 patient, discount codes');
}

seed();
module.exports = db;
