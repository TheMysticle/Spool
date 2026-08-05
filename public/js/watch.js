// Utility to get a human-readable resolution label from height
function getResolutionLabel(height) {
  if (!height) return 'HD';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  return `${height}p`;
}


// Utility to parse timestamps (e.g. "1:30", "1:05:20") into seconds
function parseTimestamp(tsStr) {
  const parts = tsStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// Utility to find timestamps in text and wrap them in clickable spans
function linkifyTimestamps(text) {
  if (!text) return text;
  const regex = /\b(?:[0-9]+:)?[0-5]?[0-9]:[0-5][0-9]\b/g;
  return text.replace(regex, (match) => {
    const seconds = parseTimestamp(match);
    return `<a class="timestamp-link" data-time="${seconds}">${match}</a>`;
  });
}

// Utility to // parseChapters removed, reading from database schema instead

/* watch.js — video player page */
'use strict';

(function () {
  const params = new URLSearchParams(location.search);
  const shareToken = params.get('share_token');

  if (!shareToken) {
    if (!requireAuth()) return;
  }

  function getAuthQueryString() {
    const token = getToken();
    let q = `token=${encodeURIComponent(token || '')}`;
    if (shareToken) {
      q += `&share_token=${encodeURIComponent(shareToken)}`;
    }
    return q;
  }

  function promptLogin() {
    if (confirm('You must be signed in to do this. Go to login?')) {
      window.location.href = '/login.html';
    }
  }

  let videoId = parseInt(params.get('id'), 10);
  let internalWatchStack = [];
  const seriesIdParam = parseInt(params.get('series'), 10);
  const seriesId = Number.isInteger(seriesIdParam) && seriesIdParam > 0 ? seriesIdParam : null;
  const personIdParam = parseInt(params.get('person'), 10);
  const personId = Number.isInteger(personIdParam) && personIdParam > 0 ? personIdParam : null;
  const personName = (params.get('person_name') || '').trim();
  const BROWSE_STATE_KEY = 'ma_browse_state';
  const currentUser = getUser();

  if (!videoId || isNaN(videoId)) {
    location.replace('/');
    return;
  }

  // ── Initialize force-direct as default ─────────────────────────────────────
  const FORCE_DIRECT_PLAY_KEY = 'forceDirectPlay';
  const FORCE_DIRECT_DROPDOWN_ID = 'force-direct-dropdown-toggle';
  if (!localStorage.getItem(FORCE_DIRECT_PLAY_KEY)) {
    localStorage.setItem(FORCE_DIRECT_PLAY_KEY, '1'); // Default to ON
  }

  const AUTOPLAY_KEY = 'ma_watch_autoplay';
  if (!localStorage.getItem(AUTOPLAY_KEY)) {
    localStorage.setItem(AUTOPLAY_KEY, '1'); // Default to ON
  }

  // ── Bootstrap header — avatar/dropdown/logout handled by shared.js ─────────
  // (admin-only debug bar still wired here)
  if (isAdmin()) {
    const debugBar = document.getElementById('debug-bar');
    if (debugBar) debugBar.style.display = '';
  }

  // Setup debug panel listeners immediately for admins
  if (isAdmin()) setupDebugPanel();

  function goToBrowse({ category = 'all', mode = 'browse', search, personId = null, personName = '' } = {}) {
    let state = {
      category: 'all',
      search: '',
      sort: 'name_asc',
      page: 1,
      mode: 'browse',
      personId: null,
      personName: '',
      seriesId: null,
      seriesName: '',
    };
    try {
      const saved = JSON.parse(localStorage.getItem(BROWSE_STATE_KEY) || '{}');
      state = {
        ...state,
        ...saved,
        category,
        mode,
        ...(typeof search === 'string' ? { search } : {}),
        ...(Number.isInteger(Number(personId)) && Number(personId) > 0 ? { personId: Number(personId), personName: String(personName || '') } : { personId: null, personName: '' }),
        seriesId: null,
        seriesName: '',
        page: 1,
      };
    } catch {
      state.category = category;
      state.mode = mode;
      if (typeof search === 'string') state.search = search;
      if (Number.isInteger(Number(personId)) && Number(personId) > 0) {
        state.personId = Number(personId);
        state.personName = String(personName || '');
      } else {
        state.personId = null;
        state.personName = '';
      }
      state.seriesId = null;
      state.seriesName = '';
      state.page = 1;
    }
    localStorage.setItem(BROWSE_STATE_KEY, JSON.stringify(state));
    location.href = '/';
  }

  // Watch page sidebar navigation (matching main page structure)
  document.querySelectorAll('.nav-item[data-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const category = btn.getAttribute('data-category');
      goToBrowse({ category, mode: 'browse' });
    });
  });

  document.getElementById('people-btn')?.addEventListener('click', () => {
    goToBrowse({ mode: 'people' });
  });

  document.getElementById('channels-btn')?.addEventListener('click', () => {
    goToBrowse({ mode: 'channels' });
  });

  document.getElementById('series-btn')?.addEventListener('click', () => {
    goToBrowse({ mode: 'series' });
  });

  document.getElementById('history-btn')?.addEventListener('click', () => {
    goToBrowse({ mode: 'history' });
  });

  document.getElementById('favorites-btn')?.addEventListener('click', () => {
    goToBrowse({ mode: 'favorites' });
  });

  const watchSearchInput = document.getElementById('search-input');
  const watchSearchClear = document.getElementById('search-clear-btn');

  function updateWatchSearchClear() {
    if (!watchSearchInput || !watchSearchClear) return;
    watchSearchClear.classList.toggle('show', Boolean(watchSearchInput.value.trim()));
  }

  function submitWatchSearch() {
    if (!watchSearchInput) return;
    const term = watchSearchInput.value.trim();
    if (!term) return;
    goToBrowse({ category: 'all', mode: 'browse', search: term });
  }

  watchSearchInput?.addEventListener('input', updateWatchSearchClear);
  watchSearchInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitWatchSearch();
  });

  watchSearchClear?.addEventListener('click', () => {
    if (!watchSearchInput) return;
    watchSearchInput.value = '';
    updateWatchSearchClear();
    watchSearchInput.focus();
  });

  updateWatchSearchClear();

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Video.js player ────────────────────────────────────────────────────────
  let player;
  let currentVideo = null;
  let currentChapters = null;
  let favoriteIds = new Set();
  let currentQuality = '1080p';
  let availableQualities = [];
  let isTranscoding = false;
  let lastSavedTime = 0;
  let upNextQueue = [];
  let autoplayCountdownInterval = null;
  let autoplayCountdownSecondsLeft = 0;
  let autoplayContext = { type: null, label: '' };
  const transcodeExts = new Set(['avi', 'mov', 'flv', 'ts']);
  // Set to true between first and second tap so the overlay is never woken up
  // during a potential double-tap gesture (cleared when the window expires or
  // the double-tap fires).
  let isDoubleTapWindow = false;
  // Set to true for 400ms after the user taps deadspace to dismiss the overlay,
  // so the single-tap timer and mousedown handler don't re-wake it.
  let isDismissing = false;

  function isAutoplayEnabled() {
    return localStorage.getItem(AUTOPLAY_KEY) !== '0';
  }

  function setAutoplayEnabled(enabled) {
    localStorage.setItem(AUTOPLAY_KEY, enabled ? '1' : '0');
  }

  function syncAutoplayToggleUi() {
    const toggle = document.getElementById('autoplay-toggle');
    if (!toggle) return;
    toggle.checked = isAutoplayEnabled();
  }

  function bindAutoplayToggle() {
    const toggle = document.getElementById('autoplay-toggle');
    if (!toggle || toggle.dataset.boundAutoplay === '1') return;

    toggle.dataset.boundAutoplay = '1';
    toggle.checked = isAutoplayEnabled();
    toggle.addEventListener('change', (event) => {
      const enabled = Boolean(event.target.checked);
      setAutoplayEnabled(enabled);
      if (!enabled) clearAutoplayCountdown();
      else if (player && player.ended()) maybeStartAutoplayCountdown();
    });
  }

  function clearAutoplayCountdown() {
    if (autoplayCountdownInterval) {
      clearInterval(autoplayCountdownInterval);
      autoplayCountdownInterval = null;
    }
    autoplayCountdownSecondsLeft = 0;
    const overlay = document.getElementById('autoplay-countdown-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  function nextVideoUrl(nextVideoId) {
    if (seriesId) return `/watch.html?id=${nextVideoId}&series=${seriesId}`;
    if (personId) {
      const nameQuery = personName ? `&person_name=${encodeURIComponent(personName)}` : '';
      return `/watch.html?id=${nextVideoId}&person=${personId}${nameQuery}`;
    }
    return `/watch.html?id=${nextVideoId}`;
  }

  function updateNavigationButtons() {
    const prevBtn = document.getElementById('ui-prev');
    if (!prevBtn) return;

    if (internalWatchStack.length > 0) {
      prevBtn.disabled = false;
      prevBtn.style.opacity = "1";
      prevBtn.style.pointerEvents = "auto";
    } else {
      prevBtn.disabled = true;
      prevBtn.style.opacity = "0.3";
      prevBtn.style.pointerEvents = "none";
    }
  }

  function normalizeVideoList(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.videos)) return payload.videos;
    return [];
  }

  function buildUpNextOrder(videos) {
    const list = normalizeVideoList(videos);
    const currentIndex = list.findIndex((v) => Number(v.id) === Number(videoId));
    if (currentIndex < 0) return list;
    return [...list.slice(currentIndex + 1), ...list.slice(0, currentIndex)];
  }

  function ensureAutoplayOverlay(next) {
    if (!player) return null;
    const container = player.el();

    let overlay = document.getElementById('autoplay-countdown-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'autoplay-countdown-overlay';
      overlay.className = 'autoplay-countdown-overlay';
      container.appendChild(overlay);
    } else if (overlay.parentElement !== container) {
      container.appendChild(overlay);
    }

    const token = getToken();
    const thumbUrl = next.thumbnail_path
      ? `/api/videos/${next.id}/thumbnail?${getAuthQueryString()}${next.updated_at ? `&t=${encodeURIComponent(next.updated_at)}` : ''}`
      : '';

    overlay.innerHTML = `
      <div class="autoplay-modern-card">
        <div class="autoplay-modern-thumb">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="Up Next" />` : `<div class="autoplay-thumb-placeholder">▶</div>`}
          <div class="autoplay-modern-progress-track">
            <div class="autoplay-modern-progress-bar" id="autoplay-progress-bar"></div>
          </div>
        </div>
        <div class="autoplay-modern-info">
          <p class="autoplay-modern-kicker">Up next in <span id="autoplay-countdown-value">10</span>s</p>
          <p class="autoplay-modern-title">${escHtml(next.title || 'Next video')}</p>
          <div class="autoplay-modern-actions">
            <button class="btn btn-ghost" id="autoplay-cancel" type="button">Cancel</button>
            <button class="btn btn-primary" id="autoplay-play-now" type="button">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Play Now
            </button>
          </div>
        </div>
      </div>
    `;

    overlay.querySelector('#autoplay-cancel')?.addEventListener('click', () => {
      clearAutoplayCountdown();
    });
    overlay.querySelector('#autoplay-play-now')?.addEventListener('click', () => {
      clearAutoplayCountdown();
      navigateToVideo(next.id); // SPA Navigation
    });

    return overlay;
  }

  function maybeStartAutoplayCountdown() {
    clearAutoplayCountdown();

    if (!isAutoplayEnabled()) return;
    const next = upNextQueue[0];
    if (!next) return;

    const overlay = ensureAutoplayOverlay(next);
    if (!overlay) return;

    const valueEl = document.getElementById('autoplay-countdown-value');
    const barEl = document.getElementById('autoplay-progress-bar');

    const totalSeconds = 10;
    const startedAt = Date.now();
    autoplayCountdownSecondsLeft = totalSeconds;

    if (player) player.userActive(false);

    overlay.classList.add('show');

    autoplayCountdownInterval = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const remaining = Math.max(0, totalSeconds - elapsed);
      autoplayCountdownSecondsLeft = remaining;
      const whole = Math.ceil(remaining);
      const pct = Math.max(0, (remaining / totalSeconds) * 100);

      if (valueEl) valueEl.textContent = String(whole);
      if (barEl) barEl.style.width = `${pct}%`;

      if (remaining <= 0) {
        clearAutoplayCountdown();
        // SPA Navigation to next video
        navigateToVideo(next.id);
      }
    }, 100);
  }

  function isForceDirectPlay() {
    // Viewers are always locked to direct play to avoid unnecessary transcode load.
    if (!isAdmin()) return true;
    return localStorage.getItem(FORCE_DIRECT_PLAY_KEY) === '1';
  }

  function setForceDirectPlay(enabled) {
    if (!isAdmin()) return;
    localStorage.setItem(FORCE_DIRECT_PLAY_KEY, enabled ? '1' : '0');
  }

  function ensureForceDirectDropdownItem() {
    const dropdown = document.getElementById('user-dropdown');
    if (!dropdown) return null;

    const existing = document.getElementById(FORCE_DIRECT_DROPDOWN_ID);
    if (existing) return existing;

    const logoutBtn = document.getElementById('logout-btn');
    if (!logoutBtn) return null;

    const item = document.createElement('button');
    item.id = FORCE_DIRECT_DROPDOWN_ID;
    item.type = 'button';
    item.className = 'dropdown-item';
    dropdown.insertBefore(item, logoutBtn);
    return item;
  }

  function applyForceDirectToggle() {
    const enabled = !isForceDirectPlay();
    setForceDirectPlay(enabled);
    updateForceDirectToggleUi();

    const dropdown = document.getElementById('user-dropdown');
    const trigger = document.getElementById('user-menu-trigger');
    if (dropdown) dropdown.classList.remove('show');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');

    if (!currentVideo) return;

    const currentTime = player ? player.currentTime() : 0;
    const wasPaused = player ? player.paused() : true;

    initPlayer(currentVideo, { autoStart: false });
    player.one('loadedmetadata', () => {
      player.currentTime(currentTime);
      if (!wasPaused) player.play();
    });

    toast(enabled ? 'Using native file playback (faster).' : 'Always transcoding videos (compatibility).');
  }

  function updateForceDirectToggleUi() {
    const btn = document.getElementById('force-direct-toggle');
    const menuItem = document.getElementById(FORCE_DIRECT_DROPDOWN_ID);

    if (!isAdmin()) {
      if (btn) btn.style.display = 'none';
      if (menuItem) menuItem.style.display = 'none';
      return;
    }

    if (btn) btn.style.display = 'none';

    const enabled = isForceDirectPlay();
    if (menuItem) {
      menuItem.style.display = '';
      menuItem.textContent = `Direct Play: ${enabled ? 'On' : 'Off'}`;
    }
  }

  function setupForceDirectToggle() {
    const btn = document.getElementById('force-direct-toggle');
    const menuItem = ensureForceDirectDropdownItem();
    if (!btn && !menuItem) return;

    if (!isAdmin()) {
      if (btn) btn.style.display = 'none';
      if (menuItem) menuItem.style.display = 'none';
      return;
    }

    updateForceDirectToggleUi();

    if (btn && !btn.dataset.boundForceDirect) {
      btn.dataset.boundForceDirect = '1';
      btn.addEventListener('click', applyForceDirectToggle);
    }

    if (menuItem && !menuItem.dataset.boundForceDirect) {
      menuItem.dataset.boundForceDirect = '1';
      menuItem.addEventListener('click', applyForceDirectToggle);
    }
  }

  function buildTranscodeSrc(quality, idOverride) {
    const token = getToken();
    const params = new URLSearchParams({
      transcode: '1',
      quality,
      token: token || '',
      t: String(Date.now()),
    });
    // Use override if provided (for navigation race safety)
    const id = typeof idOverride !== 'undefined' ? idOverride : videoId;
    return `/api/videos/${id}/stream?${params.toString()}`;
  }

  function showTranscodingBar() {
    isTranscoding = true;
    const bar = document.getElementById('transcoding-bar');
    if (bar) {
      bar.style.display = 'block';
      bar.querySelector('.transcoding-message')?.classList.add('animate');
    }
  }

  function hideTranscodingBar() {
    isTranscoding = false;
    const bar = document.getElementById('transcoding-bar');
    if (bar) {
      bar.style.display = 'none';
      bar.querySelector('.transcoding-message')?.classList.remove('animate');
    }
  }

  // ── Debug panel (admin only) ───────────────────────────────────────────────
  let debugEnabled = false;
  const DEBUG_MAX_ENTRIES = 300;

  function dbg(level, msg) {
    if (!debugEnabled) return;
    const log = document.getElementById('debug-log');
    if (!log) return;

    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;

    const levelLabels = { info: 'INFO', event: 'EVENT', net: 'NET', ok: 'OK', warn: 'WARN', error: 'ERROR' };

    const entry = document.createElement('div');
    entry.className = `debug-entry lvl-${level}`;
    entry.innerHTML = `<span class="debug-ts">${ts}</span><span class="debug-level">${levelLabels[level] || level}</span><span class="debug-msg">${escHtml(String(msg))}</span>`;
    log.appendChild(entry);

    // Trim old entries to keep memory bounded
    while (log.children.length > DEBUG_MAX_ENTRIES) {
      log.removeChild(log.firstChild);
    }

    // Auto-scroll to bottom
    log.scrollTop = log.scrollHeight;
  }

  function debugUpdateMeta(videoData, srcUrl, mimeType) {
    const meta = document.getElementById('debug-meta');
    if (!meta) return;
    const ext = (videoData.filename || '').split('.').pop().toLowerCase();
    meta.innerHTML = [
      `<strong>File:</strong> ${escHtml(videoData.filename || '—')}`,
      `<strong>Ext:</strong> ${ext} &nbsp; <strong>Size:</strong> ${videoData.file_size ? formatFileSize(videoData.file_size) : '—'} &nbsp; <strong>Duration:</strong> ${videoData.duration ? formatDuration(videoData.duration) : '—'}`,
      `<strong>Codec:</strong> ${escHtml(videoData.video_codec || '—')} &nbsp; <strong>Height:</strong> ${videoData.video_height || '—'}px`,
      `<strong>Mode:</strong> ${isForceDirectPlay() ? 'Direct Play' : 'Always Transcode'} &nbsp; <strong>MIME:</strong> ${escHtml(mimeType)}`,
      `<strong>URL:</strong> ${escHtml(srcUrl)}`,
    ].join('<br>');
  }

  async function debugProbeStream(url) {
    dbg('net', `HEAD ${url}`);
    try {
      const res = await fetch(url, { method: 'HEAD', headers: { Authorization: `Bearer ${getToken()}` } });
      dbg(res.ok ? 'ok' : 'warn', `HTTP ${res.status} ${res.statusText}`);
      const interesting = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
      for (const h of interesting) {
        const v = res.headers.get(h);
        if (v) dbg('net', `  ${h}: ${v}`);
      }
      if (!res.ok) dbg('error', `Stream probe failed — server returned ${res.status}`);
    } catch (err) {
      dbg('error', `Probe error: ${err.message}`);
    }
  }

  function setupDebugPlayerHooks(videoData, srcUrl) {
    if (!player || !debugEnabled) return;

    // FIX: Only probe the stream, don't re-bind listeners if already bound to this player
    if (player.debugHooksBound) {
      debugProbeStream(srcUrl);
      return;
    }
    player.debugHooksBound = true;

    const EVENTS = [
      ['loadstart',      'event', 'loadstart — browser began loading source'],
      ['durationchange', 'event', () => `durationchange — duration: ${player.duration()?.toFixed(2)}s`],
      ['loadedmetadata', 'ok',    () => `loadedmetadata — ${player.videoWidth()}×${player.videoHeight()}, duration: ${player.duration()?.toFixed(2)}s`],
      ['loadeddata',     'ok',    'loadeddata — first frame data available'],
      ['canplay',        'ok',    'canplay — enough data to start playback'],
      ['canplaythrough', 'ok',    'canplaythrough — can play without buffering pauses'],
      ['playing',        'ok',    () => `playing — currentTime: ${player.currentTime()?.toFixed(2)}s`],
      ['pause',          'info',  () => `pause — currentTime: ${player.currentTime()?.toFixed(2)}s`],
      ['seeking',        'info',  () => `seeking → ${player.currentTime()?.toFixed(2)}s`],
      ['seeked',         'info',  () => `seeked — at ${player.currentTime()?.toFixed(2)}s`],
      ['waiting',        'warn',  () => `waiting/buffering — currentTime: ${player.currentTime()?.toFixed(2)}s, readyState: ${player.readyState()}`],
      ['stalled',        'warn',  () => `stalled — no data received, readyState: ${player.readyState()}`],
      ['suspend',        'info',  'suspend — browser suspended loading'],
      ['ended',          'ok',    'ended — playback finished'],
      ['progress',       'info',  () => { const b = player.buffered(); const end = b && b.length ? b.end(b.length - 1).toFixed(2) : '0'; return `progress — buffered to ${end}s`; }],
    ];

    for (const [event, level, msgOrFn] of EVENTS) {
      player.on(event, () => {
        const msg = typeof msgOrFn === 'function' ? msgOrFn() : msgOrFn;
        dbg(level, msg);
      });
    }

    player.on('error', () => {
      const err = player.error();
      if (!err) return;
      const CODES = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
      dbg('error', `Player error ${err.code} (${CODES[err.code] || 'UNKNOWN'}): ${err.message || '—'}`);
      if (err.code === 4) dbg('warn', 'Code 4: Browser cannot decode this format in direct-play mode.');
      if (err.code === 3) dbg('warn', 'Code 3: Decode failure — corrupt file or unsupported codec variant.');
      if (err.code === 2) dbg('warn', 'Code 2: Network error — check token, server response, or file accessibility.');
    });

    // Probe stream URL immediately on setup
    debugProbeStream(srcUrl);
  }

  function setupDebugPanel() {
    if (!isAdmin()) return;

    document.getElementById('debug-clear-btn')?.addEventListener('click', () => {
      const log = document.getElementById('debug-log');
      if (log) log.innerHTML = '';
      dbg('info', 'Log cleared');
    });

    document.getElementById('debug-copy-btn')?.addEventListener('click', () => {
      const log = document.getElementById('debug-log');
      if (!log) return;
      const text = Array.from(log.querySelectorAll('.debug-entry'))
        .map((e) => `${e.querySelector('.debug-ts').textContent} [${e.querySelector('.debug-level').textContent}] ${e.querySelector('.debug-msg').textContent}`)
        .join('\n');
      navigator.clipboard.writeText(text).then(() => toast('Debug log copied!')).catch(() => toast('Copy failed', 'error'));
    });

    document.getElementById('debug-probe-btn')?.addEventListener('click', () => {
      if (!player) { dbg('warn', 'No player active to probe'); return; }
      const src = player.currentSrc();
      if (!src) { dbg('warn', 'No source URL found on current player'); return; }
      debugProbeStream(src);
    });
  }

  window.toggleDebugPanel = function () {
    debugEnabled = !debugEnabled;
    const panel = document.getElementById('debug-panel');
    const upNext = document.getElementById('up-next-aside');
    panel?.classList.toggle('debug-visible', debugEnabled);
    if (upNext) upNext.style.display = debugEnabled ? 'none' : '';

    if (debugEnabled) {
      dbg('info', 'Debug panel opened');
      dbg('info', `Video ID: ${videoId}`);
      dbg('info', `Force Direct Play: ${isForceDirectPlay() ? 'ON' : 'OFF'}`);
      if (player && currentVideo) setupDebugPlayerHooks(currentVideo, player.currentSrc() || '—');
    }
  };

  function switchQuality(quality) {
    if (!player || quality === currentQuality) return;
    dbg('info', `Switching quality to: ${quality}`);
    currentQuality = quality;
    const currentTime = player.currentTime();
    const wasPaused = player.paused();
    showTranscodingBar();
    player.src({ src: buildTranscodeSrc(quality), type: 'video/mp4' });
    player.one('loadedmetadata', () => {
      player.currentTime(currentTime);
      if (!wasPaused) player.play();
      refreshQualityMenu();
    });
  }

  function refreshQualityMenu() {
    const menu = document.getElementById('vjs-quality-menu');
    if (!menu) return;
    menu.querySelectorAll('.vjs-quality-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.quality === currentQuality);
    });
    const label = document.getElementById('vjs-quality-label');
    if (label) label.textContent = currentQuality.toUpperCase();
  }

  // --- Track the global click closer for quality menu ---
  let qualityMenuCloser = null;
  function injectResolutionBadge(videoData) {
    const controlBar = player.controlBar.el();
    if (!controlBar) return;

    const existing = document.getElementById('vjs-quality-btn');
    if (existing) existing.remove();

    // Remove previous global click listener if present
    if (qualityMenuCloser) {
      document.removeEventListener('click', qualityMenuCloser);
      qualityMenuCloser = null;
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'vjs-quality-btn';
    wrapper.className = 'vjs-quality-btn vjs-control vjs-button';
    const fsBtn = controlBar.querySelector('.vjs-fullscreen-control');

    if (isTranscoding && availableQualities.length > 0) {
      wrapper.setAttribute('role', 'menubutton');
      wrapper.setAttribute('aria-haspopup', 'true');
      wrapper.classList.add('is-interactive');
      wrapper.innerHTML = `
        <span id=\"vjs-quality-label\" class=\"vjs-quality-label\">${currentQuality.toUpperCase()}</span>
        <div id=\"vjs-quality-menu\" class=\"vjs-quality-menu\" role=\"menu\">
          ${availableQualities.map((q) => `
            <button class=\"vjs-quality-item${q.label === currentQuality ? ' active' : ''}\"\n+                    data-quality=\"${q.label}\" role=\"menuitem\">${q.label.toUpperCase()}</button>
          `).join('')}
        </div>
      `;

      wrapper.addEventListener('click', (e) => {
        const btn = e.target.closest('.vjs-quality-item');
        if (btn) {
          switchQuality(btn.dataset.quality);
          wrapper.classList.remove('open');
        } else {
          wrapper.classList.toggle('open');
        }
        e.stopPropagation();
      });

      // Track and clean up the global click closer
      qualityMenuCloser = () => wrapper.classList.remove('open');
      document.addEventListener('click', qualityMenuCloser);
    } else {
      const label = getResolutionLabel(videoData.video_height);
      wrapper.innerHTML = `<span class=\"vjs-quality-label static-badge\">${label.toUpperCase()}</span>`;
      wrapper.setAttribute('title', 'Direct Play (Original Quality)');
      wrapper.style.cursor = 'default';
    }

    controlBar.insertBefore(wrapper, fsBtn || null);
  }

  // ...existing code...

  let overlayUiBound = false;


  function syncPlayPauseIcon() {
    if (!player) return;
    const iconPlay = document.getElementById('icon-play');
    const iconPause = document.getElementById('icon-pause');
    if (!iconPlay || !iconPause) return;
    const paused = player.paused();
    iconPlay.style.display = paused ? 'block' : 'none';
    iconPause.style.display = paused ? 'none' : 'block';
  }

  function setupVideoUiOverlay() {
    const container = document.getElementById('player-container');
    const overlay = document.getElementById('video-ui-overlay');
    const playPauseBtn = document.getElementById('ui-play-pause');
    const prevBtn = document.getElementById('ui-prev');
    const nextBtn = document.getElementById('ui-next');

    if (!container || !overlay || !playPauseBtn || !prevBtn || !nextBtn) return;
    
    // MOVE OVERLAY into player (this needs to happen every time source changes)
    if (player) {
      player.ready(() => {
        const vjsRoot = player.el();
        if (vjsRoot && overlay.parentElement !== vjsRoot) {
          vjsRoot.appendChild(overlay);
        }
      });

      // These are Video.js events (cleared automatically when player.dispose() is called)
      player.on('play', syncPlayPauseIcon);
      player.on('pause', syncPlayPauseIcon);
    }

    // --- LEAK PREVENTION ---
    // If we already bound listeners to the HTML buttons, don't do it again.
    if (overlayUiBound) {
      syncPlayPauseIcon();
      updateNavigationButtons();
      return; 
    }
    // -----------------------

    overlay.addEventListener('click', (event) => {
      const interactiveTarget = event.target?.closest?.(
        '#ui-play-pause, #ui-prev, #ui-next, .video-overlay-header, .vjs-control-bar, .autoplay-modern-card, .vjs-menu'
      );
      if (interactiveTarget) return;
      event.preventDefault();
      event.stopPropagation();
      
      const isMouse = Date.now() - (window.__lastPlayerTouchTime || 0) > 1000;
      if (isMouse) {
        if (!player) return;
        if (player.paused()) {
          player.play();
        } else {
          player.pause();
        }
        if (typeof player._wakeOverlay === 'function') player._wakeOverlay();
        return;
      }
      
      isDismissing = true;
      isDoubleTapWindow = true;
      if (player) player.userActive(false);
      setTimeout(() => {
        isDismissing = false;
        isDoubleTapWindow = false;
      }, 400);
    });

    playPauseBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!player) return;
      if (player.paused()) {
        player.play();
      } else {
        player.pause();
      }
      if (typeof player._wakeOverlay === 'function') player._wakeOverlay();
    });

    nextBtn.addEventListener('click', (e) => { 
      e.stopPropagation(); 
      if (upNextQueue[0]) {
        navigateToVideo(upNextQueue[0].id);
      }
    });

    prevBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      // FIX: Use browser back to keep history and URL in perfect sync.
      // This will trigger your 'popstate' listener which calls navigateToVideo.
      if (internalWatchStack.length > 0) {
        window.history.back();
      }
    });

    overlayUiBound = true;
    syncPlayPauseIcon();
    updateNavigationButtons();
  }


  function setupDoubleTapSeek() {
    if (!player) return;
    const playerEl = player.el();
    if (!playerEl) return;

    const SEEK_SECONDS = 5;
    const DOUBLE_TAP_MS = 200;
    const RIPPLE_DURATION_MS = 550; // matches CSS animation
    let lastTapAt = 0;
    let lastTapSide = '';
    let tapResetTimer = null;
    let suppressOverlayTimer = null;
    let mouseDownTimer = null;

    // ── Reparent skip zones out of the overlay so they're always renderable ──
    // They live inside #video-ui-overlay in the HTML, which fades to opacity:0.
    // We move them directly into the vjs root so they're independent.
    player.ready(() => {
      const vjsRoot = player.el();
      const skipLeft = document.getElementById('skip-left');
      const skipRight = document.getElementById('skip-right');
      const centerIcon = document.getElementById('center-action-icon');
      if (vjsRoot) {
        if (skipLeft && skipLeft.parentElement !== vjsRoot) vjsRoot.appendChild(skipLeft);
        if (skipRight && skipRight.parentElement !== vjsRoot) vjsRoot.appendChild(skipRight);
        if (centerIcon && centerIcon.parentElement !== vjsRoot) vjsRoot.appendChild(centerIcon);
      }

      // Inject icons + seconds label into the ripple circles (idempotent)
      const REWIND_SVG = `<svg class="dt-ripple-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg>`;
      const FFWD_SVG   = `<svg class="dt-ripple-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>`;

      const rippleLeft  = document.getElementById('ripple-left');
      const rippleRight = document.getElementById('ripple-right');

      if (rippleLeft && !rippleLeft.dataset.iconInjected) {
        rippleLeft.dataset.iconInjected = '1';
        rippleLeft.innerHTML = `${REWIND_SVG}<span class="dt-ripple-label">${SEEK_SECONDS}s</span>`;
      }
      if (rippleRight && !rippleRight.dataset.iconInjected) {
        rippleRight.dataset.iconInjected = '1';
        rippleRight.innerHTML = `${FFWD_SVG}<span class="dt-ripple-label">${SEEK_SECONDS}s</span>`;
      }
    });

    function getRipple(side) {
      return side === 'left'
        ? document.getElementById('ripple-left')
        : document.getElementById('ripple-right');
    }

    function sideFromClientX(clientX) {
      const rect = playerEl.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      return clientX < midpoint ? 'left' : 'right';
    }

    function suppressOverlay() {
      // Push the player to inactive so the overlay stays dark during double-tap.
      clearTimeout(suppressOverlayTimer);
      if (player) player.userActive(false);
      suppressOverlayTimer = setTimeout(() => {
        suppressOverlayTimer = null;
      }, RIPPLE_DURATION_MS);
    }

    function triggerSkip(side) {
      if (!player) return;
      const delta = side === 'left' ? -SEEK_SECONDS : SEEK_SECONDS;
      const current = Number(player.currentTime() || 0);
      const duration = Number(player.duration() || 0);
      let target = current + delta;
      if (Number.isFinite(duration) && duration > 0) {
        target = Math.min(Math.max(0, target), duration);
      } else {
        target = Math.max(0, target);
      }
      player.currentTime(target);

      suppressOverlay();

      const ripple = getRipple(side);
      if (ripple) {
        ripple.classList.remove('animate');
        void ripple.offsetWidth;
        ripple.classList.add('animate');
      }
    }

    function isControlTarget(target) {
      return Boolean(target?.closest?.('.vjs-control-bar, .vjs-menu, .central-controls, .video-overlay-header'));
    }

    function handleMouseDown(event) {
      if (isControlTarget(event.target)) return;

      const now = Date.now();
      const side = sideFromClientX(event.clientX);

      if (now - lastTapAt <= DOUBLE_TAP_MS && lastTapSide === side) {
        // Second mousedown — confirmed double-click incoming. Suppress overlay
        // before the second click and dblclick events fire.
        isDoubleTapWindow = true;
        return;
      }

      // First mousedown — always suppress activity on this press. It's either:
      //   a) the start of a double-click (overlay should stay hidden), or
      //   b) a single click that will toggle the overlay via the click event.
      // In both cases we don't want VJS's mousedown handler to wake the overlay
      // independently — the click event will handle the wake if appropriate.
      isDoubleTapWindow = true;
      lastTapAt = now;
      lastTapSide = side;
      clearTimeout(mouseDownTimer);
      mouseDownTimer = setTimeout(() => {
        lastTapAt = 0;
        lastTapSide = '';
        // Single click confirmed (no second press came). Clear the window so
        // subsequent mouse moves can wake the overlay normally again.
        isDoubleTapWindow = false;
      }, DOUBLE_TAP_MS + 30);
    }

    function handleDoubleClick(event) {
      if (isControlTarget(event.target)) return;
      const side = sideFromClientX(event.clientX);
      isDoubleTapWindow = false; // confirmed double-click, release the window
      triggerSkip(side);
      event.preventDefault();
      event.stopPropagation();
    }

    function handleTouchEnd(event) {
      if (isControlTarget(event.target)) return;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;

      const now = Date.now();
      const side = sideFromClientX(touch.clientX);
      if (now - lastTapAt <= DOUBLE_TAP_MS && lastTapSide === side) {
        // Second tap — confirmed double-tap, fire the skip
        isDoubleTapWindow = false;
        triggerSkip(side);
        lastTapAt = 0;
        lastTapSide = '';
        clearTimeout(tapResetTimer);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // First tap — open the double-tap window so the overlay stays suppressed
      // until we either confirm a double-tap or the window expires.
      isDoubleTapWindow = true;
      lastTapAt = now;
      lastTapSide = side;
      clearTimeout(tapResetTimer);
      tapResetTimer = setTimeout(() => {
        // Window expired: single tap confirmed.
        isDoubleTapWindow = false;
        lastTapAt = 0;
        lastTapSide = '';
        // Only wake the overlay if this tap wasn't a dismiss tap. If isDismissing
        // is still true the user tapped to hide the overlay — don't re-show it.
        if (!isDismissing && player && typeof player._wakeOverlay === 'function') {
          player._wakeOverlay();
        }
      }, DOUBLE_TAP_MS + 30);
    }

    function handleTouchStart(event) {
      window.__lastPlayerTouchTime = Date.now();
      if (isControlTarget(event.target)) return;
      // Set the window flag immediately on touchstart — before VJS's own
      // touchstart handler fires and sets userActivity_=true. This ensures
      // our userActivity_ setter blocks it right at the source.
      isDoubleTapWindow = true;
      // The flag will be cleared by handleTouchEnd (single-tap timer expiry
      // or double-tap confirmation) or by the dismiss handler.
    }

    function handlePlayerClick(event) {
      if (isControlTarget(event.target)) return;
      // If a double-click is still in progress (isDoubleTapWindow still true
      // because handleDoubleClick hasn't fired yet) do nothing — dblclick will
      // handle it. Also don't wake if a dismiss just happened or if skipping.
      if (isDoubleTapWindow || isDismissing || suppressOverlayTimer) return;
      if (player && typeof player._wakeOverlay === 'function') {
        player._wakeOverlay();
      }
    }

    playerEl.addEventListener('mousedown', handleMouseDown);
    playerEl.addEventListener('click', handlePlayerClick);
    playerEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    playerEl.addEventListener('dblclick', handleDoubleClick);
    playerEl.addEventListener('touchend', handleTouchEnd, { passive: false });

    player.on('dispose', () => {
      clearTimeout(tapResetTimer);
      clearTimeout(suppressOverlayTimer);
      clearTimeout(mouseDownTimer);
      playerEl.removeEventListener('mousedown', handleMouseDown);
      playerEl.removeEventListener('click', handlePlayerClick);
      playerEl.removeEventListener('touchstart', handleTouchStart);
      playerEl.removeEventListener('dblclick', handleDoubleClick);
      playerEl.removeEventListener('touchend', handleTouchEnd);
    });
  }

  function setupSeekbarOptimizations() {
    if (!player) return;

    let isScrubbing = false;
    let scrubTargetTime = 0;
    
    // Monkey-patch currentTime to avoid seeking the video while dragging
    const originalCurrentTime = player.currentTime;
    player.currentTime = function(seconds) {
      if (seconds !== undefined) {
        if (isScrubbing) {
          scrubTargetTime = seconds;
          // Trigger timeupdate so UI progresses
          player.trigger('timeupdate');
          return;
        }
        return originalCurrentTime.call(this, seconds);
      }
      return isScrubbing ? scrubTargetTime : originalCurrentTime.call(this);
    };

    player.ready(() => {
      const progressControl = player.controlBar?.progressControl?.el();
      if (!progressControl) return;

      // Handle scrub state tracking
      const startScrub = () => { isScrubbing = true; };
      const stopScrub = () => {
        if (isScrubbing) {
          isScrubbing = false;
          originalCurrentTime.call(player, scrubTargetTime); // commit seek
        }
      };

      progressControl.addEventListener('mousedown', startScrub, { passive: true });
      progressControl.addEventListener('touchstart', startScrub, { passive: true });
      
      document.addEventListener('mouseup', stopScrub);
      document.addEventListener('touchend', stopScrub);

      // Create Live Thumbnail Preview Elements
      const previewContainer = document.createElement('div');
      previewContainer.className = 'vjs-thumbnail-preview';
      previewContainer.innerHTML = '<canvas class="vjs-thumbnail-canvas" width="160" height="90"></canvas><div class="vjs-thumbnail-chapter-title"></div><div class="vjs-thumbnail-time">0:00</div>';
      progressControl.appendChild(previewContainer);

      const timeDisplay = previewContainer.querySelector('.vjs-thumbnail-time');
      const chapterTitleDisplay = previewContainer.querySelector('.vjs-thumbnail-chapter-title');
      const formatTime = (seconds) => {
        if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
      };

      const canvas = previewContainer.querySelector('.vjs-thumbnail-canvas');
      const ctx = canvas.getContext('2d');
      
      const previewVideo = document.createElement('video');
      previewVideo.style.display = 'none';
      previewVideo.muted = true;
      previewVideo.playsInline = true;
      previewVideo.preload = 'metadata';
      document.body.appendChild(previewVideo);

      // Sync source with main player
      const syncSource = () => {
        const src = player.currentSrc();
        if (src && previewVideo.src !== src) {
          previewVideo.src = src;
        }
      };
      player.on('loadstart', syncSource);
      syncSource();

      // Render chapter markers on seekbar
      let currentChapterTitleEl = null;

      player.on('loadedmetadata', () => {
        if (!currentChapters) return;
        const duration = player.duration();
        const holder = progressControl.querySelector('.vjs-progress-holder');
        if (duration && holder) {
          // Clear old markers if any
          holder.querySelectorAll('.vjs-chapter-marker').forEach(m => m.remove());
          
          currentChapters.forEach(ch => {
            if (ch.time === 0) return; // Skip 0:00 marker
            const pct = (ch.time / duration) * 100;
            if (pct < 100) {
              const marker = document.createElement('div');
              marker.className = 'vjs-chapter-marker';
              marker.style.left = `${pct}%`;
              holder.appendChild(marker);
            }
          });
          
          // Setup chapter hover highlight overlay
          let highlightOverlay = holder.querySelector('.vjs-chapter-hover-highlight');
          if (!highlightOverlay) {
            highlightOverlay = document.createElement('div');
            highlightOverlay.className = 'vjs-chapter-hover-highlight';
            holder.insertBefore(highlightOverlay, holder.firstChild);
          }
        }

        // Add current chapter title to control bar
        if (!currentChapterTitleEl) {
          const cBar = player.controlBar;
          currentChapterTitleEl = document.createElement('div');
          currentChapterTitleEl.className = 'vjs-current-chapter-title';
          
          // Insert after time remaining so it sits to its right, but pushed away from quality
          const timeDisplayComp = cBar.getChild('durationDisplay') || cBar.getChild('currentTimeDisplay') || cBar.getChild('timeControl');
          const timeDisplayEl = timeDisplayComp ? timeDisplayComp.el() : null;
          if (timeDisplayEl) {
            cBar.el().insertBefore(currentChapterTitleEl, timeDisplayEl.nextSibling);
          } else {
            cBar.el().appendChild(currentChapterTitleEl);
          }
        }
      });

      player.on('timeupdate', () => {
        if (!currentChapters || !currentChapterTitleEl) return;
        const currentTime = player.currentTime();
        let activeChapter = currentChapters[0];
        for (const ch of currentChapters) {
          if (ch.time <= currentTime) activeChapter = ch;
          else break;
        }
        if (activeChapter) {
          currentChapterTitleEl.textContent = `• ${activeChapter.title}`;
          currentChapterTitleEl.style.display = 'block';
        } else {
          currentChapterTitleEl.style.display = 'none';
        }
      });

      let seekTimeout = null;
      let isSeeking = false;
      let lastDrawTime = -1;

      previewVideo.addEventListener('seeked', () => {
        isSeeking = false;
        ctx.drawImage(previewVideo, 0, 0, 160, 90);
      });

      const handleHover = (e) => {
        const rect = progressControl.getBoundingClientRect();
        const clientX = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
        let percent = (clientX - rect.left) / rect.width;
        percent = Math.max(0, Math.min(1, percent));
        
        const duration = player.duration() || 0;
        const hoverTime = percent * duration;
        
        timeDisplay.textContent = formatTime(hoverTime);

        if (currentChapters && currentChapters.length > 0) {
          let activeChapterIndex = 0;
          for (let i = 0; i < currentChapters.length; i++) {
            if (currentChapters[i].time <= hoverTime) activeChapterIndex = i;
          }
          const activeChapter = currentChapters[activeChapterIndex];
          const nextChapter = currentChapters[activeChapterIndex + 1];

          chapterTitleDisplay.textContent = activeChapter.title;
          chapterTitleDisplay.style.display = 'block';

          // Update highlight overlay position/width
          const holder = progressControl.querySelector('.vjs-progress-holder');
          const highlightOverlay = holder ? holder.querySelector('.vjs-chapter-hover-highlight') : null;
          if (highlightOverlay) {
            const startPct = (activeChapter.time / duration) * 100;
            const endPct = nextChapter ? (nextChapter.time / duration) * 100 : 100;
            highlightOverlay.style.left = `${startPct}%`;
            highlightOverlay.style.width = `${endPct - startPct}%`;
            highlightOverlay.style.opacity = '1';
          }
        } else {
          chapterTitleDisplay.style.display = 'none';
        }

        // Position the container
        const containerWidth = 160;
        let left = (percent * rect.width) - (containerWidth / 2);
        // Clamp to edges
        left = Math.max(0, Math.min(rect.width - containerWidth, left));
        previewContainer.style.left = left + 'px';

        // Throttle drawing
        if (Math.abs(hoverTime - lastDrawTime) > 0.5 && !isSeeking) {
          if (seekTimeout) clearTimeout(seekTimeout);
          seekTimeout = setTimeout(() => {
            isSeeking = true;
            lastDrawTime = hoverTime;
            previewVideo.currentTime = hoverTime;
          }, 100);
        }
      };

      progressControl.addEventListener('mousemove', handleHover);
      progressControl.addEventListener('touchmove', handleHover, { passive: true });
      
      const showPreview = () => { previewContainer.classList.add('show'); };
      const hidePreview = () => { 
        previewContainer.classList.remove('show'); 
        const holder = progressControl.querySelector('.vjs-progress-holder');
        const highlightOverlay = holder ? holder.querySelector('.vjs-chapter-hover-highlight') : null;
        if (highlightOverlay) highlightOverlay.style.opacity = '0';
      };

      progressControl.addEventListener('mouseenter', showPreview);
      progressControl.addEventListener('mouseleave', hidePreview);
      progressControl.addEventListener('touchstart', showPreview, { passive: true });
      progressControl.addEventListener('touchend', hidePreview);
      
      // Cleanup
      player.on('dispose', () => {
        document.removeEventListener('mouseup', stopScrub);
        document.removeEventListener('touchend', stopScrub);
        if (previewVideo.parentNode) previewVideo.parentNode.removeChild(previewVideo);
      });
    });
  }

function initPlayer(videoData, { autoStart = true } = {}) {
    if (player) {
      // FIX: Rescue custom overlays before Video.js nukes them
      const safeZone = document.getElementById('player-container');
      ['video-ui-overlay', 'skip-left', 'skip-right', 'autoplay-countdown-overlay'].forEach(id => {
        const el = document.getElementById(id);
        if (el && safeZone) safeZone.appendChild(el);
      });

      // FIX: Cleanup global quality menu listener if open during dispose
      if (qualityMenuCloser) {
        document.removeEventListener('click', qualityMenuCloser);
        qualityMenuCloser = null;
      }
      
      player.dispose();
    }

    const ext = (videoData.filename || '').split('.').pop().toLowerCase();
    const mimeMap = {
      mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
      avi: 'video/x-msvideo', mov: 'video/quicktime', m4v: 'video/mp4',
      flv: 'video/x-flv', ts: 'video/mp2t',
    };


    player = videojs('video-player', {
      controls: true,
      preload: 'metadata',
      fluid: false,
      responsive: false,
      userActions: {
        click: false,       // We handle clicks manually via the overlay
        doubleClick: false, // We handle double-tap seek manually
      },
      inactivityTimeout: 2000,
      playbackRates: [0.5, 1, 1.5, 2],
      controlBar: {
        volumePanel: { inline: true },
        children: [
          'playToggle',
          'volumePanel',
          'currentTimeDisplay',
          'timeDivider',
          'durationDisplay',
          'progressControl',
          'customControlSpacer',
          'fullscreenToggle',
        ],
      },
    });

    const userObj = getUser();
    if (userObj && typeof userObj.volume === 'number') {
      player.volume(userObj.volume);
    }

    let volumeSaveTimeout;
    player.on('volumechange', () => {
      const vol = player.volume();
      clearTimeout(volumeSaveTimeout);
      volumeSaveTimeout = setTimeout(() => {
        api('/api/user/volume', {
          method: 'POST',
          body: JSON.stringify({ volume: vol })
        }).catch(err => console.error('Failed to save volume:', err));
      }, 1000);
    });

    player.ready(() => {
      const playerEl = player.el();

      // Livechat Toggle Button
      const Button = videojs.getComponent('Button');
      class LivechatToggle extends Button {
        constructor(player, options) {
          super(player, options);
          this.controlText('Toggle Livechat');
          this.addClass('vjs-livechat-toggle');
          this.hide(); // Hidden by default, shown if in a party
        }
        handleClick() {
          if (window.toggleLivechatFeature) {
            window.toggleLivechatFeature();
            if (window.isLivechatOn) {
              this.addClass('active');
            } else {
              this.removeClass('active');
            }
          }
        }
      }
      videojs.registerComponent('LivechatToggle', LivechatToggle);
      
      // Add it before fullscreen toggle
      const controlBar = player.getChild('controlBar');
      if (controlBar) {
        controlBar.addChild('LivechatToggle', {}, controlBar.children().length - 1);
      }

// ─── STRICT ACTIVITY TRACKING ───
      // Override userActive to prevent UI wake-up during double-taps
      const originalUserActive = player.userActive.bind(player);
      player.userActive = function(bool) {
        if (bool === true && isDoubleTapWindow) return;
        return originalUserActive(bool);
      };

      // Block Video.js internal activity flagging if the interaction is outside the player
      const originalReportActivity = player.reportUserActivity;
      player.reportUserActivity = function(event) {
        if (event && event.target && !playerEl.contains(event.target)) {
          return; // Ignore pulse if it didn't come from inside the player
        }
        if (isDoubleTapWindow) return; // Ignore pulse during double-tap window
        originalReportActivity.call(this, event);
      };

      // FIX: Disable native focus check so interacting with bottom bar doesn't freeze the timeout
      player.hasFocus = function() { return false; };

      // Ensure clicking on other elements (sidebar/comments) instantly hides the player UI,
      // without corrupting the Video.js state machine.
      const activitySilencer = (e) => {
        // Skip synthetic mousedown events generated from touch taps (InputDeviceCapabilities API).
        // Without this guard, tapping the header avatar/bell on mobile fires a touch-generated
        // mousedown here in capture phase, which can cause VJS to call stopImmediatePropagation
        // internally — preventing the subsequent 'click' event from reaching the button's handler.
        if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
        if (!playerEl.contains(e.target)) {
          if (player.userActive()) {
            player.userActive(false);
          }
        }
      };
      
      if (!document.body.dataset.silencerAttached) {
        document.addEventListener('mousedown', activitySilencer, { capture: true });
        // NOTE: The 'mousemove' silencer was completely removed. Video.js naturally lets 
        // the 2s timeout run when the mouse leaves. Tracking it globally was breaking the UI.
        document.body.dataset.silencerAttached = "true";
      }

      // Prevent the player from waking up when the window gains focus
      window.removeEventListener('focus', player.boundUserFocusCheck);

      player._wakeOverlay = function() {
        originalUserActive(true);
      };

      player.on('dispose', () => {
        document.removeEventListener('mousedown', activitySilencer, { capture: true });
        delete document.body.dataset.silencerAttached;
      });
    });

    player.ready(() => {
      // Ensure overlay hides on inactivity even when paused
      player.options_.pauseAlwaysShowControls = false;
      player.on('pause', () => {
        if (player._suppressNextWake) {
          player._suppressNextWake = false;
          return;
        }
        player.userActive(true); // Show overlay for inactivityTimeout, then hide
      });
    });

    setupVideoUiOverlay();
    setupDoubleTapSeek();
    setupSeekbarOptimizations();

    const token = getToken();
    const q = getAuthQueryString();
    const mime = mimeMap[ext] || 'video/mp4';
    const shouldForceDirect = isForceDirectPlay();
    const needsTranscode = transcodeExts.has(ext);

    dbg('info', `--- initPlayer: ${videoData.filename || '?'} ---`);
    dbg('info', `ext=${ext}, forceDirect=${shouldForceDirect}, needsTranscode=${needsTranscode}`);

    // If force-direct is OFF, always use transcode for incompatible formats
    if (!shouldForceDirect && needsTranscode) {
      const src = buildTranscodeSrc(currentQuality);
      dbg('net', `Mode: transcode → ${src}`);
      debugUpdateMeta(videoData, src, 'video/mp4');
      showTranscodingBar();
      player.src({ src, type: 'video/mp4' });
      setupDebugPlayerHooks(videoData, src);
    } else {
      // Force-direct is ON: always use direct play.
      const src = `/api/videos/${videoId}/stream?${q}`;
      dbg('net', `Mode: direct → ${src}`);
      debugUpdateMeta(videoData, src, mime);
      player.src({ src, type: mime });
      setupDebugPlayerHooks(videoData, src);
    }

    player.on('play', () => {
      hideTranscodingBar();
      clearAutoplayCountdown();
    });

    player.on('seeking', () => {
      clearAutoplayCountdown();
    });

    player.on('ended', () => {
      maybeStartAutoplayCountdown();
    });

    const containerEl = document.getElementById('player-container');
    let hasAutoplayStarted = false;

    const syncNativeAspectRatio = () => {
      const nativeWidth = Number(player.videoWidth?.() || 0);
      const nativeHeight = Number(player.videoHeight?.() || 0);
      if (nativeWidth > 0 && nativeHeight > 0) {
        if (containerEl) {
          containerEl.style.aspectRatio = `${nativeWidth} / ${nativeHeight}`;
        }
        player.aspectRatio(`${nativeWidth}:${nativeHeight}`);
      }
    };

    const attemptAutoplay = () => {
      if (!autoStart || hasAutoplayStarted) return;
      // If in a watch party, don't autoplay — wait for party sync
      if ((window.WatchParty && WatchParty.isInParty()) || sessionStorage.getItem('wp_partyId')) return;
      hasAutoplayStarted = true;
      const playPromise = player.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
          // Autoplay started successfully
        }).catch((err) => {
          if (err.name === 'NotAllowedError') {
             console.warn("Autoplay blocked by browser. Leaving UI visible.");
             player.userActive(true);
          }
        });
      }
    };

    player.on('loadedmetadata', () => {
      syncNativeAspectRatio();
      attemptAutoplay();
    });

    player.on('loadeddata', () => {
      syncNativeAspectRatio();
      attemptAutoplay();
    });

    player.on('canplay', () => {
      attemptAutoplay();
    });

    player.ready(() => {
      syncNativeAspectRatio();
      attemptAutoplay();
      injectResolutionBadge(videoData);
      setupAutoFullscreen();
      if (isTranscoding) refreshQualityMenu();
      const titleEl = document.getElementById('overlay-video-title');
      if (titleEl) {
        titleEl.innerHTML = (videoData.title ? escHtml(videoData.title) : '') + 
          (videoData.is_vhs ? ` <svg class="vhs-title-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: text-bottom; margin-left: 4px; color: var(--text-muted);" title="VHS Video"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><line x1="10" y1="12" x2="14" y2="12"/></svg>` : '');
      }
      setupProgressTracking();
      setupWatchPartyHooks();

      // Automatically close menus when the controls fade out
      player.on('userinactive', () => {
        const menus = player.el().querySelectorAll('.vjs-menu');
        menus.forEach(menu => {
          menu.classList.remove('vjs-lock-showing');
        });
      });

      // Close playback rate menu immediately after selecting a value
      player.on('ratechange', () => {
        const rateMenu = player.el().querySelector('.vjs-playback-rate .vjs-menu');
        if (rateMenu) rateMenu.classList.remove('vjs-lock-showing');
      });
    });
  }

