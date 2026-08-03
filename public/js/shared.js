/* shared.js — utilities used across all pages */
'use strict';

// ── PWA: Service Worker + Install Prompt ─────────────────────────────────────
let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installBtn = document.getElementById('pwa-install-btn');
  if (installBtn) installBtn.style.display = 'flex';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── PWA: Reset browse state to home on fresh launch ──────────────────────────
(function () {
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  if (!isStandalone) return;

  if (!sessionStorage.getItem('pwa_session_active')) {
    sessionStorage.setItem('pwa_session_active', '1');
    localStorage.setItem('ma_browse_state', JSON.stringify({
      category: 'all',
      search: '',
      sort: 'name_asc',
      page: 1,
      mode: 'browse',
      personId: null,
      personName: '',
      seriesId: null,
      seriesName: '',
      specialChip: '',
    }));
  }
})();

// ── Dynamic App Name Initialization ───────────────────────────────────────────
if (window.APP_NAME && window.APP_NAME !== 'Spool') {
  document.title = document.title.replace('Spool', window.APP_NAME);
  window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.logo-text').forEach(el => {
      if (el.textContent === 'Spool') el.textContent = window.APP_NAME;
    });
  });
}

// ── HTML escaping (global) ────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem('ma_token'); }
function getUser()  { try { return JSON.parse(localStorage.getItem('ma_user')); } catch { return null; } }
function isAdmin()  { const user = getUser(); return user && user.role === 'admin'; }
function canEditVideo(video) {
  const user = getUser();
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (video && video.channel_id && user.channel_id === video.channel_id) return true;
  return false;
}
function requireAuth() {
  if (!getToken()) {
    location.replace('/login.html');
    return false;
  }
  return true;
}

function logout() {
  localStorage.removeItem('ma_token');
  localStorage.removeItem('ma_user');
  location.replace('/login.html');
}

// ── API wrapper ───────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const token = getToken();
  
  // Inject share_token into API requests if it's present in the URL
  const urlParams = new URLSearchParams(window.location.search);
  const shareToken = urlParams.get('share_token');
  if (shareToken) {
    const separator = path.includes('?') ? '&' : '?';
    path += `${separator}share_token=${encodeURIComponent(shareToken)}`;
  }

  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    if (shareToken) {
      throw new Error('Unauthorized');
    }
    logout();
    throw new Error('Unauthorized');
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Server error (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Toast notifications ───────────────────────────────────────────────────────
function toast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Formatting ────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Parses a filename/title to extract an embedded date (YYYYMMDD_).
 * Returns the cleaned title and the parsed date.
 */
function parseVideoData(rawTitle, fallbackDate) {
  const safeTitle = String(rawTitle || '');
  const normalizedTitle = safeTitle.replace(/^\uFEFF/, '').trimStart();
  // Accept YYYYMMDD followed by underscore, hyphen, or spaces.
  const dateMatch = normalizedTitle.match(/^(\d{4})(\d{2})(\d{2})[\s_-]+(.+)$/);

  if (dateMatch) {
    const [, yearStr, monthStr, dayStr, cleanedTitle] = dateMatch;
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    const extractedDate = new Date(year, month - 1, day);
    const isValidDate =
      extractedDate.getFullYear() === year &&
      extractedDate.getMonth() === month - 1 &&
      extractedDate.getDate() === day;

    if (isValidDate) {
      return {
        title: (cleanedTitle || '').trim() || normalizedTitle,
        displayDate: extractedDate,
      };
    }
  }

  const fallback = fallbackDate ? new Date(fallbackDate) : null;
  return {
    title: normalizedTitle || safeTitle,
    displayDate: fallback && !Number.isNaN(fallback.getTime()) ? fallback : null,
  };
}

function formatDate(dt) {
  if (!dt) return '—';
  const date = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { year:'numeric', month:'short', day:'numeric' });
}

const BROWSE_STATE_KEY = 'ma_browse_state';

function resetBrowseStateToHome() {
  localStorage.setItem(BROWSE_STATE_KEY, JSON.stringify({
    category: 'all',
    search: '',
    sort: 'name_asc',
    page: 1,
    mode: 'browse',
    personId: null,
    personName: '',
    seriesId: null,
    seriesName: '',
    specialChip: '',
  }));
}

function bindBrandHomeNavigation() {
  const brandLinks = document.querySelectorAll('.header-logo');
  brandLinks.forEach((link) => {
    if (link.dataset.homeBound === '1') return;
    link.dataset.homeBound = '1';
    link.addEventListener('click', () => {
      resetBrowseStateToHome();
    });
  });
}

document.addEventListener('DOMContentLoaded', bindBrandHomeNavigation);

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
    if (!document.querySelector('.modal-overlay.open')) {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    }
  }
}

