/* ─── MediConnect WebRTC — Video & Audio Calling ─── */
const WebRTCCall = (() => {
  const STUN_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  };

  let socket       = null;
  let localUser    = null;
  let pc           = null;
  let localStream  = null;
  let callType     = 'video';
  let isCaller     = false;
  let remoteUserId = null;
  let remoteName   = '';
  let remoteAvatar = '👤';
  let pendingOffer = null;
  let isMuted      = false;
  let isCamOff     = false;
  let timerInterval = null;
  let callStartTime = null;
  let autoRejectTimer = null;

  // ─── Inject UI (once) ─────────────────────────────────────────────────────
  function injectUI() {
    if (document.getElementById('wrtc-overlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
<style>
  #wrtc-incoming { display:none; }
  #wrtc-overlay  { display:none; }
  @keyframes wrtc-slidein  { from { transform:translateY(24px);opacity:0 } to { transform:none;opacity:1 } }
  @keyframes wrtc-ringpulse { 0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.6)} 60%{box-shadow:0 0 0 18px rgba(34,197,94,0)} }
  .wrtc-accept { animation: wrtc-ringpulse 1.4s infinite; }
  .wrtc-ctrl-btn {
    background: rgba(255,255,255,.15);
    color: #fff;
    border: none;
    border-radius: 50%;
    width: 58px;
    height: 58px;
    font-size: 1.4rem;
    cursor: pointer;
    backdrop-filter: blur(8px);
    transition: background .2s, transform .15s;
  }
  .wrtc-ctrl-btn:hover  { background: rgba(255,255,255,.28); transform: scale(1.08); }
  .wrtc-ctrl-btn.active { background: rgba(239,68,68,.75); }
</style>

<!-- ─── Incoming Call Modal ─── -->
<div id="wrtc-incoming" style="display:none;position:fixed;inset:0;z-index:10000;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(6px)">
  <div style="background:#fff;border-radius:24px;padding:2.5rem 2rem;text-align:center;max-width:320px;width:90%;box-shadow:0 24px 64px rgba(0,0,0,.35);animation:wrtc-slidein .3s ease">
    <div id="wrtc-inc-avatar" style="font-size:4.5rem;margin-bottom:.5rem">👤</div>
    <div id="wrtc-inc-name"   style="font-size:1.25rem;font-weight:700;color:#111827;margin-bottom:.35rem">Incoming Call</div>
    <div id="wrtc-inc-type"   style="font-size:.85rem;color:#6b7280;margin-bottom:2rem">📹 Video Call</div>
    <div style="display:flex;gap:1.5rem;justify-content:center;align-items:center">
      <div style="text-align:center">
        <button onclick="WebRTCCall._rejectCall()" style="background:#ef4444;color:#fff;border:none;border-radius:50%;width:64px;height:64px;font-size:1.8rem;cursor:pointer;box-shadow:0 4px 16px rgba(239,68,68,.45);display:block">✕</button>
        <div style="margin-top:.5rem;font-size:.75rem;color:#6b7280">Decline</div>
      </div>
      <div style="text-align:center">
        <button onclick="WebRTCCall._acceptCall()" class="wrtc-accept" style="background:#22c55e;color:#fff;border:none;border-radius:50%;width:64px;height:64px;font-size:1.8rem;cursor:pointer;box-shadow:0 4px 16px rgba(34,197,94,.45);display:block">✓</button>
        <div style="margin-top:.5rem;font-size:.75rem;color:#6b7280">Accept</div>
      </div>
    </div>
  </div>
</div>

<!-- ─── Active Call Overlay ─── -->
<div id="wrtc-overlay" style="display:none;position:fixed;inset:0;z-index:9999;background:#0a0c12;flex-direction:column">
  <!-- Remote video (full screen) -->
  <video id="wrtc-remote-video" autoplay playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none"></video>

  <!-- Remote placeholder (audio/connecting) -->
  <div id="wrtc-remote-placeholder" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff">
    <div id="wrtc-ph-avatar" style="font-size:7rem;margin-bottom:1rem;line-height:1">👤</div>
    <div id="wrtc-ph-name"   style="font-size:1.6rem;font-weight:600;margin-bottom:.5rem"></div>
    <div id="wrtc-ph-status" style="font-size:.9rem;color:rgba(255,255,255,.6)">Connecting…</div>
  </div>

  <!-- Local PiP -->
  <video id="wrtc-local-video" autoplay playsinline muted style="position:absolute;bottom:108px;right:16px;width:120px;height:168px;object-fit:cover;border-radius:14px;border:2px solid rgba(255,255,255,.25);background:#111;box-shadow:0 4px 20px rgba(0,0,0,.5);display:none"></video>

  <!-- Top info bar -->
  <div style="position:absolute;top:0;left:0;right:0;padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;background:linear-gradient(180deg,rgba(0,0,0,.85) 0%,transparent 100%)">
    <div id="wrtc-bar-avatar" style="font-size:2.2rem;line-height:1">👤</div>
    <div>
      <div id="wrtc-bar-name"   style="color:#fff;font-weight:700;font-size:1rem"></div>
      <div id="wrtc-bar-status" style="color:rgba(255,255,255,.6);font-size:.78rem">Calling…</div>
    </div>
    <div id="wrtc-timer" style="margin-left:auto;color:rgba(255,255,255,.85);font-size:.9rem;font-family:monospace;display:none">00:00</div>
  </div>

  <!-- Controls bar -->
  <div style="position:absolute;bottom:0;left:0;right:0;padding:1.25rem 1rem 1.75rem;display:flex;align-items:center;justify-content:center;gap:1rem;background:linear-gradient(0deg,rgba(0,0,0,.9) 0%,transparent 100%)">
    <div style="display:flex;flex-direction:column;align-items:center;gap:.4rem">
      <button id="wrtc-btn-mic" class="wrtc-ctrl-btn" onclick="WebRTCCall.toggleMic()" title="Toggle Mic">🎙️</button>
      <span style="color:rgba(255,255,255,.5);font-size:.7rem">Mic</span>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:.4rem">
      <button id="wrtc-btn-cam" class="wrtc-ctrl-btn" onclick="WebRTCCall.toggleCam()" title="Toggle Camera">📹</button>
      <span style="color:rgba(255,255,255,.5);font-size:.7rem">Camera</span>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:.4rem">
      <button onclick="WebRTCCall.endCall()" style="background:#ef4444;color:#fff;border:none;border-radius:50%;width:70px;height:70px;font-size:1.9rem;cursor:pointer;box-shadow:0 4px 24px rgba(239,68,68,.55);transition:transform .15s" onmouseenter="this.style.transform='scale(1.08)'" onmouseleave="this.style.transform=''" title="End Call">📵</button>
      <span style="color:rgba(255,255,255,.5);font-size:.7rem">End</span>
    </div>
  </div>
</div>
`);
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────
  function showOverlay(show) {
    const el = document.getElementById('wrtc-overlay');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  function showIncoming(show) {
    const el = document.getElementById('wrtc-incoming');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  function setBarStatus(text) {
    const el = document.getElementById('wrtc-bar-status');
    if (el) el.textContent = text;
  }

  function setPhStatus(text) {
    const el = document.getElementById('wrtc-ph-status');
    if (el) el.textContent = text;
  }

  function startTimer() {
    callStartTime = Date.now();
    const el = document.getElementById('wrtc-timer');
    if (el) el.style.display = 'block';
    timerInterval = setInterval(() => {
      const s   = Math.floor((Date.now() - callStartTime) / 1000);
      const mm  = String(Math.floor(s / 60)).padStart(2, '0');
      const ss  = String(s % 60).padStart(2, '0');
      if (el) el.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function populateOverlay() {
    const elems = {
      'wrtc-bar-avatar': remoteAvatar,
      'wrtc-bar-name':   remoteName,
      'wrtc-ph-avatar':  remoteAvatar,
      'wrtc-ph-name':    remoteName,
    };
    for (const [id, val] of Object.entries(elems)) {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    }
    setBarStatus(isCaller ? 'Calling…' : 'Connecting…');
    setPhStatus(isCaller ? 'Ringing…' : 'Connecting…');

    const camBtn = document.getElementById('wrtc-btn-cam');
    if (camBtn) camBtn.style.display = callType === 'audio' ? 'none' : '';

    // Hide remote video, show placeholder
    const rv = document.getElementById('wrtc-remote-video');
    if (rv) rv.style.display = 'none';
    const ph = document.getElementById('wrtc-remote-placeholder');
    if (ph) ph.style.display = 'flex';
  }

  // ─── RTCPeerConnection ────────────────────────────────────────────────────
  function createPC() {
    pc = new RTCPeerConnection(STUN_CONFIG);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && remoteUserId) {
        socket.emit('call:ice-candidate', { to: remoteUserId, candidate });
      }
    };

    pc.ontrack = (e) => {
      const rv = document.getElementById('wrtc-remote-video');
      const ph = document.getElementById('wrtc-remote-placeholder');
      if (rv) {
        rv.srcObject = e.streams[0];
        rv.style.display = callType === 'video' ? 'block' : 'none';
      }
      if (ph) ph.style.display = callType === 'audio' ? 'flex' : 'none';
      setBarStatus('Connected');
      setPhStatus('Connected');
      if (!timerInterval) startTimer();
    };

    pc.onconnectionstatechange = () => {
      if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
        cleanup();
        if (typeof showToast === 'function') showToast('Call disconnected', 'error');
      }
    };

    return pc;
  }

  async function getMedia(type) {
    const constraints = type === 'audio'
      ? { audio: true, video: false }
      : { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // ─── Initiate Call ────────────────────────────────────────────────────────
  async function start(targetUserId, targetName, targetAvatar, type) {
    if (!socket) { if (typeof showToast === 'function') showToast('Not connected to server', 'error'); return; }
    if (pc)      { if (typeof showToast === 'function') showToast('Already in a call', 'error'); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      if (typeof showToast === 'function') showToast('Your browser does not support media calls', 'error');
      return;
    }

    remoteUserId = Number(targetUserId);
    remoteName   = targetName  || 'Unknown';
    remoteAvatar = targetAvatar || '👤';
    callType     = type || 'video';
    isCaller     = true;
    isMuted      = false;
    isCamOff     = false;

    injectUI();
    populateOverlay();
    showOverlay(true);

    try {
      localStream = await getMedia(callType);
    } catch (err) {
      showOverlay(false);
      if (typeof showToast === 'function') showToast('Camera/mic access denied: ' + err.message, 'error');
      return;
    }

    const lv = document.getElementById('wrtc-local-video');
    if (lv) {
      lv.srcObject = localStream;
      lv.style.display = callType === 'video' ? 'block' : 'none';
    }

    createPC();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:offer', { to: remoteUserId, offer, callType });
    } catch (err) {
      cleanup();
      if (typeof showToast === 'function') showToast('Failed to initiate call', 'error');
    }
  }

  // ─── Accept Incoming ──────────────────────────────────────────────────────
  async function _acceptCall() {
    clearTimeout(autoRejectTimer);
    showIncoming(false);
    injectUI();
    populateOverlay();
    showOverlay(true);

    try {
      localStream = await getMedia(callType);
    } catch (err) {
      socket.emit('call:reject', { to: remoteUserId, reason: 'media_error' });
      cleanup();
      if (typeof showToast === 'function') showToast('Camera/mic access denied', 'error');
      return;
    }

    const lv = document.getElementById('wrtc-local-video');
    if (lv) {
      lv.srcObject = localStream;
      lv.style.display = callType === 'video' ? 'block' : 'none';
    }

    createPC();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call:answer', { to: remoteUserId, answer });
    } catch (err) {
      socket.emit('call:reject', { to: remoteUserId, reason: 'media_error' });
      cleanup();
    }
  }

  function _rejectCall() {
    clearTimeout(autoRejectTimer);
    showIncoming(false);
    if (socket && remoteUserId) socket.emit('call:reject', { to: remoteUserId, reason: 'declined' });
    cleanup();
  }

  // ─── Controls ─────────────────────────────────────────────────────────────
  function toggleMic() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    const btn = document.getElementById('wrtc-btn-mic');
    if (!btn) return;
    btn.classList.toggle('active', isMuted);
    btn.textContent = isMuted ? '🔇' : '🎙️';
  }

  function toggleCam() {
    if (!localStream || callType === 'audio') return;
    isCamOff = !isCamOff;
    localStream.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
    const btn = document.getElementById('wrtc-btn-cam');
    if (btn) { btn.classList.toggle('active', isCamOff); btn.textContent = isCamOff ? '🚫' : '📹'; }
    const lv = document.getElementById('wrtc-local-video');
    if (lv) lv.style.display = isCamOff ? 'none' : 'block';
  }

  function endCall() {
    if (socket && remoteUserId) socket.emit('call:end', { to: remoteUserId });
    cleanup();
    if (typeof showToast === 'function') showToast('Call ended', '');
  }

  function cleanup() {
    stopTimer();
    clearTimeout(autoRejectTimer);
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (pc) { pc.close(); pc = null; }
    const lv = document.getElementById('wrtc-local-video');
    if (lv) { lv.srcObject = null; lv.style.display = 'none'; }
    const rv = document.getElementById('wrtc-remote-video');
    if (rv) { rv.srcObject = null; rv.style.display = 'none'; }
    showOverlay(false);
    showIncoming(false);

    const timer = document.getElementById('wrtc-timer');
    if (timer) timer.style.display = 'none';

    remoteUserId = null;
    isCaller     = false;
    isMuted      = false;
    isCamOff     = false;
    pendingOffer = null;

    const micBtn = document.getElementById('wrtc-btn-mic');
    if (micBtn) { micBtn.classList.remove('active'); micBtn.textContent = '🎙️'; }
    const camBtn = document.getElementById('wrtc-btn-cam');
    if (camBtn) { camBtn.classList.remove('active'); camBtn.textContent = '📹'; }
  }

  // ─── Socket Signaling ─────────────────────────────────────────────────────
  function init(sock, user) {
    socket    = sock;
    localUser = user;
    injectUI();

    socket.on('call:incoming', ({ from, fromName, offer, callType: ct }) => {
      if (pc) {
        socket.emit('call:reject', { to: from, reason: 'busy' });
        return;
      }
      remoteUserId = Number(from);
      remoteName   = fromName || 'Unknown';
      remoteAvatar = '👤';
      callType     = ct || 'video';
      isCaller     = false;
      pendingOffer = offer;

      const incAvatar = document.getElementById('wrtc-inc-avatar');
      const incName   = document.getElementById('wrtc-inc-name');
      const incType   = document.getElementById('wrtc-inc-type');
      if (incAvatar) incAvatar.textContent = remoteAvatar;
      if (incName)   incName.textContent   = fromName;
      if (incType)   incType.textContent   = ct === 'audio' ? '📞 Audio Call' : '📹 Video Call';
      showIncoming(true);

      autoRejectTimer = setTimeout(() => {
        if (document.getElementById('wrtc-incoming')?.style.display !== 'none') {
          _rejectCall();
        }
      }, 35000);
    });

    socket.on('call:answered', ({ answer }) => {
      if (!pc) return;
      pc.setRemoteDescription(new RTCSessionDescription(answer)).then(() => {
        setBarStatus('Ringing…');
      }).catch(() => {});
    });

    socket.on('call:ice-candidate', ({ candidate }) => {
      if (!pc || !candidate) return;
      pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    });

    socket.on('call:rejected', ({ reason }) => {
      cleanup();
      const msgs = {
        declined:    'Call declined',
        busy:        'User is busy in another call',
        media_error: 'Other party could not access their camera/mic',
      };
      if (typeof showToast === 'function') showToast(msgs[reason] || 'Call was not answered', 'error');
    });

    socket.on('call:ended', () => {
      cleanup();
      if (typeof showToast === 'function') showToast('Call ended by other party', '');
    });

    socket.on('call:unavailable', () => {
      cleanup();
      if (typeof showToast === 'function') showToast('User is offline — call unavailable', 'error');
    });
  }

  return { init, start, endCall, toggleMic, toggleCam, _acceptCall, _rejectCall };
})();