function setupWatchPartyHooks() {
  if (!window.WatchParty || !player) return;

  let _wpWaiting = false;      // are we in a "waiting for sync" state?
  let _wpIgnoreNextPlay = false;
  let _wpIgnoreNextPause = false;
  let _wpIgnoreNextSeek = false;

  // ── Emit sync events (only for USER-initiated actions) ──
  player.on('play', () => {
    if (_wpIgnoreNextPlay) {
      _wpIgnoreNextPlay = false;
      return;
    }
    WatchParty.sendSync('play', player.currentTime());
  });
  player.on('pause', () => {
    if (_wpIgnoreNextPause) {
      _wpIgnoreNextPause = false;
      return;
    }
    WatchParty.sendSync('pause', player.currentTime());
  });
  player.on('seeked', () => {
    if (_wpIgnoreNextSeek) {
      _wpIgnoreNextSeek = false;
      return;
    }
    
    // Workaround for browser/video.js race condition on fast clicks
    // where currentTime temporarily reads 0 before jumping to the actual seek time.
    setTimeout(() => {
      if (WatchParty.isInParty()) {
        const t = player.currentTime();
        WatchParty.sendSync('seek', t);
      }
    }, 100);
  });
  player.on('waiting', () => {
    WatchParty.sendBuffering();
  });
  player.on('canplay', () => {
    WatchParty.sendReady();
  });

  const checkAndSendReady = () => {
    if (player.readyState() >= 3) {
      WatchParty.sendReady();
    }
  };
  window.addEventListener('party:joined', checkAndSendReady);
  window.addEventListener('party:created', checkAndSendReady);

  player.on('loadedmetadata', () => {
    if (window.WatchParty && WatchParty.isInParty()) {
      WatchParty.requestSync();
    }
  });

  // ── Receive sync events ──
  window.addEventListener('party:sync', (e) => {
    const msg = e.detail;

    const drift = Math.abs(player.currentTime() - msg.currentTime);
    if (drift > 1.5 || msg.action === 'seek' || msg.action === 'update') {
      // Pause BEFORE seeking to prevent the browser from aborting an unbuffered seek
      if (!player.paused()) {
        _wpIgnoreNextPause = true;
        player.pause();
      }
      _wpIgnoreNextSeek = true;
      player.currentTime(msg.currentTime);
    }
    
    if (msg.action === 'play') {
      if (player.paused() && !_wpWaiting) {
        _wpIgnoreNextPlay = true;
        const p = player.play();
        if (p && p.catch) p.catch(() => { _wpIgnoreNextPlay = false; });
      }
    } else if (msg.action === 'pause') {
      if (!player.paused()) {
        _wpIgnoreNextPause = true;
        player.pause();
      }
    }
  });

  window.addEventListener('party:waiting', (e) => {
    if (window.WatchParty && WatchParty.isBrowsing()) return;
    const msg = e.detail;
    const overlay = document.getElementById('watch-party-overlay');
    const textEl = document.getElementById('wp-waiting-text');
    
    if (msg.waiting) {
      _wpWaiting = true;
      if (!player.paused()) {
        if (player.seeking()) {
          // Do not interrupt a pending seek with a pause, it aborts the seek in some browsers!
          player.one('seeked', () => {
            if (_wpWaiting && !player.paused()) {
              _wpIgnoreNextPause = true;
              player.pause();
            }
          });
        } else {
          _wpIgnoreNextPause = true;
          player.pause();
        }
      }
      if (textEl) {
        textEl.textContent = msg.videoSync
          ? 'Waiting for everyone to load the video...'
          : `Waiting for ${msg.displayName || 'someone'}...`;
      }
      if (overlay) overlay.style.display = 'flex';
    } else {
      _wpWaiting = false;
      if (overlay) overlay.style.display = 'none';
      if (typeof msg.syncTime === 'number') {
        _wpIgnoreNextSeek = true;
        player.currentTime(msg.syncTime);
      }
      if (player.paused()) {
        _wpIgnoreNextPlay = true;
        const p = player.play();
        if (p && p.catch) p.catch(() => { _wpIgnoreNextPlay = false; });
      }
    }
  });

  window.addEventListener('party:video_change', (e) => {
    const msg = e.detail;
    const currentVideoId = Number(new URLSearchParams(location.search).get('id'));
    if (msg.videoId && msg.videoId !== currentVideoId) {
      toast(`${msg.fromUsername} changed the video.`, 'info');
      navigateToVideo(msg.videoId, false, true);
    } else if (msg.videoId && msg.videoId === currentVideoId) {
      if (window.WatchParty && WatchParty.isInParty()) {
        WatchParty.setBrowsingStatus(false);
        if (typeof msg.currentTime === 'number') {
          player.currentTime(msg.currentTime); // move them to the start along with everyone else
        }
        if (player.readyState() >= 3) {
          WatchParty.sendReady();
        }
      }
    }
  });

  window.addEventListener('party:provide_sync', () => {
    if (player.readyState() >= 1 && window.WatchParty) {
      WatchParty.sendSync('update', player.currentTime());
    }
  });

  window.addEventListener('party:member_changed', renderWatchPartyBar);
  window.addEventListener('party:joined', () => {
    renderWatchPartyBar();
    toast('Joined watch party!', 'success');
  });
  window.addEventListener('party:created', renderWatchPartyBar);
  window.addEventListener('party:ended', () => {
    const bar = document.getElementById('watch-party-bar');
    if (bar) bar.style.display = 'none';
    const overlay = document.getElementById('watch-party-overlay');
    if (overlay) overlay.style.display = 'none';
  });

  // Render initial state
  if (WatchParty.isInParty()) {
    renderWatchPartyBar();
    const toggle = player.controlBar.getChild('LivechatToggle');
    if (toggle) toggle.show();
    // Re-render chat if friends panel has it
    if (window.chatMessages) renderFloatingChat(window.chatMessages);
  }

  // ─── Floating Livechat Integration ───
  function appendFloatingChat(msg) {
    const flMessages = document.getElementById('fl-messages');
    if (!flMessages) return;
    flMessages.insertAdjacentHTML('beforeend', `
      <div class="fl-msg">
        <strong>${escHtml(msg.displayName)}:</strong>
        <span>${escHtml(msg.text)}</span>
      </div>
    `);
    flMessages.scrollTop = flMessages.scrollHeight;
  }

  function renderFloatingChat(messages) {
    const flMessages = document.getElementById('fl-messages');
    if (!flMessages) return;
    flMessages.innerHTML = '';
    if (Array.isArray(messages)) {
      messages.forEach(msg => appendFloatingChat(msg));
    }
  }

  window.addEventListener('party:joined', (e) => {
    const toggle = player.controlBar.getChild('LivechatToggle');
    if (toggle) toggle.show();
    if (e.detail && e.detail.messages) renderFloatingChat(e.detail.messages);
  });

  window.addEventListener('party:state', (e) => {
    const toggle = player.controlBar.getChild('LivechatToggle');
    if (toggle) toggle.show();
    if (e.detail && e.detail.messages) renderFloatingChat(e.detail.messages);
  });

  window.addEventListener('party:left', () => {
    const toggle = player.controlBar.getChild('LivechatToggle');
    if (toggle) {
      toggle.hide();
      toggle.removeClass('active');
    }
    window.isLivechatOn = false;
    window.updateLivechatUI();
  });

  window.addEventListener('party:chat', (e) => {
    appendFloatingChat(e.detail);
  });

  window.isLivechatOn = false;
  window.isLivechatExpanded = false;

  window.toggleLivechatFeature = function() {
    window.isLivechatOn = !window.isLivechatOn;
    // When turning on in windowed mode, auto-expand the chat
    if (window.isLivechatOn && !player.isFullscreen()) {
      window.isLivechatExpanded = true;
    }
    window.updateLivechatUI();
  };

  window.updateLivechatUI = function() {
    const fl = document.getElementById('floating-livechat');
    const fab = document.getElementById('fl-fab');
    if (!fl || !fab || !player) return;

    if (!window.isLivechatOn) {
      fl.classList.add('hidden');
      fab.classList.add('hidden');
      return;
    }

    // It is ON. Check fullscreen state.
    if (player.isFullscreen()) {
      // Fullscreen mode: Move fl inside player, show it, hide fab.
      fl.classList.remove('windowed-mode');
      fl.classList.add('fullscreen-mode');
      fl.classList.remove('hidden');
      fab.classList.add('hidden');
      
      if (fl.parentNode !== player.el()) {
        player.el().appendChild(fl);
      }
    } else {
      // Windowed mode: Move fl to body, show fab, toggle fl based on expanded state.
      fl.classList.remove('fullscreen-mode');
      fl.classList.add('windowed-mode');
      fab.classList.remove('hidden');
      
      if (fl.parentNode !== document.body) {
        document.body.appendChild(fl);
      }
      
      if (window.isLivechatExpanded) {
        fl.classList.remove('hidden');
        const input = document.getElementById('fl-input');
        if (input) input.focus();
      } else {
        fl.classList.add('hidden');
      }
    }
  };

  // FAB Click handler
  const fab = document.getElementById('fl-fab');
  if (fab) {
    fab.addEventListener('click', () => {
      window.isLivechatExpanded = !window.isLivechatExpanded;
      window.updateLivechatUI();
    });
  }

  // Listen for fullscreen changes
  player.on('fullscreenchange', () => {
    window.updateLivechatUI();
  });

  const flInput = document.getElementById('fl-input');
  if (flInput) {
    flInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !player.isFullscreen()) {
        // Escape in windowed mode closes the popup
        window.isLivechatExpanded = false;
        window.updateLivechatUI();
      }
      if (e.key === 'Enter') {
        const text = flInput.value.trim();
        if (text && window.WatchParty) {
          WatchParty.sendChat(text);
          flInput.value = '';
        }
      }
    });
  }
}