// ── Video Settings Popup (unified, available on all pages) ────────────────────
(function () {
  let _vapVideoId = null;
  let _vapCurrentPeopleIds = [];
  let _vapVideoData = null;

  function ensureVideoSettingsModal() {
    if (document.getElementById('video-settings-popup')) return;
    const html = `
      <div class="modal-overlay" id="video-settings-popup">
        <div class="modal vap-modal">
          <div class="modal-header">
            <h3>Video Settings</h3>
            <button class="btn-icon" id="vap-close" type="button" aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="vap-tabs">
            <button class="vap-tab-btn active" data-tab="details" type="button">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Details
            </button>
            <button class="vap-tab-btn" data-tab="access" type="button">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Access
            </button>
            <button class="vap-tab-btn" data-tab="people" type="button">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              People
            </button>
          </div>
          <div class="vap-body">
            <!-- Details Tab -->
            <div class="vap-tab-panel active" id="vap-panel-details">
              <div class="vap-section">
                <div class="form-group">
                  <label class="form-label" for="vap-edit-title">Title</label>
                  <input class="form-input" id="vap-edit-title" type="text" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="vap-edit-date">Date</label>
                  <input class="form-input" id="vap-edit-date" type="date" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="vap-edit-category">Category</label>
                  <select class="form-input" id="vap-edit-category">
                    <option value="video">Video</option>
                    <option value="livestream">Live Stream</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label" for="vap-edit-desc">Description</label>
                  <textarea class="form-input" id="vap-edit-desc" rows="4" style="resize: none;"></textarea>
                </div>
                <div class="vap-section-header-row" style="margin-top: 8px;">
                  <div>
                    <h4 class="vap-section-title" style="font-size: 0.95rem;">Tag as VHS</h4>
                    <p class="vap-hint">Apply retro VHS effects to this video.</p>
                  </div>
                  <label class="switch">
                    <input type="checkbox" id="vap-edit-is-vhs" />
                    <span class="slider"></span>
                  </label>
                </div>
              </div>
            </div>
            <!-- Access Tab -->
            <div class="vap-tab-panel" id="vap-panel-access">
              <div class="vap-section">
                <div class="vap-section-header-row">
                  <div>
                    <h4 class="vap-section-title">Public Access</h4>
                    <p class="vap-hint">Allow all registered users to view this video.</p>
                  </div>
                  <label class="switch">
                    <input type="checkbox" id="vap-all-users" />
                    <span class="slider"></span>
                  </label>
                </div>
                <div id="vap-users-section" class="vap-users-section">
                  <p class="vap-subsection-label">Or restrict to specific viewers:</p>
                  <div id="vap-users-list" class="vap-users-list"></div>
                </div>
              </div>
            </div>
            <!-- People Tab -->
            <div class="vap-tab-panel" id="vap-panel-people">
              <div class="vap-section">
                <h4 class="vap-section-title">People Tags</h4>
                <p class="vap-hint">Tag people so this video appears on their profile.</p>
                <select id="vap-person-select" class="form-input vap-person-select">
                  <option value="">+ Add person to video\u2026</option>
                </select>
                <div id="vap-people-list" class="vap-people-list"></div>
              </div>
            </div>
          </div>
          <p id="vap-error" class="form-error" style="padding:0 1.25rem; margin-top: 0;"></p>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="vap-cancel" type="button">Cancel</button>
            <button class="btn btn-primary" id="vap-save" type="button">Save Changes</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    // Tab switching
    document.querySelectorAll('.vap-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.vap-tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.vap-tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`vap-panel-${btn.dataset.tab}`).classList.add('active');
      });
    });

    document.getElementById('vap-close').addEventListener('click', () => closeModal('video-settings-popup'));
    document.getElementById('vap-cancel').addEventListener('click', () => closeModal('video-settings-popup'));
    document.getElementById('video-settings-popup').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal('video-settings-popup');
    });

    document.getElementById('vap-all-users').addEventListener('change', () => {
      const checked = document.getElementById('vap-all-users').checked;
      const usersSection = document.getElementById('vap-users-section');
      usersSection.style.opacity = checked ? '0.3' : '1';
      usersSection.style.pointerEvents = checked ? 'none' : 'auto';
    });

    document.getElementById('vap-person-select').addEventListener('change', async (e) => {
      const sel = e.target;
      const pid = parseInt(sel.value, 10);
      if (!pid) return;

      if (_vapCurrentPeopleIds.includes(pid)) {
        sel.value = '';
        return;
      }

      sel.disabled = true;
      try {
        _vapCurrentPeopleIds = [..._vapCurrentPeopleIds, pid];
        await saveVideoPeople();
        sel.value = '';
      } finally {
        sel.disabled = false;
      }
    });

    document.getElementById('vap-save').addEventListener('click', async () => {
      const errEl = document.getElementById('vap-error');
      const saveBtn = document.getElementById('vap-save');
      errEl.textContent = '';
      saveBtn.disabled = true;

      try {
        // Save details
        const dateValue = document.getElementById('vap-edit-date').value;
        await api(`/api/videos/${_vapVideoId}`, {
          method: 'PUT',
          body: JSON.stringify({
            title: document.getElementById('vap-edit-title').value.trim(),
            content_date: dateValue ? new Date(dateValue).toISOString() : null,
            category: document.getElementById('vap-edit-category').value,
            description: document.getElementById('vap-edit-desc').value.trim(),
            is_vhs: document.getElementById('vap-edit-is-vhs').checked ? 1 : 0,
          }),
        });

        // Save access
        const allUsers = document.getElementById('vap-all-users').checked;
        const userIds = [];
        document.querySelectorAll('.vap-user-cb:checked').forEach((cb) => {
          userIds.push(parseInt(cb.value, 10));
        });
        await api(`/api/videos/${_vapVideoId}/access`, {
          method: 'PUT',
          body: JSON.stringify({ all_users: allUsers, user_ids: userIds }),
        });

        toast('Video settings saved.');
        closeModal('video-settings-popup');
        // Refresh video info on watch page
        if (typeof window.currentVideo !== 'undefined' && typeof window.reloadVideoInfo === 'function') {
          window.reloadVideoInfo();
        }
        // Reload current page video grid if on browse
        if (typeof loadVideos === 'function') loadVideos();
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  async function saveVideoPeople() {
    try {
      await api(`/api/videos/${_vapVideoId}/people`, {
        method: 'PUT',
        body: JSON.stringify({ person_ids: _vapCurrentPeopleIds }),
      });
      await renderVapPeople();
      if (typeof window.refreshWatchPeopleTags === 'function') {
        window.refreshWatchPeopleTags();
      }
    } catch (err) {
      document.getElementById('vap-error').textContent = err.message;
    }
  }

  async function renderVapPeople() {
    const listEl = document.getElementById('vap-people-list');
    const token = getToken();
    try {
      const people = await api(`/api/videos/${_vapVideoId}/people`);
      _vapCurrentPeopleIds = people.map((p) => p.id);
      listEl.innerHTML = people.length
        ? people.map((p) => {
            const img = p.image_path
              ? `<img src="/api/people/${p.id}/image?token=${encodeURIComponent(token || '')}" class="vap-person-img" />`
              : `<span class="vap-person-initial">${escHtml((p.name || '?')[0]).toUpperCase()}</span>`;
            return `<div class="vap-person-row">
              <div class="vap-person-avatar">${img}</div>
              <span class="vap-person-name">${escHtml(p.name)}</span>
              <button class="btn-icon vap-person-remove" data-id="${p.id}" type="button" title="Remove">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>`;
          }).join('')
        : '<p class="vap-empty">No people tagged yet.</p>';

      listEl.querySelectorAll('.vap-person-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const pid = parseInt(btn.dataset.id, 10);
          _vapCurrentPeopleIds = _vapCurrentPeopleIds.filter((id) => id !== pid);
          await saveVideoPeople();
        });
      });

      // Refresh add dropdown — use /api/people (authenticated, not admin-only)
      const allPeople = await api('/api/people');
      const sel = document.getElementById('vap-person-select');
      sel.innerHTML = '<option value="">+ Add person to video\u2026</option>' +
        allPeople
          .filter((p) => !_vapCurrentPeopleIds.includes(p.id))
          .map((p) => `<option value="${p.id}">${escHtml(p.name)}</option>`)
          .join('');
    } catch (err) {
      listEl.textContent = err.message;
    }
  }

  window.openVideoAdminPopup = async function (videoId) {
    if (!getUser()) return;
    ensureVideoSettingsModal();
    _vapVideoId = videoId;
    _vapVideoData = null;
    document.getElementById('vap-error').textContent = '';
    document.getElementById('vap-users-list').innerHTML = 'Loading\u2026';
    document.getElementById('vap-people-list').innerHTML = 'Loading\u2026';
    // Reset details fields
    document.getElementById('vap-edit-title').value = '';
    document.getElementById('vap-edit-date').value = '';
    document.getElementById('vap-edit-category').value = 'video';
    document.getElementById('vap-edit-desc').value = '';
    document.getElementById('vap-edit-is-vhs').checked = false;
    // Reset to first tab
    document.querySelectorAll('.vap-tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.vap-tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelector('.vap-tab-btn[data-tab="details"]').classList.add('active');
    document.getElementById('vap-panel-details').classList.add('active');

    openModal('video-settings-popup');

    try {
      // Fetch video details, access config, and viewers in parallel
      // Use /api/videos/:id/viewers (accessible to channel owners) instead of /api/admin/users
      const [videoData, access, allUsers] = await Promise.all([
        api(`/api/videos/${videoId}`),
        api(`/api/videos/${videoId}/access`),
        api(`/api/videos/${videoId}/viewers`),
      ]);

      // Fill in details tab
      _vapVideoData = videoData;
      document.getElementById('vap-edit-title').value = videoData.title || '';
      if (videoData.content_date) {
        document.getElementById('vap-edit-date').value = videoData.content_date.split('T')[0];
      }
      document.getElementById('vap-edit-category').value = videoData.category || 'video';
      document.getElementById('vap-edit-desc').value = videoData.description || '';
      document.getElementById('vap-edit-is-vhs').checked = !!videoData.is_vhs;

      // Render access tab
      const allCb = document.getElementById('vap-all-users');
      allCb.checked = access.all_users;
      const usersSection = document.getElementById('vap-users-section');
      usersSection.style.opacity = access.all_users ? '0.3' : '1';
      usersSection.style.pointerEvents = access.all_users ? 'none' : 'auto';

      const viewers = allUsers.filter((u) => u.role !== 'admin');
      if (viewers.length) {
        document.getElementById('vap-users-list').innerHTML = viewers.map((u) =>
          `<label class="vap-user-row">
            <input type="checkbox" class="vap-user-cb" value="${u.id}" ${access.user_ids.includes(u.id) ? 'checked' : ''} />
            <div class="vap-user-row-info">
              <span class="vap-user-row-name">${escHtml(u.display_name || u.username)}</span>
              <span class="vap-user-row-handle">@${escHtml(u.username)}</span>
            </div>
          </label>`
        ).join('');
      } else {
        document.getElementById('vap-users-list').innerHTML = '<p class="vap-empty">No viewer accounts yet.</p>';
      }

      // Render people tab
      await renderVapPeople();
    } catch (err) {
      document.getElementById('vap-error').textContent = err.message;
    }
  };
})();


// ── Avatar helpers ───────────────────────────────────────────────────────────
function refreshAvatars(user) {
  const avatarEls = document.querySelectorAll('.avatar');
  const token = getToken();
  const avatarUrl = user?.avatar_path && token
    ? `/api/users/avatar/${user.id}?t=${Date.now()}&token=${encodeURIComponent(token)}`
    : null;

  avatarEls.forEach((el) => {
    // Some avatars are page-specific and should not be replaced with the logged-in user's avatar.
    if (el.hasAttribute('data-avatar-static')) return;

    const fallback = (user?.display_name || user?.username || '?')[0].toUpperCase();
    if (avatarUrl) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = 'Avatar';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        el.replaceChildren(document.createTextNode(fallback));
      }, { once: true });
      el.replaceChildren(img);
      return;
    }
    el.replaceChildren(document.createTextNode(fallback));
  });
}

function syncAvatarControls(user) {
  const removeBtn = document.getElementById('remove-avatar-btn');
  if (!removeBtn) return;
  removeBtn.style.display = user?.avatar_path ? '' : 'none';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

function isMobileViewport() {
  return window.innerWidth <= 768;
}

// ── Sidebar + User Dropdown (runs on every page) ──────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const SIDEBAR_KEY = 'ma_sidebar_collapsed';
  const SETTINGS_MODAL_ID = 'user-settings-modal';
  let settingsImageBase64 = null;
  let settingsImageRemoved = false;

  // ── Header Scroll Behavior (CSS controls where hiding takes effect) ─────
  const header = document.querySelector('.header');
  if (header) {
    let lastScrollY = window.scrollY;

    window.addEventListener('scroll', () => {
      const currentScrollY = window.scrollY;
      const delta = currentScrollY - lastScrollY;

      // Ignore tiny scroll jitters (trackpad / touch inertia)
      if (Math.abs(delta) < 5) return;

      if (delta > 0 && currentScrollY > 64) {
        if (!header.classList.contains('header--hidden')) {
          header.classList.add('header--hidden');
        }
      } else if (delta < 0) {
        if (header.classList.contains('header--hidden')) {
          header.classList.remove('header--hidden');
        }
      }
      lastScrollY = currentScrollY <= 0 ? 0 : currentScrollY;
    }, { passive: true });
  }

  // ── Sidebar toggle (hamburger) ────────────────────────────────────────────
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const mainLayout = document.querySelector('.main-layout');
  const sidebar = document.getElementById('sidebar') || mainLayout?.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');

  if (sidebarToggle && mainLayout && sidebar) {
    const closeMobileSidebar = () => {
      sidebar.classList.remove('open');
      overlay?.classList.remove('show');
      document.body.style.overflow = '';
    };

    const openMobileSidebar = () => {
      sidebar.classList.add('open');
      overlay?.classList.add('show');
      document.body.style.overflow = 'hidden';
    };

    // Restore desktop collapsed state
    if (localStorage.getItem(SIDEBAR_KEY) === '1') {
      mainLayout.classList.add('collapsed');
    }

    sidebarToggle.addEventListener('click', () => {
      if (isMobileViewport()) {
        if (sidebar.classList.contains('open')) closeMobileSidebar();
        else openMobileSidebar();
      } else {
        const collapsed = mainLayout.classList.toggle('collapsed');
        localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      }
    });

    overlay?.addEventListener('click', () => {
      closeMobileSidebar();
    });

    // Close mobile drawer when selecting any nav item.
    sidebar.addEventListener('click', (e) => {
      const navTarget = e.target.closest('.nav-item, .tab-btn, a');
      if (!navTarget) return;
      if (isMobileViewport()) closeMobileSidebar();
    });

    // Keep state clean when resizing between desktop/mobile.
    window.addEventListener('resize', () => {
      if (!isMobileViewport()) closeMobileSidebar();
    });
  }

  // ── User dropdown ─────────────────────────────────────────────────────────
  const trigger  = document.getElementById('user-menu-trigger');
  const dropdown = document.getElementById('user-dropdown');

  const applyUserUI = (user) => {
    if (!user) return;

    refreshAvatars(user);
    syncAvatarControls(user);

    const nameEl = document.getElementById('dropdown-user-name');
    const roleEl = document.getElementById('dropdown-user-role');
    if (nameEl) nameEl.textContent = user.display_name || user.username || 'Unknown';
    if (roleEl) {
      const isUserAdmin = user.role === 'admin';
      roleEl.textContent = isUserAdmin ? 'Administrator' : 'Viewer';
      roleEl.classList.toggle('role-admin', isUserAdmin);
    }

    const adminLink = document.getElementById('admin-link');
    if (adminLink) {
      adminLink.style.display = user.role === 'admin' ? 'flex' : 'none';
      adminLink.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.7a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.7z"></path></svg> Admin Panel`;
    }
    
    const uploadTrigger = document.getElementById('upload-trigger');
    if (uploadTrigger) {
      const canUpload = user.role === 'admin' || user.can_upload === 1;
      uploadTrigger.style.display = canUpload ? 'inline-flex' : 'none';
    }

    const channelsBtn = document.getElementById('channels-btn');
    if (channelsBtn) {
      channelsBtn.style.display = 'flex';
    }

    ensureInstallMenuItem();
  };

  function ensureInstallMenuItem() {
    const dropdown = document.getElementById('user-dropdown');
    if (!dropdown || document.getElementById('pwa-install-btn')) return;
    const logoutBtn = document.getElementById('logout-btn');
    if (!logoutBtn) return;

    const installBtn = document.createElement('button');
    installBtn.className = 'dropdown-item';
    installBtn.id = 'pwa-install-btn';
    installBtn.type = 'button';
    installBtn.setAttribute('role', 'menuitem');
    installBtn.style.display = deferredPrompt ? 'flex' : 'none';
    installBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
      Install App
    `;
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') installBtn.style.display = 'none';
      deferredPrompt = null;
    });

    dropdown.insertBefore(installBtn, logoutBtn);
  }

  function ensureSettingsMenuItem() {
    if (!dropdown || document.getElementById('settings-btn')) return;
    const logoutBtn = document.getElementById('logout-btn');
    if (!logoutBtn) return;

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'dropdown-item';
    settingsBtn.id = 'settings-btn';
    settingsBtn.type = 'button';
    settingsBtn.setAttribute('role', 'menuitem');
    settingsBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      Settings
    `;
    dropdown.insertBefore(settingsBtn, logoutBtn);
  }

  function ensureYourChannelMenuItem() {
    if (!dropdown || document.getElementById('your-channel-btn')) return;
    const user = getUser();
    if (!user || !user.channel_id) return;
    // Show if admin or if they have upload rights and a channel
    if (user.role !== 'admin' && !user.can_upload) return;
    
    const settingsBtn = document.getElementById('settings-btn');
    if (!settingsBtn) return; // Insert before settings

    const yourChannelBtn = document.createElement('a');
    yourChannelBtn.className = 'dropdown-item';
    yourChannelBtn.id = 'your-channel-btn';
    yourChannelBtn.href = `/?mode=channel_profile&channelId=${user.channel_id}`;
    yourChannelBtn.setAttribute('role', 'menuitem');
    yourChannelBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
      </svg>
      Your Channel
    `;
    dropdown.insertBefore(yourChannelBtn, settingsBtn);
  }

  function ensureSettingsModal() {
    if (document.getElementById(SETTINGS_MODAL_ID)) return;
    const html = `
      <div class="modal-overlay" id="${SETTINGS_MODAL_ID}">
        <div class="modal settings-modal">
          <div class="modal-header">
            <h3>Settings</h3>
            <button class="btn-icon" id="settings-close" type="button" aria-label="Close settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          <div class="settings-section">
            <h4 class="settings-title">Profile Picture</h4>
            <div class="settings-avatar-row">
              <div class="avatar avatar-lg settings-avatar-preview" id="settings-avatar-preview">?</div>
              <div class="settings-avatar-actions">
                <input type="file" id="settings-avatar-input" hidden accept="image/jpeg,image/png,image/webp" />
                <button class="btn btn-ghost btn-sm" id="settings-avatar-upload" type="button">Upload Image</button>
                <button class="btn btn-danger btn-sm" id="settings-avatar-remove" type="button" style="display:none">Remove</button>
                <p class="settings-help">Max 2MB. Jpg, Png, or Webp.</p>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <h4 class="settings-title">Change Password</h4>
            <div class="form-group">
              <label class="form-label" for="settings-current-password">Current Password</label>
              <input class="form-input" id="settings-current-password" type="password" autocomplete="current-password" maxlength="128" />
            </div>
            <div class="form-group">
              <label class="form-label" for="settings-new-password">New Password</label>
              <input class="form-input" id="settings-new-password" type="password" autocomplete="new-password" maxlength="128" />
            </div>
            <div class="form-group">
              <label class="form-label" for="settings-confirm-password">Confirm New Password</label>
              <input class="form-input" id="settings-confirm-password" type="password" autocomplete="new-password" maxlength="128" />
            </div>
          </div>

          <p class="form-error" id="settings-error"></p>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="settings-cancel" type="button">Cancel</button>
            <button class="btn btn-primary" id="settings-save" type="button">Save Changes</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    const overlay = document.getElementById(SETTINGS_MODAL_ID);
    overlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal(SETTINGS_MODAL_ID);
    });

    document.getElementById('settings-close')?.addEventListener('click', () => closeModal(SETTINGS_MODAL_ID));
    document.getElementById('settings-cancel')?.addEventListener('click', () => closeModal(SETTINGS_MODAL_ID));
    document.getElementById('settings-avatar-upload')?.addEventListener('click', () => {
      document.getElementById('settings-avatar-input')?.click();
    });
  }

  function renderSettingsAvatar(user) {
    const preview = document.getElementById('settings-avatar-preview');
    const removeBtn = document.getElementById('settings-avatar-remove');
    if (!preview || !removeBtn) return;

    const fallback = (user?.display_name || user?.username || '?')[0].toUpperCase();
    const token = getToken();
    const avatarUrl = settingsImageBase64 || (user?.avatar_path && token
      ? `/api/users/avatar/${user.id}?t=${Date.now()}&token=${encodeURIComponent(token)}`
      : null);

    if (avatarUrl) {
      preview.innerHTML = `<img src="${avatarUrl}" alt="Avatar" loading="lazy" decoding="async" />`;
      removeBtn.style.display = '';
      return;
    }

    preview.replaceChildren(document.createTextNode(fallback));
    removeBtn.style.display = 'none';
  }

  function resetSettingsFields(user) {
    settingsImageBase64 = null;
    settingsImageRemoved = false;
    const errEl = document.getElementById('settings-error');
    const cur = document.getElementById('settings-current-password');
    const next = document.getElementById('settings-new-password');
    const confirm = document.getElementById('settings-confirm-password');
    const fileInput = document.getElementById('settings-avatar-input');
    if (errEl) errEl.textContent = '';
    if (cur) cur.value = '';
    if (next) next.value = '';
    if (confirm) confirm.value = '';
    if (fileInput) fileInput.value = '';
    renderSettingsAvatar(user);
  }

  async function openSettingsModal() {
    ensureSettingsModal();
    dropdown?.classList.remove('show');
    trigger?.setAttribute('aria-expanded', 'false');

    const user = getUser();
    resetSettingsFields(user);
    openModal(SETTINGS_MODAL_ID);
  }

  async function saveSettings() {
    const errEl = document.getElementById('settings-error');
    const cur = document.getElementById('settings-current-password')?.value || '';
    const next = document.getElementById('settings-new-password')?.value || '';
    const confirm = document.getElementById('settings-confirm-password')?.value || '';
    if (errEl) errEl.textContent = '';

    const wantsPasswordChange = !!(cur || next || confirm);
    if (wantsPasswordChange) {
      if (!cur || !next || !confirm) {
        if (errEl) errEl.textContent = 'Fill all password fields to change password.';
        return;
      }
      if (next !== confirm) {
        if (errEl) errEl.textContent = 'New passwords do not match.';
        return;
      }
      if (next.length < 8) {
        if (errEl) errEl.textContent = 'New password must be at least 8 characters.';
        return;
      }
    }

    const saveBtn = document.getElementById('settings-save');
    if (saveBtn) saveBtn.disabled = true;

    try {
      let changed = false;

      if (settingsImageBase64) {
        await api('/api/user/avatar', {
          method: 'POST',
          body: JSON.stringify({ imageBase64: settingsImageBase64 }),
        });
        changed = true;
      } else if (settingsImageRemoved) {
        await api('/api/user/avatar', { method: 'DELETE' });
        changed = true;
      }

      if (wantsPasswordChange) {
        await api('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({
            current_password: cur,
            new_password: next,
          }),
        });
        changed = true;
      }

      if (!changed) {
        if (errEl) errEl.textContent = 'No changes to save.';
        return;
      }

      await syncCurrentUserFromServer();
      resetSettingsFields(getUser());
      closeModal(SETTINGS_MODAL_ID);
      toast('Settings updated successfully.');
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Failed to save settings.';
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  const cachedUser = getUser();
  applyUserUI(cachedUser);

  async function syncCurrentUserFromServer() {
    // Always refresh user profile from server so avatar/display changes sync across devices.
    const token = getToken();
    if (!token) return;

    try {
      const serverUser = await api('/api/auth/me');
      localStorage.setItem('ma_user', JSON.stringify(serverUser));
      applyUserUI(serverUser);
    } catch (err) {
      // api() already handles unauthorized tokens; ignore transient fetch errors here.
      console.warn('[User Sync] Failed to refresh current user:', err.message);
    }
  }

  await syncCurrentUserFromServer();

  ensureSettingsMenuItem();
  ensureYourChannelMenuItem();
  ensureSettingsModal();

  const settingsInput = document.getElementById('settings-avatar-input');
  settingsInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const errEl = document.getElementById('settings-error');
    if (!file) return;

    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      if (errEl) errEl.textContent = 'Only jpg, png, and webp images are allowed.';
      e.target.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      if (errEl) errEl.textContent = 'Image is too large (Max 2MB).';
      e.target.value = '';
      return;
    }

    try {
      settingsImageBase64 = await fileToDataUrl(file);
      settingsImageRemoved = false;
      if (errEl) errEl.textContent = '';
      renderSettingsAvatar(getUser());
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Failed to process image.';
    }
  });

  document.getElementById('settings-avatar-remove')?.addEventListener('click', () => {
    settingsImageBase64 = null;
    settingsImageRemoved = true;
    const fileInput = document.getElementById('settings-avatar-input');
    if (fileInput) fileInput.value = '';
    renderSettingsAvatar({ ...getUser(), avatar_path: null });
  });

  document.getElementById('settings-save')?.addEventListener('click', saveSettings);

  // ── Notification Logic ─────────────────────────────────────────────────────
  const notifTrigger = document.getElementById('notif-trigger');
  const notifDropdown = document.getElementById('notif-dropdown');
  const notifList = document.getElementById('notif-list');
  const notifBadge = document.getElementById('notif-badge');

  async function updateNotifications() {
    if (!getUser()) return;
    if (!notifList || !notifBadge) return;
    try {
      const notifs = await api('/api/user/notifications');
      const unreadCount = notifs.filter((n) => !Number(n.is_read)).length;

      if (unreadCount > 0) {
        notifBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
        notifBadge.style.display = 'flex';
      } else {
        notifBadge.style.display = 'none';
      }

      if (!notifs.length) {
        notifList.innerHTML = '<div class="notif-empty">All caught up!</div>';
        return;
      }

      notifList.innerHTML = notifs.map((n) => {
        const author = String(n.display_name || n.username || 'User');
        const authorInitial = (author[0] || '?').toUpperCase();
        const fallbackExpr = JSON.stringify(authorInitial);
        const token = getToken();
        let avatarUrl = null;
        if (n.type === 'channel_upload') {
          avatarUrl = n.avatar_path ? `${n.avatar_path}?t=${Date.now()}` : null;
        } else if (n.user_id && n.avatar_path && token) {
          avatarUrl = `/api/users/avatar/${Number(n.user_id)}?token=${encodeURIComponent(token)}&t=${Date.now()}`;
        }
        const videoTitle = String(n.video_title || 'a video');
        const isRead = Number(n.is_read) === 1;
        const isReplyToMe = Number(n.is_reply_to_me) === 1;

        // Friend request notification
        if (n.type === 'friend_request') {
          return `
            <div class="notif-item unread is-friend-request" data-fr-user-id="${Number(n.user_id)}">
              <div class="notif-avatar">${avatarUrl
                ? `<img src="${avatarUrl}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.parentNode.textContent=${fallbackExpr}" />`
                : escHtml(authorInitial)}</div>
              <div class="notif-content">
                <div class="notif-type-row"><span class="notif-type friend-req">Friend Request</span></div>
                <p class="notif-message"><strong>${escHtml(author)}</strong> wants to be your friend</p>
                <span class="notif-time">${formatDate(n.created_at)}</span>
                <div class="notif-fr-actions">
                  <button class="btn btn-primary btn-sm notif-fr-accept" data-uid="${Number(n.user_id)}" type="button">Accept</button>
                  <button class="btn btn-ghost btn-sm notif-fr-deny" data-uid="${Number(n.user_id)}" type="button">Deny</button>
                </div>
              </div>
              <div class="unread-dot"></div>
            </div>
          `;
        }

        const typeLabel = n.type === 'channel_upload'
          ? '<span class="notif-type upload">New Upload</span>'
          : isReplyToMe
            ? '<span class="notif-type reply">Reply</span>'
            : '<span class="notif-type">Comment</span>';
        return `
          <div class="notif-item ${isRead ? '' : 'unread'} ${isReplyToMe ? 'is-reply' : ''}" onclick="handleNotifClick(${Number(n.id)}, ${Number(n.video_id)}, '${n.type}')">
            <div class="notif-avatar">${avatarUrl
              ? `<img src="${avatarUrl}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.parentNode.textContent=${fallbackExpr}" />`
              : escHtml(authorInitial)}</div>
            <div class="notif-content">
              <div class="notif-type-row">${typeLabel}</div>
              <p class="notif-message"><strong>${escHtml(author)}</strong> on <em>${escHtml(videoTitle)}</em></p>
              <span class="notif-time">${formatDate(n.created_at)}</span>
            </div>
            ${isRead ? '' : '<div class="unread-dot"></div>'}
          </div>
        `;
      }).join('');

      // Bind friend request accept/deny buttons inside notification dropdown
      notifList.querySelectorAll('.notif-fr-accept').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await api(`/api/friends/accept/${btn.dataset.uid}`, { method: 'POST' });
            toast('Friend request accepted!', 'success');
            await updateNotifications();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
      notifList.querySelectorAll('.notif-fr-deny').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await api(`/api/friends/deny/${btn.dataset.uid}`, { method: 'POST' });
            toast('Friend request denied.', 'success');
            await updateNotifications();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    } catch (e) {
      console.error('Notif error', e);
    }
  }

  window.handleNotifClick = async (id, videoId, type = 'comment') => {
    const safeId = Number(id);
    const safeVideoId = Number(videoId);
    const targetHash = type === 'channel_upload' ? '' : `#comment-${safeId}`;
    const currentVideoId = Number(new URLSearchParams(location.search).get('id'));
    const isWatchPage = /\/watch\.html$/i.test(location.pathname);
    const isSameVideoPage = isWatchPage && currentVideoId === safeVideoId;

    try {
      await api(`/api/user/notifications/${safeId}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      await updateNotifications();
      notifDropdown?.classList.remove('show');

      if (isSameVideoPage) {
        if (location.hash !== targetHash) {
          location.hash = targetHash;
        } else {
          document.getElementById(`comment-${safeCommentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }

      location.href = `/watch.html?id=${safeVideoId}${targetHash}`;
    } catch (e) {
      notifDropdown?.classList.remove('show');
      location.href = `/watch.html?id=${safeVideoId}`;
    }
  };

  notifTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    notifDropdown?.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    if (notifDropdown && notifTrigger && !notifDropdown.contains(e.target) && !notifTrigger.contains(e.target)) {
      notifDropdown.classList.remove('show');
    }
  });

  if (notifTrigger) {
    updateNotifications();
    setInterval(updateNotifications, 60000);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById(SETTINGS_MODAL_ID);
      if (modal?.classList.contains('open')) closeModal(SETTINGS_MODAL_ID);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncCurrentUserFromServer();
    }
  });

  if (trigger && dropdown) {
    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dropdown.classList.toggle('show');
      trigger.setAttribute('aria-expanded', String(open));
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== trigger) {
        dropdown.classList.remove('show');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
  }
});

