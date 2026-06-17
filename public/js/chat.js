/* ─── MediConnect Real-time Chat (Socket.io) ─── */
class ChatManager {
  constructor(token, currentUser) {
    this.token       = token;
    this.currentUser = currentUser;
    this.socket      = null;
    this.activeConvo = null;
    this.onMessage   = null;
    this.onStatus    = null;
    this.onlineUsers = new Set();
    this.typingTimer = null;
  }

  connect() {
    if (this.socket?.connected) return;
    this.socket = io({ auth: { token: this.token } });

    this.socket.on('connect', () => {});

    this.socket.on('new_message', (msg) => {
      if (typeof this.onMessage === 'function') this.onMessage(msg);
    });

    this.socket.on('user_status', ({ userId, online }) => {
      if (online) this.onlineUsers.add(userId);
      else        this.onlineUsers.delete(userId);
      if (typeof this.onStatus === 'function') this.onStatus(userId, online);
    });

    this.socket.on('typing', ({ from, name }) => {
      const el = document.getElementById('typing-indicator');
      if (el && this.activeConvo === from) el.textContent = name + ' is typing...';
    });

    this.socket.on('stop_typing', ({ from }) => {
      const el = document.getElementById('typing-indicator');
      if (el && this.activeConvo === from) el.textContent = '';
    });

    this.socket.on('messages_read', ({ by }) => {
      // Could update UI read receipts
    });

    this.socket.on('connect_error', () => {});
  }

  send(to, content) {
    if (!this.socket?.connected) return false;
    this.socket.emit('send_message', { to, content });
    this.socket.emit('stop_typing', { to });
    return true;
  }

  markRead(from) {
    if (this.socket?.connected) this.socket.emit('mark_read', { from });
  }

  emitTyping(to) {
    if (!this.socket?.connected) return;
    this.socket.emit('typing', { to });
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.socket.emit('stop_typing', { to }), 2000);
  }

  isOnline(userId) { return this.onlineUsers.has(Number(userId)); }

  disconnect() { this.socket?.disconnect(); }
}

// Global chat instance (initialized after login)
let Chat = null;

function initChat(token, user) {
  Chat = new ChatManager(token, user);
  Chat.connect();
}

// ─── Chat UI helpers ──────────────────────────────────────────────────────────
function renderMessage(msg, currentUserId) {
  const mine = msg.sender_id === currentUserId;
  const time  = new Date(msg.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const c = msg.content || '';
  let body;
  if (c.startsWith('data:image/')) {
    body = `<img src="${c}" style="max-width:220px;max-height:220px;border-radius:8px;display:block;cursor:pointer" onclick="this.style.maxWidth=this.style.maxWidth==='100%'?'220px':'100%'" loading="lazy" />`;
  } else if (c.startsWith('data:audio/')) {
    body = `<audio controls style="max-width:240px;width:100%"><source src="${c}"></audio>`;
  } else {
    body = escHtml(c);
  }
  return `<div class="msg ${mine ? 'msg-out' : 'msg-in'}">
    ${body}
    <div class="msg-time">${time}</div>
  </div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function scrollChatToBottom(el) {
  if (el) el.scrollTop = el.scrollHeight;
}

function setupScrollButton(msgsEl, btnId) {
  if (!msgsEl) return;
  const btn = document.getElementById(btnId);
  if (!btn) return;
  msgsEl.addEventListener('scroll', () => {
    const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    btn.style.display = nearBottom ? 'none' : 'flex';
  });
}