function renderWatchPartyBar() {
  const bar = document.getElementById('watch-party-bar');
  const membersEl = document.getElementById('wp-bar-members');
  const manageBtn = document.getElementById('wp-bar-manage');
  
  if (!WatchParty.isInParty()) {
    if (bar) bar.style.display = 'none';
    return;
  }

  if (bar) bar.style.display = 'flex';
  
  if (manageBtn) {
    manageBtn.onclick = () => {
      if (window.openFriendsPanel) window.openFriendsPanel();
    };
  }

  if (membersEl) {
    const members = WatchParty.getPartyMembers();
    const token = getToken();
    let html = '';
    for (const [uid, m] of members) {
      const avatarUrl = m.avatarPath && token
        ? `/api/users/avatar/${uid}?token=${encodeURIComponent(token)}&t=${Date.now()}`
        : null;
      const initial = (m.displayName || m.username || '?')[0].toUpperCase();
      
      const isBrowsing = m.browsing;
      const isBuffering = m.buffering && !isBrowsing;
      
      let title = escHtml(m.displayName);
      if (isBrowsing) title += ' (Browsing videos)';
      else if (isBuffering) title += ' (Buffering)';

      html += `
        <div class="wp-bar-avatar ${isBuffering ? 'buffering' : ''} ${isBrowsing ? 'browsing' : ''}" title="${title}">
          ${avatarUrl
            ? `<img src="${avatarUrl}" alt="" loading="lazy" />`
            : `<span>${escHtml(initial)}</span>`
          }
          <div class="fp-status-dot ${isBrowsing ? 'browsing-dot' : 'online'}"></div>
        </div>
      `;
    }
    membersEl.innerHTML = html;
  }
}

// --- Navigation token for SPA race safety ---
let currentNavToken = 0;
async function navigateToVideo(newId, isPopState = false, fromServerSync = false) {
  const myToken = ++currentNavToken;
  clearAutoplayCountdown();
  if (!newId || isNaN(newId)) return;

  // FIX: Prevent infinite stack memory leak (cap at 50 history entries)
  if (!isPopState) {
    internalWatchStack.push(videoId);
    if (internalWatchStack.length > 50) internalWatchStack.shift();
  } else {
    internalWatchStack.pop(); 
  }
  
  // FIX: Clear obsolete state from previous video to prevent memory leaks
  expandedCommentThreads.clear();
  isDoubleTapWindow = false; 
  isDismissing = false;

  videoId = newId;
  updateNavigationButtons(); // Refresh the UI state

  if (!isPopState) {
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('id', newId);
    window.history.pushState({ videoId: newId }, '', newUrl);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });

  try {
    // 2. Fetch new video data and context-specific lists
    const [data, qualityData, seriesData, personData] = await Promise.all([
      api(`/api/videos/${newId}`),
      api(`/api/videos/${newId}/qualities`).catch(() => ({ qualities: [] })),
      seriesId ? api(`/api/series/${seriesId}/videos`).catch(() => null) : Promise.resolve(null),
      personId ? api(`/api/videos?limit=120&page=1&person_id=${personId}`).catch(() => null) : Promise.resolve(null),
    ]);

    // Abort if a newer navigation started
    if (myToken !== currentNavToken) return;

    currentVideo = data;
    availableQualities = qualityData.qualities || [];

    // Notify watch party instantly before loading src to prevent overlay flashing
    if (window.WatchParty && WatchParty.isInParty()) {
      if (WatchParty.isPartyHost()) {
        if (!fromServerSync) WatchParty.changeVideo(newId, data.title, 0);
      } else if (!fromServerSync) {
        WatchParty.setBrowsingStatus(true);
        
        // Remove existing toast if any
        let existing = document.getElementById('wp-guest-toast');
        if (existing) existing.remove();
        
        const toastEl = document.createElement('div');
        toastEl.id = 'wp-guest-toast';
        toastEl.className = 'wp-invite-popup wp-suggest-toast';
        toastEl.innerHTML = `
          <div class="wp-invite-body" style="gap: 12px; margin-top: 0;">
            <div class="wp-invite-title" style="font-size: 0.95rem;">You are browsing privately. Suggest this video to the Host?</div>
            <div class="wp-invite-actions">
              <button class="btn btn-primary" id="wp-guest-suggest-btn">Suggest</button>
              <button class="btn btn-secondary" id="wp-guest-dismiss-btn">Just Browse</button>
            </div>
          </div>
        `;
        document.body.appendChild(toastEl);
        
        document.getElementById('wp-guest-suggest-btn').onclick = () => {
          WatchParty.suggestVideo(newId, data.title);
          toastEl.remove();
          toast('Suggestion sent to Host!', 'success');
        };
        document.getElementById('wp-guest-dismiss-btn').onclick = () => toastEl.remove();
        setTimeout(() => { if (toastEl.parentNode) toastEl.remove(); }, 12000);
      } else {
        // We are a guest following a server sync. Rejoin the party properly.
        WatchParty.setBrowsingStatus(false);
      }
    }

    // 3. Update Player Source
    const ext = data.filename.split('.').pop().toLowerCase();
    const token = getToken();
    const q = getAuthQueryString();
    
    const mimeMap = { mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska', avi:'video/x-msvideo', mov:'video/quicktime', flv:'video/x-flv', ts:'video/mp2t' };
    const mime = mimeMap[ext] || 'video/mp4';

    // FIX: Properly update transcode state flags
    isTranscoding = !isForceDirectPlay() && transcodeExts.has(ext);

    if (isTranscoding) {
      showTranscodingBar();
      const src = buildTranscodeSrc(currentQuality, newId);
      player.src({ src, type: 'video/mp4' });
      setupDebugPlayerHooks(data, src);        // FIX: Restore debug hooks
      debugUpdateMeta(data, src, 'video/mp4'); // FIX: Restore debug metadata
    } else {
      hideTranscodingBar();
      const src = `/api/videos/${newId}/stream?${q}`;
      player.src({ src, type: mime });
      setupDebugPlayerHooks(data, src);        // FIX: Restore debug hooks
      debugUpdateMeta(data, src, mime);        // FIX: Restore debug metadata
    }

    // 4. Update UI & Metadata
    renderVideoInfo(data);
    injectResolutionBadge(data);
    
    // 5. Rebuild "Up Next" queue
    if (seriesId && seriesData) {
      renderUpNext(buildUpNextOrder(seriesData));
    } else if (personId && personData) {
      renderUpNext(buildUpNextOrder(personData));
    } else {
      const listData = await api(`/api/videos?limit=40&page=1`);
      renderUpNext(shuffleVideos(normalizeVideoList(listData)));
    }

    // 6. Reset Logic & Autoplay
    loadComments();
    setupProgressTracking();
    
    // Ensure the player is ready to play and handle the promise
    player.ready(() => {
      const playPromise = player.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          syncPlayPauseIcon();
        }).catch(error => {
          console.warn("Autoplay prevented:", error);
          syncPlayPauseIcon();
        });
      }
    });
    
  } catch (err) {
    console.error("SPA Navigation failed:", err);
    location.href = `/watch.html?id=${newId}${seriesId ? `&series=${seriesId}` : ''}${personId ? `&person=${personId}` : ''}`;
  }
}

window.navigateToVideo = navigateToVideo;

// Handle browser back/forward buttons for SPA navigation
  window.addEventListener('popstate', (event) => {
    const newParams = new URLSearchParams(window.location.search);
    const newId = parseInt(newParams.get('id'), 10);
    
    // FIX: If there is no ID in the URL, we've navigated off the watch page entirely.
    if (!newId || isNaN(newId)) {
      window.location.replace(window.location.pathname + window.location.search);
      return;
    }

    if (newId !== videoId) {
      navigateToVideo(newId, true);
    }
  });

  // --- Orientation change handler (module scope for add/remove) ---
  function handleOrientationChange() {
    let isLandscape = false;
    if (window.screen && window.screen.orientation && window.screen.orientation.type) {
      isLandscape = window.screen.orientation.type.startsWith('landscape');
    } else if (typeof window.orientation !== 'undefined') {
      isLandscape = window.orientation === 90 || window.orientation === -90;
    } else {
      isLandscape = window.matchMedia("(orientation: landscape)").matches;
    }
    
    if (!player) return;
    
    if (isLandscape) {
      if (!player.isFullscreen()) {
        player.requestFullscreen();
      }
    } else {
      if (player.isFullscreen()) {
        player.exitFullscreen();
      }
    }
  }

  function setupAutoFullscreen() {
    // 1. Check if we are on a mobile device
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || 
                     (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
    if (!isMobile || !player) return;
    // Guard: only attach once per player instance
    if (player.el().dataset.autoFullscreenAttached) return;
    player.el().dataset.autoFullscreenAttached = '1';
    window.addEventListener('orientationchange', handleOrientationChange);
    if (screen.orientation) {
      screen.orientation.addEventListener('change', handleOrientationChange);
    }
    // Remove listeners on player dispose
    player.on('dispose', () => {
      window.removeEventListener('orientationchange', handleOrientationChange);
      if (screen.orientation) {
        screen.orientation.removeEventListener('change', handleOrientationChange);
      }
    });
  }

  let cumulativeWatchTime = 0;
  let lastCheckTime = -1;
  let hasRecordedView = false;

  function setupProgressTracking() {
    lastSavedTime = 0;
    cumulativeWatchTime = 0;
    lastCheckTime = -1;
    hasRecordedView = false;
    player.off('timeupdate', onTimeUpdate); // remove previous
    player.on('timeupdate', onTimeUpdate);
  }

  function onTimeUpdate() {
    const rawTime = player.currentTime();
    
    // Accumulate watch time (ignore jumps larger than 1.5 second, meaning they skipped)
    if (lastCheckTime !== -1 && rawTime > lastCheckTime) {
      const diff = rawTime - lastCheckTime;
      if (diff < 1.5) {
        cumulativeWatchTime += diff;
      }
    }
    lastCheckTime = rawTime;

    if (cumulativeWatchTime >= 15 && !hasRecordedView) {
      hasRecordedView = true;
      api(`/api/videos/${videoId}/view`, { method: 'POST' }).catch(() => {});
    }

    const currentTime = Math.floor(rawTime);
    if (currentTime % 10 === 0 && currentTime !== lastSavedTime && currentTime > 0) {
      lastSavedTime = currentTime;
      saveProgress(currentTime);
    }
  }

  async function saveProgress(seconds) {
    if (!currentUser) return;
    if (isNaN(seconds) || seconds < 0) return;
    try {
      await api(`/api/videos/${videoId}/progress`, {
        method: 'POST',
        body: JSON.stringify({ position: seconds }),
      });
    } catch (e) {
      console.error('[Progress] Save failed:', e.message);
    }
  }

  async function loadFavoriteIds() {
    if (!currentUser) {
      favoriteIds = new Set();
      return;
    }
    try {
      const data = await api('/api/user/favorites/ids');
      favoriteIds = new Set(Array.isArray(data.ids) ? data.ids : []);
    } catch {
      favoriteIds = new Set();
    }
  }

  async function toggleFavorite(videoId) {
    if (!currentUser) return promptLogin();
    
    const isFav = favoriteIds.has(videoId);
    if (isFav) {
      await api(`/api/user/favorites/${videoId}`, { method: 'DELETE' });
      favoriteIds.delete(videoId);
      toast('Removed from favorites.');
      return false;
    }

    await api(`/api/user/favorites/${videoId}`, { method: 'POST' });
    favoriteIds.add(videoId);
    toast('Added to favorites.');
    return true;
  }

  // ── Reload video info (called from shared Video Settings modal) ────────────
  window.reloadVideoInfo = async function () {
    try {
      const data = await api(`/api/videos/${videoId}`);
      currentVideo = {
        ...data,
        channel: data.channel || currentVideo?.channel || null,
      };
      renderVideoInfo(currentVideo);
    } catch (err) {
      console.error('[reloadVideoInfo]', err);
    }
  };

  // ── Render video info ──────────────────────────────────────────────────────
  function renderVideoInfo(video) {
    const channelData = video.channel || {};
    const authorName = channelData.name || channelData.channel_name || 'Mysticle Archive';
    const authorAvatarPath = channelData.avatar_path || channelData.channel_avatar || '';
    const authorAvatar = authorAvatarPath ? `${authorAvatarPath}?t=${Date.now()}&${getAuthQueryString()}` : '';
    const authorInitial = (authorName[0] || 'M').toUpperCase();
    const infoEl = document.getElementById('video-info');
    if (!infoEl) return;
    
    const isFav = favoriteIds.has(video.id);
    const favIconOutline = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
    const favIconFilled = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;

    const canDownload = currentUser && (currentUser.role === 'admin' || currentUser.can_download);
    const downloadBtn = canDownload ? `
      <a href="/api/videos/${video.id}/download?token=${encodeURIComponent(getToken() || '')}" class="btn-action icon-only" id="watch-download-btn" title="Download Video" aria-label="Download Video" download>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
      </a>` : '';

    const shareBtn = canEditVideo(currentVideo) ? `
      <button class="btn-action icon-only" id="watch-share-btn" type="button" title="Share Video" aria-label="Share Video">
        <svg style="transform: translateX(-1px);" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
      </button>` : '';

    const adminMenu = canEditVideo(currentVideo) ? `
      <div class="watch-admin-dropdown-wrap">
        <button class="btn-action icon-only" id="watch-admin-menu-btn" type="button" title="Video Options" aria-label="Video Options">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
        </button>
        <div class="watch-admin-menu" id="watch-admin-menu">
          <button class="dropdown-item" id="menu-settings-btn" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Video Settings
          </button>
          <button class="dropdown-item" id="menu-debug-btn" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
            Debug Console
          </button>
        </div>
      </div>` : '';

    const categoryLabel = video.category === 'livestream' ? 'Live Stream' : 'Video';
    const viewsStr = `${video.view_count.toLocaleString()} view${video.view_count !== 1 ? 's' : ''}`;
    
    const dateStr = formatVideoDate(video);
    
    const sizeTag = video.file_size ? `<span class="meta-tag">${formatFileSize(video.file_size)}</span>` : '';
    const durationTag = video.duration ? `<span class="meta-tag">${formatDuration(video.duration)}</span>` : '';
    const descHtml = video.description
      ? `<div class="description-text">${linkifyTimestamps(escHtml(video.description))}</div>`
      : '';

    const chaptersBtn = currentChapters && currentChapters.length > 0 ? `
      <button class="btn-action icon-only" id="watch-chapters-btn" type="button" title="Chapters" aria-label="Chapters">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
      </button>` : '';

    const chaptersChipBar = currentChapters && currentChapters.length > 0 ? `
      <div class="chapters-chip-bar" id="chapters-chip-bar">
        ${currentChapters.map(ch => `
          <button class="chapter-chip" data-time="${ch.time}" type="button">
            <span class="chapter-chip-time">${ch.timeStr}</span>
            <span class="chapter-chip-title">${escHtml(ch.title)}</span>
          </button>
        `).join('')}
      </div>` : '';

    infoEl.innerHTML = `
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">
        <h1 class="video-info-title">
          ${escHtml(video.title)}
          ${video.is_vhs ? `<svg class="vhs-title-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-left: 4px; color: var(--text-muted);" title="VHS Video"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><line x1="10" y1="12" x2="14" y2="12"/></svg>` : ''}
        </h1>
        ${video.category === 'livestream'
          ? (video.is_currently_live
              ? `<span class="badge-live">LIVE</span>`
              : `<span class="badge-live-archive"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Live Archive</span>`)
          : ''}
      </div>

      <div class="video-owner-row">
        <a href="/?channelId=${video.channel_id || 'main'}" class="owner-left" style="text-decoration: none; color: inherit; cursor: pointer;">
          <div class="owner-avatar">
            ${authorAvatar ? `<img src="${authorAvatar}" alt="Channel Avatar" />` : authorInitial}
          </div>
          <div class="owner-meta">
            <span class="owner-name">${escHtml(authorName)}</span>
          </div>
        </a>
        <div class="video-actions">
          <button class="btn-action icon-only ${isFav ? 'favorite-active' : ''}" id="watch-favorite-btn" type="button" aria-pressed="${isFav ? 'true' : 'false'}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
            ${isFav ? favIconFilled : favIconOutline}
          </button>
          ${downloadBtn}
          ${shareBtn}
          ${chaptersBtn}
          ${adminMenu}
        </div>
      </div>

      ${chaptersChipBar}
      <div class="description-box">
        <div class="description-meta">
          <div class="meta-text-group">
            <span>${viewsStr}</span>
            <span>${dateStr}</span>
          </div>
          <div class="meta-chips-group">
            ${durationTag}
            ${sizeTag}
          </div>
        </div>
        ${descHtml}
        ${video.location ? `
        <div class="video-location-container">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="location-pin-icon"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
          <span class="video-location-text">${escHtml(video.location)}</span>
        </div>` : ''}
      </div>

      <div id="video-people-tags" class="video-people-tags"></div>
    `;

    document.getElementById('watch-favorite-btn')?.addEventListener('click', async () => {
      try {
        const isNowFav = await toggleFavorite(video.id);
        renderVideoInfo(video);
        if (isNowFav) {
          const newBtn = document.getElementById('watch-favorite-btn');
          if (newBtn) {
            newBtn.classList.remove('animate-pop');
            void newBtn.offsetWidth; // trigger reflow
            newBtn.classList.add('animate-pop');
          }
        }
      } catch (err) {
        toast(err.message || 'Failed to update favorite.', 'error');
      }
    });

    document.getElementById('watch-chapters-btn')?.addEventListener('click', () => {
      document.getElementById('chapters-chip-bar')?.classList.toggle('show');
    });

    document.querySelectorAll('.chapter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const time = parseInt(btn.dataset.time, 10);
        if (!isNaN(time) && player) {
          player.currentTime(time);
        }
      });
    });

    if (canEditVideo(currentVideo)) {
      const menuBtn = document.getElementById('watch-admin-menu-btn');
      const menu = document.getElementById('watch-admin-menu');

      menuBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        menu?.classList.toggle('show');
      });

      if (!document.body.dataset.watchAdminMenuBound) {
        document.body.dataset.watchAdminMenuBound = '1';
        document.addEventListener('click', (e) => {
          const activeMenu = document.getElementById('watch-admin-menu');
          const activeBtn = document.getElementById('watch-admin-menu-btn');
          if (!activeMenu || !activeBtn) return;
          if (activeMenu.contains(e.target) || activeBtn.contains(e.target)) return;
          activeMenu.classList.remove('show');
        });
      }

      document.getElementById('menu-settings-btn')?.addEventListener('click', () => {
        menu?.classList.remove('show');
        openVideoAdminPopup(video.id);
      });

      document.getElementById('menu-debug-btn')?.addEventListener('click', () => {
        menu?.classList.remove('show');
        window.toggleDebugPanel();
      });

      document.getElementById('watch-share-btn')?.addEventListener('click', async () => {
        try {
          const checkRes = await api(`/api/videos/${video.id}/share`);
          let shareToken = checkRes.token;
          
          const action = prompt(
            shareToken 
              ? `This video is shared! Link: \n${window.location.origin}/share/${shareToken}\n\nType 'revoke' to disable this link, or click OK to close.`
              : 'This video is not shared yet. Type "share" to create a public link.'
          );
          
          if (action && action.trim().toLowerCase() === 'revoke' && shareToken) {
            await api(`/api/videos/${video.id}/share`, { method: 'DELETE' });
            toast('Share link revoked successfully.');
          } else if (action && action.trim().toLowerCase() === 'share' && !shareToken) {
            const createRes = await api(`/api/videos/${video.id}/share`, { method: 'POST' });
            prompt('Video shared successfully! Copy your link:', `${window.location.origin}/share/${createRes.token}`);
          }
        } catch (err) {
          toast(err.message || 'Error managing share link', 'error');
        }
      });
    }

    document.title = `${video.title} — ${window.APP_NAME || 'Spool'}`;
    const overlayTitleEl = document.getElementById('overlay-video-title');
    if (overlayTitleEl) {
      overlayTitleEl.innerHTML = (video.title ? escHtml(video.title) : 'Untitled') + 
        (video.is_vhs ? ` <svg class="vhs-title-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: text-bottom; margin-left: 4px; color: var(--text-muted);" title="VHS Video"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><line x1="10" y1="12" x2="14" y2="12"/></svg>` : '');
    }

    // Load people tags async
    loadVideoPeopleTags(video.id);
  }

  async function loadVideoPeopleTags(vid) {
    const container = document.getElementById('video-people-tags');
    if (!container) return;
    try {
      const people = await api(`/api/videos/${vid}/people`);
      if (!people.length) { container.style.display = 'none'; return; }
      container.style.display = 'block';
      const token = getToken();

      container.innerHTML = `
        <div class="people-tags-label">In this video</div>
        <div class="people-tags-list" id="people-tags-list"></div>
        <div class="person-spotlight-card" id="person-spotlight"></div>`;

      const listEl = document.getElementById('people-tags-list');
      const spotlightEl = document.getElementById('person-spotlight');

      const personFullName = (p) =>
        `${p?.name || ''} ${p?.second_name || ''} ${p?.surname || ''}`.replace(/\s+/g, ' ').trim() || 'Unknown';

      const personImageSrc = (p) => {
        if (p?.vhs_photo_id) {
          return `/api/people/${p.id}/vhs-photos/${p.vhs_photo_id}/image?${getAuthQueryString()}`;
        }
        if (p?.image_path) {
          return `/api/people/${p.id}/image?${getAuthQueryString()}`;
        }
        return null;
      };


      listEl.innerHTML = people.map((p) => {
        const firstName = (p.name || '').trim() || 'Unknown';
        const fullName = personFullName(p);
        const imgSrc = personImageSrc(p);
        const avatarInner = imgSrc
          ? `<img src="${imgSrc}" alt="${escHtml(firstName)}" />`
          : escHtml((firstName || '?')[0].toUpperCase());
        return `<div class="person-tag-chip" data-person-id="${p.id}" role="button" tabindex="0" aria-label="View details for ${escHtml(fullName)}">
          <div class="chip-avatar">${avatarInner}</div>
          <span class="chip-name">${escHtml(firstName)}</span>
        </div>`;
      }).join('');

      const personMap = new Map(people.map((p) => [String(p.id), p]));

      listEl.querySelectorAll('.person-tag-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const pid = String(chip.dataset.personId || '');
          const person = personMap.get(pid);
          if (!person) return;

          const allChips = listEl.querySelectorAll('.person-tag-chip');

          if (spotlightEl.dataset.activeId === pid) {
            // Same chip — toggle off
            spotlightEl.classList.remove('show');
            spotlightEl.dataset.activeId = '';
            allChips.forEach(c => c.classList.remove('active'));
            return;
          }

          allChips.forEach(c => c.classList.remove('active'));
          chip.classList.add('active');

          const fullName = personFullName(person);
          const imgSrc = personImageSrc(person);
          const avatarInner = imgSrc
            ? `<img src="${imgSrc}" alt="${escHtml(fullName)}" />`
            : escHtml((person.name || '?')[0].toUpperCase());

          const bioHtml = (person.bio || 'No biography available.')
            .split('\n')
            .filter(p => p.trim())
            .map(p => `<p>${escHtml(p)}</p>`)
            .join('');

          spotlightEl.innerHTML = `
            <div class="spotlight-avatar">${avatarInner}</div>
            <div class="spotlight-info">
              <div class="spotlight-name">${escHtml(fullName)}</div>
              <div class="spotlight-bio">${bioHtml}</div>
              <div class="spotlight-actions">
                <button class="btn btn-primary btn-sm" id="spotlight-view-btn" type="button">
                  More with ${escHtml((person.name || '').trim() || fullName)}
                </button>
              </div>
            </div>`;

          document.getElementById('spotlight-view-btn')?.addEventListener('click', () => {
            const personNameQuery = encodeURIComponent(fullName);
            window.location.href = `/index.html?personId=${encodeURIComponent(String(person.id))}&person_name=${personNameQuery}&from=people`;
          });

          spotlightEl.dataset.activeId = pid;
          spotlightEl.classList.add('show');

          if (window.innerWidth < 768) {
            spotlightEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
      });
    } catch {
      container.innerHTML = '';
    }
  }

  window.refreshWatchPeopleTags = function () {
    loadVideoPeopleTags(videoId);
  };

  function ensurePersonDetailsModal() {
    if (document.getElementById('person-details-modal')) return;
    const html = `
      <div class="modal-overlay" id="person-details-modal">
        <div class="modal person-details-modal">
          <div class="modal-header">
            <h3>Person Details</h3>
            <button class="btn-icon" id="person-details-close" type="button" aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="person-details-content">
            <div class="person-details-avatar" id="person-details-avatar">?</div>
            <div class="person-details-name" id="person-details-name">Unknown</div>
            <div class="person-details-bio" id="person-details-bio">No bio available.</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" id="person-details-more" type="button">More videos with this person</button>
            <button class="btn btn-ghost" id="person-details-ok" type="button">Close</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('person-details-close')?.addEventListener('click', () => closeModal('person-details-modal'));
    document.getElementById('person-details-ok')?.addEventListener('click', () => closeModal('person-details-modal'));
    document.getElementById('person-details-more')?.addEventListener('click', () => {
      const modal = document.getElementById('person-details-modal');
      const pid = Number(modal?.dataset?.personId || 0);
      const pname = String(modal?.dataset?.personName || '');
      if (!Number.isInteger(pid) || pid <= 0) return;
      goToBrowse({ mode: 'browse', category: 'all', personId: pid, personName: pname });
    });
    document.getElementById('person-details-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('person-details-modal');
    });
  }

  function openPersonDetailsModal(person) {
    ensurePersonDetailsModal();

    const modalEl = document.getElementById('person-details-modal');
    const nameEl = document.getElementById('person-details-name');
    const bioEl = document.getElementById('person-details-bio');
    const avatarEl = document.getElementById('person-details-avatar');
    const moreBtn = document.getElementById('person-details-more');
    if (!nameEl || !bioEl || !avatarEl) return;

    const token = getToken();
    const name = String(person?.name || 'Unknown');
    const bio = String(person?.bio || '').trim();
    const initial = (name[0] || '?').toUpperCase();

    if (modalEl) {
      modalEl.dataset.personId = String(Number(person?.id || 0) || 0);
      modalEl.dataset.personName = name;
    }
    if (moreBtn) {
      moreBtn.textContent = `More videos with ${name}`;
    }

    const fullName = `${person?.name || 'Unknown'} ${person?.second_name || ''} ${person?.surname || ''}`.trim();
    nameEl.textContent = fullName;
    if (bio) {
      bioEl.innerHTML = bio.split('\n')
        .filter(p => p.trim())
        .map(p => `<p>${escHtml(p)}</p>`)
        .join('');
    } else {
      bioEl.innerHTML = '<p>No bio available.</p>';
    }

    if (person?.image_path) {
      avatarEl.innerHTML = `<img src="/api/people/${person.id}/image?${getAuthQueryString()}" class="person-details-img" alt="${escHtml(name)}" />`;
    } else {
      avatarEl.textContent = initial;
    }

    openModal('person-details-modal');
  }

  function buildUpNextOrder(payload) {
    const list = normalizeVideoList(payload);
    const currentIndex = list.findIndex((v) => Number(v.id) === Number(videoId));
    if (currentIndex < 0) return list;
    // Reorder so the next video in sequence is at index 0
    return [...list.slice(currentIndex + 1), ...list.slice(0, currentIndex)];
  }

  // ── Render "Up Next" sidebar ───────────────────────────────────────────────
  function renderUpNext(videos) {
    const el = document.getElementById('up-next');
    if (!el) return;

    // Filter out current video and limit results
    const others = videos.filter((v) => Number(v.id) !== Number(videoId)).slice(0, 12);
    upNextQueue = others;
    
    const aside = document.getElementById('up-next-aside');
    if (!others.length) { 
      if (aside) aside.style.display = 'none';
      return; 
    }
    if (aside) aside.style.display = '';

    const token = getToken();
    el.innerHTML = others.map((v) => {
        const targetUrl = nextVideoUrl(v.id);
        const dateLabel = formatVideoDate(v);
        const durationLabel = v.duration ? formatDuration(v.duration) : '';
        return `
        <div class="mini-card" onclick="navigateToVideo(${v.id})" role="button" tabindex="0" data-video-id="${v.id}">
          <div class="mini-thumb">
            ${v.thumbnail_path
              ? `<img src="/api/videos/${v.id}/thumbnail?${getAuthQueryString()}${v.updated_at ? `&t=${encodeURIComponent(v.updated_at)}` : ''}" alt="${escHtml(v.title)}" />`
              : `<div class="thumb-placeholder">▶</div>`
            }
            ${durationLabel ? `<span class="mini-duration-badge">${escHtml(durationLabel)}</span>` : ''}
          </div>
          <div class="mini-info">
            <p class="mini-title">
              ${escHtml(v.title)}
              ${v.is_vhs ? `<svg class="vhs-title-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: text-bottom; margin-left: 4px; color: var(--text-muted);" title="VHS Video"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><line x1="10" y1="12" x2="14" y2="12"/></svg>` : ''}
            </p>
            <a href="/?channelId=${v.channel_id || 'main'}" class="mini-channel-name" style="text-decoration: none; color: var(--text-secondary); font-size: 0.85rem; display: block; margin-bottom: 2px; transition: color 0.2s;" onclick="event.stopPropagation();">
              ${escHtml(v.channel_name || (v.channel_id ? 'Channel' : 'Mysticle Archive'))}
            </a>
            <p class="mini-meta">${escHtml(dateLabel)}</p>
          </div>
        </div>`;
      }).join('');

    bindAutoplayToggle();
    syncAutoplayToggleUi();
    setupHoverPreview();
  }

  function setupHoverPreview() {
    const FORCE_DIRECT_PLAY_KEY = 'forceDirectPlay';
    const container = document.getElementById('up-next');
    if (!container) return;

    if (!localStorage.getItem(FORCE_DIRECT_PLAY_KEY)) {
      localStorage.setItem(FORCE_DIRECT_PLAY_KEY, '1');
    }

    function isForceDirectPlayForPreviews() {
      if (!isAdmin()) return true;
      return localStorage.getItem(FORCE_DIRECT_PLAY_KEY) === '1';
    }

    let hoverCard = null;
    let hoverDelayTimer = null;
    let previewStopTimer = null;

    function clearPreview(card) {
      if (hoverDelayTimer) { clearTimeout(hoverDelayTimer); hoverDelayTimer = null; }
      if (previewStopTimer) { clearTimeout(previewStopTimer); previewStopTimer = null; }
      if (card) {
        const vid = card.querySelector('.hover-preview');
        if (vid) { vid.pause(); vid.src = ''; vid.remove(); }
      }
    }

    // Only attach once
    if (container.dataset.hoverBound) return;
    container.dataset.hoverBound = 'true';

    container.addEventListener('mouseover', (e) => {
      const card = e.target.closest('.mini-card');
      if (!card || card === hoverCard) return;

      clearPreview(hoverCard);
      hoverCard = card;

      if (!isForceDirectPlayForPreviews()) return;

      const videoId = card.dataset.videoId;
      if (!videoId) return;

      hoverDelayTimer = setTimeout(() => {
        hoverDelayTimer = null;
        const thumb = card.querySelector('.mini-thumb');
        if (!thumb || card !== hoverCard) return;

        const src = `/api/videos/${videoId}/stream?preview=1&${getAuthQueryString()}`;

        const vid = document.createElement('video');
        vid.className = 'hover-preview';
        vid.muted = true;
        vid.playsInline = true;
        vid.src = src;
        // Make it overlay the thumbnail nicely
        vid.style.position = 'absolute';
        vid.style.top = '0';
        vid.style.left = '0';
        vid.style.width = '100%';
        vid.style.height = '100%';
        vid.style.objectFit = 'cover';
        vid.style.borderRadius = '8px';
        vid.style.zIndex = '2';
        
        thumb.style.position = 'relative';
        thumb.appendChild(vid);
        vid.play().catch(() => {});

        previewStopTimer = setTimeout(() => {
          vid.pause();
          vid.src = '';
          vid.remove();
        }, 10000);
      }, 500);
    });

    container.addEventListener('mouseout', (e) => {
      if (!hoverCard) return;
      const relatedTarget = e.relatedTarget;
      if (hoverCard.contains(relatedTarget)) return;
      clearPreview(hoverCard);
      hoverCard = null;
    });
  }

  function shuffleVideos(list) {
    const arr = Array.isArray(list) ? [...list] : [];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ── Edit video modal (uploader/admin only) ──────────────────────────────────────────

  // ── Comments ───────────────────────────────────────────────────────────────
  let replyTargetCommentId = null;
  let replyLookup = new Map();
  let selectedGifUrl = null;
  const expandedCommentThreads = new Set();

  function ensureGifPickerModal() {
    if (document.getElementById('gif-picker-modal')) return;
    const html = `
      <div class="modal-overlay" id="gif-picker-modal">
        <div class="modal gif-picker-modal">
          <div class="modal-header">
            <h3>Select GIF</h3>
            <button class="btn-icon" id="gif-picker-close" type="button">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="gif-picker-search-wrap">
            <div class="search-bar-wrapper">
              <input type="text" id="gif-picker-search" placeholder="Search Klipy..." autocomplete="off" />
              <button class="search-btn" id="gif-picker-search-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
            </div>
          </div>
          <div class="gif-picker-content">
            <div class="gif-picker-grid" id="gif-picker-grid"></div>
            <p id="gif-picker-error" class="form-error"></p>
          </div>
          <div class="gif-picker-footer">
            <span class="gif-attribution">Powered by <strong>KLIPY</strong></span>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('gif-picker-close')?.addEventListener('click', () => closeModal('gif-picker-modal'));
    document.getElementById('gif-picker-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('gif-picker-modal');
    });

    const runSearch = () => {
      const query = document.getElementById('gif-picker-search')?.value?.trim() || '';
      loadGifResults(query);
    };
    document.getElementById('gif-picker-search-btn')?.addEventListener('click', runSearch);
    document.getElementById('gif-picker-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch();
      }
    });
  }

  function setSelectedGif(url) {
    selectedGifUrl = url || null;
    
    // 1. Grab the elements we need to update
    const preview = document.getElementById('comment-gif-preview');
    const removeBtn = document.getElementById('comment-gif-remove');
    const submitBtn = document.getElementById('comment-submit');
    const inputEl = document.getElementById('comment-input');
    const actionsEl = document.getElementById('comment-form-actions');

    // 2. Automatically show the submit button row and enable/disable it based on text OR gif
    if (submitBtn && inputEl) {
      submitBtn.disabled = inputEl.value.trim().length === 0 && !selectedGifUrl;
    }
    if (selectedGifUrl && actionsEl) {
      actionsEl.style.display = 'block';
    }

    if (!preview || !removeBtn) return;

    // 3. Update the visual GIF preview
    if (!selectedGifUrl) {
      preview.innerHTML = '';
      preview.style.display = 'none';
      removeBtn.style.display = 'none';
      return;
    }

    preview.innerHTML = `<img src="${selectedGifUrl}" alt="Selected GIF" loading="lazy" decoding="async" />`;
    preview.style.display = 'block';
    removeBtn.style.display = 'inline-flex';
  }

  const CLIENT_FALLBACK_GIFS = [
    { id: 'c-fallback-1', title: 'Happy', url: 'https://media.tenor.com/eY6m0a4q4mUAAAAM/happy-dance.gif' },
    { id: 'c-fallback-2', title: 'Wow', url: 'https://media.tenor.com/eV9N9Jw2j6kAAAAM/wow-oh-wow.gif' },
    { id: 'c-fallback-3', title: 'LOL', url: 'https://media.tenor.com/X3xMIBqQ9S4AAAAM/laughing-lol.gif' },
    { id: 'c-fallback-4', title: 'Thumbs up', url: 'https://media.tenor.com/2roX3uxz_68AAAAM/thumbs-up.gif' },
    { id: 'c-fallback-5', title: 'Cute', url: 'https://media.tenor.com/3ZZiQf9i4GgAAAAM/cute-cat.gif' },
  ];

  function renderGifCards(grid, items) {
    if (!items.length) {
      grid.innerHTML = '<p class="vap-empty">No GIFs found.</p>';
      return;
    }

    const cards = items
      .map((item) => {
        const tiny = item?.url || '';
        if (!tiny) return '';
        return `<button class="gif-picker-item" type="button" data-gif-url="${tiny}" aria-label="Select GIF">
          <img src="${tiny}" alt="GIF" loading="lazy" decoding="async" />
        </button>`;
      })
      .join('');

    grid.innerHTML = cards || '<p class="vap-empty">No GIFs found.</p>';
    grid.querySelectorAll('.gif-picker-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        setSelectedGif(btn.dataset.gifUrl || '');
        closeModal('gif-picker-modal');
      });
    });
  }

  async function loadGifResults(query = '') {
    const grid = document.getElementById('gif-picker-grid');
    const errEl = document.getElementById('gif-picker-error');
    if (!grid || !errEl) return;

    errEl.textContent = '';
    grid.innerHTML = '<div class="state-loading" style="padding:1rem"><span>Loading GIFs...</span></div>';

    try {
      const endpoint = query
        ? `/api/gifs?q=${encodeURIComponent(query)}&limit=24`
        : '/api/gifs?limit=24';

      const token = getToken();
      const res = await fetch(endpoint, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) {
        let responsePreview = '';
        try {
          responsePreview = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
        } catch {
          responsePreview = '[unreadable response body]';
        }
        console.error('[GIF] Endpoint failed', {
          endpoint,
          status: res.status,
          statusText: res.statusText,
          body: responsePreview,
        });

        errEl.textContent = `GIF service is unavailable right now (HTTP ${res.status}). Showing emergency fallback GIFs.`;
        renderGifCards(grid, CLIENT_FALLBACK_GIFS);
        return;
      }

      const data = await res.json();
      console.info('[GIF] Endpoint response', {
        endpoint,
        provider: data.provider,
        degraded: !!data.degraded,
        reason: data.reason || null,
        request_id: data.request_id || null,
        count: Array.isArray(data.gifs) ? data.gifs.length : 0,
      });
      const items = Array.isArray(data.gifs) ? data.gifs : [];

      if (data.degraded) {
        errEl.textContent = `GIF provider is limited right now, showing fallback GIFs. Ref: ${data.request_id || 'n/a'}`;
        console.warn('[GIF] Degraded mode active', {
          reason: data.reason || 'unknown',
          request_id: data.request_id || null,
        });
      }

      renderGifCards(grid, items);
    } catch (err) {
      renderGifCards(grid, CLIENT_FALLBACK_GIFS);
      console.error('[GIF] Failed to load GIFs', {
        query,
        message: err?.message || String(err),
      });
      errEl.textContent = `${err.message || 'Failed to load GIFs.'} Showing emergency fallback GIFs.`;
    }
  }

  function ensureGifControls() {
    const form = document.getElementById('comment-form');
    const actions = document.querySelector('#comment-form .comment-actions');
    if (!form || !actions) return;

    if (!document.getElementById('comment-gif-preview')) {
      form.insertAdjacentHTML('beforeend', `
        <div class="comment-gif-preview" id="comment-gif-preview" style="display:none"></div>
      `);
    }

    if (!document.getElementById('comment-gif-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'comment-gif-btn';
      btn.className = 'comment-btn';
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg> GIF`;
      actions.insertBefore(btn, document.getElementById('comment-submit'));
    }

    if (!document.getElementById('comment-gif-remove')) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.id = 'comment-gif-remove';
      removeBtn.className = 'btn btn-danger btn-sm';
      removeBtn.textContent = 'Remove GIF';
      removeBtn.style.display = 'none';
      actions.insertBefore(removeBtn, document.getElementById('comment-submit'));
    }

    document.getElementById('comment-gif-btn')?.addEventListener('click', async () => {
      ensureGifPickerModal();
      openModal('gif-picker-modal');
      const input = document.getElementById('gif-picker-search');
      if (input) input.value = '';
      await loadGifResults('');
    });

    document.getElementById('comment-gif-remove')?.addEventListener('click', () => setSelectedGif(null));
  }

  function ensureReplyIndicator() {
    const group = document.querySelector('#comment-form .comment-form-group');
    if (!group) return;

    const existing = document.getElementById('comment-reply-target');
    if (existing && !group.contains(existing)) {
      group.insertBefore(existing, group.firstChild);
      return;
    }
    if (existing) return;
    const html = `
      <div id="comment-reply-target" class="comment-reply-target" style="display:none">
        <span id="comment-reply-label"></span>
        <button type="button" class="btn btn-ghost btn-sm" id="comment-reply-cancel">Cancel</button>
      </div>`;
    group.insertAdjacentHTML('afterbegin', html);
    document.getElementById('comment-reply-cancel')?.addEventListener('click', clearReplyTarget);
  }

  function expandCommentThreadAncestors(commentId) {
    let node = replyLookup.get(commentId);
    while (node) {
      expandedCommentThreads.add(node.id);
      node = node.parent_comment_id ? replyLookup.get(node.parent_comment_id) : null;
    }
  }

  function countAllReplies(comment) {
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    return replies.reduce((sum, child) => sum + 1 + countAllReplies(child), 0);
  }

  function setReplyTarget(commentId) {
    if (!currentUser) return promptLogin();
    const comment = replyLookup.get(commentId);
    if (!comment) return;

    expandCommentThreadAncestors(commentId);
    replyTargetCommentId = commentId;
    const replyTarget = document.getElementById('comment-reply-target');
    const replyLabel = document.getElementById('comment-reply-label');
    const input = document.getElementById('comment-input');
    const submit = document.getElementById('comment-submit');
    const actions = document.getElementById('comment-form-actions');

    if (replyTarget && replyLabel) {
      const author = comment.display_name || comment.username || 'User';
      replyLabel.textContent = `Replying to ${author}`;
      replyTarget.style.display = 'flex';
    }
    if (input) {
      input.placeholder = 'Write your reply...';
      input.style.minHeight = '60px';
      input.focus();
    }
    if (actions) actions.style.display = 'block';
    if (submit) submit.textContent = 'Reply';
  }

  function clearReplyTarget() {
    replyTargetCommentId = null;
    const replyTarget = document.getElementById('comment-reply-target');
    const input = document.getElementById('comment-input');
    const submit = document.getElementById('comment-submit');
    if (replyTarget) replyTarget.style.display = 'none';
    if (input) input.placeholder = 'Add a comment...';
    if (submit) submit.textContent = 'Comment';
  }

  function buildCommentTree(comments) {
    const nodes = comments.map((c) => ({ ...c, replies: [] }));
    const byId = new Map(nodes.map((c) => [c.id, c]));
    const roots = [];

    for (const node of nodes) {
      if (node.parent_comment_id && byId.has(node.parent_comment_id)) {
        byId.get(node.parent_comment_id).replies.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  const COMMENT_REPLY_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 19.5 4 22V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-3.5 2.5Z"/></svg>`;
  const COMMENT_DELETE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
  const COMMENT_REPLY_CONNECTOR = `<svg class="comment-replies-connector" viewBox="0 0 48 100" preserveAspectRatio="none" fill="none" aria-hidden="true"><path d="M14 8V84Q14 97 30 97H48" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;

  function renderCommentNode(comment, depth = 0) {
    const canEdit = comment.user_id === currentUser?.id;
    const canDelete = isAdmin() || comment.user_id === currentUser?.id;
    const hasLiked = Boolean(comment.viewer_liked);
    const hasHearted = Boolean(comment.viewer_hearted);
    const likeCount = Number(comment.like_count || 0);
    const heartCount = Number(comment.heart_count || 0);
    const likeIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${hasLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>`;
    const heartIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${hasHearted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
    const author = comment.display_name || comment.username || 'User';
    const authorInitial = (author[0] || '?').toUpperCase();
    const edited = comment.updated_at ? ' • <span class="comment-edited">edited</span>' : '';
    const token = getToken();
    const avatarUrl = comment.user_id && token
      ? `/api/users/avatar/${comment.user_id}?${getAuthQueryString()}&t=${Date.now()}`
      : null;
    const safeContent = linkifyTimestamps(escHtml(comment.content || ''));
    const gifHtml = comment.gif_url
      ? `<div class="comment-gif-wrap"><img class="comment-gif" src="${escHtml(comment.gif_url)}" alt="Comment GIF" loading="lazy" decoding="async" /></div>`
      : '';
    const fallbackExpr = JSON.stringify(authorInitial);
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    const replyCount = countAllReplies(comment);
    const isExpanded = expandedCommentThreads.has(comment.id);
    const replyToggleLabel = isExpanded
      ? 'Hide replies'
      : `${replyCount} ${replyCount === 1 ? 'Reply' : 'Replies'}`;

    return `
      <div class="comment-thread" id="comment-${comment.id}" data-comment-id="${comment.id}">
        <div class="comment-item${replyCount > 0 ? ' has-replies-toggle' : ''}">
          <div class="comment-avatar">
            ${avatarUrl
              ? `<img src="${avatarUrl}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.parentNode.textContent=${fallbackExpr}" />`
              : escHtml(authorInitial)}
          </div>
          <div class="comment-content-wrap">
            <div class="comment-header">
              <span class="comment-author">${escHtml(author)}</span>
              <span class="comment-date">${formatDate(comment.created_at)}${edited}</span>
            </div>
            ${safeContent ? `<p class="comment-text">${safeContent}</p>` : ''}
            ${gifHtml}
            <div class="comment-actions">
              <button class="comment-btn reaction-btn ${hasLiked ? 'active' : ''}" type="button" onclick="toggleCommentReaction(${comment.id}, 'like')" title="Like">
                ${likeIcon} <span>${likeCount > 0 ? likeCount : ''}</span>
              </button>
              <button class="comment-btn comment-btn-icon" type="button" onclick="replyToComment(${comment.id})" title="Reply" aria-label="Reply">${COMMENT_REPLY_ICON}</button>
              ${isAdmin() ? `
                <button class="comment-btn heart-btn ${hasHearted ? 'active' : ''}" type="button" onclick="toggleCommentReaction(${comment.id}, 'heart')" title="Heart">
                  ${heartIcon} <span>${heartCount > 0 ? heartCount : ''}</span>
                </button>` : ''}
              ${canEdit ? `<button class="comment-btn comment-btn-icon" type="button" onclick="editComment(${comment.id})" title="Edit" aria-label="Edit"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>` : ''}
              ${canDelete ? `<button class="comment-btn comment-btn-icon danger" type="button" onclick="removeComment(${comment.id})" title="Delete" aria-label="Delete">${COMMENT_DELETE_ICON}</button>` : ''}
            </div>
          </div>
          ${replyCount > 0 ? `
            ${COMMENT_REPLY_CONNECTOR}
            <div class="comment-replies-branch">
              <button
                class="comment-replies-toggle"
                type="button"
                data-comment-id="${comment.id}"
                data-reply-count="${replyCount}"
                aria-expanded="${isExpanded ? 'true' : 'false'}"
              >
                <span class="comment-replies-toggle-label">${escHtml(replyToggleLabel)}</span>
              </button>
            </div>` : ''}
        </div>
        ${replyCount > 0 ? `
          <div class="comment-replies${isExpanded ? '' : ' is-collapsed'}">
            ${replies.map((reply) => renderCommentNode(reply, depth + 1)).join('')}
          </div>` : ''}
      </div>
    `;
  }

  const COMMENT_CONNECTOR_AVATAR_GAP = 6;

  function positionCommentConnectors() {
    document.querySelectorAll('.comment-item.has-replies-toggle').forEach((item) => {
      const avatar = item.querySelector('.comment-avatar');
      const toggle = item.querySelector('.comment-replies-toggle');
      const connector = item.querySelector('.comment-replies-connector');
      if (!avatar || !toggle || !connector) return;

      const itemRect = item.getBoundingClientRect();
      const avatarRect = avatar.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();

      const top = Math.round(avatarRect.bottom - itemRect.top + COMMENT_CONNECTOR_AVATAR_GAP);
      const toggleCenterY = toggleRect.top + toggleRect.height / 2 - itemRect.top;
      const height = Math.max(Math.round(toggleCenterY - top), 8);

      connector.style.top = `${top}px`;
      connector.style.height = `${height}px`;
      connector.style.bottom = 'auto';
    });
  }

  function scheduleCommentConnectorLayout() {
    requestAnimationFrame(() => {
      requestAnimationFrame(positionCommentConnectors);
    });
  }

  function setupCommentsListInteractions() {
    const list = document.getElementById('comments-list');
    if (!list || list.dataset.boundReplies === '1') return;
    list.dataset.boundReplies = '1';

    if (!window.__maCommentConnectorResizeBound) {
      window.__maCommentConnectorResizeBound = true;
      window.addEventListener('resize', () => {
        clearTimeout(window.__maCommentConnectorResizeTimer);
        window.__maCommentConnectorResizeTimer = setTimeout(positionCommentConnectors, 100);
      });
    }

    list.addEventListener('click', (event) => {
      const toggle = event.target.closest('.comment-replies-toggle');
      if (!toggle) return;
      event.preventDefault();

      const commentId = Number(toggle.dataset.commentId);
      if (!Number.isInteger(commentId)) return;

      const thread = toggle.closest('.comment-thread');
      const replies = thread?.querySelector(':scope > .comment-replies');
      const label = toggle.querySelector('.comment-replies-toggle-label');
      const count = Number(toggle.dataset.replyCount) || 0;
      const willExpand = !expandedCommentThreads.has(commentId);

      if (willExpand) expandedCommentThreads.add(commentId);
      else expandedCommentThreads.delete(commentId);

      replies?.classList.toggle('is-collapsed', !willExpand);
      toggle.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
      if (label) {
        label.textContent = willExpand
          ? 'Hide replies'
          : `${count} ${count === 1 ? 'Reply' : 'Replies'}`;
      }
      scheduleCommentConnectorLayout();
    });
  }

  async function loadComments() {
    const list = document.getElementById('comments-list');
    const count = document.getElementById('comments-count');
    if (!list || !count) return;

    try {
      const comments = await api(`/api/videos/${videoId}/comments`);
      count.textContent = String(comments.length);
      replyLookup = new Map(comments.map((c) => [c.id, c]));

      if (!comments.length) {
        list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No comments yet.</p>';
        return;
      }

      const roots = buildCommentTree(comments);
      list.innerHTML = roots.map((comment) => renderCommentNode(comment)).join('');
      setupCommentsListInteractions();
      scheduleCommentConnectorLayout();
    } catch (err) {
      list.innerHTML = `<p style="color:var(--danger);font-size:0.85rem">Failed to load comments: ${escHtml(err.message)}</p>`;
    }
  }

  async function submitComment(content, parentCommentId = null, gifUrl = null) {
    if (parentCommentId) expandCommentThreadAncestors(parentCommentId);
    await api(`/api/videos/${videoId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, parent_comment_id: parentCommentId, gif_url: gifUrl }),
    });
    await loadComments();
  }

  window.replyToComment = function (commentId) {
    setReplyTarget(commentId);
  };

  window.editComment = async function (commentId) {
    const comment = replyLookup.get(commentId);
    if (!comment || comment.user_id !== currentUser?.id) {
      toast('You can only edit your own comments.', 'error');
      return;
    }

    const text = prompt('Edit your comment:');
    if (text === null) return;
    const content = text.trim();
    if (!content) {
      toast('Comment cannot be empty.', 'error');
      return;
    }

    try {
      await api(`/api/videos/${videoId}/comments/${commentId}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      });
      toast('Comment updated.');
      await loadComments();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.removeComment = async function (commentId) {
    if (!confirm('Delete this comment?')) return;
    try {
      await api(`/api/videos/${videoId}/comments/${commentId}`, { method: 'DELETE' });
      toast('Comment deleted.');
      await loadComments();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.toggleCommentReaction = async function (commentId, type) {
    if (!currentUser) return promptLogin();
    try {
      await api(`/api/videos/${videoId}/comments/${commentId}/reaction`, {
        method: 'POST',
        body: JSON.stringify({ type }),
      });
      await loadComments();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  document.getElementById('comment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('comment-input');
    const err = document.getElementById('comment-error');
    const submit = document.getElementById('comment-submit');
    if (!input || !submit || !err) return;

    err.textContent = '';
    const content = input.value.trim();
    if (!content && !selectedGifUrl) {
      err.textContent = 'Comment cannot be empty.';
      return;
    }

    submit.disabled = true;
    try {
      await submitComment(content, replyTargetCommentId, selectedGifUrl);
      input.value = '';
      setSelectedGif(null);
      clearReplyTarget();
      const actions = document.getElementById('comment-form-actions');
      if (actions) actions.style.display = 'none';
      input.style.minHeight = '';
      submit.disabled = true;
      toast('Comment posted.');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      if (input.value.trim() || selectedGifUrl) submit.disabled = false;
    }
  });

  const commentInput = document.getElementById('comment-input');
  const commentActions = document.getElementById('comment-form-actions');
  const commentSubmit = document.getElementById('comment-submit');
  const commentCancel = document.getElementById('comment-cancel');

  if (!currentUser) {
    const commentForm = document.getElementById('comment-form');
    if (commentForm) {
      commentForm.innerHTML = `
        <div style="padding: 16px; text-align: center; background: rgba(0,0,0,0.1); border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); margin-bottom: 24px;">
          <p style="margin: 0 0 12px 0; color: #aaa;">You must be signed in to add comments.</p>
          <a href="/login.html" class="btn btn-primary" style="display: inline-block; text-decoration: none;">Sign In</a>
        </div>
      `;
    }
  }

  commentInput?.addEventListener('focus', () => {
    if (commentActions) commentActions.style.display = 'block';
    commentInput.style.minHeight = '60px';
  });

  commentInput?.addEventListener('input', () => {
    if (!commentSubmit) return;
    commentSubmit.disabled = commentInput.value.trim().length === 0 && !selectedGifUrl;
  });

  commentCancel?.addEventListener('click', () => {
    if (!commentInput || !commentSubmit || !commentActions) return;
    commentInput.value = '';
    commentInput.style.minHeight = '';
    commentActions.style.display = 'none';
    commentSubmit.disabled = true;
    document.getElementById('comment-error').textContent = '';
    clearReplyTarget();
    setSelectedGif(null);
  });


  // ── Keyboard shortcut: Player controls & modals ──────────────────────────────
  function showCenterIcon(type, value) {
    const icon = document.getElementById('center-action-icon');
    if (!icon) return;
    
    if (type === 'play') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    } else if (type === 'pause') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    } else if (type === 'volume-up' || type === 'volume-down') {
      let iconPath = '';
      if (value === 0) iconPath = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>';
      else if (value < 0.5) iconPath = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
      else iconPath = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 12px;">${iconPath}</svg><div style="position: absolute; bottom: 8px; font-size: 13px; font-weight: 700;">${Math.round(value * 100)}%</div>`;
    }
    
    icon.classList.remove('animate');
    void icon.offsetWidth;
    icon.classList.add('animate');
  }

  function seekAndAnimate(side, delta) {
    if (!player) return;
    const current = Number(player.currentTime() || 0);
    const duration = Number(player.duration() || 0);
    let target = current + delta;
    if (Number.isFinite(duration) && duration > 0) {
      target = Math.min(Math.max(0, target), duration);
    } else {
      target = Math.max(0, target);
    }
    player.currentTime(target);

    const ripple = document.getElementById(`ripple-${side}`);
    if (ripple) {
      const label = ripple.querySelector('.dt-ripple-label');
      if (label) label.textContent = Math.abs(delta) + 's';
      
      ripple.classList.remove('animate');
      void ripple.offsetWidth;
      ripple.classList.add('animate');
    }
  }
  // Timestamp click handling
  document.addEventListener('click', (e) => {
    const tsLink = e.target.closest('.timestamp-link');
    if (tsLink && player) {
      e.preventDefault();
      const time = parseFloat(tsLink.dataset.time);
      if (!isNaN(time)) {
        player.currentTime(time);
        player.play();
        const videoContainer = document.querySelector('.video-container') || document.querySelector('#video-container');
        if (videoContainer) {
          videoContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const editModal = document.getElementById('video-settings-popup');
      const personModal = document.getElementById('person-details-modal');
      if (editModal?.classList.contains('open')) closeModal('video-settings-popup');
      if (personModal?.classList.contains('open')) closeModal('person-details-modal');
      return;
    }

    // Ignore player hotkeys if user is typing in an input
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

    if (!player) return;

    if (e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      
      const wasActive = player.userActive();
      if (!wasActive) player._suppressNextWake = true;

      if (player.paused()) {
        player.play();
        showCenterIcon('play');
      } else {
        player.pause();
        showCenterIcon('pause');
      }
      
      if (!wasActive) player.userActive(false);

    } else if (e.code === 'KeyA') {
      e.preventDefault();
      seekAndAnimate('left', -10);
    } else if (e.code === 'KeyD') {
      e.preventDefault();
      seekAndAnimate('right', 10);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      seekAndAnimate('left', -5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      seekAndAnimate('right', 5);
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      let vol = player.volume() + 0.05;
      if (vol > 1) vol = 1;
      player.volume(vol);
      player.muted(vol === 0);
      showCenterIcon('volume-up', vol);
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      let vol = player.volume() - 0.05;
      if (vol < 0) vol = 0;
      player.volume(vol);
      player.muted(vol === 0);
      showCenterIcon('volume-down', vol);
    }
  }, { capture: true });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });

  // ── Load video data ────────────────────────────────────────────────────────
  async function loadPage() {
    try {
      setupForceDirectToggle();
      bindAutoplayToggle();
      syncAutoplayToggleUi();
      ensureReplyIndicator();
      ensureGifControls();
      clearReplyTarget();

      const [video, listData, qualityData, seriesData, personData] = await Promise.all([
        api(`/api/videos/${videoId}`),
        currentUser ? api(`/api/videos?limit=40&page=1`).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
        api(`/api/videos/${videoId}/qualities`).catch(() => ({ qualities: [] })),
        seriesId ? api(`/api/series/${seriesId}/videos`).catch(() => null) : Promise.resolve(null),
        personId ? api(`/api/videos?limit=120&page=1&person_id=${personId}`).catch(() => null) : Promise.resolve(null),
        loadFavoriteIds(),
      ]);

      const progressData = currentUser ? await api(`/api/videos/${videoId}/progress`).catch(() => ({ position: 0 })) : { position: 0 };

      currentVideo = video;
      if (video.has_chapters) {
        try {
          currentChapters = video.chapters_json ? JSON.parse(video.chapters_json) : null;
        } catch (e) { currentChapters = null; }
      } else {
        currentChapters = null;
      }

      // Set quality list; auto-pick the highest available resolution.
      availableQualities = qualityData.qualities || [];
      if (availableQualities.length > 0) {
        const getQualityValue = (label) => {
          const normalizedLabel = String(label || '').toLowerCase();
          if (normalizedLabel === '4k') return 2160;
          return parseInt(normalizedLabel, 10) || 0;
        };

        availableQualities.sort((left, right) => getQualityValue(right.label) - getQualityValue(left.label));
        currentQuality = availableQualities[0].label;
        dbg('info', `Auto-selected highest resolution: ${currentQuality}`);
      } else {
        currentQuality = '1080p';
      }

      initPlayer(video);

      // Resume from last saved position
      if (progressData.position > 10) {
        player.one('loadedmetadata', () => {
          player.currentTime(progressData.position);
          toast(`Resumed from ${formatDuration(progressData.position)}`);
        });
      }

      renderVideoInfo(video);
      if (seriesId && seriesData) {
        autoplayContext = { type: 'series', label: 'Series' };
        renderUpNext(buildUpNextOrder(seriesData), autoplayContext);
      } else if (personId && personData) {
        autoplayContext = { type: 'person', label: personName ? `Person: ${personName}` : 'Person' };
        renderUpNext(buildUpNextOrder(personData), autoplayContext);
      } else {
        autoplayContext = { type: null, label: '' };
        // Outside of series, randomize Up Next each time a new watch page loads.
        renderUpNext(shuffleVideos(normalizeVideoList(listData)), autoplayContext);
      }
      await loadComments();
    } catch (err) {
      document.getElementById('video-info').innerHTML =
        `<p style="color:var(--danger)">Error loading video: ${escHtml(err.message)}</p>`;
    }
  }

  loadPage();

})();