const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encryption');

function decMsg(m) {
  return m ? { ...m, content: decrypt(m.content) } : m;
}
function decMsgs(arr) {
  return arr.map(decMsg);
}

// ─── GET /api/messages/conversations ──────────────────────────────────────────
router.get('/conversations', auth, (req, res) => {
  const uid = req.user.id;
  const convos = db.prepare(`
    SELECT
      other_id, other_name, other_role,
      last_message, last_time,
      SUM(unread) as unread_count
    FROM (
      SELECT
        CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END as other_id,
        CASE WHEN sender_id=? THEN ru.name ELSE su.name END as other_name,
        CASE WHEN sender_id=? THEN ru.role ELSE su.role END as other_role,
        m.content as last_message,
        m.created_at as last_time,
        CASE WHEN m.receiver_id=? AND m.is_read=0 THEN 1 ELSE 0 END as unread
      FROM messages m
      JOIN users su ON su.id=m.sender_id
      JOIN users ru ON ru.id=m.receiver_id
      WHERE m.sender_id=? OR m.receiver_id=?
    )
    GROUP BY other_id
    ORDER BY last_time DESC
  `).all(uid,uid,uid,uid,uid,uid);

  // Decrypt preview (truncated for conversation list)
  const result = convos.map(c => {
    let doctorInfo = null;
    if (c.other_role === 'doctor') {
      doctorInfo = db.prepare('SELECT d.* FROM doctors d JOIN users u ON u.id=d.user_id WHERE u.id=?').get(c.other_id);
    }
    const plainContent = decrypt(c.last_message) || '';
    return {
      ...c,
      last_message: plainContent.slice(0, 80) + (plainContent.length > 80 ? '…' : ''),
      doctorInfo,
    };
  });

  req.audit('LIST_CONVERSATIONS', 'message', null, {});
  res.json(result);
});

// ─── GET /api/messages/unread/count ──────────────────────────────────────────
router.get('/unread/count', auth, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE receiver_id=? AND is_read=0').get(req.user.id);
  res.json({ count: count.cnt });
});

// ─── GET /api/messages/:userId ────────────────────────────────────────────────
router.get('/:userId', auth, (req, res) => {
  const uid   = req.user.id;
  const other = parseInt(req.params.userId);

  if (isNaN(other)) return res.status(400).json({ error: 'Invalid user ID' });

  const msgs = db.prepare(`
    SELECT m.*, u.name as sender_name, u.role as sender_role
    FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE (m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)
    ORDER BY m.created_at ASC
    LIMIT 500
  `).all(uid, other, other, uid);

  // Mark as read
  db.prepare('UPDATE messages SET is_read=1 WHERE sender_id=? AND receiver_id=?').run(other, uid);

  req.audit('READ_MESSAGES', 'message', other, { message_count: msgs.length });
  res.json(decMsgs(msgs));
});

// ─── POST /api/messages ───────────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  const { to, content } = req.body;
  if (!to || !content)               return res.status(400).json({ error: 'to and content required' });
  if (typeof content !== 'string')   return res.status(400).json({ error: 'content must be a string' });
  if (content.length > 2000000)      return res.status(400).json({ error: 'Message too long' });

  const receiver = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(to);
  if (!receiver) return res.status(404).json({ error: 'Recipient not found' });

  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO messages (sender_id,receiver_id,content) VALUES (?,?,?)'
  ).run(req.user.id, to, encrypt(content.trim()));

  const msg = db.prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.is_read, m.created_at,
           u.name as sender_name, u.role as sender_role
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
  `).get(id);

  const deliverMsg = { ...msg, content: content.trim() };

  const io     = req.app.get('io');
  const online = req.app.get('onlineUsers');
  if (io && online) {
    const rSock = online.get(Number(to));
    if (rSock) io.to(rSock).emit('new_message', deliverMsg);
  }

  req.audit('SEND_MESSAGE', 'message', id, { to });
  res.status(201).json(deliverMsg);
});

module.exports = router;