// ── Avatar Utilities ────────────────────────────────────────────────────────
window.openAvatarLightbox = function(imgSrc) {
  if (!imgSrc || imgSrc.includes('data:image/svg+xml')) return;
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0'; overlay.style.left = '0';
  overlay.style.width = '100vw'; overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0,0,0,0.85)';
  overlay.style.zIndex = '99999';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.cursor = 'zoom-out';
  
  const img = document.createElement('img');
  img.src = imgSrc;
  img.style.maxWidth = '90vw';
  img.style.maxHeight = '90vh';
  img.style.aspectRatio = '1 / 1';
  img.style.objectFit = 'cover';
  img.style.borderRadius = '50%';
  img.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
  
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  
  overlay.addEventListener('click', () => {
    overlay.remove();
  });
};

window.openAvatarCropper = function(file, onCropComplete) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const modal = document.createElement('div');
      modal.className = 'cropper-modal';
      modal.innerHTML = `
        <div class="cropper-container">
          <div class="cropper-header">
            <h3>Crop Profile Picture</h3>
            <button class="icon-btn" onclick="this.closest('.cropper-modal').remove()">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="cropper-canvas-wrapper" style="position:relative; width: 100%; max-width: 500px; height: 400px; background: #000; overflow: hidden; touch-action: none; cursor: grab; margin: 0 auto;">
            <canvas id="avatar-cropper-canvas" style="position:absolute; top:0; left:0; width:100%; height:100%;"></canvas>
            <div class="cropper-overlay" style="position:absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; background: rgba(0,0,0,0.5); mask: radial-gradient(circle at center, transparent 150px, #000 151px); -webkit-mask: radial-gradient(circle at center, transparent 150px, #000 151px);"></div>
            <div style="position:absolute; top:50%; left:50%; width:300px; height:300px; transform: translate(-50%, -50%); pointer-events:none; border: 2px dashed var(--accent); border-radius: 50%; box-sizing: border-box;"></div>
          </div>
          <div class="cropper-controls" style="padding: 16px; display:flex; align-items:center; gap: 16px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="range" id="avatar-cropper-zoom" min="0.1" max="3" step="0.01" value="1" style="flex:1;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          </div>
          <div class="cropper-footer" style="padding: 16px; border-top: 1px solid var(--border); display:flex; justify-content:flex-end; gap: 12px;">
            <button class="btn btn-secondary" onclick="this.closest('.cropper-modal').remove()">Cancel</button>
            <button class="btn btn-primary" id="avatar-cropper-save">Crop</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const canvas = document.getElementById('avatar-cropper-canvas');
      const ctx = canvas.getContext('2d');
      const wrapper = canvas.parentElement;
      
      let cw = wrapper.clientWidth;
      let ch = wrapper.clientHeight;
      const pixelRatio = 3;
      canvas.width = cw * pixelRatio;
      canvas.height = ch * pixelRatio;
      ctx.scale(pixelRatio, pixelRatio);

      const circleRadius = 150; 
      
      let scale = Math.max((circleRadius * 2) / img.width, (circleRadius * 2) / img.height);
      let posX = (cw - img.width * scale) / 2;
      let posY = (ch - img.height * scale) / 2;
      let isDragging = false;
      let startX, startY;

      function render() {
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(img, posX, posY, img.width * scale, img.height * scale);
      }

      function clamp() {
        const minX = (cw / 2) + circleRadius - img.width * scale;
        const maxX = (cw / 2) - circleRadius;
        const minY = (ch / 2) + circleRadius - img.height * scale;
        const maxY = (ch / 2) - circleRadius;
        
        if (posX > maxX) posX = maxX;
        if (posX < minX) posX = minX;
        if (posY > maxY) posY = maxY;
        if (posY < minY) posY = minY;
      }

      render();
      
      document.getElementById('avatar-cropper-zoom').value = scale;
      document.getElementById('avatar-cropper-zoom').min = scale * 0.5;
      document.getElementById('avatar-cropper-zoom').max = scale * 3;

      const handleStart = (e) => {
        isDragging = true;
        wrapper.style.cursor = 'grabbing';
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX - posX;
        startY = clientY - posY;
      };
      
      const handleMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        posX = clientX - startX;
        posY = clientY - startY;
        clamp();
        render();
      };
      
      const handleEnd = () => {
        isDragging = false;
        wrapper.style.cursor = 'grab';
      };

      wrapper.addEventListener('mousedown', handleStart);
      window.addEventListener('mousemove', handleMove, { passive: false });
      window.addEventListener('mouseup', handleEnd);
      wrapper.addEventListener('touchstart', handleStart, { passive: false });
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);

      document.getElementById('avatar-cropper-zoom').addEventListener('input', (e) => {
        const newScale = parseFloat(e.target.value);
        const centerX = cw / 2;
        const centerY = ch / 2;
        
        const relX = (centerX - posX) / scale;
        const relY = (centerY - posY) / scale;
        
        scale = newScale;
        
        posX = centerX - relX * scale;
        posY = centerY - relY * scale;
        
        clamp();
        render();
      });

      document.getElementById('avatar-cropper-save').addEventListener('click', () => {
        const outCanvas = document.createElement('canvas');
        const outCtx = outCanvas.getContext('2d');
        const targetSize = 1024;
        outCanvas.width = targetSize;
        outCanvas.height = targetSize;
        
        const cropX = ((cw / 2) - circleRadius - posX) / scale;
        const cropY = ((ch / 2) - circleRadius - posY) / scale;
        const cropW = (circleRadius * 2) / scale;
        const cropH = (circleRadius * 2) / scale;
        
        outCtx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, targetSize, targetSize);
        
        const dataUrl = outCanvas.toDataURL('image/jpeg', 0.95);
        onCropComplete(dataUrl);
        modal.remove();
        
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      });
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
};

window.openChannelEditor = function(channelId, currentName, currentAvatar, currentBanner, onSaveComplete) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.style.zIndex = '10000';
  
  overlay.innerHTML = `
    <div class="modal" style="width: 100%; max-width: 600px; padding: 0; overflow: hidden; display: flex; flex-direction: column;">
      <div class="modal-header" style="padding: 24px 24px 0 24px; margin-bottom: 0;">
        <h3>Channel Settings</h3>
        <button class="icon-btn" onclick="this.closest('.modal-overlay').remove()" style="background: none; border: none; color: var(--text); cursor: pointer;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      
      <div style="padding: 24px; overflow-y: auto;">
        
        <div style="margin-bottom: 32px;">
          <label style="display: block; font-weight: 500; margin-bottom: 12px; color: var(--text-muted);">Channel Banner</label>
          <div style="position: relative; width: 100%; height: 120px; background: ${currentBanner ? `url('${currentBanner}') center/cover` : 'var(--bg-hover)'}; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; display: flex; align-items: center; justify-content: center;"
               onmouseover="this.querySelector('.edit-overlay').style.opacity='1'"
               onmouseout="this.querySelector('.edit-overlay').style.opacity='0'">
            <div class="edit-overlay" id="editor-banner-btn" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s; cursor: pointer; color: white;" title="Change Banner">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
            </div>
          </div>
        </div>

        <div style="margin-bottom: 32px; display: flex; gap: 24px; align-items: flex-start;">
          <div>
            <label style="display: block; font-weight: 500; margin-bottom: 12px; color: var(--text-muted);">Profile Picture</label>
            <div style="position: relative; width: 100px; height: 100px; border-radius: 50%; border: 2px solid var(--border); overflow: hidden;"
                 onmouseover="this.querySelector('.edit-overlay').style.opacity='1'"
                 onmouseout="this.querySelector('.edit-overlay').style.opacity='0'">
              <img id="editor-avatar-img" src="${currentAvatar}" style="width: 100%; height: 100%; object-fit: cover; display: block;" alt="Avatar">
              <div class="edit-overlay" id="editor-avatar-btn" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s; cursor: pointer; color: white;" title="Change Profile Picture">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
              </div>
            </div>
          </div>

          <div style="flex-grow: 1;">
            <label style="display: block; font-weight: 500; margin-bottom: 12px; color: var(--text-muted);">Channel Name</label>
            <input type="text" id="editor-name-input" value="${escHtml(currentName)}" class="form-input" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 1rem;" placeholder="Enter channel name...">
          </div>
        </div>

      </div>

      <div class="modal-footer" style="padding: 16px 24px 24px 24px; margin-top: 0; display: flex; justify-content: flex-end; gap: 12px; border-top: 1px solid var(--border);">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" id="editor-save-btn">Save Changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Avatar Upload Logic
  document.getElementById('editor-avatar-btn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      window.openAvatarCropper(file, async (croppedBase64) => {
        try {
          await api('/api/channels/' + channelId + '/avatar', { method: 'POST', body: JSON.stringify({ imageBase64: croppedBase64 }) });
          toast('Avatar updated!');
          document.getElementById('editor-avatar-img').src = croppedBase64;
          if (onSaveComplete) onSaveComplete(true);
        } catch (err) {
          toast(err.message || 'Failed to update avatar.', 'error');
        }
      });
    };
    input.click();
  });

  // Banner Upload Logic
  document.getElementById('editor-banner-btn').addEventListener('click', () => {
    // We cannot easily pass back the cropped banner preview here because banner cropper is in main.js. 
    // Wait, banner cropper is not in shared.js! Let's close modal and call the banner upload.
    if (window.uploadChannelBanner) {
      overlay.remove(); // Close modal so banner cropper can be seen
      window.uploadChannelBanner(channelId);
    } else {
      toast('Banner editing not available in this view yet.', 'error');
    }
  });

  // Save Name Logic
  document.getElementById('editor-save-btn').addEventListener('click', async () => {
    const newName = document.getElementById('editor-name-input').value.trim();
    if (!newName) {
      toast('Channel name cannot be empty', 'error');
      return;
    }
    
    if (newName !== currentName) {
      try {
        await api('/api/channels/' + channelId + '/name', { method: 'POST', body: JSON.stringify({ name: newName }) });
        toast('Channel name updated!');
      } catch (err) {
        toast(err.message || 'Failed to update name.', 'error');
        return;
      }
    }
    
    overlay.remove();
    if (onSaveComplete) onSaveComplete(true);
  });
};

  window.uploadChannelBanner = function(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      openBannerCropper(file, id);
    };
    input.click();
  };

  window.uploadChannelAvatar = function(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      window.openAvatarCropper(file, async (croppedBase64) => {
        try {
          await api('/api/channels/' + id + '/avatar', { method: 'POST', body: JSON.stringify({ imageBase64: croppedBase64 }) });
          toast('Avatar updated successfully!');
          renderChannelPage(id);
        } catch (err) {
          toast(err.message || 'Failed to update avatar.', 'error');
        }
      });
    };
    input.click();
  };

  function openBannerCropper(file, channelId) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const modal = document.createElement('div');
        modal.className = 'cropper-modal';
        modal.innerHTML = `
          <div class="cropper-container">
            <div class="cropper-header">
              <h3>Position and Size</h3>
              <button class="icon-btn" onclick="this.closest('.cropper-modal').remove()">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="cropper-canvas-wrapper" style="position:relative; width: 100%; max-width: 800px; height: 300px; background: #000; overflow: hidden; touch-action: none; cursor: grab;">
              <canvas id="cropper-canvas" style="position:absolute; top:0; left:0; width:100%; height:100%;"></canvas>
              <div class="cropper-overlay" style="position:absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; border-top: 50px solid rgba(0,0,0,0.5); border-bottom: 50px solid rgba(0,0,0,0.5);"></div>
              <div style="position:absolute; top:50px; left:0; right:0; bottom:50px; pointer-events:none; border: 2px solid var(--accent); box-sizing: border-box;"></div>
            </div>
            <div class="cropper-controls" style="padding: 16px; display:flex; align-items:center; gap: 16px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="range" id="cropper-zoom" min="0.1" max="3" step="0.01" value="1" style="flex:1;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            </div>
            <div class="cropper-footer" style="padding: 16px; border-top: 1px solid var(--border); display:flex; justify-content:flex-end; gap: 12px;">
              <button class="btn btn-secondary" onclick="this.closest('.cropper-modal').remove()">Cancel</button>
              <button class="btn btn-primary" id="cropper-save">Save Banner</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);

        const canvas = document.getElementById('cropper-canvas');
        const ctx = canvas.getContext('2d');
        const wrapper = canvas.parentElement;
        
        let cw = wrapper.clientWidth;
        let ch = wrapper.clientHeight;
        const pixelRatio = 3;
        canvas.width = cw * pixelRatio;
        canvas.height = ch * pixelRatio;
        ctx.scale(pixelRatio, pixelRatio);

        // Overlay cutout is top 50px, bottom 50px. Height is ch - 100. Width is cw.
        const targetW = cw;
        const targetH = ch - 100;
        
        // Initial scale to fit width
        let scale = cw / img.width;
        if (img.height * scale < targetH) {
          scale = targetH / img.height; // scale to fit height if needed
        }
        
        document.getElementById('cropper-zoom').value = scale;
        document.getElementById('cropper-zoom').min = scale * 0.5;
        document.getElementById('cropper-zoom').max = scale * 3;

        let panX = (cw - img.width * scale) / 2;
        let panY = (ch - img.height * scale) / 2;

        function draw() {
          ctx.clearRect(0, 0, cw, ch);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, panX, panY, img.width * scale, img.height * scale);
        }

        draw();

        document.getElementById('cropper-zoom').addEventListener('input', (e) => {
          const newScale = parseFloat(e.target.value);
          const cx = cw / 2;
          const cy = ch / 2;
          panX = cx - (cx - panX) * (newScale / scale);
          panY = cy - (cy - panY) * (newScale / scale);
          scale = newScale;
          draw();
        });

        let isDragging = false;
        let startX, startY;

        wrapper.addEventListener('pointerdown', (e) => {
          isDragging = true;
          startX = e.clientX - panX;
          startY = e.clientY - panY;
          wrapper.setPointerCapture(e.pointerId);
          wrapper.style.cursor = 'grabbing';
        });

        wrapper.addEventListener('pointermove', (e) => {
          if (!isDragging) return;
          panX = e.clientX - startX;
          panY = e.clientY - startY;
          draw();
        });

        wrapper.addEventListener('pointerup', (e) => {
          isDragging = false;
          wrapper.releasePointerCapture(e.pointerId);
          wrapper.style.cursor = 'grab';
        });
        wrapper.addEventListener('pointercancel', () => { isDragging = false; wrapper.style.cursor = 'grab'; });

        document.getElementById('cropper-save').addEventListener('click', async () => {
          // Crop the image!
          const outCanvas = document.createElement('canvas');
          outCanvas.width = targetW * pixelRatio;
          outCanvas.height = targetH * pixelRatio;
          const outCtx = outCanvas.getContext('2d');
          
          outCtx.drawImage(
            canvas,
            0, 50 * pixelRatio, targetW * pixelRatio, targetH * pixelRatio, // Source (x,y,w,h) from the visible canvas
            0, 0, targetW * pixelRatio, targetH * pixelRatio   // Dest
          );
          
          const imageBase64 = outCanvas.toDataURL('image/jpeg', 0.9);
          const btn = document.getElementById('cropper-save');
          btn.disabled = true;
          btn.textContent = 'Saving...';
          
          try {
            await api('/api/channels/' + channelId + '/banner', { method: 'POST', body: JSON.stringify({ imageBase64 }) });
            toast('Banner updated successfully', 'success');
            modal.remove();
            location.reload();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Save Banner';
          }
        });
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }
