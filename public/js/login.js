/* login.js — handles the login form */
'use strict';

(function () {
  // Redirect to home if already logged in
  if (localStorage.getItem('ma_token')) {
    location.replace('/');
    return;
  }

  const form = document.getElementById('login-form');
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');
  const usernameGroup = document.getElementById('username-group');
  const passwordGroup = document.getElementById('password-group');
  const twofaPanel = document.getElementById('twofa-panel');
  const twofaSetup = document.getElementById('twofa-setup');
  const twofaPanelTitle = document.getElementById('twofa-panel-title');
  const twofaPanelCopy = document.getElementById('twofa-panel-copy');
  const twofaSecret = document.getElementById('twofa-secret');
  const twofaUri = document.getElementById('twofa-uri');
  const twofaCodeInput = document.getElementById('twofa-code');
  const credentialsSection = document.getElementById('credentials-section');
  const introEl = document.getElementById('login-intro');
  const introRainEl = document.getElementById('login-intro-rain');
  const introStatusEl = document.getElementById('login-intro-status-text');
  const loginBox = document.getElementById('login-box');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pendingChallengeId = null;
  let pendingSetupMode = false;

  function setButtonLabel(text) {
    const label = btn.querySelector('span');
    if (label) {
      label.textContent = text;
    } else {
      btn.textContent = text;
    }
  }

  function showError(message) {
    errorEl.textContent = message;
    if (loginBox) {
      loginBox.classList.remove('shake');
      void loginBox.offsetWidth;
      loginBox.classList.add('shake');
    }
  }

  function showTwofaStep(data) {
    pendingChallengeId = data.challenge_id;
    pendingSetupMode = Boolean(data.requires_2fa_setup);

    if (credentialsSection) {
      credentialsSection.style.display = 'none';
    } else {
      usernameGroup.style.display = 'none';
      passwordGroup.style.display = 'none';
    }
    twofaPanel.style.display = 'block';
    twofaPanel.classList.remove('is-visible');
    requestAnimationFrame(() => twofaPanel.classList.add('is-visible'));
    twofaCodeInput.value = '';
    twofaCodeInput.focus();

    if (pendingSetupMode) {
      twofaPanelTitle.textContent = 'Mandatory 2FA setup required';
      twofaPanelCopy.textContent = 'Add this account to your authenticator app, then enter the 6-digit code to complete sign-in.';
      twofaSetup.style.display = 'block';
      twofaSecret.textContent = data.secret || '';
      twofaUri.textContent = data.otpauth_url || '';
      const qrImg = document.getElementById('twofa-qr');
      const qrWrap = document.getElementById('twofa-qr-wrap');
      if (qrImg && qrWrap && data.qr_data_url) {
        qrImg.src = data.qr_data_url;
        qrWrap.style.display = 'flex';
      }
    } else {
      twofaPanelTitle.textContent = 'Enter your authenticator code';
      twofaPanelCopy.textContent = 'Use your 2FA app to generate a 6-digit code.';
      twofaSetup.style.display = 'none';
      twofaSecret.textContent = '';
      twofaUri.textContent = '';
    }

    btn.disabled = false;
    setButtonLabel('Verify Code');
  }

  async function verifyTwofaCode() {
    const code = twofaCodeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showError('Enter a valid 6-digit 2FA code.');
      btn.disabled = false;
      setButtonLabel('Verify Code');
      return;
    }

    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge_id: pendingChallengeId, code }),
      });
      const data = await res.json();

      if (!res.ok) {
        showError(data.error || '2FA verification failed.');
        btn.disabled = false;
        setButtonLabel('Verify Code');
        return;
      }

      localStorage.setItem('ma_token', data.token);
      localStorage.setItem('ma_user', JSON.stringify(data.user));
      location.replace('/');
    } catch {
      showError('Network error. Please try again.');
      btn.disabled = false;
      setButtonLabel('Verify Code');
    }
  }

  function seedVaultRain() {
    if (!introRainEl) return;
    const glyphs = ['0', '1', 'A', 'C', 'D', 'E', 'F', '7', '9', 'X', 'K', 'M', 'T', 'V', 'S', 'L'];
    const viewportWidth = window.innerWidth || 1280;
    const streamCount = prefersReducedMotion
      ? 14
      : Math.max(42, Math.floor(viewportWidth / 26));

    introRainEl.innerHTML = Array.from({ length: streamCount }, (_, index) => {
      const startX = Math.random() * 100;
      const length = 18 + Math.floor(Math.random() * 24);
      const offset = Math.random() * 100;
      const stream = Array.from({ length }, () => glyphs[Math.floor(Math.random() * glyphs.length)]).join('<br />');
      const duration = 4.2 + Math.random() * 3.8;
      const delay = -(Math.random() * duration);
      const size = 0.58 + Math.random() * 0.34;
      const opacity = 0.14 + Math.random() * 0.58;
      const left = Math.max(0, Math.min(100, startX + (index % 2 === 0 ? -2 : 2)));
      return `<div class="login-intro-stream" style="left:${left}vw; transform:translateY(${-40 - offset * 0.2}vh); --rain-duration:${duration}s; --rain-delay:${delay}s; font-size:${size}rem; opacity:${opacity};">${stream}</div>`;
    }).join('');
  }

  function revealLogin() {
    if (introEl) introEl.classList.add('is-hidden');
    if (loginBox) loginBox.classList.add('is-mounted');
    window.setTimeout(() => {
      if (introEl) introEl.style.display = 'none';
    }, 500);
  }

  seedVaultRain();
  if (prefersReducedMotion && introStatusEl) {
    introStatusEl.textContent = 'Secure channel established';
  }
  revealLogin();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    btn.disabled = true;
    setButtonLabel(pendingChallengeId ? 'Verifying…' : 'Signing In…');

    if (pendingChallengeId) {
      await verifyTwofaCode();
      return;
    }

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
      showError('Please enter username and password.');
      btn.disabled = false;
      setButtonLabel('Continue');
      return;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Login failed.');
        btn.disabled = false;
        setButtonLabel('Continue');
        return;
      }

      if (data.requires_2fa || data.requires_2fa_setup) {
        showTwofaStep(data);
        return;
      }

      localStorage.setItem('ma_token', data.token);
      localStorage.setItem('ma_user', JSON.stringify(data.user));
      location.replace('/');
    } catch {
      showError('Network error. Please try again.');
      btn.disabled = false;
      setButtonLabel('Continue');
    }
  });
})();
