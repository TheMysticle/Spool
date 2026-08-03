/* admin.js — admin panel */
'use strict';

(function () {
  if (!requireAuth()) return;

  // Must be admin
  const user = getUser();
  if (!user || user.role !== 'admin') {
    location.replace('/');
    return;
  }

  // ── Bootstrap header ───────────────────────────────────────────────────────
  // Avatar / dropdown / logout handled by shared.js DOMContentLoaded block

  // ── Sidebar navigation ─────────────────────────────────────────────────────
  document.querySelectorAll('.admin-nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.admin-nav-item').forEach((i) => i.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach((p) => p.classList.remove('active'));
      item.classList.add('active');
      const panel = document.getElementById(item.dataset.panel);
      if (panel) panel.classList.add('active');

      // Lazy-load panel data
      if (item.dataset.panel === 'panel-users') loadUsers();
      if (item.dataset.panel === 'panel-channels') loadChannels();
      if (item.dataset.panel === 'panel-scan') loadScanStatus();
      if (item.dataset.panel === 'panel-videos') loadAdminVideos();
      if (item.dataset.panel === 'panel-people') loadPeople();
      if (item.dataset.panel === 'panel-series') loadSeries();
      if (item.dataset.panel === 'panel-shares') loadShares();
      if (item.dataset.panel === 'panel-channel') loadChannelProfile();
      if (item.dataset.panel === 'panel-dialogs') loadDialogs();
      if (item.dataset.panel === 'panel-audit') loadAuditLogs();
      if (item.dataset.panel === 'panel-transcoder') loadTranscoderStatus();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Channels panel ────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  window.loadChannels = async function loadChannels() {
    try {
      const res = await api('/api/admin/channels');
      const grid = document.getElementById('channels-grid');
      grid.innerHTML = '';
      if (!res.length) {
        grid.innerHTML = '<p>No channels found.</p>';
        return;
      }

      res.forEach(ch => {
        const avatarUrl = ch.avatar_path || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%232c2c2c"/><text x="50" y="55" font-family="sans-serif" font-size="40" fill="%238b5cf6" text-anchor="middle">${ch.name.charAt(0).toUpperCase()}</text></svg>`;
        const bannerUrl = ch.banner_path || '';

        const card = document.createElement('div');
        card.className = 'channel-admin-card';
        card.style.cssText = 'background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column;';
        
        card.innerHTML = `
          <div style="height: 100px; background: ${bannerUrl ? `url('${bannerUrl}') center/cover` : 'var(--bg-hover)'}; position: relative;">
            <button class="channel-page-banner-upload" onclick="window.openChannelEditor('${ch.id}', '${escHtml(ch.name)}', '${avatarUrl}', '${bannerUrl}', () => loadChannels())" title="Channel Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
          </div>
          <div style="padding: 16px; display: flex; flex-direction: column; align-items: center; position: relative; margin-top: -50px;">
            <div style="position: relative; border-radius: 50%; overflow: hidden; border: 4px solid var(--surface); width: 80px; height: 80px; flex-shrink: 0;">
              <img src="${avatarUrl}" style="width: 100%; height: 100%; object-fit: cover; display: block;" alt="Avatar">
            </div>
            <h3 style="margin: 12px 0 4px 0; font-size: 1.1rem; text-align: center;">${escHtml(ch.name)}</h3>
            <span style="color: var(--text-muted); font-size: 0.9rem;">@${escHtml(ch.username)}</span>
            ${ch.is_main ? '<span style="margin-top: 8px; font-size: 0.8rem; background: var(--accent); color: white; padding: 2px 8px; border-radius: 12px;">Main Channel</span>' : ''}
          </div>
        `;
        grid.appendChild(card);
      });
    } catch (err) {
      toast('Failed to load channels', 'error');
    }
  }

  // Replaced adminUploadChannelAvatar with openChannelEditor

  // ══════════════════════════════════════════════════════════════════════════
  // ── Videos panel ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let videoPage = 1;
  let videoSearch = '';
  let videoSearchTimeout;
  let videoSelectionMode = false;
  const selectedVideoIds = new Set();
  let adminSeriesCache = [];
  let adminPeopleCache = [];
  let adminViewerUsersCache = [];
  const VIDEO_LONG_PRESS_MS = 450;
  let videoLongPressTimer = null;

  function clearVideoLongPressTimer() {
    if (videoLongPressTimer) {
      clearTimeout(videoLongPressTimer);
      videoLongPressTimer = null;
    }
  }

  function enterVideoSelectionMode(videoId) {
    videoSelectionMode = true;
    if (videoId) selectedVideoIds.add(Number(videoId));
    updateVideoSelectionUi();
  }

  function exitVideoSelectionMode() {
    videoSelectionMode = false;
    selectedVideoIds.clear();
    updateVideoSelectionUi();
  }

  function toggleVideoSelection(videoId) {
    const id = Number(videoId);
    if (selectedVideoIds.has(id)) selectedVideoIds.delete(id);
    else selectedVideoIds.add(id);

    if (!selectedVideoIds.size) {
      exitVideoSelectionMode();
      return;
    }
    updateVideoSelectionUi();
  }

  function bindVideoSelectionRowHandlers() {
    document.querySelectorAll('#videos-tbody .admin-video-row').forEach((row) => {
      const id = Number(row.dataset.videoId);

      row.addEventListener('pointerdown', (e) => {
        if (videoSelectionMode) return;
        if (e.button !== 0) return;
        if (e.target.closest('button, a, input, select, textarea, .btn')) return;
        clearVideoLongPressTimer();
        videoLongPressTimer = setTimeout(() => {
          enterVideoSelectionMode(id);
        }, VIDEO_LONG_PRESS_MS);
      });

      row.addEventListener('pointerup', clearVideoLongPressTimer);
      row.addEventListener('pointerleave', clearVideoLongPressTimer);
      row.addEventListener('pointercancel', clearVideoLongPressTimer);

      row.addEventListener('click', (e) => {
        if (!videoSelectionMode) return;
        if (e.target.closest('button, a, input, select, textarea, .btn')) return;
        e.preventDefault();
        toggleVideoSelection(id);
      });
    });
  }

  async function populateBulkUserDropdown() {
    const select = document.getElementById('video-bulk-user');
    if (!select) return;

    if (!adminViewerUsersCache.length) {
      const users = await api('/api/admin/users');
      adminViewerUsersCache = users.filter((u) => u.role !== 'admin');
    }

    if (!adminViewerUsersCache.length) {
      select.innerHTML = '<option value="">No viewer accounts</option>';
      return;
    }

    select.innerHTML = adminViewerUsersCache
      .map((u) => `<option value="${u.id}">${escHtml(u.display_name || u.username)} (@${escHtml(u.username)})</option>`)
      .join('');
  }

  async function populateBulkSeriesDropdown() {
    const select = document.getElementById('video-bulk-series');
    if (!select) return;

    if (!adminSeriesCache.length) {
      adminSeriesCache = await api('/api/admin/series');
    }

    if (!adminSeriesCache.length) {
      select.innerHTML = '<option value="">No series created yet</option>';
      return;
    }

    select.innerHTML = adminSeriesCache
      .map((s) => `<option value="${s.id}">${escHtml(s.name)} (${Number(s.total_videos || 0)} videos)</option>`)
      .join('');
  }

  async function populateBulkPeopleTagDropdown() {
    const select = document.getElementById('video-bulk-people');
    if (!select) return;

    if (!adminPeopleCache.length) {
      adminPeopleCache = await api('/api/admin/people');
    }

    if (!adminPeopleCache.length) {
      select.innerHTML = '<option value="">No people available</option>';
      return;
    }

    select.innerHTML = adminPeopleCache
      .map((p) => `<option value="${p.id}">${escHtml(p.name)}</option>`)
      .join('');
  }

  async function applyBulkVideoAccess() {
    if (!selectedVideoIds.size) {
      toast('Select at least one video first.', 'error');
      return;
    }

    const modeSel = document.getElementById('video-bulk-access-mode');
    const userSel = document.getElementById('video-bulk-user');
    const seriesSel = document.getElementById('video-bulk-series');
    const peopleSel = document.getElementById('video-bulk-people');
    const seriesNameInput = document.getElementById('video-bulk-series-name');
    const seriesDescInput = document.getElementById('video-bulk-series-desc');
    const mode = modeSel?.value || 'everyone';
    const personUserId = Number(userSel?.value || 0);
    const seriesId = Number(seriesSel?.value || 0);
    const selectedPeopleIds = Array.from(peopleSel?.selectedOptions || [])
      .map((opt) => Number(opt.value))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (mode === 'user' && !personUserId) {
      toast('Choose a user account first.', 'error');
      return;
    }
    if (mode === 'series' && !seriesId) {
      toast('Choose a series first.', 'error');
      return;
    }
    if (mode === 'create_series' && !String(seriesNameInput?.value || '').trim()) {
      toast('Enter a series name first.', 'error');
      return;
    }
    if (mode === 'add_people' && !selectedPeopleIds.length) {
      toast('Select at least one person tag.', 'error');
      return;
    }

    if (mode === 'series') {
      try {
        await api(`/api/admin/series/${seriesId}/videos`, {
          method: 'POST',
          body: JSON.stringify({ video_ids: Array.from(selectedVideoIds) }),
        });
        toast(`Added ${selectedVideoIds.size} selected video${selectedVideoIds.size === 1 ? '' : 's'} to series.`);
        exitVideoSelectionMode();
        loadAdminVideos();
      } catch (err) {
        toast(err.message || 'Failed to add videos to series.', 'error');
      }
      return;
    }

    if (mode === 'create_series') {
      try {
        const created = await api('/api/admin/series', {
          method: 'POST',
          body: JSON.stringify({
            name: String(seriesNameInput?.value || '').trim(),
            description: String(seriesDescInput?.value || '').trim(),
          }),
        });
        const newSeriesId = Number(created?.series?.id || 0);
        if (!newSeriesId) throw new Error('Failed to create series.');
        await api(`/api/admin/series/${newSeriesId}/videos`, {
          method: 'POST',
          body: JSON.stringify({ video_ids: Array.from(selectedVideoIds) }),
        });

        adminSeriesCache = [];
        if (seriesNameInput) seriesNameInput.value = '';
        if (seriesDescInput) seriesDescInput.value = '';
        toast(`Created series and added ${selectedVideoIds.size} selected video${selectedVideoIds.size === 1 ? '' : 's'}.`);
        exitVideoSelectionMode();
        loadAdminVideos();
      } catch (err) {
        toast(err.message || 'Failed to create series and add videos.', 'error');
      }
      return;
    }

    if (mode === 'add_people') {
      let changed = 0;
      let failed = 0;
      for (const videoId of selectedVideoIds) {
        try {
          const current = await api(`/api/admin/videos/${videoId}/people`);
          const merged = Array.from(
            new Set([...(current || []).map((p) => Number(p.id)).filter((id) => Number.isInteger(id) && id > 0), ...selectedPeopleIds])
          );
          await api(`/api/admin/videos/${videoId}/people`, {
            method: 'PUT',
            body: JSON.stringify({ person_ids: merged }),
          });
          changed++;
        } catch {
          failed++;
        }
      }

      if (failed) toast(`People tagging done: ${changed} updated, ${failed} failed.`, 'error');
      else toast(`People tagging done: ${changed} updated.`);
      exitVideoSelectionMode();
      loadAdminVideos();
      return;
    }

    let changed = 0;
    let skipped = 0;
    let failed = 0;

    for (const videoId of selectedVideoIds) {
      try {
        if (mode === 'everyone') {
          await api(`/api/admin/videos/${videoId}/access`, {
            method: 'PUT',
            body: JSON.stringify({ all_users: true, user_ids: [] }),
          });
          changed++;
        } else {
          const current = await api(`/api/admin/videos/${videoId}/access`);
          if (current.all_users) {
            skipped++;
            continue;
          }
          const merged = Array.from(
            new Set([...(current.user_ids || []), personUserId].map(Number).filter((n) => !isNaN(n) && n > 0))
          );
          if (!merged.length) {
            skipped++;
            continue;
          }
          await api(`/api/admin/videos/${videoId}/access`, {
            method: 'PUT',
            body: JSON.stringify({ all_users: false, user_ids: merged }),
          });
          changed++;
        }
      } catch {
        failed++;
      }
    }

    if (failed) toast(`Bulk access done: ${changed} updated, ${skipped} skipped, ${failed} failed.`, 'error');
    else toast(`Bulk access done: ${changed} updated${skipped ? `, ${skipped} skipped` : ''}.`);

    exitVideoSelectionMode();
    loadAdminVideos();
  }

  document.getElementById('video-search')?.addEventListener('input', (e) => {
    clearTimeout(videoSearchTimeout);
    videoSearchTimeout = setTimeout(() => {
      videoSearch = e.target.value.trim();
      videoPage = 1;
      exitVideoSelectionMode();
      loadAdminVideos();
    }, 350);
  });

  document.getElementById('video-bulk-access-mode')?.addEventListener('change', async (e) => {
    const mode = e.target.value;
    if (mode === 'user') await populateBulkUserDropdown();
    if (mode === 'series') await populateBulkSeriesDropdown();
    if (mode === 'add_people') await populateBulkPeopleTagDropdown();
    updateVideoSelectionUi();
  });

  document.getElementById('video-bulk-apply-btn')?.addEventListener('click', async () => {
    await applyBulkVideoAccess();
  });

  document.getElementById('video-bulk-cancel-btn')?.addEventListener('click', () => {
    exitVideoSelectionMode();
  });

  function updateVideoSelectionUi() {
    const bar = document.getElementById('video-selection-bar');
    const count = document.getElementById('video-selection-count');
    const modeSel = document.getElementById('video-bulk-access-mode');
    const userWrap = document.getElementById('video-bulk-user-wrap');
    const seriesWrap = document.getElementById('video-bulk-series-wrap');
    const createWrap = document.getElementById('video-bulk-series-create-wrap');
    const createDescWrap = document.getElementById('video-bulk-series-desc-wrap');
    const peopleWrap = document.getElementById('video-bulk-people-wrap');

    if (bar) {
      bar.style.display = videoSelectionMode ? 'flex' : 'none';
    }
    if (count) {
      count.textContent = `${selectedVideoIds.size} selected`;
    }

    const mode = modeSel?.value || 'everyone';
    if (userWrap) userWrap.style.display = mode === 'user' ? '' : 'none';
    if (seriesWrap) seriesWrap.style.display = mode === 'series' ? '' : 'none';
    if (createWrap) createWrap.style.display = mode === 'create_series' ? '' : 'none';
    if (createDescWrap) createDescWrap.style.display = mode === 'create_series' ? '' : 'none';
    if (peopleWrap) peopleWrap.style.display = mode === 'add_people' ? '' : 'none';

    document.querySelectorAll('#videos-tbody .admin-video-row').forEach((row) => {
      const id = Number(row.dataset.videoId);
      row.classList.toggle('selected', selectedVideoIds.has(id));
    });
  }

  async function loadAdminVideos() {
    const tbody = document.getElementById('videos-tbody');
    const params = new URLSearchParams({ page: videoPage, limit: 30, ...(videoSearch ? { search: videoSearch } : {}) });
    try {
      const data = await api(`/api/videos?${params}`);
      if (!data.videos.length) {
        exitVideoSelectionMode();
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">No videos found.</td></tr>';
        document.getElementById('videos-pagination').innerHTML = '';
        return;
      }
      tbody.innerHTML = data.videos.map((v) => {
        const rawTitle = v.original_title || v.title;
        return `
        <tr class="admin-video-row${selectedVideoIds.has(v.id) ? ' selected' : ''}" data-video-id="${v.id}">
          <td data-label="#" style="color:var(--text-muted);font-size:0.75rem">${v.id}</td>
          <td data-label="Title">
            <a href="/watch.html?id=${v.id}" style="color:var(--accent);font-weight:500" target="_blank" title="${escHtml(rawTitle)}">${escHtml(v.title)}</a>
            ${v.description ? `<p style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px">${escHtml(v.description.slice(0, 80))}${v.description.length > 80 ? '…' : ''}</p>` : ''}
          </td>
          <td data-label="Category"><span class="card-category ${v.category}">${v.category === 'livestream' ? 'Live Stream' : 'Video'}</span></td>
          <td data-label="Duration">${formatDuration(v.duration) || '—'}</td>
          <td data-label="Views">${v.view_count}</td>
          <td data-label="Actions">
            <div class="admin-row-actions">
              <button class="btn btn-ghost btn-sm" onclick="openVideoEdit(${v.id}, ${JSON.stringify(escHtml(v.title)).replace(/"/g, "'")}, '${v.category}', ${JSON.stringify(escHtml(v.description || '')).replace(/"/g, "'")})">Edit</button>
            </div>
          </td>
        </tr>`;
      }).join('');

      bindVideoSelectionRowHandlers();
      updateVideoSelectionUi();

      renderVideosPagination(data.pages, data.page);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);padding:1rem">${escHtml(err.message)}</td></tr>`;
    }
  }

  function renderVideosPagination(pages, page) {
    const container = document.getElementById('videos-pagination');
    if (pages <= 1) { container.innerHTML = ''; return; }
    let html = `<button class="page-btn" onclick="adminVideoPage(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹</button>`;
    for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) {
      html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="adminVideoPage(${i})">${i}</button>`;
    }
    html += `<button class="page-btn" onclick="adminVideoPage(${page + 1})" ${page >= pages ? 'disabled' : ''}>›</button>`;
    container.innerHTML = html;
  }

  window.adminVideoPage = function (p) { videoPage = p; loadAdminVideos(); };

  // ── Video Edit modal ───────────────────────────────────────────────────────
  window.openVideoEdit = function (id, title, category, desc) {
    if (videoSelectionMode) {
      toggleVideoSelection(id);
      return;
    }
    document.getElementById('video-edit-id').value = id;
    document.getElementById('video-edit-title').value = title;
    document.getElementById('video-edit-category').value = category;
    document.getElementById('video-edit-desc').value = desc;
    document.getElementById('video-edit-error').textContent = '';
    openModal('video-edit-modal');
  };

  document.getElementById('video-edit-close')?.addEventListener('click', () => closeModal('video-edit-modal'));
  document.getElementById('video-edit-cancel')?.addEventListener('click', () => closeModal('video-edit-modal'));
  document.getElementById('video-edit-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('video-edit-modal');
  });

  document.getElementById('video-edit-save')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('video-edit-save');
    const id = document.getElementById('video-edit-id').value;
    saveBtn.disabled = true;
    document.getElementById('video-edit-error').textContent = '';
    try {
      await api(`/api/videos/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: document.getElementById('video-edit-title').value.trim(),
          category: document.getElementById('video-edit-category').value,
          description: document.getElementById('video-edit-desc').value,
        }),
      });
      closeModal('video-edit-modal');
      toast('Video updated!');
      loadAdminVideos();
    } catch (err) {
      document.getElementById('video-edit-error').textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Users panel ───────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    try {
      const users = await api('/api/admin/users');
      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">No users.</td></tr>';
        return;
      }
      tbody.innerHTML = users.map((u) => `
        <tr>
          <td data-label="Username" style="font-weight:600;color:var(--text-primary)">${escHtml(u.username)}</td>
          <td data-label="Display Name">${escHtml(u.display_name || '—')}</td>
          <td data-label="Role"><span class="badge badge-${u.role}">${u.role}</span>${u.can_upload ? ' <span class="badge" style="background:var(--success);color:#fff">Uploader</span>' : ''}</td>
          <td data-label="Last Login">${formatDate(u.last_login)}</td>
          <td data-label="Actions">
            <div class="admin-row-actions">
              <button class="btn btn-ghost btn-sm" onclick="editUser(${u.id}, '${escHtml(u.username)}', '${escHtml(u.display_name || '')}', '${u.role}', ${u.can_upload})" aria-label="Edit">Edit</button>
              <button class="btn btn-ghost btn-sm btn-icon" onclick="openAuthResetModal(${u.id}, '${escHtml(u.username)}')" aria-label="Reset Authentication" style="padding: 4px 8px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
                </svg>
              </button>
              ${u.id !== user.id
                ? `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${escHtml(u.username)}')">Delete</button>`
                : '<span style="font-size:0.75rem;color:var(--text-muted);padding:0.3rem">You</span>'}
            </div>
          </td>
        </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger);padding:1rem">${escHtml(err.message)}</td></tr>`;
    }
  }

  // ── Add user button ────────────────────────────────────────────────────────
  document.getElementById('add-user-btn')?.addEventListener('click', () => {
    document.getElementById('user-modal-title').textContent = 'Create New User';
    document.getElementById('user-modal-id').value = '';
    document.getElementById('user-username').value = '';
    document.getElementById('user-display-name').value = '';
    document.getElementById('user-role').value = 'viewer';
    document.getElementById('user-can-upload').checked = false;
    document.getElementById('user-password').value = '';
    document.getElementById('user-modal-error').textContent = '';

    // Show username field for new users
    document.getElementById('user-username-group').style.display = 'block';
    document.getElementById('user-pass-label').textContent = 'Password';
    document.getElementById('user-pass-hint').textContent = 'Minimum 8 characters.';

    openModal('user-modal');
  });

  window.editUser = function (id, username, displayName, role, canUpload) {
    document.getElementById('user-modal-title').textContent = 'Edit User Account';
    document.getElementById('user-modal-id').value = id;
    document.getElementById('user-username').value = username;
    document.getElementById('user-display-name').value = displayName;
    document.getElementById('user-role').value = role;
    document.getElementById('user-can-upload').checked = !!canUpload;
    document.getElementById('user-password').value = '';
    document.getElementById('user-modal-error').textContent = '';

    // Hide username field as it cannot be changed
    document.getElementById('user-username-group').style.display = 'none';
    document.getElementById('user-pass-label').textContent = 'Reset Password';
    document.getElementById('user-pass-hint').textContent = 'Leave blank to keep the current password.';

    openModal('user-modal');
  };

  window.deleteUser = async function (id, username) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      toast('User deleted.');
      loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  document.getElementById('user-modal-close')?.addEventListener('click', () => closeModal('user-modal'));
  document.getElementById('user-modal-cancel')?.addEventListener('click', () => closeModal('user-modal'));
  document.getElementById('user-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('user-modal');
  });

  // Auth Reset Modal Logic
  window.openAuthResetModal = function(id, username) {
    document.getElementById('auth-reset-id').value = id;
    document.getElementById('auth-reset-username').textContent = username;
    openModal('auth-reset-modal');
  };

  document.getElementById('auth-reset-close')?.addEventListener('click', () => closeModal('auth-reset-modal'));
  document.getElementById('auth-reset-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('auth-reset-modal');
  });

  document.getElementById('btn-reset-vhs')?.addEventListener('click', async () => {
    const id = document.getElementById('auth-reset-id').value;
    try {
      await api(`/api/admin/users/${id}/reset-lockouts`, { method: 'POST' });
      toast('VHS lockouts cleared.');
      closeModal('auth-reset-modal');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('btn-reset-2fa-attempts')?.addEventListener('click', async () => {
    const id = document.getElementById('auth-reset-id').value;
    try {
      await api(`/api/admin/users/${id}/reset-2fa-attempts`, { method: 'POST' });
      toast('2FA login challenges cleared.');
      closeModal('auth-reset-modal');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('btn-disable-2fa')?.addEventListener('click', async () => {
    const id = document.getElementById('auth-reset-id').value;
    if (!confirm('Are you sure you want to disable 2FA for this user? They will be able to log in with just their password.')) return;
    try {
      await api(`/api/admin/users/${id}/disable-2fa`, { method: 'POST' });
      toast('2FA disabled for user.');
      closeModal('auth-reset-modal');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('user-modal-save')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('user-modal-save');
    const id = document.getElementById('user-modal-id').value;
    const errEl = document.getElementById('user-modal-error');
    errEl.textContent = '';
    saveBtn.disabled = true;

    const display_name = document.getElementById('user-display-name').value.trim();
    const role = document.getElementById('user-role').value;
    const can_upload = document.getElementById('user-can-upload').checked ? 1 : 0;
    const password = document.getElementById('user-password').value;

    try {
      if (id) {
        // Editing existing user
        const payload = { display_name, role, can_upload };
        if (password) payload.new_password = password;
        await api(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('User updated.');
      } else {
        // Creating new user
        const username = document.getElementById('user-username').value.trim().toLowerCase();
        if (!password) { errEl.textContent = 'Password is required for new users.'; saveBtn.disabled = false; return; }
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({ username, password, display_name, role, can_upload }),
        });
        toast('User created.');
      }
      closeModal('user-modal');
      loadUsers();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Scan panel ────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  async function loadScanStatus() {
    try {
      const status = await api('/api/admin/scan-status');
      document.getElementById('scan-running').textContent = status.running ? '🔄 Running…' : '✓ Idle';
      document.getElementById('scan-found').textContent = status.found ?? '—';
      document.getElementById('scan-processed').textContent = status.processed ?? '—';
      document.getElementById('scan-message').textContent = status.message || '—';
      document.getElementById('scan-btn').disabled = status.running;
      const regenBtn = document.getElementById('regen-thumbs-btn');
      if (regenBtn) regenBtn.disabled = status.running;
      
      try {
        const transcodeSettings = await api('/api/admin/settings/transcoder');
        const toggle = document.getElementById('auto-transcode-toggle');
        const toggle4k = document.getElementById('auto-transcode-4k-toggle');
        const toggleSize = document.getElementById('auto-transcode-size-toggle');
        const sizeInput = document.getElementById('auto-transcode-size-input');

        const threadsSelect = document.getElementById('auto-transcode-threads-select');
        const cpuInfo = document.getElementById('auto-transcode-cpu-info');

        if (toggle) toggle.checked = !!transcodeSettings.auto_transcode_enabled;
        if (toggle4k) toggle4k.checked = !!transcodeSettings.auto_transcode_confirm_4k;
        if (toggleSize) toggleSize.checked = (transcodeSettings.auto_transcode_confirm_size_mb || 0) > 0;
        if (sizeInput) sizeInput.value = transcodeSettings.auto_transcode_confirm_size_mb || 2000;
        if (threadsSelect) threadsSelect.value = String(transcodeSettings.auto_transcode_threads || 0);

        if (cpuInfo && transcodeSettings.totalCpus) {
          cpuInfo.textContent = `(System has ${transcodeSettings.totalCpus} logical cores)`;
        }
      } catch (err) {}
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function startScanPolling(onComplete) {
    const poll = setInterval(async () => {
      const s = await api('/api/admin/scan-status');
      document.getElementById('scan-running').textContent = s.running ? '🔄 Running…' : '✓ Idle';
      document.getElementById('scan-found').textContent = s.found ?? '—';
      document.getElementById('scan-processed').textContent = s.processed ?? '—';
      document.getElementById('scan-errors').textContent = s.errors ?? '—';
      document.getElementById('scan-message').textContent = s.message || '—';
      document.getElementById('scan-btn').disabled = s.running;
      const regenBtn = document.getElementById('regen-thumbs-btn');
      if (regenBtn) regenBtn.disabled = s.running;
      if (!s.running) {
        clearInterval(poll);
        if (typeof onComplete === 'function') onComplete();
      }
    }, 2500);
  }

  document.getElementById('scan-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/scan', { method: 'POST' });
      toast('Scan started!');
      document.getElementById('scan-btn').disabled = true;
      const regenBtn = document.getElementById('regen-thumbs-btn');
      if (regenBtn) regenBtn.disabled = true;
      loadScanStatus();
      startScanPolling(() => toast('Scan complete!'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('refresh-scan-btn')?.addEventListener('click', loadScanStatus);

  document.getElementById('regen-thumbs-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/scan/regenerate-thumbnails', { method: 'POST' });
      toast('Thumbnail regeneration started!');
      document.getElementById('scan-btn').disabled = true;
      document.getElementById('regen-thumbs-btn').disabled = true;
      loadScanStatus();
      startScanPolling(() => toast('Thumbnail regeneration complete!'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function updateTranscoderSettingsPayload(payload) {
    try {
      await api('/api/admin/settings/transcoder', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      toast('Transcoder settings updated');
      loadTranscoderStatus();
    } catch (err) {
      toast('Failed to update transcode settings', 'error');
    }
  }

  document.getElementById('auto-transcode-toggle')?.addEventListener('change', async (e) => {
    await updateTranscoderSettingsPayload({ auto_transcode_enabled: e.target.checked });
  });

  document.getElementById('auto-transcode-4k-toggle')?.addEventListener('change', async (e) => {
    await updateTranscoderSettingsPayload({ auto_transcode_confirm_4k: e.target.checked });
  });

  document.getElementById('auto-transcode-size-toggle')?.addEventListener('change', async (e) => {
    const sizeInput = document.getElementById('auto-transcode-size-input');
    const val = e.target.checked ? (parseInt(sizeInput?.value, 10) || 2000) : 0;
    await updateTranscoderSettingsPayload({ auto_transcode_confirm_size_mb: val });
  });

  document.getElementById('auto-transcode-size-input')?.addEventListener('change', async (e) => {
    const toggleSize = document.getElementById('auto-transcode-size-toggle');
    if (toggleSize && toggleSize.checked) {
      const val = Math.max(1, parseInt(e.target.value, 10) || 2000);
      await updateTranscoderSettingsPayload({ auto_transcode_confirm_size_mb: val });
    }
  });

  document.getElementById('auto-transcode-threads-select')?.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10) || 0;
    await updateTranscoderSettingsPayload({ auto_transcode_threads: val });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Transcoder Panel ──────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  
  let transcodePoll = null;

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '—';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    const mb = bytes / (1024 * 1024);
    return mb.toFixed(1) + ' MB';
  }
  
  async function loadTranscoderStatus() {
    try {
      const status = await api('/api/admin/transcode/status');
      const currentJobEl = document.getElementById('transcode-current-job');
      const queueTbody = document.getElementById('transcode-queue-tbody');
      
      if (!currentJobEl || !queueTbody) return;

      if (!status.enabled) {
        currentJobEl.innerHTML = '<p style="color:var(--text-secondary);">Auto Transcoder is disabled in the Library Scan settings.</p>';
        queueTbody.innerHTML = '';
      } else if (!status.isProcessing) {
        currentJobEl.innerHTML = '<p style="color:var(--text-secondary);">Idle. No active jobs.</p>';
      } else {
        const job = status.currentJob;
        currentJobEl.innerHTML = `
          <div style="margin-bottom:8px;">
            <strong>Transcoding:</strong> ${escHtml(job.title || job.sourcePath.split(/[\\/]/).pop())} (ID: ${job.videoId})
          </div>
          <div class="upload-progress-bar-container">
            <div class="upload-progress-bar" style="width: ${status.currentProgress}%; background: var(--accent);"></div>
          </div>
          <div style="text-align:right; font-size: 0.85rem; margin-top:4px;">${status.currentProgress}%</div>
        `;
      }
      
      queueTbody.innerHTML = '';
      if (status.queue && status.queue.length > 0) {
        status.queue.forEach((job) => {
          const tr = document.createElement('tr');

          const resolutionStr = job.video_height > 0 ? `${job.video_height}p` : '—';
          const sizeStr = formatBytes(job.file_size);

          let statusBadge = '<span style="color:#60a5fa;font-weight:600;">Queued</span>';
          let actionsHtml = '';

          if (job.requiresApproval) {
            statusBadge = `<span style="color:#f59e0b;font-weight:600;" title="${escHtml(job.approvalReason || '')}">⚠️ Awaiting Approval</span>`;
            actionsHtml = `
              <button class="btn btn-sm btn-primary approve-job-btn" data-video-id="${job.videoId}" style="padding:2px 8px;font-size:0.8rem;">Approve</button>
              <button class="btn btn-sm btn-danger remove-job-btn" data-video-id="${job.videoId}" style="padding:2px 8px;font-size:0.8rem;margin-left:4px;">Cancel</button>
            `;
          } else {
            actionsHtml = `
              <button class="btn btn-sm btn-danger remove-job-btn" data-video-id="${job.videoId}" style="padding:2px 8px;font-size:0.8rem;">Cancel</button>
            `;
          }

          tr.innerHTML = `
            <td>
              <strong style="display:block;font-size:0.9rem;">${escHtml(job.title || 'Video #' + job.videoId)}</strong>
              <small style="color:var(--text-secondary);word-break:break-all;">${escHtml(job.sourcePath)}</small>
            </td>
            <td style="white-space:nowrap;">${resolutionStr} / ${sizeStr}</td>
            <td style="white-space:nowrap;">${statusBadge}</td>
            <td style="white-space:nowrap;">${actionsHtml}</td>
          `;
          queueTbody.appendChild(tr);
        });

        // Add event handlers for approve / remove
        queueTbody.querySelectorAll('.approve-job-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.videoId;
            try {
              await api(`/api/admin/transcode/approve/${id}`, { method: 'POST' });
              toast('Job approved! Transcoding will start.');
              loadTranscoderStatus();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });

        queueTbody.querySelectorAll('.remove-job-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.videoId;
            try {
              await api(`/api/admin/transcode/queue/${id}`, { method: 'DELETE' });
              toast('Job removed from queue.');
              loadTranscoderStatus();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        });
      } else if (status.enabled && !status.isProcessing) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="4" style="text-align:center; color:var(--text-secondary);">Queue is empty</td>`;
        queueTbody.appendChild(tr);
      }
    } catch (err) {
      console.error('Failed to load transcoder status', err);
    }
    
    // Manage polling
    if (!transcodePoll && document.getElementById('panel-transcoder').classList.contains('active')) {
      transcodePoll = setInterval(() => {
        if (!document.getElementById('panel-transcoder').classList.contains('active')) {
          clearInterval(transcodePoll);
          transcodePoll = null;
          return;
        }
        loadTranscoderStatus();
      }, 2000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Account / Change Password panel ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  async function processAndUploadAvatar(file) {
    const MAX_SIZE = 2 * 1024 * 1024;
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast('Only jpg, png, or webp images are allowed.', 'error');
      return;
    }
    if (file.size > MAX_SIZE) {
      toast('Image is too large (Max 2MB).', 'error');
      return;
    }

    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to initialize image processing.');

      const size = 400;
      canvas.width = size;
      canvas.height = size;

      const ratio = Math.max(size / bitmap.width, size / bitmap.height);
      const x = (size - bitmap.width * ratio) / 2;
      const y = (size - bitmap.height * ratio) / 2;
      ctx.drawImage(bitmap, x, y, bitmap.width * ratio, bitmap.height * ratio);

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((out) => {
          if (!out) {
            reject(new Error('Image encoding failed.'));
            return;
          }
          resolve(out);
        }, 'image/jpeg', 0.85);
      });

      if (blob.size > MAX_SIZE) {
        toast('Processed image is too large (Max 2MB).', 'error');
        return;
      }

      const imageBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read processed image.'));
        reader.readAsDataURL(blob);
      });

      const result = await api('/api/user/avatar', {
        method: 'POST',
        body: JSON.stringify({ imageBase64 }),
      });

      const current = getUser() || {};
      current.avatar_path = result.path;
      localStorage.setItem('ma_user', JSON.stringify(current));
      refreshAvatars(current);
      syncAvatarControls(current);
      toast('Profile picture updated!');
    } catch (err) {
      toast(err.message || 'Failed to process avatar.', 'error');
    }
  }

  document.getElementById('account-avatar-display')?.addEventListener('click', () => {
    document.getElementById('avatar-input')?.click();
  });

  document.getElementById('account-avatar-display')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.getElementById('avatar-input')?.click();
    }
  });

  document.getElementById('avatar-input')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await processAndUploadAvatar(file);
    e.target.value = '';
  });

  document.getElementById('remove-avatar-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/user/avatar', { method: 'DELETE' });
      const current = getUser() || {};
      current.avatar_path = null;
      localStorage.setItem('ma_user', JSON.stringify(current));
      refreshAvatars(current);
      syncAvatarControls(current);
      toast('Profile picture removed.');
    } catch (err) {
      toast(err.message || 'Failed to remove avatar.', 'error');
    }
  });

  syncAvatarControls(getUser());

  document.getElementById('change-pw-btn')?.addEventListener('click', async () => {
    const errEl = document.getElementById('pw-error');
    errEl.textContent = '';
    const cur = document.getElementById('cur-pass').value;
    const newP = document.getElementById('new-pass').value;
    const conf = document.getElementById('confirm-pass').value;

    if (!cur || !newP || !conf) { errEl.textContent = 'All fields are required.'; return; }
    if (newP !== conf) { errEl.textContent = 'New passwords do not match.'; return; }
    if (newP.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }

    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: cur, new_password: newP }),
      });
      toast('Password changed! Please log in again.');
      setTimeout(logout, 1500);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // ── System Settings / API Keys ──────────────────────────────────────────────
  const panelSettingsBtn = document.querySelector('[data-panel="panel-settings"]');
  if (panelSettingsBtn) {
    panelSettingsBtn.addEventListener('click', async () => {
      try {
        const data = await api('/api/admin/settings/api-keys');
        document.getElementById('settings-klipy-key').value = data.klipy_api_key || '';
      } catch (err) {
        toast('Failed to load settings: ' + err.message, 'error');
      }
    });
  }

  document.getElementById('settings-save-btn')?.addEventListener('click', async () => {
    const errEl = document.getElementById('settings-error');
    errEl.textContent = '';
    const klipyKey = document.getElementById('settings-klipy-key').value;

    try {
      await api('/api/admin/settings/api-keys', {
        method: 'POST',
        body: JSON.stringify({ klipy_api_key: klipyKey })
      });
      toast('Settings saved successfully.');
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // ── Escape closes modals ───────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('user-modal');
      closeModal('video-edit-modal');
      closeModal('person-modal');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── People panel ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let _personImgBase64 = null;
  let _personImgRemoved = false;

  async function loadPeople() {
    const grid = document.getElementById('people-admin-grid');
    try {
      const people = await api('/api/admin/people');
      if (!people.length) {
        grid.innerHTML = '<p style="color:var(--text-muted);padding:1rem 0">No people yet. Add someone above.</p>';
        return;
      }
      const token = getToken();
      grid.innerHTML = people.map((p) => {
        const initial = escHtml((p.name || '?').charAt(0).toUpperCase());
        const avatarHtml = p.image_path
          ? `<img src="/api/people/${p.id}/image?token=${encodeURIComponent(token || '')}" alt="${escHtml(p.name)}" />`
          : `<span class="person-card-avatar-fallback">${initial}</span>`;
        const linkedUser = p.username ? `@${escHtml(p.username)}` : 'Unlinked Profile';
        const bio = p.bio && String(p.bio).trim().length
          ? escHtml(p.bio)
          : 'No biography provided for this person.';
        return `
          <div class="person-admin-card">
            <div class="person-card-cover">
              <div class="person-card-avatar">
                ${avatarHtml}
              </div>
            </div>
            <div class="person-card-body">
              <h4 class="person-card-name">${escHtml(p.name)}</h4>
              <div class="person-card-link">${linkedUser}</div>
              <p class="person-card-bio">${bio}</p>
            </div>
            <div class="person-card-footer">
              <button class="btn btn-ghost btn-sm" onclick="editPerson(${p.id})">Edit Profile</button>
              <button class="btn btn-danger btn-sm" onclick="deletePerson(${p.id}, '${escHtml(p.name)}')">Delete</button>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      grid.innerHTML = `<p style="color:var(--danger)">${escHtml(err.message)}</p>`;
    }
  }

  async function populatePersonUserSelect(selectedUserId) {
    const sel = document.getElementById('person-user-link');
    try {
      const users = await api('/api/admin/users');
      sel.innerHTML = '<option value="">— No link —</option>' +
        users.filter((u) => u.role !== 'admin').map((u) =>
          `<option value="${u.id}" ${u.id === selectedUserId ? 'selected' : ''}>${escHtml(u.display_name || u.username)} (@${escHtml(u.username)})</option>`
        ).join('');
    } catch {
      sel.innerHTML = '<option value="">Failed to load users</option>';
    }
  }

  document.getElementById('add-person-btn')?.addEventListener('click', () => {
    document.getElementById('person-modal-title').textContent = 'Add Person';
    document.getElementById('person-modal-id').value = '';
    document.getElementById('person-name').value = '';
    document.getElementById('person-bio').value = '';
    document.getElementById('person-title-tags').value = '';
    document.getElementById('person-modal-error').textContent = '';
    document.getElementById('person-img-remove').style.display = 'none';
    const preview = document.getElementById('person-img-preview');
    preview.innerHTML = '?';
    preview.style.background = '';
    _personImgBase64 = null;
    _personImgRemoved = false;
    populatePersonUserSelect(null);
    openModal('person-modal');
  });

  window.editPerson = async function (id) {
    try {
      const people = await api('/api/admin/people');
      const p = people.find((x) => x.id === id);
      if (!p) { toast('Person not found.', 'error'); return; }

      document.getElementById('person-modal-title').textContent = 'Edit Person';
      document.getElementById('person-modal-id').value = id;
      document.getElementById('person-name').value = p.name;
      document.getElementById('person-bio').value = p.bio || '';
      document.getElementById('person-title-tags').value = p.title_tags || '';
      document.getElementById('person-modal-error').textContent = '';
      _personImgBase64 = null;
      _personImgRemoved = false;

      const preview = document.getElementById('person-img-preview');
      const token = getToken();
      if (p.image_path) {
        preview.innerHTML = `<img src="/api/people/${p.id}/image?token=${encodeURIComponent(token || '')}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`;
        document.getElementById('person-img-remove').style.display = '';
      } else {
        preview.innerHTML = escHtml(p.name[0] || '?');
        document.getElementById('person-img-remove').style.display = 'none';
      }

      await populatePersonUserSelect(p.user_id);
      openModal('person-modal');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.deletePerson = async function (id, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/people/${id}`, { method: 'DELETE' });
      toast('Person deleted.');
      loadPeople();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  document.getElementById('person-img-btn')?.addEventListener('click', () => {
    document.getElementById('person-img-input')?.click();
  });

  document.getElementById('person-img-input')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast('Only jpg, png, or webp allowed.', 'error'); return;
    }
    if (file.size > 2 * 1024 * 1024) { toast('Max 2MB.', 'error'); return; }

    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const size = 400;
      canvas.width = size; canvas.height = size;
      const ratio = Math.max(size / bitmap.width, size / bitmap.height);
      const x = (size - bitmap.width * ratio) / 2;
      const y = (size - bitmap.height * ratio) / 2;
      ctx.drawImage(bitmap, x, y, bitmap.width * ratio, bitmap.height * ratio);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('Read failed'));
        r.readAsDataURL(blob);
      });
      _personImgBase64 = base64;
      _personImgRemoved = false;
      const preview = document.getElementById('person-img-preview');
      preview.innerHTML = `<img src="${base64}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`;
      document.getElementById('person-img-remove').style.display = '';
    } catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  });

  document.getElementById('person-img-remove')?.addEventListener('click', () => {
    _personImgBase64 = null;
    _personImgRemoved = true;
    const preview = document.getElementById('person-img-preview');
    const nameVal = document.getElementById('person-name').value;
    preview.innerHTML = escHtml(nameVal[0] || '?');
    document.getElementById('person-img-remove').style.display = 'none';
  });

  document.getElementById('person-modal-close')?.addEventListener('click', () => closeModal('person-modal'));
  document.getElementById('person-modal-cancel')?.addEventListener('click', () => closeModal('person-modal'));
  document.getElementById('person-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('person-modal');
  });

  document.getElementById('person-modal-save')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('person-modal-save');
    const errEl = document.getElementById('person-modal-error');
    const id = document.getElementById('person-modal-id').value;
    const name = document.getElementById('person-name').value.trim();
    const bio = document.getElementById('person-bio').value.trim();
    const titleTags = document.getElementById('person-title-tags').value.trim();
    const userIdVal = document.getElementById('person-user-link').value;
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Name is required.'; return; }
    saveBtn.disabled = true;

    try {
      let personId = id ? parseInt(id, 10) : null;

      if (id) {
        await api(`/api/admin/people/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, bio, title_tags: titleTags, user_id: userIdVal ? parseInt(userIdVal, 10) : null }),
        });
      } else {
        const result = await api('/api/admin/people', {
          method: 'POST',
          body: JSON.stringify({ name, bio, title_tags: titleTags }),
        });
        personId = result.id;
        // Set user link
        if (userIdVal) {
          await api(`/api/admin/people/${personId}`, {
            method: 'PUT',
            body: JSON.stringify({ user_id: parseInt(userIdVal, 10) }),
          });
        }
      }

      // Upload image if selected
      if (_personImgBase64 && personId) {
        await api(`/api/admin/people/${personId}/image`, {
          method: 'POST',
          body: JSON.stringify({ imageBase64: _personImgBase64 }),
        });
      }

      toast(id ? 'Person updated.' : 'Person added.');
      closeModal('person-modal');
      loadPeople();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Series panel ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let _seriesAccessId = null;

  async function loadSeries() {
    const grid = document.getElementById('series-admin-grid');
    if (!grid) return;
    try {
      const [seriesRows, users] = await Promise.all([
        api('/api/admin/series'),
        api('/api/admin/users'),
      ]);
      const accessEntries = await Promise.all(
        seriesRows.map(async (s) => {
          try {
            const access = await api(`/api/admin/series/${s.id}/access`);
            return [s.id, access];
          } catch {
            return [s.id, { all_users: false, user_ids: [] }];
          }
        })
      );
      const accessMap = new Map(accessEntries);
      const viewerUsers = users.filter((u) => u.role !== 'admin');
      adminSeriesCache = seriesRows;

      if (!seriesRows.length) {
        grid.innerHTML = '<div class="state-empty">No series yet. Create one above.</div>';
        return;
      }

      const token = getToken();

      grid.innerHTML = seriesRows.map((s) => {
        const total = Number(s.total_videos || 0);
        const access = accessMap.get(s.id) || { all_users: false, user_ids: [] };
        const allowedUsers = Array.isArray(access.user_ids) ? access.user_ids : [];
        const statusText = access.all_users
          ? 'Public'
          : (allowedUsers.length ? `${allowedUsers.length} Viewer${allowedUsers.length === 1 ? '' : 's'}` : 'Private');

        const previewIds = String(s.preview_video_ids || '').split(',').map(Number).filter((id) => id > 0).slice(0, 3);
        const thumbStackHtml = previewIds.length
          ? `<div class="series-thumb-stack" aria-hidden="true">${previewIds.map((videoId, idx) => `<img class="series-thumb-item" data-layer="${idx}" src="/api/videos/${videoId}/thumbnail?token=${encodeURIComponent(token || '')}" loading="lazy" alt="" />`).join('')}</div>`
          : `<div class="series-thumb-stack empty-stack"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg></div>`;

        const desc = s.description && String(s.description).trim().length
          ? escHtml(s.description)
          : 'No description provided.';

        return `
          <div class="series-admin-card">
            <div class="series-card-cover">
              ${thumbStackHtml}
            </div>
            <div class="series-card-body">
              <h4 class="series-card-name">${escHtml(s.name)}</h4>
              <div class="series-card-meta">
                <span>${total} video${total === 1 ? '' : 's'}</span> • <span>${escHtml(statusText)}</span>
              </div>
              <p class="series-card-desc">${desc}</p>
            </div>
            <div class="series-card-footer">
              <button class="btn btn-ghost btn-sm" onclick="editSeries(${s.id})">Edit</button>
              <button class="btn btn-ghost btn-sm" onclick="openSeriesAccess(${s.id})">Access</button>
              <button class="btn btn-danger btn-sm" onclick="deleteSeriesAdmin(${s.id})">Delete</button>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      grid.innerHTML = `<div class="state-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
    }
  }

  window.openSeriesAccess = async function (seriesId) {
    _seriesAccessId = seriesId;
    document.getElementById('series-access-error').textContent = '';
    document.getElementById('series-users-list').innerHTML = 'Loading\u2026';
    openModal('series-access-modal');

    try {
      const [access, allUsers] = await Promise.all([
        api(`/api/admin/series/${seriesId}/access`),
        api('/api/admin/users'),
      ]);

      const allCb = document.getElementById('series-all-users');
      allCb.checked = access.all_users;
      const usersSection = document.getElementById('series-users-section');
      usersSection.style.opacity = access.all_users ? '0.3' : '1';
      usersSection.style.pointerEvents = access.all_users ? 'none' : 'auto';

      const selectedUserIds = Array.isArray(access.user_ids) ? access.user_ids : [];
      const viewers = allUsers.filter((u) => u.role !== 'admin');
      if (viewers.length) {
        document.getElementById('series-users-list').innerHTML = viewers.map((u) =>
          `<label class="vap-user-row">
            <input type="checkbox" class="series-user-cb" value="${u.id}" ${selectedUserIds.includes(u.id) ? 'checked' : ''} />
            <div class="vap-user-row-info">
              <span class="vap-user-row-name">${escHtml(u.display_name || u.username)}</span>
              <span class="vap-user-row-handle">@${escHtml(u.username)}</span>
            </div>
          </label>`
        ).join('');
      } else {
        document.getElementById('series-users-list').innerHTML = '<p class="vap-empty">No viewer accounts yet.</p>';
      }
    } catch (err) {
      document.getElementById('series-access-error').textContent = err.message;
    }
  };

  document.getElementById('series-all-users')?.addEventListener('change', () => {
    const checked = document.getElementById('series-all-users').checked;
    const usersSection = document.getElementById('series-users-section');
    usersSection.style.opacity = checked ? '0.3' : '1';
    usersSection.style.pointerEvents = checked ? 'none' : 'auto';
  });

  document.getElementById('series-access-close')?.addEventListener('click', () => closeModal('series-access-modal'));
  document.getElementById('series-access-cancel')?.addEventListener('click', () => closeModal('series-access-modal'));
  document.getElementById('series-access-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('series-access-modal');
  });

  document.getElementById('series-access-save')?.addEventListener('click', async () => {
    const errEl = document.getElementById('series-access-error');
    errEl.textContent = '';
    const allUsers = document.getElementById('series-all-users').checked;
    const userIds = [];
    document.querySelectorAll('.series-user-cb:checked').forEach((cb) => {
      userIds.push(parseInt(cb.value, 10));
    });

    try {
      await api(`/api/admin/series/${_seriesAccessId}/access`, {
        method: 'PUT',
        body: JSON.stringify({ all_users: allUsers, user_ids: userIds }),
      });
      toast('Series access saved.');
      closeModal('series-access-modal');
      loadSeries();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  document.getElementById('create-series-btn')?.addEventListener('click', () => {
    document.querySelector('#series-edit-modal .modal-header h3').textContent = 'Create Series';
    const idEl = document.getElementById('series-edit-id');
    const nameEl = document.getElementById('series-edit-name');
    const descEl = document.getElementById('series-edit-description');
    const errEl = document.getElementById('series-edit-error');
    if (idEl) idEl.value = '';
    if (nameEl) nameEl.value = '';
    if (descEl) descEl.value = '';
    if (errEl) errEl.textContent = '';
    openModal('series-edit-modal');
  });

  window.editSeries = function (seriesId) {
    const row = adminSeriesCache.find((s) => s.id === seriesId);
    if (!row) {
      toast('Series not found.', 'error');
      return;
    }

    document.querySelector('#series-edit-modal .modal-header h3').textContent = 'Edit Series';

    const idEl = document.getElementById('series-edit-id');
    const nameEl = document.getElementById('series-edit-name');
    const descEl = document.getElementById('series-edit-description');
    const errEl = document.getElementById('series-edit-error');
    if (!idEl || !nameEl || !descEl || !errEl) return;

    idEl.value = String(seriesId);
    nameEl.value = row.name || '';
    descEl.value = row.description || '';
    errEl.textContent = '';
    openModal('series-edit-modal');
  };

  window.deleteSeriesAdmin = async function (seriesId) {
    const row = adminSeriesCache.find((s) => s.id === seriesId);
    const name = row?.name || `#${seriesId}`;
    if (!confirm(`Delete series "${name}"?`)) return;
    try {
      await api(`/api/admin/series/${seriesId}`, { method: 'DELETE' });
      toast('Series deleted.');
      adminSeriesCache = [];
      loadSeries();
    } catch (err) {
      toast(err.message || 'Failed to delete series.', 'error');
    }
  };

  document.getElementById('series-edit-close')?.addEventListener('click', () => closeModal('series-edit-modal'));
  document.getElementById('series-edit-cancel')?.addEventListener('click', () => closeModal('series-edit-modal'));
  document.getElementById('series-edit-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('series-edit-modal');
  });

  document.getElementById('series-edit-save')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('series-edit-save');
    const idEl = document.getElementById('series-edit-id');
    const nameEl = document.getElementById('series-edit-name');
    const descEl = document.getElementById('series-edit-description');
    const errEl = document.getElementById('series-edit-error');
    if (!saveBtn || !idEl || !nameEl || !descEl || !errEl) return;

    const seriesId = Number(idEl.value || 0);
    const name = String(nameEl.value || '').trim();
    const description = String(descEl.value || '').trim();

    errEl.textContent = '';
    if (!name) {
      errEl.textContent = 'Playlist name is required.';
      return;
    }

    saveBtn.disabled = true;
    try {
      if (seriesId) {
        await api(`/api/admin/series/${seriesId}`, {
          method: 'PUT',
          body: JSON.stringify({ name, description }),
        });
        toast('Playlist details updated.');
      } else {
        await api('/api/admin/series', {
          method: 'POST',
          body: JSON.stringify({ name, description }),
        });
        toast('Series created.');
      }
      closeModal('series-edit-modal');
      adminSeriesCache = [];
      loadSeries();
    } catch (err) {
      errEl.textContent = err.message || 'Failed to save playlist.';
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ── Utils ──────────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Init: load videos panel ────────────────────────────────────────────────
  loadAdminVideos();

  // ══════════════════════════════════════════════════════════════════════════
  // ── Channel Profile Panel ─────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let _channelImgBase64 = null;
  let _channelImgRemoved = false;

  async function loadChannelProfile() {
    try {
      const profile = await api('/api/admin/settings/channel');
      const nameInput = document.getElementById('channel-name-input');
      const preview = document.getElementById('channel-avatar-preview');
      const removeBtn = document.getElementById('channel-avatar-remove');
      
      _channelImgBase64 = null;
      _channelImgRemoved = false;
      document.getElementById('channel-error').textContent = '';

      if (nameInput) nameInput.value = profile.channel_name || 'Mysticle Archive';
      
      const fallback = (profile.channel_name || 'M')[0].toUpperCase();
      if (profile.channel_avatar) {
        preview.innerHTML = `<img src="${profile.channel_avatar}?token=${encodeURIComponent(getToken() || '')}&t=${Date.now()}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`;
        removeBtn.style.display = '';
      } else {
        preview.innerHTML = escHtml(fallback);
        removeBtn.style.display = 'none';
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  document.getElementById('channel-avatar-upload')?.addEventListener('click', () => {
    document.getElementById('channel-avatar-input')?.click();
  });

  document.getElementById('channel-avatar-input')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!'image/jpeg,image/png,image/webp'.split(',').includes(file.type)) {
      toast('Only jpg, png, or webp allowed.', 'error'); return;
    }
    if (file.size > 2 * 1024 * 1024) { toast('Max 2MB.', 'error'); return; }

    window.openAvatarCropper(file, (croppedBase64) => {
      _channelImgBase64 = croppedBase64;
      _channelImgRemoved = false;
      const preview = document.getElementById('channel-avatar-preview');
      preview.innerHTML = `<img src="${croppedBase64}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`;
      document.getElementById('channel-avatar-remove').style.display = '';
      e.target.value = '';
    });
  });

  document.getElementById('channel-avatar-remove')?.addEventListener('click', () => {
    _channelImgBase64 = null;
    _channelImgRemoved = true;
    const preview = document.getElementById('channel-avatar-preview');
    const nameVal = document.getElementById('channel-name-input').value || 'M';
    preview.innerHTML = escHtml(nameVal[0].toUpperCase());
    document.getElementById('channel-avatar-remove').style.display = 'none';
  });

  document.getElementById('channel-save-btn')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('channel-save-btn');
    const errEl = document.getElementById('channel-error');
    const name = document.getElementById('channel-name-input').value.trim();
    
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Channel name is required.'; return; }
    saveBtn.disabled = true;

    try {
      await api('/api/admin/settings/channel', {
        method: 'PUT',
        body: JSON.stringify({ channel_name: name }),
      });

      if (_channelImgBase64) {
        await api('/api/admin/settings/channel/avatar', {
          method: 'POST',
          body: JSON.stringify({ imageBase64: _channelImgBase64 }),
        });
      } else if (_channelImgRemoved) {
        await api('/api/admin/settings/channel/avatar', { method: 'DELETE' });
      }

      toast('Channel profile updated.');
      loadChannelProfile();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dialogs panel ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  async function loadDialogs() {
    const listEl = document.getElementById('dialogs-admin-list');
    if (!listEl) return;
    listEl.textContent = 'Loading…';
    try {
      const dialogs = await api('/api/admin/dialogs');
      if (!dialogs.length) {
        listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No dialogs yet.</p>';
        return;
      }
      listEl.innerHTML = dialogs.map(d => `
        <div class="dialog-admin-row" data-id="${d.id}">
          <div class="dialog-admin-row-info">
            <span class="dialog-admin-row-title">${escHtml(d.title)}</span>
            <span class="dialog-admin-row-meta">${escHtml(d.created_by_name || 'System')} &middot; ${new Date(d.created_at).toLocaleDateString()} &middot; ${d.read_count} read</span>
          </div>
          <div class="dialog-admin-row-actions">
            <button class="btn btn-ghost btn-sm" onclick="previewDialog(${d.id})">Preview</button>
            <button class="btn btn-danger btn-sm" onclick="deleteDialogAdmin(${d.id})">Delete</button>
          </div>
        </div>
      `).join('');
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--danger);font-size:0.85rem">Failed to load dialogs.</p>`;
    }
  }

  document.getElementById('dialog-create-btn')?.addEventListener('click', async () => {
    const title = document.getElementById('dialog-new-title')?.value.trim();
    const body  = document.getElementById('dialog-new-body')?.value.trim();
    const titlePl = document.getElementById('dialog-new-title-pl')?.value.trim();
    const bodyPl  = document.getElementById('dialog-new-body-pl')?.value.trim();
    const errEl = document.getElementById('dialog-form-error');
    if (!title) { errEl.textContent = 'Title is required.'; return; }
    if (!body)  { errEl.textContent = 'Message body is required.'; return; }
    errEl.textContent = '';
    try {
      await api('/api/admin/dialogs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, title_pl: titlePl || null, body_pl: bodyPl || null }),
      });
      document.getElementById('dialog-new-title').value = '';
      document.getElementById('dialog-new-body').value = '';
      document.getElementById('dialog-new-title-pl').value = '';
      document.getElementById('dialog-new-body-pl').value = '';
      loadDialogs();
    } catch (e) { errEl.textContent = e.message || 'Network error.'; }
  });

  function renderDialogBody(rawBody) {
    return String(rawBody || '')
      .split(/\n\n+/)
      .filter((para) => String(para || '').trim())
      .map((para, idx) => {
        const escaped = para
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
        return `<p class="${idx === 0 ? 'dialog-intro' : 'dialog-paragraph'}">${escaped}</p>`;
      })
      .join('');
  }

  let currentPreviewDialogData = null;

  function updatePreviewDialogLanguage(lang) {
    const previewTitle = document.getElementById('dialog-preview-title');
    const previewBody = document.getElementById('dialog-preview-body');
    const btnEn = document.getElementById('dialog-preview-lang-en');
    const btnPl = document.getElementById('dialog-preview-lang-pl');
    if (!currentPreviewDialogData || !previewTitle || !previewBody) return;

    const hasPl = Boolean(currentPreviewDialogData.title_pl || currentPreviewDialogData.body_pl);
    const effectiveLang = (lang === 'pl' && hasPl) ? 'pl' : 'en';
    const title = effectiveLang === 'pl'
      ? (currentPreviewDialogData.title_pl || currentPreviewDialogData.title || 'Announcement')
      : (currentPreviewDialogData.title || 'Announcement');
    const body = effectiveLang === 'pl'
      ? (currentPreviewDialogData.body_pl || currentPreviewDialogData.body || '')
      : (currentPreviewDialogData.body || '');

    previewTitle.innerText = title;
    previewBody.innerHTML = renderDialogBody(body);
    btnEn?.classList.toggle('active', effectiveLang === 'en');
    btnPl?.classList.toggle('active', effectiveLang === 'pl');
    if (btnPl) btnPl.disabled = !hasPl;
  }

  // Expose for inline onclick
  window.previewDialog = async function(id) {
    const previewOverlay = document.getElementById('dialog-preview-overlay');
    if (!previewOverlay) return;

    try {
      const all = await api('/api/admin/dialogs');
      const dialogData = all.find((x) => Number(x.id) === Number(id));
      if (dialogData) {
        currentPreviewDialogData = dialogData;
        updatePreviewDialogLanguage('en');
      }
    } catch {
      const row = document.querySelector(`.dialog-admin-row[data-id="${id}"]`);
      currentPreviewDialogData = {
        title: row?.querySelector('.dialog-admin-row-title')?.textContent || 'Announcement',
        body: '',
        title_pl: null,
        body_pl: null,
      };
      updatePreviewDialogLanguage('en');
    }

    previewOverlay.classList.add('open');
  };

  document.getElementById('dialog-preview-lang-en')?.addEventListener('click', () => {
    updatePreviewDialogLanguage('en');
  });

  document.getElementById('dialog-preview-lang-pl')?.addEventListener('click', () => {
    updatePreviewDialogLanguage('pl');
  });

  const dialogPreviewClose = document.getElementById('dialog-preview-close');
  if (dialogPreviewClose) {
    dialogPreviewClose.onclick = () => {
      document.getElementById('dialog-preview-overlay')?.classList.remove('open');
    };
  }

  window.deleteDialogAdmin = async function(id) {
    if (!confirm('Delete this dialog? Users who haven\'t seen it yet will no longer receive it.')) return;
    await api(`/api/admin/dialogs/${id}`, { method: 'DELETE' });
    loadDialogs();
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ── Activity log panel ───────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  async function loadAuditLogs() {
    const listEl = document.getElementById('audit-log-list');
    if (!listEl) return;
    listEl.textContent = 'Loading…';
    try {
      const logs = await api('/api/admin/audit-logs?limit=300');
      if (!logs.length) {
        listEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No activity logged yet.</p>';
        return;
      }
      listEl.innerHTML = logs.map((row) => {
        const when = new Date(row.created_at).toLocaleString();
        const who = row.display_name || row.username || `User #${row.user_id || '?'}`;
        const details = row.details ? escHtml(row.details) : 'No details';
        const action = escHtml(row.action || 'unknown');
        const ip = row.ip_address ? `IP: ${escHtml(row.ip_address)}` : '';
        return `
          <div class="audit-log-row">
            <div class="audit-log-main">
              <span class="audit-log-action">${action}</span>
              <span class="audit-log-user">${escHtml(who)}</span>
              <span class="audit-log-time">${escHtml(when)}</span>
            </div>
            <div class="audit-log-details">${details}</div>
            ${ip ? `<div class="audit-log-ip">${ip}</div>` : ''}
          </div>
        `;
      }).join('');
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--danger);font-size:0.85rem">Failed to load activity log: ${escHtml(e.message || 'Unknown error')}</p>`;
    }
  }

  document.getElementById('refresh-audit-btn')?.addEventListener('click', () => {
    loadAuditLogs();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Shared Videos ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  async function loadShares() {
    try {
      const shares = await api('/api/admin/shares');
      const tbody = document.getElementById('admin-shares-list');
      if (!tbody) return;
      if (shares.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#888;">No videos are currently shared.</td></tr>';
        return;
      }
      tbody.innerHTML = shares.map(share => `
        <tr>
          <td>${share.video_id}</td>
          <td>${escHtml(share.video_title || 'Unknown Video')}</td>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="text" readonly value="${window.location.origin}/share/${share.token}" style="flex:1; padding:4px 8px; border-radius:4px; border:1px solid #333; background:#1a1a1a; color:#fff;" />
              <button class="btn-action icon-only" onclick="navigator.clipboard.writeText('${window.location.origin}/share/${share.token}'); window.toast('Copied link!')" title="Copy Link">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>
          </td>
          <td>${new Date(share.created_at).toLocaleString()}</td>
          <td>
            <button class="btn btn-danger btn-sm revoke-share-btn" data-id="${share.video_id}" title="Revoke Share">Revoke</button>
          </td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.revoke-share-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const videoId = e.target.dataset.id;
          if (confirm('Are you sure you want to revoke this public link? Anyone with the link will instantly lose access.')) {
            try {
              await api(`/api/admin/shares/${videoId}`, { method: 'DELETE' });
              toast('Share link revoked.');
              loadShares(); // refresh
            } catch (err) {
              toast('Error revoking share: ' + err.message, 'error');
            }
          }
        });
      });
    } catch (err) {
      toast('Failed to load shared videos: ' + err.message, 'error');
    }
  }

})();
