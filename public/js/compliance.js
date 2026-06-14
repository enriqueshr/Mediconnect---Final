/**
 * MediConnect Compliance Module
 * - HIPAA-required automatic session timeout (§164.312(a)(2)(iii))
 * - GDPR/CCPA cookie consent (Art. 6, Art. 7)
 * - GDPR data controls (export, erasure)
 * - Secure logout with token revocation
 */
(function() {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────────────────────
  const WARN_IDLE_MS   = 14 * 60 * 1000; // 14 minutes
  const LOGOUT_IDLE_MS = 15 * 60 * 1000; // 15 minutes (HIPAA recommendation)
  const CHECK_INTERVAL = 20 * 1000;       // check every 20 seconds

  let lastActivity     = Date.now();
  let warnShown        = false;
  let checkTimer       = null;
  let countdownTimer   = null;

  // ─── Session Timeout ────────────────────────────────────────────────────────
  const SessionTimeout = {
    init() {
      const token = localStorage.getItem('mc_token');
      if (!token) return; // Not logged in, nothing to do

      ['mousedown','mousemove','keydown','scroll','touchstart','click'].forEach(e => {
        document.addEventListener(e, () => this.resetActivity(), { passive: true });
      });

      checkTimer = setInterval(() => this.check(), CHECK_INTERVAL);
    },

    resetActivity() {
      lastActivity = Date.now();
      if (warnShown) {
        warnShown = false;
        clearInterval(countdownTimer);
        document.getElementById('mc-session-warning')?.remove();
      }
    },

    check() {
      if (!localStorage.getItem('mc_token')) {
        clearInterval(checkTimer);
        return;
      }
      const idleMs = Date.now() - lastActivity;
      if (idleMs >= LOGOUT_IDLE_MS) {
        this.forceLogout('Session expired due to inactivity.');
      } else if (idleMs >= WARN_IDLE_MS && !warnShown) {
        this.showWarning();
      }
    },

    showWarning() {
      warnShown = true;
      let secsLeft = Math.ceil((LOGOUT_IDLE_MS - (Date.now() - lastActivity)) / 1000);

      const overlay = document.createElement('div');
      overlay.id    = 'mc-session-warning';
      overlay.style.cssText = `
        position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);
        z-index:99999;display:flex;align-items:center;justify-content:center;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      `;
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;padding:32px 40px;max-width:420px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);">
          <div style="font-size:40px;margin-bottom:12px;">⏱️</div>
          <h3 style="margin:0 0 8px;color:#111827;font-size:20px;">Session Expiring Soon</h3>
          <p style="color:#6b7280;margin:0 0 20px;line-height:1.5;">
            For your security, you will be automatically logged out due to inactivity in
            <strong id="mc-countdown" style="color:#dc2626;">${secsLeft}s</strong>.
          </p>
          <p style="color:#9ca3af;font-size:12px;margin:0 0 20px;">
            HIPAA requires automatic logoff after periods of inactivity.
          </p>
          <div style="display:flex;gap:12px;justify-content:center;">
            <button id="mc-stay-btn" style="background:#0d9488;color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:15px;font-weight:600;">
              Stay Logged In
            </button>
            <button id="mc-logout-btn" style="background:#f3f4f6;color:#374151;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:15px;">
              Log Out Now
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      document.getElementById('mc-stay-btn').addEventListener('click', () => {
        this.resetActivity();
      });
      document.getElementById('mc-logout-btn').addEventListener('click', () => {
        this.forceLogout('You have been logged out.');
      });

      countdownTimer = setInterval(() => {
        secsLeft = Math.max(0, Math.ceil((LOGOUT_IDLE_MS - (Date.now() - lastActivity)) / 1000));
        const el = document.getElementById('mc-countdown');
        if (el) el.textContent = `${secsLeft}s`;
        if (secsLeft <= 0) clearInterval(countdownTimer);
      }, 1000);
    },

    async forceLogout(reason) {
      clearInterval(checkTimer);
      clearInterval(countdownTimer);

      // Revoke refresh token on server
      try {
        const refresh = localStorage.getItem('mc_refresh_token');
        const token   = localStorage.getItem('mc_token');
        if (token) {
          await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ refresh_token: refresh }),
          });
        }
      } catch {}

      localStorage.removeItem('mc_token');
      localStorage.removeItem('mc_refresh_token');
      localStorage.removeItem('mc_user');
      sessionStorage.clear();

      const base  = window.location.pathname.includes('admin')  ? '/admin.html'
                  : window.location.pathname.includes('doctor') ? '/doctor.html'
                  : '/';
      window.location.href = base + '?session_expired=1&reason=' + encodeURIComponent(reason);
    },
  };

  // ─── Cookie / Consent Banner ────────────────────────────────────────────────
  const CookieConsent = {
    KEY: 'mc_consent_v1',

    hasDecided() {
      return localStorage.getItem(this.KEY) !== null;
    },

    init() {
      if (this.hasDecided()) return;
      this.showBanner();
    },

    showBanner() {
      const banner = document.createElement('div');
      banner.id    = 'mc-cookie-banner';
      banner.style.cssText = `
        position:fixed;bottom:0;left:0;right:0;background:#1f2937;color:#f9fafb;
        padding:16px 24px;z-index:9999;display:flex;flex-wrap:wrap;align-items:center;
        gap:12px;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        font-size:14px;box-shadow:0 -4px 20px rgba(0,0,0,.3);
      `;
      banner.innerHTML = `
        <div style="flex:1;min-width:280px;line-height:1.5;">
          🍪 We use essential cookies and store encrypted health data to provide our services.
          By using MediConnect you agree to our
          <a href="/privacy.html" style="color:#5eead4;text-decoration:underline;">Privacy Policy</a> and
          <a href="/terms.html" style="color:#5eead4;text-decoration:underline;">Terms of Service</a>.
          Your data is processed in compliance with <strong>HIPAA</strong>, <strong>GDPR</strong>, and <strong>CCPA</strong>.
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button id="mc-consent-deny" style="background:#374151;color:#d1d5db;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;">
            Essential Only
          </button>
          <button id="mc-consent-accept" style="background:#0d9488;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">
            Accept All
          </button>
        </div>
      `;

      document.body.appendChild(banner);

      document.getElementById('mc-consent-accept').addEventListener('click', () => this.grant('all'));
      document.getElementById('mc-consent-deny').addEventListener('click', () => this.grant('essential'));
    },

    grant(level) {
      localStorage.setItem(this.KEY, JSON.stringify({ level, ts: new Date().toISOString() }));
      document.getElementById('mc-cookie-banner')?.remove();

      const token = localStorage.getItem('mc_token');
      if (token) {
        fetch('/api/gdpr/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ consent_type: level === 'all' ? 'analytics' : 'essential_only', granted: true }),
        }).catch(() => {});
      }
    },
  };

  // ─── Session Expired Notice ──────────────────────────────────────────────────
  function checkSessionExpiredParam() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('session_expired')) return;

    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed;top:20px;left:50%;transform:translateX(-50%);
      background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;
      z-index:99999;font-family:-apple-system,sans-serif;font-size:14px;
      box-shadow:0 4px 12px rgba(0,0,0,.2);
    `;
    toast.textContent = params.get('reason') || 'Your session has expired. Please log in again.';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);

    // Clean URL
    const url = new URL(window.location);
    url.searchParams.delete('session_expired');
    url.searchParams.delete('reason');
    window.history.replaceState({}, '', url);
  }

  // ─── GDPR Controls ──────────────────────────────────────────────────────────
  window.MediCompliance = {
    async exportData() {
      const token = localStorage.getItem('mc_token');
      if (!token) return alert('Please log in first.');
      try {
        const res  = await fetch('/api/gdpr/export', { headers: { 'Authorization': `Bearer ${token}` } });
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `mediconnect-data-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch { alert('Export failed. Try again.'); }
    },

    async requestErasure() {
      if (!confirm(
        'This will anonymise all your personal data. Medical records are retained in de-identified form as required by law.\n\nType "DELETE MY ACCOUNT" to confirm, or Cancel.'
      )) return;
      const confirm2 = prompt('Type exactly: DELETE MY ACCOUNT');
      if (confirm2 !== 'DELETE MY ACCOUNT') return alert('Confirmation did not match.');

      const token = localStorage.getItem('mc_token');
      try {
        const res = await fetch('/api/gdpr/me', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ confirm: 'DELETE MY ACCOUNT' }),
        });
        const data = await res.json();
        if (res.ok) {
          alert(data.message + '\n\nReference: ' + data.reference);
          localStorage.clear();
          window.location.href = '/';
        } else {
          alert('Error: ' + data.error);
        }
      } catch { alert('Request failed. Contact dpo@mediconnect.com'); }
    },
  };

  // ─── Init ────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    checkSessionExpiredParam();
    CookieConsent.init();
    SessionTimeout.init();
  });

})();
