/* ─── MediConnect API Helper ─── */
const API = {
  base: '/api',

  _token() { return localStorage.getItem('mc_token'); },

  async _req(method, path, body, auth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const t = this._token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(this.base + path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  },

  get:    (path, auth)       => API._req('GET',    path, null, auth),
  post:   (path, body, auth) => API._req('POST',   path, body, auth),
  patch:  (path, body)       => API._req('PATCH',  path, body),
  del:    (path)             => API._req('DELETE', path),

  // Auth
  login:           (email, pw)  => API.post('/auth/login',    { email, password: pw }, false),
  register:        (data)       => API.post('/auth/register', data, false),
  registerDoctor:  (data)       => API.post('/auth/register-doctor', data, false),
  me:              ()           => API.get('/auth/me'),
  changePassword:  (old_, new_) => API.post('/auth/change-password', { oldPassword: old_, newPassword: new_ }),

  // Doctors
  doctors:       (params = {}) => API.get('/doctors?' + new URLSearchParams(params)),
  doctor:        (id)          => API.get('/doctors/' + id),
  doctorSlots:   (id, p)       => API.get('/doctors/' + id + '/slots?' + new URLSearchParams(p)),
  updateDoctor:  (id, data)    => API.patch('/doctors/' + id, data),
  toggleStatus:  (id, online)  => API.patch('/doctors/' + id + '/status', { online }),
  leaveReview:   (id, data)    => API.post('/doctors/' + id + '/reviews', data),

  // Appointments
  bookAppointment:  (data)       => API.post('/appointments', data),
  appointments:     (params = {}) => API.get('/appointments?' + new URLSearchParams(params)),
  appointment:      (id)         => API.get('/appointments/' + id),
  cancelAppt:       (id)         => API.patch('/appointments/' + id + '/status', { status: 'cancelled' }),
  deleteAppt:       (id)         => API._req('DELETE', '/appointments/' + id),
  updateApptStatus: (id, status, notes) => API.patch('/appointments/' + id + '/status', { status, notes }),
  saveNotes:        (id, notes)  => API.patch('/appointments/' + id + '/notes', { notes }),

  // Messages
  conversations:  ()   => API.get('/messages/conversations'),
  messages:       (uid) => API.get('/messages/' + uid),
  sendMsg:        (to, content) => API.post('/messages', { to, content }),
  unreadCount:    ()   => API.get('/messages/unread/count'),

  // Payments
  esewaInitiate:    (appt_id) => API.post('/payments/esewa/initiate', { appointment_id: appt_id }),
  validateDiscount: (code, doc_id) => API.post('/payments/validate-discount', { code, doctor_id: doc_id }),
  confirmCash:      (appt_id) => API.post('/payments/cash/confirm', { appointment_id: appt_id }),

  // Profile
  updateProfile: (data)       => API.patch('/auth/me', data),
  logout:        (refresh)    => API.post('/auth/logout', { refresh_token: refresh }),

  // GDPR
  gdprExport:    ()           => API._req('GET', '/gdpr/export'),
  gdprErase:     ()           => API._req('DELETE', '/gdpr/me', { confirm: 'DELETE MY ACCOUNT' }),
  gdprAuditTrail: ()          => API.get('/gdpr/audit-trail'),

  // Schedule
  addScheduleSlot:    (docId, data)    => API.post('/doctors/' + docId + '/schedule', data),
  removeScheduleSlot: (docId, slotId)  => API.del('/doctors/' + docId + '/schedule/' + slotId),

  // Admin
  adminStats:       ()           => API.get('/admin/stats'),
  adminUsers:       (params)     => API.get('/admin/users?' + new URLSearchParams(params||{})),
  adminDoctors:     ()           => API.get('/admin/doctors'),
  adminCreateDoc:   (data)       => API.post('/admin/doctors', data),
  adminAppts:       (params)     => API.get('/admin/appointments?' + new URLSearchParams(params||{})),
  adminPayments:    ()           => API.get('/admin/payments'),
  adminDiscounts:   ()           => API.get('/admin/discounts'),
  adminCreateCode:  (data)       => API.post('/admin/discounts', data),
  adminUpdateCode:  (id, data)   => API.patch('/admin/discounts/' + id, data),
  adminDeleteCode:  (id)         => API.del('/admin/discounts/' + id),
  adminVerifyDoc:   (id, v)      => API.patch('/admin/doctors/' + id + '/verify', { verified: v }),
  adminDeleteUser:  (id)         => API.del('/admin/users/' + id),
};

// ─── Auth State ───────────────────────────────────────────────────────────────
const Auth = {
  getUser()        { try { return JSON.parse(localStorage.getItem('mc_user')||'null'); } catch { return null; } },
  getToken()       { return localStorage.getItem('mc_token'); },
  getRefresh()     { return localStorage.getItem('mc_refresh_token'); },
  isLoggedIn()     { return !!this.getToken(); },
  save(token, user, refreshToken) {
    localStorage.setItem('mc_token', token);
    localStorage.setItem('mc_user', JSON.stringify(user));
    if (refreshToken) localStorage.setItem('mc_refresh_token', refreshToken);
  },
  logout() {
    localStorage.removeItem('mc_token');
    localStorage.removeItem('mc_refresh_token');
    localStorage.removeItem('mc_user');
  },
};

// ─── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function timeAgo(dt) {
  const diff = (Date.now() - new Date(dt)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return new Date(dt).toLocaleDateString();
}
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'}) : '-'; }
function fmtTime(t) { return t || '-'; }
