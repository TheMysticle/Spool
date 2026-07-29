/* main.js — home / browse page */
'use strict';

(function () {
  if (!requireAuth()) return;

  const STORAGE_KEY = 'ma_browse_state';
  const HOME_SELECT_LONG_PRESS_MS = 450;

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    category: 'all',
    search: '',
    sort: 'name_asc',
    page: 1,
    total: 0,
    pages: 0,
    mode: 'browse',
    personId: null,
    personName: '',
    seriesId: null,
    seriesName: '',
    specialChip: '',
  };
  let userProgress = {}; // { video_id: percent_watched }
  let favoriteIds = new Set();
  let homeSelectionMode = false;
  let homeLongPressTimer = null;
  let homeLongPressActivated = false;
  const selectedHomeItems = new Set();
  let homeBulkUsers = [];
  let homeBulkSeries = [];
  let homeBulkPeople = [];
  let currentBulkAction = 'grant_everyone';
  let currentBulkUserId = null;
  let currentBulkSeriesId = null;
  let bulkSelectedPeople = new Set();
  let seriesOrderState = {
    seriesId: null,
    seriesName: '',
    videos: [],
  };
  let seriesOrderDragIndex = -1;

  const savedState = localStorage.getItem(STORAGE_KEY);
  if (savedState) {
    try {
      const parsed = JSON.parse(savedState);
      state.category = parsed.category || 'all';
      state.sort     = parsed.sort     || 'name_asc';
      state.page     = parsed.page     || 1;
      state.search   = parsed.search   || '';
      state.mode     = ['browse', 'history', 'favorites', 'people', 'series', 'channels'].includes(parsed.mode) ? parsed.mode : 'browse';
      state.personId = Number.isFinite(Number(parsed.personId)) ? Number(parsed.personId) : null;
      state.personName = parsed.personName || '';
      state.seriesId = Number.isFinite(Number(parsed.seriesId)) ? Number(parsed.seriesId) : null;
      state.seriesName = parsed.seriesName || '';
    } catch (e) { console.error('Failed to restore browse state', e); }
  }

  function saveCurrentState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      category: state.category,
      sort:     state.sort,
      page:     state.page,
      search:   state.search,
      mode:     state.mode,
      personId: state.personId,
      personName: state.personName,
      seriesId: state.seriesId,
      seriesName: state.seriesName,
    }));
  }

  function syncUI() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = state.search;

    const sortLabels = {
      name_asc: 'Name: A to Z',
      name_desc: 'Name: Z to A',
      people_asc: 'People: A to Z',
      people_desc: 'People: Z to A',
      newest: 'Newest First',
      oldest: 'Oldest First',
    };
    const current = document.getElementById('sort-current');
    if (current) current.textContent = `Sort by: ${sortLabels[state.sort] || sortLabels.name_asc}`;
    document.querySelectorAll('.sort-option').forEach((opt) => {
      opt.classList.toggle('active', opt.dataset.sort === state.sort);
    });

    const isHistory = state.mode === 'history';
    const isFavorites = state.mode === 'favorites';
    const isPeople = state.mode === 'people';
    const isSeriesDirectory = state.mode === 'series' && !state.seriesId;
    const isSeriesSelected = state.mode === 'series' && Boolean(state.seriesId);
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const isBrowse = state.mode === 'browse';
      const isChip = btn.classList.contains('chip');
      const chipSpecial = (btn.dataset.special || '').trim();

      let active = false;
      if (isBrowse) {
        if (isChip && state.specialChip === 'recently-uploaded') {
          active = chipSpecial === 'recently-uploaded';
        } else {
          active = btn.dataset.category === state.category;
          if (isChip && chipSpecial && chipSpecial !== state.specialChip) active = false;
        }
      }

      btn.classList.toggle('active', active);
    });
    document.getElementById('history-btn')?.classList.toggle('active', isHistory);
    document.getElementById('favorites-btn')?.classList.toggle('active', isFavorites);
    document.getElementById('people-btn')?.classList.toggle('active', isPeople);
    document.getElementById('series-btn')?.classList.toggle('active', state.mode === 'series');

    document.getElementById('videos-view')?.classList.toggle('is-hidden', isPeople || isSeriesDirectory);
    document.getElementById('people-view')?.classList.toggle('is-hidden', !isPeople);
    document.getElementById('series-view')?.classList.toggle('is-hidden', !isSeriesDirectory);
    document.querySelector('.toolbar')?.classList.toggle('is-hidden', isSeriesSelected);

    const showSortTools = !(isPeople || state.mode === 'series' || isHistory);
    document.getElementById('sort-menu-container')?.classList.toggle('is-hidden', !showSortTools);
    const sortLabel = document.querySelector('.section-tools .sort-label');
    if (sortLabel) sortLabel.style.display = showSortTools ? '' : 'none';
    if (!showSortTools) {
      document.getElementById('sort-menu')?.classList.remove('show');
      document.getElementById('sort-trigger')?.setAttribute('aria-expanded', 'false');
    }

    updateSectionLabel();
    updateHomeSelectionUi();
  }

  let searchTimeout;
  const searchInputEl = document.getElementById('search-input');
  const searchClearBtnEl = document.getElementById('search-clear-btn');

  function updateSearchClearButton() {
    if (!searchClearBtnEl || !searchInputEl) return;
    searchClearBtnEl.classList.toggle('show', Boolean(searchInputEl.value.trim()));
  }

  // ── Bootstrap UI ──────────────────────────────────────────────────────────
  // Avatar / dropdown / admin link populated by shared.js DOMContentLoaded block

  // ── Category tabs ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.category = btn.dataset.category;
      const requestedSort = (btn.dataset.sort || '').trim();
      if (requestedSort) state.sort = requestedSort;
      state.specialChip = (btn.dataset.special || '').trim();
      state.mode = 'browse';
      state.personId = null;
      state.personName = '';
      state.seriesId = null;
      state.seriesName = '';
      state.channelId = null;
      state.channelName = '';
      state.page = 1;
      document.getElementById('channels-btn')?.classList.remove('active');
      document.getElementById('series-btn')?.classList.remove('active');
      document.getElementById('people-btn')?.classList.remove('active');
      document.getElementById('history-btn')?.classList.remove('active');
      document.getElementById('favorites-btn')?.classList.remove('active');
      btn.classList.add('active');
      syncUI();
      loadVideos();
    });
  });

  document.getElementById('history-btn')?.addEventListener('click', () => {
    state.mode = 'history';
    state.personId = null;
    state.personName = '';
    state.seriesId = null;
    state.seriesName = '';
    state.page = 1;
    // Clear active on category tabs, highlight history
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('history-btn')?.classList.add('active');
    document.getElementById('channels-btn')?.classList.remove('active');
    document.getElementById('series-btn')?.classList.remove('active');
    document.getElementById('people-btn')?.classList.remove('active');
    document.getElementById('favorites-btn')?.classList.remove('active');
    syncUI();
    updateSectionLabel();
    loadVideos();
  });

  document.getElementById('favorites-btn')?.addEventListener('click', () => {
    state.mode = 'favorites';
    state.personId = null;
    state.personName = '';
    state.seriesId = null;
    state.seriesName = '';
    state.page = 1;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('history-btn')?.classList.remove('active');
    document.getElementById('favorites-btn')?.classList.add('active');
    syncUI();
    updateSectionLabel();
    loadVideos();
  });

  document.getElementById('people-btn')?.addEventListener('click', () => {
    state.mode = 'people';
    state.personId = null;
    state.personName = '';
    state.seriesId = null;
    state.seriesName = '';
    state.page = 1;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('history-btn')?.classList.remove('active');
    document.getElementById('favorites-btn')?.classList.remove('active');
    document.getElementById('channels-btn')?.classList.remove('active');
    document.getElementById('series-btn')?.classList.remove('active');
    syncUI();
    loadPeopleDirectory();
  });

  document.getElementById('series-btn')?.addEventListener('click', () => {
    state.mode = 'series';
    state.personId = null;
    state.personName = '';
    state.seriesId = null;
    state.seriesName = '';
    state.page = 1;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('history-btn')?.classList.remove('active');
    document.getElementById('favorites-btn')?.classList.remove('active');
    document.getElementById('people-btn')?.classList.remove('active');
    document.getElementById('channels-btn')?.classList.remove('active');
    document.getElementById('series-btn')?.classList.add('active');
    syncUI();
    loadSeriesDirectory();
  });

  document.getElementById('channels-btn')?.addEventListener('click', () => {
    state.mode = 'channels';
    state.personId = null;
    state.personName = '';
    state.seriesId = null;
    state.seriesName = '';
    state.channelId = null;
    state.channelName = '';
    state.page = 1;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('history-btn')?.classList.remove('active');
    document.getElementById('favorites-btn')?.classList.remove('active');
    document.getElementById('people-btn')?.classList.remove('active');
    document.getElementById('series-btn')?.classList.remove('active');
    document.getElementById('channels-btn')?.classList.add('active');
    syncUI();
    loadChannelsDirectory();
  });

  document.getElementById('home-selection-apply')?.addEventListener('click', async () => {
    await applyHomeSelectionAccess();
  });

  document.getElementById('home-selection-clear')?.addEventListener('click', () => {
    homeSelectionMode = false;
    selectedHomeItems.clear();
    syncUI();
  });

  document.getElementById('home-selection-select-all')?.addEventListener('click', () => {
    if (!(state.mode === 'series' && state.seriesId)) return;
    const cards = document.querySelectorAll('#video-grid .home-selectable[data-select-key^="video:"]');
    cards.forEach((card) => {
      const key = card.getAttribute('data-select-key');
      if (key) selectedHomeItems.add(key);
    });
    updateHomeSelectionUi();
  });

  // ── Search ─────────────────────────────────────────────────────────────────
  document.getElementById('search-input')?.addEventListener('input', (e) => {
    updateSearchClearButton();
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value.trim();
      state.page = 1;
      loadVideos();
    }, 350);
  });

  searchClearBtnEl?.addEventListener('click', () => {
    if (!searchInputEl) return;
    searchInputEl.value = '';
    updateSearchClearButton();
    clearTimeout(searchTimeout);
    state.search = '';
    state.page = 1;
    loadVideos();
    searchInputEl.focus();
  });

  const sortTrigger = document.getElementById('sort-trigger');
  const sortMenu = document.getElementById('sort-menu');

  sortTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = sortMenu?.classList.toggle('show');
    sortTrigger.setAttribute('aria-expanded', String(Boolean(open)));
  });

  document.querySelectorAll('.sort-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      state.sort = opt.dataset.sort || 'name_asc';
      state.specialChip = '';
      state.page = 1;
      sortMenu?.classList.remove('show');
      sortTrigger?.setAttribute('aria-expanded', 'false');
      syncUI();
      loadVideos();
    });
  });

  document.addEventListener('click', (e) => {
    if (!sortMenu || !sortTrigger) return;
    if (!sortMenu.contains(e.target) && !sortTrigger.contains(e.target)) {
      sortMenu.classList.remove('show');
      sortTrigger.setAttribute('aria-expanded', 'false');
    }
  });


  // ── Helpers ────────────────────────────────────────────────────────────────
  function updateSectionLabel() {
    const labels = { all: 'All Videos', video: 'Videos', livestream: 'Live Streams', history: 'Recently Watched', favorites: 'Favorites', people: 'People', series: 'Series' };
    const el = document.getElementById('section-label');
    const subtitle = document.getElementById('section-subtitle');

    if (state.mode === 'people') {
      if (el) el.textContent = labels.people;
      if (subtitle) subtitle.textContent = 'Tap a profile to jump into their tagged videos.';
      return;
    }

    if (state.mode === 'channels') {
      if (el) el.textContent = labels.channels;
      if (subtitle) subtitle.textContent = 'Browse channels and open one to watch.';
      return;
    }

    if (state.mode === 'series' && !state.seriesId) {
      if (el) el.textContent = labels.series;
      if (subtitle) subtitle.textContent = 'Browse shared playlists and open one to watch.';
      return;
    }

    if (state.mode === 'series' && state.seriesId) {
      if (el) el.textContent = '';
      if (subtitle) subtitle.textContent = 'Only videos you can access are shown here.';
      return;
    }

    if (state.mode === 'history') {
      if (el) el.textContent = labels.history;
      if (subtitle) subtitle.textContent = 'Your recently watched archive.';
      return;
    }

    if (state.mode === 'favorites') {
      if (el) el.textContent = labels.favorites;
      if (subtitle) subtitle.textContent = 'Everything you saved for later.';
      return;
    }

    if (state.personId) {
      if (el) el.textContent = state.personName ? `Videos with ${state.personName}` : 'Tagged videos';
      if (subtitle) subtitle.textContent = 'All archive items tagged with this person.';
      return;
    }

    if (el) el.textContent = labels[state.category] || 'Videos';
    if (subtitle) subtitle.textContent = 'Browse the archive.';
  }

  async function loadFavoriteIds() {
    try {
      const data = await api('/api/user/favorites/ids');
      favoriteIds = new Set(Array.isArray(data.ids) ? data.ids : []);
    } catch {
      favoriteIds = new Set();
    }
  }

  function homeSelectionKey(type, id) {
    return `${type}:${id}`;
  }

  function toggleHomeSelection(type, id) {
    const key = homeSelectionKey(type, id);
    if (selectedHomeItems.has(key)) selectedHomeItems.delete(key);
    else selectedHomeItems.add(key);
    homeSelectionMode = selectedHomeItems.size > 0;
    updateHomeSelectionUi();
  }

  function selectedVideoIdsFromHomeSelection() {
    return Array.from(selectedHomeItems)
      .filter((key) => key.startsWith('video:'))
      .map((key) => Number(key.slice('video:'.length)))
      .filter((id) => Number.isInteger(id) && id > 0);
  }

  async function populateHomeBulkUserDropdown() {
    const userMenu = document.getElementById('bulk-user-menu');
    const userTrigger = document.getElementById('bulk-user-trigger');
    if (!userMenu || !userTrigger) return;

    if (!homeBulkUsers.length) {
      const users = await api('/api/admin/users');
      homeBulkUsers = users.filter((u) => u.role !== 'admin');
    }

    if (!homeBulkUsers.length) {
      userMenu.innerHTML = '<button class="glass-option" type="button" data-value="">No viewer accounts</button>';
      userTrigger.textContent = 'No viewer accounts';
      currentBulkUserId = null;
      return;
    }

    userMenu.innerHTML = homeBulkUsers
      .map((u) => `<button class="glass-option" type="button" data-value="${u.id}">${escHtml(u.display_name || u.username)} (@${escHtml(u.username)})</button>`)
      .join('');

    if (!homeBulkUsers.some((u) => Number(u.id) === Number(currentBulkUserId))) {
      currentBulkUserId = Number(homeBulkUsers[0].id);
    }
    const selectedUser = homeBulkUsers.find((u) => Number(u.id) === Number(currentBulkUserId)) || homeBulkUsers[0];
    if (selectedUser) {
      userTrigger.textContent = `${selectedUser.display_name || selectedUser.username} (@${selectedUser.username})`;
    }
  }

  async function populateHomeBulkSeriesDropdown() {
    const seriesMenu = document.getElementById('bulk-series-menu');
    const seriesTrigger = document.getElementById('bulk-series-trigger');
    if (!seriesMenu || !seriesTrigger) return;

    if (!homeBulkSeries.length) {
      const rows = await api('/api/admin/series');
      homeBulkSeries = rows;
    }

    if (!homeBulkSeries.length) {
      seriesMenu.innerHTML = '<button class="glass-option" type="button" data-value="">No playlists available</button>';
      seriesTrigger.textContent = 'No playlists available';
      currentBulkSeriesId = null;
      return;
    }

    seriesMenu.innerHTML = homeBulkSeries
      .map((s) => `<button class="glass-option" type="button" data-value="${s.id}">${escHtml(s.name)} (${Number(s.total_videos || 0)} videos)</button>`)
      .join('');

    if (!homeBulkSeries.some((s) => Number(s.id) === Number(currentBulkSeriesId))) {
      currentBulkSeriesId = Number(homeBulkSeries[0].id);
    }
    const selectedSeries = homeBulkSeries.find((s) => Number(s.id) === Number(currentBulkSeriesId)) || homeBulkSeries[0];
    if (selectedSeries) {
      seriesTrigger.textContent = `${selectedSeries.name} (${Number(selectedSeries.total_videos || 0)} videos)`;
    }
  }

  function toggleBulkPerson(personId) {
    const id = Number(personId);
    if (!Number.isInteger(id) || id <= 0) return;
    if (bulkSelectedPeople.has(id)) bulkSelectedPeople.delete(id);
    else bulkSelectedPeople.add(id);
    updatePeoplePickerUi();
  }

  function updatePeoplePickerUi() {
    const trigger = document.getElementById('people-picker-trigger');
    if (!trigger) return;

    const count = bulkSelectedPeople.size;
    trigger.textContent = count === 0 ? 'Select People' : `${count} Tagged`;
    trigger.classList.toggle('has-selection', count > 0);

    document.querySelectorAll('#people-picker-grid .flyout-item').forEach((item) => {
      const pid = Number(item.dataset.id);
      item.classList.toggle('active', bulkSelectedPeople.has(pid));
    });
  }

  async function populatePeoplePicker() {
    const grid = document.getElementById('people-picker-grid');
    if (!grid) return;

    if (!homeBulkPeople.length) {
      homeBulkPeople = await api('/api/admin/people');
    }

    if (!homeBulkPeople.length) {
      grid.innerHTML = '<p class="flyout-empty">No people available</p>';
      updatePeoplePickerUi();
      return;
    }

    const token = getToken();
    grid.innerHTML = homeBulkPeople.map((p) => `
      <button class="flyout-item" type="button" data-id="${p.id}">
        <div class="flyout-avatar">
          ${p.image_path
            ? `<img src="/api/people/${p.id}/image?token=${encodeURIComponent(token || '')}" alt="${escHtml(p.name)}" loading="lazy" />`
            : `<span>${escHtml((p.name || '?')[0].toUpperCase())}</span>`}
        </div>
        <span class="flyout-name">${escHtml(p.name)}</span>
      </button>
    `).join('');

    grid.querySelectorAll('.flyout-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleBulkPerson(btn.dataset.id);
      });
    });

    updatePeoplePickerUi();
  }

  async function applyHomeSelectionAccess() {
    if (getUser()?.role !== 'admin') return;

    const videoIds = selectedVideoIdsFromHomeSelection();
    if (!videoIds.length) {
      toast('Select at least one video card.', 'error');
      return;
    }

    const seriesNameInput = document.getElementById('home-bulk-series-name');
    const seriesDescInput = document.getElementById('home-bulk-series-desc');
    const mode = currentBulkAction;
    const uid = Number(currentBulkUserId || 0);
    const seriesId = Number(currentBulkSeriesId || 0);
    const selectedPeopleIds = Array.from(bulkSelectedPeople)
      .filter((id) => Number.isInteger(id) && id > 0);

    if ((mode === 'grant_user' || mode === 'remove_user') && !uid) {
      toast('Choose a user first.', 'error');
      return;
    }

    if (mode === 'add_to_series' && !seriesId) {
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

    if (mode === 'add_to_series') {
      try {
        await api(`/api/admin/series/${seriesId}/videos`, {
          method: 'POST',
          body: JSON.stringify({ video_ids: videoIds }),
        });
        toast(`Added ${videoIds.length} selected video${videoIds.length === 1 ? '' : 's'} to series.`);
      } catch (err) {
        toast(err.message || 'Failed to add videos to series.', 'error');
        return;
      }

      homeSelectionMode = false;
      selectedHomeItems.clear();
      syncUI();
      loadVideos();
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
          body: JSON.stringify({ video_ids: videoIds }),
        });

        homeBulkSeries = [];
        if (seriesNameInput) seriesNameInput.value = '';
        if (seriesDescInput) seriesDescInput.value = '';
        toast(`Created series and added ${videoIds.length} selected video${videoIds.length === 1 ? '' : 's'}.`);
      } catch (err) {
        toast(err.message || 'Failed to create series and add videos.', 'error');
        return;
      }

      homeSelectionMode = false;
      selectedHomeItems.clear();
      syncUI();
      loadVideos();
      return;
    }

    if (mode === 'add_people') {
      let changed = 0;
      let failed = 0;

      for (const videoId of videoIds) {
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

      homeSelectionMode = false;
      selectedHomeItems.clear();
      syncUI();
      loadVideos();
      return;
    }

    let changed = 0;
    let failed = 0;

    for (const videoId of videoIds) {
      try {
        const current = await api(`/api/admin/videos/${videoId}/access`);

        if (mode === 'grant_everyone') {
          await api(`/api/admin/videos/${videoId}/access`, {
            method: 'PUT',
            body: JSON.stringify({ all_users: true, user_ids: [] }),
          });
        } else if (mode === 'remove_everyone') {
          await api(`/api/admin/videos/${videoId}/access`, {
            method: 'PUT',
            body: JSON.stringify({ all_users: false, user_ids: current.user_ids || [] }),
          });
        } else if (mode === 'grant_user') {
          const merged = Array.from(new Set([...(current.user_ids || []), uid]));
          await api(`/api/admin/videos/${videoId}/access`, {
            method: 'PUT',
            body: JSON.stringify({ all_users: Boolean(current.all_users), user_ids: merged }),
          });
        } else if (mode === 'remove_user') {
          const filtered = (current.user_ids || []).filter((id) => Number(id) !== uid);
          await api(`/api/admin/videos/${videoId}/access`, {
            method: 'PUT',
            body: JSON.stringify({ all_users: Boolean(current.all_users), user_ids: filtered }),
          });
        }

        changed++;
      } catch {
        failed++;
      }
    }

    if (failed) toast(`Done: ${changed} updated, ${failed} failed.`, 'error');
    else toast(`Done: ${changed} updated.`);

    homeSelectionMode = false;
    selectedHomeItems.clear();
    syncUI();
    if (state.mode === 'people') loadPeopleDirectory();
    else loadVideos();
  }

  function updateHomeSelectionUi() {
    const bar = document.getElementById('home-selection-bar');
    const count = document.getElementById('home-selection-count');
    const userWrap = document.getElementById('bulk-user-wrapper');
    const seriesWrap = document.getElementById('bulk-series-wrapper');
    const peopleWrap = document.getElementById('bulk-people-wrapper');
    const nameInput = document.getElementById('home-bulk-series-name');
    const applyBtn = document.getElementById('home-selection-apply');
    const isAdmin = getUser()?.role === 'admin';
    const selectedItemCount = selectedHomeItems.size;

    if (bar) {
      bar.style.display = homeSelectionMode && isAdmin ? 'flex' : 'none';
      if (count) count.textContent = `${selectedHomeItems.size} selected`;
    }

    const mode = currentBulkAction;
    const hasTargetControl = mode === 'grant_user' || mode === 'remove_user' || mode === 'add_to_series' || mode === 'create_series' || mode === 'add_people';
    if (bar) bar.classList.toggle('has-target', hasTargetControl);
    if (userWrap) userWrap.style.display = (mode === 'grant_user' || mode === 'remove_user') ? 'block' : 'none';
    if (seriesWrap) seriesWrap.style.display = mode === 'add_to_series' ? 'block' : 'none';
    if (nameInput) nameInput.style.display = mode === 'create_series' ? 'block' : 'none';
    if (peopleWrap) {
      peopleWrap.style.display = mode === 'add_people' ? 'block' : 'none';
      if (mode === 'add_people') {
        populatePeoplePicker();
        updatePeoplePickerUi();
      }
    }

    if (nameInput && mode !== 'create_series') nameInput.value = '';

    if (applyBtn) applyBtn.disabled = !isAdmin || !homeSelectionMode || !selectedItemCount;

    document.querySelectorAll('.home-selectable').forEach((card) => {
      const key = card.dataset.selectKey;
      card.classList.toggle('selected', Boolean(key && selectedHomeItems.has(key)));
    });
  }

  function setupGlassSelect(wrapperId, onSelect) {
    const wrapper = document.getElementById(wrapperId);
    const trigger = wrapper?.querySelector('.glass-select-trigger');
    const menu = wrapper?.querySelector('.glass-select-menu');
    if (!wrapper || !trigger || !menu || wrapper.dataset.bound === '1') return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.glass-select-menu.show').forEach((m) => {
        if (m !== menu) m.classList.remove('show');
      });
      menu.classList.toggle('show');
    });

    menu.addEventListener('click', (e) => {
      const option = e.target.closest('.glass-option');
      if (!option) return;
      const val = option.dataset.value;
      const label = option.textContent || '';
      trigger.textContent = label;
      menu.classList.remove('show');
      if (onSelect) onSelect(val, label);
    });

    wrapper.dataset.bound = '1';
  }

  function setupPeoplePicker() {
    const trigger = document.getElementById('people-picker-trigger');
    const menu = document.getElementById('people-picker-menu');
    const wrapper = document.getElementById('bulk-people-wrapper');
    if (!trigger || !menu || !wrapper || wrapper.dataset.bound === '1') return;

    trigger.addEventListener('click', async (e) => {
      e.stopPropagation();
      document.querySelectorAll('.glass-select-menu.show').forEach((m) => m.classList.remove('show'));
      document.querySelectorAll('.people-flyout.show').forEach((m) => {
        if (m !== menu) m.classList.remove('show');
      });
      if (!menu.classList.contains('show')) {
        await populatePeoplePicker();
        updatePeoplePickerUi();
      }
      menu.classList.toggle('show');
    });

    menu.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    wrapper.dataset.bound = '1';
  }

  document.addEventListener('click', () => {
    document.querySelectorAll('.glass-select-menu.show').forEach((m) => m.classList.remove('show'));
    document.querySelectorAll('.people-flyout.show').forEach((m) => m.classList.remove('show'));
  });

  setupGlassSelect('bulk-action-wrapper', async (val) => {
    currentBulkAction = val || 'grant_everyone';
    if (currentBulkAction === 'grant_user' || currentBulkAction === 'remove_user') {
      await populateHomeBulkUserDropdown();
    } else if (currentBulkAction === 'add_to_series') {
      await populateHomeBulkSeriesDropdown();
    } else if (currentBulkAction === 'add_people') {
      await populatePeoplePicker();
      updatePeoplePickerUi();
    }
    updateHomeSelectionUi();
  });

  setupGlassSelect('bulk-user-wrapper', (val) => {
    currentBulkUserId = Number(val || 0) || null;
    updateHomeSelectionUi();
  });

  setupGlassSelect('bulk-series-wrapper', (val) => {
    currentBulkSeriesId = Number(val || 0) || null;
    updateHomeSelectionUi();
  });

  setupPeoplePicker();
  window.toggleBulkPerson = toggleBulkPerson;

  window.handleHomeCardPointerDown = function (event, type, id) {
    if (getUser()?.role !== 'admin') return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    clearTimeout(homeLongPressTimer);
    homeLongPressActivated = false;
    homeLongPressTimer = setTimeout(() => {
      if (!homeSelectionMode) {
        homeSelectionMode = true;
      }
      homeLongPressActivated = true;
      toggleHomeSelection(type, id);
    }, HOME_SELECT_LONG_PRESS_MS);
  };

  window.clearHomeCardPointerTimer = function () {
    clearTimeout(homeLongPressTimer);
    homeLongPressTimer = null;
  };

  window.handleHomeVideoCardClick = function (event, videoId) {
    if (getUser()?.role === 'admin' && homeLongPressActivated) {
      event.preventDefault();
      event.stopPropagation();
      homeLongPressActivated = false;
      return;
    }
    if (homeSelectionMode && getUser()?.role === 'admin') {
      event.preventDefault();
      event.stopPropagation();
      toggleHomeSelection('video', videoId);
      return;
    }
    const seriesQuery = state.mode === 'series' && state.seriesId
      ? `&series=${encodeURIComponent(String(state.seriesId))}`
      : '';
    const personQuery = !seriesQuery && state.personId
      ? `&person=${encodeURIComponent(String(state.personId))}${state.personName ? `&person_name=${encodeURIComponent(state.personName)}` : ''}`
      : '';
    location.href = `/watch.html?id=${videoId}${seriesQuery}${personQuery}`;
  };

  window.handleHomePersonCardClick = function (event, personId, personName) {
    if (getUser()?.role === 'admin' && homeLongPressActivated) {
      event.preventDefault();
      event.stopPropagation();
      homeLongPressActivated = false;
      return;
    }
    if (homeSelectionMode && getUser()?.role === 'admin') {
      event.preventDefault();
      event.stopPropagation();
      toggleHomeSelection('person', personId);
      return;
    }
    openPersonVideos(personId, personName);
  };

  window.handleHomePersonCardClickFromCard = function (event, personId, cardEl) {
    const personName = cardEl?.dataset?.personName || '';
    handleHomePersonCardClick(event, personId, personName);
  };

  window.toggleFavorite = async function (event, videoId) {
    event.stopPropagation();
    event.preventDefault();

    const buttonEl = event.target?.closest('.card-favorite-btn') || event.currentTarget;
    const cardEl = buttonEl?.closest('.video-card');
    if (cardEl) {
      cardEl.classList.add('suppress-hover');
      setTimeout(() => cardEl.classList.remove('suppress-hover'), 220);
    }

    const isFav = favoriteIds.has(videoId);
    try {
      if (isFav) {
        await api(`/api/user/favorites/${videoId}`, { method: 'DELETE' });
        favoriteIds.delete(videoId);
        toast('Removed from favorites.');

        if (state.mode === 'favorites') {
          loadVideos();
          return;
        }
      } else {
        await api(`/api/user/favorites/${videoId}`, { method: 'POST' });
        favoriteIds.add(videoId);
        toast('Added to favorites.');
      }

      const btn = buttonEl;
      if (btn) {
        btn.classList.toggle('active', !isFav);
        btn.setAttribute('aria-pressed', String(!isFav));
        btn.setAttribute('title', !isFav ? 'Remove favorite' : 'Add to favorites');
      }
    } catch (err) {
      toast(err.message || 'Failed to update favorite.', 'error');
    }
  };

  function thumbUrl(video) {
    const token = getToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    return video.thumbnail_path
      ? `/api/videos/${video.id}/thumbnail${tokenParam}`
      : null;
  }

  // Stored globally to pass from getAllVideos wrapper into card renders
  let globalChannelProfile = { channel_name: 'Mysticle Archive', channel_avatar: null };

  function renderVideoCard(video) {
    const thumb = thumbUrl(video);
    const dur = formatDuration(video.duration);
    const created = formatDate(video.content_date || video.file_created_at || video.scanned_at);
    const isFav = favoriteIds.has(video.id);
    
    const authorName = video.channel_name || globalChannelProfile.channel_name || 'Mysticle Archive';
    const authorAvatarPath = video.channel_avatar_path || globalChannelProfile.channel_avatar || '';
    const authorAvatar = authorAvatarPath ? `${authorAvatarPath}?t=${Date.now()}&token=${encodeURIComponent(getToken() || '')}` : '';
    const authorInitial = (authorName[0] || 'M').toUpperCase();
    const currentUser = getUser();
    const canEdit = canEditVideo(video);
    const adminGear = canEdit ? `
      <button class="card-admin-btn" type="button" title="Manage access &amp; people"
        onpointerdown="event.stopPropagation()"
        onclick="event.stopPropagation();event.preventDefault();openVideoAdminPopup(${video.id})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>` : '';

    return `
      <article class="video-card home-selectable" data-select-key="video:${video.id}" onclick="handleHomeVideoCardClick(event, ${video.id})" role="button" tabindex="0"
        onpointerdown="handleHomeCardPointerDown(event, 'video', ${video.id})"
        onpointerup="clearHomeCardPointerTimer()" onpointerleave="clearHomeCardPointerTimer()" onpointercancel="clearHomeCardPointerTimer()"
        onkeydown="if(event.key==='Enter')handleHomeVideoCardClick(event, ${video.id})">
        <div class="card-thumb">
          <button class="card-favorite-btn ${isFav ? 'active' : ''}" type="button" aria-pressed="${isFav ? 'true' : 'false'}" title="${isFav ? 'Remove favorite' : 'Add to favorites'}" onpointerdown="event.stopPropagation()" onclick="toggleFavorite(event, ${video.id})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7-4.35-9.5-8.14C.98 10.5 1.4 7.2 3.9 5.6c2.01-1.29 4.62-.9 6.1.9L12 8.4l2-1.9c1.48-1.8 4.09-2.19 6.1-.9 2.5 1.6 2.92 4.9 1.4 7.26C19 16.65 12 21 12 21z"/></svg>
          </button>
          ${adminGear}
          ${thumb
            ? `<img src="${thumb}" alt="${escHtml(video.title)}" loading="lazy" />`
            : `<div class="thumb-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
               </div>`
          }
          ${dur ? `<span class="card-duration">${escHtml(dur)}</span>` : ''}
          <span class="card-views-badge">${video.view_count} view${video.view_count !== 1 ? 's' : ''}</span>
          ${(userProgress[video.id] || 0) > 1 ? `<div class="card-progress-container"><div class="card-progress-bar" style="width:${Math.min(userProgress[video.id], 100)}%"></div></div>` : ''}
          <div class="card-play-overlay">
            <div class="card-play-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>
        </div>
        <div class="card-body">
          <div class="card-avatar">
            ${authorAvatar
              ? `<img src="${escHtml(authorAvatar)}" alt="${escHtml(authorName)}" loading="lazy" />`
              : escHtml(authorInitial)
            }
          </div>
          <div class="card-copy">
            <h3 class="card-title" title="${escHtml(video.title)}">${escHtml(video.title)}</h3>
            <div class="card-meta">
              <span>${escHtml(authorName)}</span>
              <span class="meta-dot">•</span>
              <span>${Number(video.view_count || 0).toLocaleString()} view${Number(video.view_count || 0) === 1 ? '' : 's'}</span>
              <span class="meta-dot">•</span>
              <span>${escHtml(created || 'Recently')}</span>
            </div>
          </div>
        </div>
      </article>`;
  }

  function formatHistoryDayLabel(dayKey) {
    const date = new Date(`${dayKey}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dayKey;

    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    const yesterdayKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;

    if (dayKey === todayKey) return 'Today';
    if (dayKey === yesterdayKey) return 'Yesterday';

    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function parseWatchedAtDate(rawValue) {
    if (!rawValue) return null;
    if (rawValue instanceof Date) return Number.isNaN(rawValue.getTime()) ? null : rawValue;
    const str = String(rawValue).trim();
    if (!str) return null;

    // SQLite CURRENT_TIMESTAMP is UTC ("YYYY-MM-DD HH:MM:SS").
    // Parse as UTC explicitly, then group by local calendar day.
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)
      ? `${str.replace(' ', 'T')}Z`
      : str;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function renderWatchHistoryGrouped(videos) {
    const groups = new Map();
    videos.forEach((video) => {
      const watched = parseWatchedAtDate(video.watched_at);
      const key = watched && !Number.isNaN(watched.getTime())
        ? `${watched.getFullYear()}-${String(watched.getMonth() + 1).padStart(2, '0')}-${String(watched.getDate()).padStart(2, '0')}`
        : 'Unknown date';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(video);
    });

    return Array.from(groups.entries()).map(([key, items]) => `
      <section class="history-date-section">
        <header class="history-date-header">
          <h3>${escHtml(formatHistoryDayLabel(key))}</h3>
          <span>${items.length} video${items.length === 1 ? '' : 's'}</span>
        </header>
        <div class="history-date-grid">
          ${items.map(renderVideoCard).join('')}
        </div>
      </section>
    `).join('');
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderPagination() {
    const container = document.getElementById('pagination');
    if (!container) return;
    if (state.pages <= 1) { container.innerHTML = ''; return; }

    let html = '';
    html += `<button class="page-btn" onclick="changePage(${state.page - 1})" ${state.page <= 1 ? 'disabled' : ''}>‹</button>`;

    const start = Math.max(1, state.page - 2);
    const end = Math.min(state.pages, state.page + 2);

    if (start > 1) html += `<button class="page-btn" onclick="changePage(1)">1</button>${start > 2 ? '<span style="color:var(--text-muted);padding:0 0.25rem">…</span>' : ''}`;

    for (let i = start; i <= end; i++) {
      html += `<button class="page-btn ${i === state.page ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
    }

    if (end < state.pages) {
      html += `${end < state.pages - 1 ? '<span style="color:var(--text-muted);padding:0 0.25rem">…</span>' : ''}<button class="page-btn" onclick="changePage(${state.pages})">${state.pages}</button>`;
    }

    html += `<button class="page-btn" onclick="changePage(${state.page + 1})" ${state.page >= state.pages ? 'disabled' : ''}>›</button>`;
    container.innerHTML = html;
  }

  window.changePage = function (page) {
    state.page = page;
    loadVideos();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function openPersonVideos(personId, personName) {
    state.personId = personId;
    state.personName = personName || '';
    state.mode = 'browse';
    state.category = 'all';
    state.search = '';
    state.seriesId = null;
    state.seriesName = '';
    state.page = 1;
    syncUI();
    loadVideos();
  }

  function openSeriesVideos(seriesId, seriesName) {
    state.mode = 'series';
    state.seriesId = Number(seriesId);
    state.seriesName = seriesName || '';
    state.page = 1;
    syncUI();
    loadVideos();
  }

  function renderPeopleCard(person, token) {
    const avatarSrc = person.image_path
      ? `/api/people/${person.id}/image?token=${encodeURIComponent(token || '')}`
      : '';
    const fallback = escHtml((person.name || '?')[0].toUpperCase());
    const count = Number(person.video_count || 0);

    return `
      <article class="person-chip home-selectable" data-select-key="person:${person.id}" role="button" tabindex="0" data-person-id="${person.id}" data-person-name="${escHtml(person.name)}"
        onclick="handleHomePersonCardClickFromCard(event, ${person.id}, this)"
        onpointerdown="handleHomeCardPointerDown(event, 'person', ${person.id})"
        onpointerup="clearHomeCardPointerTimer()" onpointerleave="clearHomeCardPointerTimer()" onpointercancel="clearHomeCardPointerTimer()"
        onkeydown="if(event.key==='Enter')handleHomePersonCardClickFromCard(event, ${person.id}, this)">
        <div class="person-chip-bg">
          ${avatarSrc
            ? `<img src="${avatarSrc}" alt="${escHtml(person.name)}" loading="lazy" />`
            : `<div class="person-chip-fallback">${fallback}</div>`
          }
          <div class="person-chip-overlay"></div>
        </div>
        <div class="person-chip-copy">
          <h3 class="person-chip-name">${escHtml(person.name)}</h3>
          <span class="person-chip-count">${count} video${count === 1 ? '' : 's'}</span>
        </div>
      </article>`;
  }

  async function loadPeopleDirectory() {
    saveCurrentState();
    const grid = document.getElementById('people-grid');
    document.getElementById('channel-page-container').style.display = 'none';
    document.getElementById('top-chip-bar').style.display = 'flex';
    document.querySelector('.toolbar').style.display = 'flex';
    if (grid) grid.style.display = 'grid';
    const countEl = document.getElementById('people-count');
    if (!grid) return;

    grid.innerHTML = '<div class="state-loading people-state-loading"><div class="spinner"></div><span>Loading people…</span></div>';
    if (countEl) countEl.textContent = '—';

    try {
      const people = await api('/api/people');
      if (countEl) countEl.textContent = `${people.length} person${people.length !== 1 ? 's' : ''}`;

      if (!people.length) {
        grid.innerHTML = '<div class="state-empty people-state-empty"><p>No people have been added yet.</p></div>';
        return;
      }

      const token = getToken();
      grid.innerHTML = people.map((person) => renderPeopleCard(person, token)).join('');
      updateHomeSelectionUi();
    } catch (err) {
      grid.innerHTML = `<div class="state-empty people-state-empty"><p style="color:var(--danger)">Failed to load people: ${escHtml(err.message)}</p></div>`;
    }
  }

  function renderSeriesCard(series) {
    const visibleCount = Number(series.visible_videos || 0);
    const totalCount = Number(series.total_videos || 0);
    const token = getToken();
    const previewIds = String(series.preview_video_ids || '')
      .split(',')
      .map((part) => Number(part))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 3);
    const thumbStack = previewIds.length
      ? `<div class="series-thumb-stack" aria-hidden="true">${previewIds
          .map((videoId, idx) => `<img class="series-thumb-item" data-layer="${idx}" src="/api/videos/${videoId}/thumbnail?token=${encodeURIComponent(token || '')}" loading="lazy" alt="" />`)
          .join('')}</div>`
      : `<span style="font-size:1.2rem">▶</span>`;
    const adminGear = getUser()?.role === 'admin'
      ? `<button class="series-admin-btn" type="button" title="Reorder playlist"
          onpointerdown="event.stopPropagation()"
          onclick="event.preventDefault();event.stopPropagation();openSeriesOrderModal(${series.id})">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>`
      : '';
    return `
      <article class="series-chip" role="button" tabindex="0" data-series-name="${escHtml(series.name)}"
        onclick="handleSeriesCardClickFromCard(event, ${series.id}, this)"
        onkeydown="if(event.key==='Enter')handleSeriesCardClickFromCard(event, ${series.id}, this)">
        <div class="series-chip-media">
          ${adminGear}
          ${thumbStack}
        </div>
        <div class="series-chip-copy">
          <h3 class="series-chip-name">${escHtml(series.name)}</h3>
          <span class="series-chip-count">${visibleCount} of ${totalCount} videos</span>
        </div>
      </article>`;
  }

  function renderSeriesPlaylistItem(video, index) {
    const thumb = thumbUrl(video);
    const dur = formatDuration(video.duration) || '—';
    const created = formatDate(video.content_date || video.file_created_at || video.scanned_at);
    const progress = Math.min(Math.max(Number(userProgress[video.id] || 0), 0), 100);

    return `
      <article class="series-playlist-item home-selectable${index === 0 ? ' is-active' : ''}" data-select-key="video:${video.id}"
        role="button" tabindex="0"
        onclick="handleHomeVideoCardClick(event, ${video.id})"
        onpointerdown="handleHomeCardPointerDown(event, 'video', ${video.id})"
        onpointerup="clearHomeCardPointerTimer()" onpointerleave="clearHomeCardPointerTimer()" onpointercancel="clearHomeCardPointerTimer()"
        onkeydown="if(event.key==='Enter')handleHomeVideoCardClick(event, ${video.id})">
        <span class="series-playlist-index">${index + 1}</span>
        <div class="series-playlist-thumb-wrap">
          ${thumb
            ? `<img class="series-playlist-thumb" src="${thumb}" alt="${escHtml(video.title)}" loading="lazy" />`
            : `<div class="series-playlist-thumb series-playlist-thumb-placeholder">▶</div>`}
          <span class="series-playlist-duration">${escHtml(dur)}</span>
          ${progress > 1 ? `<span class="series-playlist-progress" style="width:${progress}%"></span>` : ''}
        </div>
        <div class="series-playlist-copy">
          <h4>${escHtml(video.title)}</h4>
          <p>${video.view_count} view${video.view_count !== 1 ? 's' : ''} · ${escHtml(created)}</p>
        </div>
      </article>`;
  }

  function renderSeriesSelectedView(result, videos) {
    const first = videos[0];
    const title = result?.series?.name || state.seriesName || 'Series';
    const description = String(result?.series?.description || '').trim();
    const totalLabel = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;
    const firstThumb = first ? thumbUrl(first) : null;
    const adminActions = getUser()?.role === 'admin'
      ? `<button class="btn btn-ghost btn-sm" type="button" onclick="openSeriesOrderModal(${Number(state.seriesId || 0)})">Reorder playlist</button>`
      : '';

    if (!first) {
      return `
        <section class="series-selected-layout">
          <header class="series-selected-hero">
            <div class="series-selected-eyebrow">Series</div>
            <h3>${escHtml(title)}</h3>
            <p>This series has no videos you can watch yet.</p>
            <button class="btn btn-ghost btn-sm" type="button" onclick="backToSeriesDirectory()">Back to series</button>
          </header>
        </section>`;
    }

    return `
      <section class="series-selected-layout">
        <header class="series-selected-hero">
          <div class="series-selected-eyebrow">Series playlist</div>
          <h3>${escHtml(title)}</h3>
          ${description ? `<p>${escHtml(description)}</p>` : '<p>Watch from the top or jump to any item in the playlist.</p>'}
          <div class="series-hero-meta">
            <span>${totalLabel}</span>
            <span>Starts with: ${escHtml(first.title)}</span>
          </div>
          <div class="series-hero-actions">
            <button class="btn btn-primary btn-sm" type="button" onclick="handleHomeVideoCardClick(event, ${first.id})">Play from start</button>
            ${adminActions}
            <button class="btn btn-ghost btn-sm" type="button" onclick="backToSeriesDirectory()">Back to series</button>
          </div>
        </header>

        <article class="series-feature-card home-selectable" data-select-key="video:${first.id}" role="button" tabindex="0"
          onclick="handleHomeVideoCardClick(event, ${first.id})"
          onpointerdown="handleHomeCardPointerDown(event, 'video', ${first.id})"
          onpointerup="clearHomeCardPointerTimer()" onpointerleave="clearHomeCardPointerTimer()" onpointercancel="clearHomeCardPointerTimer()"
          onkeydown="if(event.key==='Enter')handleHomeVideoCardClick(event, ${first.id})">
          <div class="series-feature-media">
            ${firstThumb
              ? `<img src="${firstThumb}" alt="${escHtml(first.title)}" loading="lazy" />`
              : '<div class="series-feature-placeholder">▶</div>'}
          </div>
          <div class="series-feature-copy">
            <h4>${escHtml(first.title)}</h4>
            <p>${first.description ? escHtml(first.description) : 'Open this video to begin the series.'}</p>
          </div>
        </article>

        <aside class="series-playlist-panel">
          <div class="series-playlist-head">
            <h4>Playlist</h4>
            <span>${totalLabel}</span>
          </div>
          <div class="series-playlist-list">
            ${videos.map((video, idx) => renderSeriesPlaylistItem(video, idx)).join('')}
          </div>
        </aside>
      </section>`;
  }

  function syncSeriesPlaylistPanelHeight() {
    const layout = document.querySelector('#video-grid .series-selected-layout');
    if (!layout) return;

    const panel = layout.querySelector('.series-playlist-panel');
    const feature = layout.querySelector('.series-feature-card');
    if (!panel || !feature) return;

    if (window.matchMedia('(max-width: 1024px)').matches) {
      panel.style.maxHeight = '';
      return;
    }

    const featureHeight = Math.ceil(feature.getBoundingClientRect().height);
    if (featureHeight > 0) {
      panel.style.maxHeight = `${featureHeight}px`;
    }
  }

  window.handleSeriesCardClickFromCard = function (event, seriesId, cardEl) {
    event.preventDefault();
    const seriesName = cardEl?.dataset?.seriesName || '';
    openSeriesVideos(seriesId, seriesName);
  };

  window.backToSeriesDirectory = function () {
    state.mode = 'series';
    state.seriesId = null;
    state.seriesName = '';
    state.page = 1;
    syncUI();
    loadSeriesDirectory();
  };

  window.addEventListener('resize', () => {
    if (state.mode === 'series' && state.seriesId) {
      syncSeriesPlaylistPanelHeight();
    }
  });

  function renderSeriesOrderList() {
    const listEl = document.getElementById('series-order-list');
    if (!listEl) return;
    const token = getToken();

    if (!seriesOrderState.videos.length) {
      listEl.innerHTML = '<div class="state-empty"><p>No videos in this playlist.</p></div>';
      return;
    }

    listEl.innerHTML = seriesOrderState.videos.map((video, idx) => {
      const thumb = video.thumbnail_path
        ? `/api/videos/${video.id}/thumbnail?token=${encodeURIComponent(token || '')}`
        : '';
      return `
        <article class="series-order-item" draggable="true"
          ondragstart="startSeriesOrderDrag(event, ${idx})"
          ondragover="overSeriesOrderDrag(event)"
          ondragleave="leaveSeriesOrderDrag(event)"
          ondrop="dropSeriesOrderDrag(event, ${idx})"
          ondragend="endSeriesOrderDrag(event)">
          <span class="series-order-item-index">${idx + 1}</span>
          <div class="series-order-item-thumb">
            ${thumb ? `<img src="${thumb}" alt="${escHtml(video.title)}" loading="lazy" />` : '<div class="thumb-placeholder" style="font-size:1rem">▶</div>'}
          </div>
          <p class="series-order-item-title">${escHtml(video.title)}</p>
          <div class="series-order-item-actions">
            <button class="btn btn-ghost btn-sm" type="button" title="Move up" ${idx === 0 ? 'disabled' : ''} onclick="moveSeriesOrderItem(${idx}, -1)">↑</button>
            <button class="btn btn-ghost btn-sm" type="button" title="Move down" ${idx === seriesOrderState.videos.length - 1 ? 'disabled' : ''} onclick="moveSeriesOrderItem(${idx}, 1)">↓</button>
          </div>
        </article>`;
    }).join('');
  }

  window.startSeriesOrderDrag = function (event, index) {
    seriesOrderDragIndex = Number(index);
    if (event?.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
    event?.currentTarget?.classList?.add('is-dragging');
  };

  window.overSeriesOrderDrag = function (event) {
    event.preventDefault();
    event.currentTarget?.classList?.add('drag-over');
    if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
  };

  window.leaveSeriesOrderDrag = function (event) {
    event.currentTarget?.classList?.remove('drag-over');
  };

  window.endSeriesOrderDrag = function (event) {
    event.currentTarget?.classList?.remove('is-dragging');
    document.querySelectorAll('.series-order-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
  };

  window.dropSeriesOrderDrag = function (event, targetIndex) {
    event.preventDefault();
    const target = Number(targetIndex);
    const source = Number.isInteger(seriesOrderDragIndex) ? seriesOrderDragIndex : Number(event?.dataTransfer?.getData('text/plain'));
    event.currentTarget?.classList?.remove('drag-over');

    if (!Number.isInteger(source) || !Number.isInteger(target)) return;
    if (source < 0 || target < 0 || source >= seriesOrderState.videos.length || target >= seriesOrderState.videos.length) return;
    if (source === target) return;

    const next = [...seriesOrderState.videos];
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    seriesOrderState.videos = next;
    seriesOrderDragIndex = -1;
    renderSeriesOrderList();
  };

  window.moveSeriesOrderItem = function (index, direction) {
    const from = Number(index);
    const delta = Number(direction);
    const to = from + delta;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    if (from < 0 || to < 0 || from >= seriesOrderState.videos.length || to >= seriesOrderState.videos.length) return;
    const next = [...seriesOrderState.videos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    seriesOrderState.videos = next;
    renderSeriesOrderList();
  };

  window.openSeriesOrderModal = async function (seriesId) {
    if (getUser()?.role !== 'admin') return;
    const id = Number(seriesId);
    if (!Number.isInteger(id) || id < 1) return;

    const titleEl = document.getElementById('series-order-title');
    const errEl = document.getElementById('series-order-error');
    if (titleEl) titleEl.textContent = 'Reorder Playlist';
    if (errEl) errEl.textContent = '';

    try {
      const payload = await api(`/api/admin/series/${id}/videos`);
      seriesOrderState = {
        seriesId: id,
        seriesName: payload?.series?.name || '',
        videos: Array.isArray(payload?.videos) ? payload.videos : [],
      };
      if (titleEl) {
        titleEl.textContent = `Reorder Playlist${seriesOrderState.seriesName ? `: ${seriesOrderState.seriesName}` : ''}`;
      }
      renderSeriesOrderList();
      openModal('series-order-modal');
    } catch (err) {
      toast(err.message || 'Failed to load playlist videos.', 'error');
    }
  };

  document.getElementById('series-order-close')?.addEventListener('click', () => closeModal('series-order-modal'));
  document.getElementById('series-order-cancel')?.addEventListener('click', () => closeModal('series-order-modal'));
  document.getElementById('series-order-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('series-order-modal');
  });

  document.getElementById('series-order-save')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('series-order-save');
    const errEl = document.getElementById('series-order-error');
    if (!saveBtn || !errEl) return;
    if (!seriesOrderState.seriesId) return;

    saveBtn.disabled = true;
    errEl.textContent = '';
    try {
      await api(`/api/admin/series/${seriesOrderState.seriesId}/videos/order`, {
        method: 'PUT',
        body: JSON.stringify({ video_ids: seriesOrderState.videos.map((v) => v.id) }),
      });

      closeModal('series-order-modal');
      toast('Playlist order updated.');

      if (state.mode === 'series' && Number(state.seriesId) === Number(seriesOrderState.seriesId)) {
        await loadVideos();
      }
      await loadSeriesDirectory();
    } catch (err) {
      errEl.textContent = err.message || 'Failed to save playlist order.';
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.getElementById('series-order-sort-date')?.addEventListener('click', () => {
    const pickDate = (video) => {
      const raw = video?.content_date || video?.file_created_at || video?.scanned_at || '';
      const dt = raw ? new Date(raw) : null;
      return dt && !Number.isNaN(dt.getTime()) ? dt.getTime() : 0;
    };

    seriesOrderState.videos = [...seriesOrderState.videos].sort((a, b) => pickDate(a) - pickDate(b));
    renderSeriesOrderList();
    toast('Playlist sorted by date (oldest first).');
  });

  async function loadSeriesDirectory() {
    saveCurrentState();
    const grid = document.getElementById('series-grid');
    document.getElementById('channel-page-container').style.display = 'none';
    document.getElementById('top-chip-bar').style.display = 'flex';
    document.querySelector('.toolbar').style.display = 'flex';
    if (grid) grid.style.display = 'grid';
    const countEl = document.getElementById('series-count');
    if (!grid) return;

    grid.innerHTML = '<div class="state-loading people-state-loading"><div class="spinner"></div><span>Loading series…</span></div>';
    if (countEl) countEl.textContent = '—';

    try {
      const rows = await api('/api/series');
      if (countEl) countEl.textContent = `${rows.length} series`;

      if (!rows.length) {
        grid.innerHTML = '<div class="state-empty people-state-empty"><p>No series available yet.</p></div>';
        return;
      }

      grid.innerHTML = rows.map((row) => renderSeriesCard(row)).join('');
    } catch (err) {
      grid.innerHTML = `<div class="state-empty people-state-empty"><p style="color:var(--danger)">Failed to load series: ${escHtml(err.message)}</p></div>`;
    }
  }

  // ── Load videos ────────────────────────────────────────────────────────────
  async function loadChannelsDirectory() {
    saveCurrentState();
    const grid = document.getElementById('video-grid');
    document.getElementById('channel-page-container').style.display = 'none';
    document.getElementById('top-chip-bar').style.display = 'flex';
    document.querySelector('.toolbar').style.display = 'flex';
    grid.style.display = 'grid';
    grid.innerHTML = '<div class="state-loading"><div class="spinner"></div><span>Loading Channels…</span></div>';
    document.getElementById('pagination').innerHTML = '';
    updateSectionLabel();
    const countEl = document.getElementById('video-count');
    if (countEl) countEl.textContent = '';

    try {
      const data = await api('/api/channels');
      if (!data.channels || data.channels.length === 0) {
        grid.innerHTML = '<div class="state-empty" style="grid-column:1/-1"><p>No channels found.</p></div>';
        return;
      }
      
      let html = '<div class="channels-grid" style="grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 24px; padding: 16px 0;">';
      data.channels.forEach(ch => {
        const avatarUrl = ch.avatar_path ? `${ch.avatar_path}?t=${Date.now()}&token=${encodeURIComponent(getToken() || '')}` : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%232c2c2c"/><text x="50" y="55" font-family="sans-serif" font-size="40" fill="%238b5cf6" text-anchor="middle">?</text></svg>';
        html += `
          <div class="channel-card" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: transparent; border-radius: 8px; cursor: pointer; transition: background 0.2s, transform 0.2s;" onmouseover="this.style.background='var(--bg-hover)'; this.style.transform='scale(1.02)';" onmouseout="this.style.background='transparent'; this.style.transform='none';" onclick="selectChannel('${ch.id}', '${escHtml(ch.name)}')">
            <img src="${avatarUrl}" class="channel-avatar" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; background: var(--bg-hover);" alt="${escHtml(ch.name)}" onerror="this.onerror=null; this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\'><rect width=\'100\' height=\'100\' fill=\'%232c2c2c\'/><text x=\'50\' y=\'55\' font-family=\'sans-serif\' font-size=\'40\' fill=\'%238b5cf6\' text-anchor=\'middle\'>?</text></svg>';">
            <h3 class="channel-name" style="font-size: 1rem; font-weight: 600; text-align: center; word-break: break-word;">${escHtml(ch.name)}</h3>
          </div>
        `;
      });
      html += '</div>';
      grid.innerHTML = html;
    } catch (err) {
      grid.innerHTML = `<div class="state-empty" style="grid-column:1/-1"><p style="color:var(--danger)">Failed to load channels: ${escHtml(err.message)}</p></div>`;
    }
  }

  window.selectChannel = function(id, name) {
    state.channelId = id;
    state.channelName = name;
    state.page = 1;
    state.mode = 'channel_profile';
    saveCurrentState();
    renderChannelPage(id);
  };

  async function renderChannelPage(id) {
    // Hide default grids
    document.getElementById('top-chip-bar').style.display = 'none';
    document.querySelector('.toolbar').style.display = 'none';
    document.getElementById('video-grid').style.display = 'none';
    document.getElementById('pagination').innerHTML = '';
    
    const container = document.getElementById('channel-page-container');
    container.style.display = 'block';
    container.innerHTML = '<div class="state-loading"><div class="spinner"></div><span>Loading Channel...</span></div>';

    try {
      const channelData = await api(`/api/channels/${id}`);
      const ch = channelData.channel;
      
      const isMain = id === 'main';
      const token = getToken();
      
      const avatarUrl = ch.avatar_path ? `${ch.avatar_path}?t=${Date.now()}&token=${encodeURIComponent(token || '')}` : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%232c2c2c"/><text x="50" y="55" font-family="sans-serif" font-size="40" fill="%238b5cf6" text-anchor="middle">?</text></svg>';
      const bannerUrl = ch.banner_path ? `${ch.banner_path}?t=${Date.now()}&token=${encodeURIComponent(token || '')}` : '';
      
      const user = getUser();
      const canEdit = user && (user.role === 'admin' || user.id === ch.user_id);
      
      const subButtonText = ch.is_subscribed ? 'Subscribed' : 'Subscribe';
      const subButtonClass = ch.is_subscribed ? 'btn-secondary' : 'btn-primary';

      container.innerHTML = `
        <div class="channel-page-header">
          <div class="channel-page-banner" style="background-image: url('${bannerUrl}')">
            ${canEdit ? `<button class="channel-page-banner-upload" onclick="uploadChannelBanner('${id}')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg> Edit Banner</button>` : ''}
          </div>
          <div class="channel-page-info-bar">
            <img class="channel-page-avatar" src="${avatarUrl}" alt="${escHtml(ch.name)}">
            <div class="channel-page-details">
              <h1 class="channel-page-title">${escHtml(ch.name)}</h1>
              <div class="channel-page-meta">
                <span>${ch.subscriber_count || 0} subscribers</span>
              </div>
            </div>
            <div class="channel-page-actions">
              <button class="btn ${subButtonClass}" onclick="toggleChannelSubscription('${id}', this)">${subButtonText}</button>
              ${canEdit ? `<button class="vhs-settings-btn" onclick="setupVhsPassword('${id}')" title="VHS Settings"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></button>` : ''}
            </div>
          </div>
          <div class="channel-page-nav" style="display: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding: 12px 24px;">
            <div class="channel-page-tabs" style="display: flex; flex-wrap: wrap; gap: 8px; border-bottom: none; padding: 0;">
              <button class="channel-page-tab active" onclick="switchChannelTab('${id}', 'videos')">Videos</button>
              <button class="channel-page-tab" onclick="switchChannelTab('${id}', 'livestreams')">Livestreams</button>
              <button class="channel-page-tab" onclick="switchChannelTab('${id}', 'community')">Community</button>
              <button class="channel-page-tab" onclick="switchChannelTab('${id}', 'vhs')">VHS</button>
            </div>
            <div id="channel-page-toolbar" class="channel-tab-toolbar" style="display:none; flex-wrap: wrap; gap: 12px; align-items: center;">
              <div style="position:relative; flex: 1; min-width: 140px;">
                <input type="text" id="channel-search-input" placeholder="Search..." style="width:100%; padding: 8px 16px 8px 36px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg-main); color: var(--text-primary); font-size: 0.95rem; transition: border-color 0.2s;">
                <svg style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--text-secondary);" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              </div>
              <select id="channel-sort-select" style="padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-main); color: var(--text-primary); font-size: 0.95rem; cursor: pointer; flex-shrink: 0;">
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
                <option value="title_asc">Name: A to Z</option>
                <option value="title_desc">Name: Z to A</option>
              </select>
            </div>
          </div>
        </div>
        <div id="channel-page-content" style="padding: 24px;">
          <div class="state-loading"><div class="spinner"></div></div>
        </div>
      `;
      
      const searchInput = document.getElementById('channel-search-input');
      const sortSelect = document.getElementById('channel-sort-select');
      
      let searchTimeout;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const activeTab = document.querySelector('.channel-page-tab.active').textContent.toLowerCase();
          switchChannelTab(id, activeTab, searchInput.value, sortSelect.value);
        }, 500);
      });
      
      sortSelect.addEventListener('change', () => {
        const activeTab = document.querySelector('.channel-page-tab.active').textContent.toLowerCase();
        switchChannelTab(id, activeTab, searchInput.value, sortSelect.value);
      });
      
      switchChannelTab(id, 'videos');
      
    } catch (err) {
      container.innerHTML = `<div class="state-empty"><p style="color:var(--danger)">Failed to load channel: ${escHtml(err.message)}</p></div>`;
    }
  }
  
  window.toggleChannelSubscription = async function(id, btn) {
    try {
      const res = await api('/api/channels/' + id + '/subscribe', { method: 'POST' });
      if (res.subscribed) {
        btn.textContent = 'Subscribed';
        btn.className = 'btn btn-secondary';
      } else {
        btn.textContent = 'Subscribe';
        btn.className = 'btn btn-primary';
      }
    } catch (e) {
      toast('Failed to toggle subscription', 'error');
    }
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
        canvas.width = cw;
        canvas.height = ch;

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
          outCanvas.width = targetW;
          outCanvas.height = targetH;
          const outCtx = outCanvas.getContext('2d');
          
          outCtx.drawImage(
            canvas,
            0, 50, targetW, targetH, // Source (x,y,w,h) from the visible canvas
            0, 0, targetW, targetH   // Dest
          );
          
          const imageBase64 = outCanvas.toDataURL('image/jpeg', 0.9);
          const btn = document.getElementById('cropper-save');
          btn.disabled = true;
          btn.textContent = 'Saving...';
          
          try {
            await api('/api/channels/' + channelId + '/banner', { method: 'POST', body: JSON.stringify({ imageBase64 }) });
            toast('Banner updated successfully', 'success');
            modal.remove();
            renderChannelPage(channelId);
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
  
  window.setupVhsPassword = async function(id) {
    const pw = prompt("Enter a new VHS password for this channel (or leave empty to remove):");
    if (pw === null) return;
    
    try {
      await api('/api/channels/' + id + '/vhs_password', { method: 'POST', body: JSON.stringify({ password: pw }) });
      toast('VHS password updated', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  
  window.switchChannelTab = async function(id, tab, search = '', sort = 'newest') {
    document.querySelectorAll('.channel-page-tab').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.channel-page-tab[onclick="switchChannelTab('${id}', '${tab}')"]`).classList.add('active');
    
    const content = document.getElementById('channel-page-content');
    const toolbar = document.getElementById('channel-page-toolbar');
    
    // Only show search/sort toolbar for video tabs
    if (['videos', 'livestreams', 'vhs'].includes(tab)) {
      toolbar.style.display = 'flex';
      const searchInput = document.getElementById('channel-search-input');
      if (tab === 'videos') searchInput.placeholder = 'Search videos...';
      if (tab === 'livestreams') searchInput.placeholder = 'Search livestreams...';
      if (tab === 'vhs') searchInput.placeholder = 'Search VHS...';
    } else {
      toolbar.style.display = 'none';
    }
    
    content.innerHTML = '<div class="state-loading"><div class="spinner"></div></div>';
    
    try {
      const qs = `channelId=${id}&limit=100&sort=${sort}${search ? '&search=' + encodeURIComponent(search) : ''}`;
      
      if (tab === 'videos') {
        const data = await api(`/api/videos?${qs}&category=video`);
        content.innerHTML = data.videos.length 
          ? `<div class="channels-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">${data.videos.map(renderVideoCard).join('')}</div>`
          : '<div class="state-empty"><p>No videos found.</p></div>';
      } else if (tab === 'livestreams') {
        const data = await api(`/api/videos?${qs}&category=livestream`);
        content.innerHTML = data.videos.length 
          ? `<div class="channels-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">${data.videos.map(renderVideoCard).join('')}</div>`
          : '<div class="state-empty"><p>No livestreams found.</p></div>';
      } else if (tab === 'community') {
        const data = await api(`/api/channels/${id}/community`);
        let html = '';
        const user = getUser();
        const canEdit = user && (user.role === 'admin' || String(user.id) === String(id));
        if (canEdit) {
           html += `
             <div style="background: var(--bg-card); padding: 16px; border-radius: 12px; margin-bottom: 24px; border: 1px solid var(--border);">
               <textarea id="community-post-text" placeholder="What's on your mind?" style="width: 100%; height: 80px; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-main); color: var(--text-primary); margin-bottom: 12px; resize: vertical;"></textarea>
               <div id="community-post-image-preview" style="display:none; margin-bottom: 12px; position: relative; max-width: 300px;">
                 <img src="" style="width: 100%; border-radius: 8px; border: 1px solid var(--border);">
                 <button class="icon-btn" onclick="this.parentElement.style.display='none'; this.previousElementSibling.src=''; delete this.parentElement.dataset.base64;" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.5);">
                   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                 </button>
               </div>
               <div style="display: flex; justify-content: space-between; align-items: center;">
                 <button class="btn btn-secondary" onclick="document.getElementById('community-image-input').click()">
                   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                   Add Image/GIF
                 </button>
                 <input type="file" id="community-image-input" accept="image/jpeg,image/png,image/webp,image/gif" style="display: none;" onchange="handleCommunityImageSelect(event)">
                 <button class="btn btn-primary" onclick="submitCommunityPost('${id}')">Post</button>
               </div>
             </div>
           `;
        }
        
        if (data.posts && data.posts.length > 0) {
          html += data.posts.map(p => {
             const avatarUrl = p.channel_avatar ? `${p.channel_avatar}?t=${Date.now()}&token=${encodeURIComponent(getToken() || '')}` : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%232c2c2c"/><text x="50" y="55" font-family="sans-serif" font-size="40" fill="%238b5cf6" text-anchor="middle">?</text></svg>';
             const imageUrl = p.image_path ? `${p.image_path}?t=${Date.now()}&token=${encodeURIComponent(getToken() || '')}` : '';
             const isEditedHtml = p.is_edited ? '<span class="community-post-time" style="font-style: italic; margin-left: 4px;">(edited)</span>' : '';
             const actionsHtml = canEdit ? `
               <div class="community-post-actions" style="margin-left: auto; display: flex; gap: 8px;">
                 <button class="icon-btn" onclick="editCommunityPost(${p.id}, '${id}', this)" title="Edit">
                   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                 </button>
                 <button class="icon-btn" onclick="deleteCommunityPost(${p.id}, '${id}')" title="Delete">
                   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                 </button>
               </div>
             ` : '';
             return `
               <div class="channel-community-post" id="community-post-${p.id}">
                 <img class="community-post-avatar" src="${avatarUrl}">
                 <div class="community-post-content" style="width: 100%;">
                   <div class="community-post-header">
                     <span class="community-post-author">${escHtml(p.channel_name)}</span>
                     <span class="community-post-time">${formatDate(p.created_at)}</span>
                     ${isEditedHtml}
                     ${actionsHtml}
                   </div>
                   <div class="community-post-text" id="community-post-text-${p.id}" data-raw="${escHtml(p.content)}">${escHtml(p.content)}</div>
                   ${imageUrl ? `<img src="${imageUrl}" class="community-post-image" alt="Post attachment">` : ''}
                 </div>
               </div>
             `;
          }).join('');
        } else {
          html += '<div class="state-empty"><p>No community posts yet.</p></div>';
        }
        content.innerHTML = html;
      } else if (tab === 'vhs') {
        const vhsToken = sessionStorage.getItem('vhs_token_' + id);
        if (vhsToken) {
           const data = await api(`/api/videos?${qs}&include_vhs=true`, {
             headers: { 'X-VHS-Token': vhsToken }
           });
           const vhsVideos = data.videos.filter(v => v.is_vhs === 1);
           content.innerHTML = vhsVideos.length 
             ? `<div class="channels-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">${vhsVideos.map(renderVideoCard).join('')}</div>`
             : '<div class="state-empty"><p>No VHS tapes found.</p></div>';
        } else {
           content.innerHTML = `
             <div class="vhs-lock-screen">
               <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 24px; color: var(--accent);">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                 <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
               </svg>
               <p>This content is locked behind a VHS password.</p>
               <input type="password" id="vhs-password-input" placeholder="Enter Password" onkeypress="if(event.key==='Enter') submitVhsPassword('${id}')">
               <button class="btn btn-primary" onclick="submitVhsPassword('${id}')">Unlock</button>
             </div>
           `;
        }
      }
    } catch (e) {
      content.innerHTML = `<div class="state-empty"><p style="color:var(--danger)">Failed to load tab: ${escHtml(e.message)}</p></div>`;
    }
  };
  
  window.submitCommunityPost = async function(id) {
    const text = document.getElementById('community-post-text').value;
    const previewBlock = document.getElementById('community-post-image-preview');
    const imageBase64 = previewBlock && previewBlock.dataset.base64 ? previewBlock.dataset.base64 : null;
    
    if (!text.trim() && !imageBase64) return;
    try {
      await api('/api/channels/' + id + '/community', { 
        method: 'POST', 
        body: JSON.stringify({ content: text, imageBase64 }) 
      });
      switchChannelTab(id, 'community');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  window.editCommunityPost = function(postId, channelId, btnEl) {
    const postEl = document.getElementById('community-post-' + postId);
    const textEl = document.getElementById('community-post-text-' + postId);
    const rawContent = textEl.dataset.raw;
    
    const editHtml = `
      <div style="margin-top: 12px; border: 1px solid var(--accent); border-radius: 8px; padding: 12px; background: var(--bg-hover);">
        <textarea id="edit-post-text-${postId}" style="width: 100%; min-height: 80px; padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-main); color: var(--text-primary); margin-bottom: 12px; resize: vertical;">${rawContent}</textarea>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-secondary" onclick="switchChannelTab('${channelId}', 'community')">Cancel</button>
          <button class="btn btn-primary" onclick="saveCommunityPostEdit(${postId}, '${channelId}')">Save</button>
        </div>
      </div>
    `;
    textEl.innerHTML = editHtml;
    btnEl.style.display = 'none'; // hide the edit button so they don't click it twice
  };

  window.saveCommunityPostEdit = async function(postId, channelId) {
    const text = document.getElementById('edit-post-text-' + postId).value;
    if (!text.trim()) return;
    try {
      await api('/api/channels/' + channelId + '/community/' + postId, { 
        method: 'PUT', 
        body: JSON.stringify({ content: text }) 
      });
      toast('Post updated successfully', 'success');
      switchChannelTab(channelId, 'community');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  window.deleteCommunityPost = async function(postId, channelId) {
    if (!confirm('Are you sure you want to delete this post?')) return;
    try {
      await api('/api/channels/' + channelId + '/community/' + postId, { method: 'DELETE' });
      toast('Post deleted', 'success');
      switchChannelTab(channelId, 'community');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  window.handleCommunityImageSelect = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    openCommunityImageCropper(file, (imageBase64) => {
      const previewBlock = document.getElementById('community-post-image-preview');
      previewBlock.style.display = 'block';
      previewBlock.dataset.base64 = imageBase64;
      previewBlock.querySelector('img').src = imageBase64;
    });
    e.target.value = '';
  };

  function openCommunityImageCropper(file, onCropComplete) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const modal = document.createElement('div');
        modal.className = 'cropper-modal';
        modal.innerHTML = `
          <div class="cropper-container">
            <div class="cropper-header">
              <h3>Crop Image (4:3)</h3>
              <button class="icon-btn" onclick="this.closest('.cropper-modal').remove()">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="cropper-canvas-wrapper" style="position:relative; width: 100%; max-width: 600px; height: 400px; background: #000; overflow: hidden; touch-action: none; cursor: grab; margin: 0 auto;">
              <canvas id="community-cropper-canvas" style="position:absolute; top:0; left:0; width:100%; height:100%;"></canvas>
              <div style="position:absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; border: 2px solid var(--accent); box-sizing: border-box; box-shadow: 0 0 0 9999px rgba(0,0,0,0.5);"></div>
            </div>
            <div class="cropper-controls" style="padding: 16px; display:flex; align-items:center; gap: 16px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="range" id="community-cropper-zoom" min="0.1" max="3" step="0.01" value="1" style="flex:1;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            </div>
            <div class="cropper-footer" style="padding: 16px; border-top: 1px solid var(--border); display:flex; justify-content:flex-end; gap: 12px;">
              <button class="btn btn-secondary" onclick="this.closest('.cropper-modal').remove()">Cancel</button>
              <button class="btn btn-primary" id="community-cropper-save">Attach</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);

        const canvas = document.getElementById('community-cropper-canvas');
        const ctx = canvas.getContext('2d');
        const wrapper = canvas.parentElement;
        
        let cw = wrapper.clientWidth || 600;
        let ch = cw * 0.75;
        wrapper.style.height = ch + 'px';
        
        canvas.width = cw;
        canvas.height = ch;

        let scale = cw / img.width;
        if (img.height * scale < ch) {
          scale = ch / img.height; 
        }
        
        document.getElementById('community-cropper-zoom').value = scale;
        document.getElementById('community-cropper-zoom').min = scale * 0.5;
        document.getElementById('community-cropper-zoom').max = scale * 3;

        let panX = (cw - img.width * scale) / 2;
        let panY = (ch - img.height * scale) / 2;

        function draw() {
          ctx.clearRect(0, 0, cw, ch);
          ctx.drawImage(img, panX, panY, img.width * scale, img.height * scale);
        }

        draw();

        document.getElementById('community-cropper-zoom').addEventListener('input', (e) => {
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

        document.getElementById('community-cropper-save').addEventListener('click', () => {
          const imageBase64 = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
          onCropComplete(imageBase64);
          modal.remove();
        });
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }
  
  window.submitVhsPassword = async function(id) {
    const pw = document.getElementById('vhs-password-input').value;
    if (!pw) return;
    try {
      const res = await api('/api/channels/' + id + '/vhs_verify', { method: 'POST', body: JSON.stringify({ password: pw }) });
      sessionStorage.setItem('vhs_token_' + id, res.token);
      switchChannelTab(id, 'vhs');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  async function loadVideos() {
    saveCurrentState();
    const grid = document.getElementById('video-grid');
    document.getElementById('channel-page-container').style.display = 'none';
    document.getElementById('top-chip-bar').style.display = 'flex';
    document.querySelector('.toolbar').style.display = 'flex';
    grid.style.display = 'grid';
    grid.innerHTML = '<div class="state-loading"><div class="spinner"></div><span>Loading…</span></div>';

    if (state.mode === 'series' && !state.seriesId) {
      updateSectionLabel();
      document.getElementById('pagination').innerHTML = '';
      await loadSeriesDirectory();
      return;
    }

    await loadFavoriteIds();

    // History mode: show recently watched from the progress API
    if (state.mode === 'history') {
      try {
        const [data, config, progressList] = await Promise.all([
          api('/api/user/history?limit=40'),
          api('/api/videos?limit=1'), // Dummy call just to get channel settings safely
          api('/api/user/progress').catch(() => []),
        ]);
        if (config.channel) globalChannelProfile = config.channel;

        userProgress = {};
        progressList.forEach((p) => {
          if (p.duration > 0) userProgress[p.video_id] = (p.last_position / p.duration) * 100;
        });

        updateSectionLabel();
        const countEl = document.getElementById('video-count');
        if (countEl) countEl.textContent = `${data.videos.length} video${data.videos.length !== 1 ? 's' : ''}`;
        grid.innerHTML = data.videos.length
          ? renderWatchHistoryGrouped(data.videos)
          : '<div class="state-empty" style="grid-column:1/-1"><p>No watch history yet.</p></div>';
        document.getElementById('pagination').innerHTML = '';
        updateHomeSelectionUi();
      } catch (err) {
        grid.innerHTML = `<div class="state-empty" style="grid-column:1/-1"><p style="color:var(--danger)">Failed to load history: ${escHtml(err.message)}</p></div>`;
      }
      return;
    }

    if (state.mode === 'favorites') {
      try {
        const [data, config, progressList] = await Promise.all([
          api('/api/user/favorites?limit=200'),
          api('/api/videos?limit=1'),
          api('/api/user/progress').catch(() => []),
        ]);

        if (config.channel) globalChannelProfile = config.channel;

        userProgress = {};
        progressList.forEach((p) => {
          if (p.duration > 0) userProgress[p.video_id] = (p.last_position / p.duration) * 100;
        });

        updateSectionLabel();
        const countEl = document.getElementById('video-count');
        if (countEl) countEl.textContent = `${data.videos.length} video${data.videos.length !== 1 ? 's' : ''}`;
        grid.innerHTML = data.videos.length
          ? data.videos.map(renderVideoCard).join('')
          : '<div class="state-empty" style="grid-column:1/-1"><p>No favorites yet.</p></div>';
        document.getElementById('pagination').innerHTML = '';
        updateHomeSelectionUi();
      } catch (err) {
        grid.innerHTML = `<div class="state-empty" style="grid-column:1/-1"><p style="color:var(--danger)">Failed to load favorites: ${escHtml(err.message)}</p></div>`;
      }
      return;
    }

    if (state.mode === 'series' && state.seriesId) {
      try {
        const [result, progressList] = await Promise.all([
          api(`/api/series/${state.seriesId}/videos`),
          api('/api/user/progress').catch(() => []),
        ]);

        userProgress = {};
        progressList.forEach((p) => {
          if (p.duration > 0) userProgress[p.video_id] = (p.last_position / p.duration) * 100;
        });

        const videos = Array.isArray(result.videos) ? result.videos : [];
        const countEl = document.getElementById('video-count');
        if (countEl) countEl.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;

        if (result.series && result.series.name) {
          state.seriesName = result.series.name;
        }

        updateSectionLabel();
        grid.innerHTML = renderSeriesSelectedView(result, videos);
        requestAnimationFrame(() => {
          syncSeriesPlaylistPanelHeight();
          requestAnimationFrame(() => syncSeriesPlaylistPanelHeight());
        });
        const featureImage = grid.querySelector('.series-feature-media img');
        if (featureImage && !featureImage.complete) {
          featureImage.addEventListener('load', () => syncSeriesPlaylistPanelHeight(), { once: true });
        }
        document.getElementById('pagination').innerHTML = '';
        updateHomeSelectionUi();
      } catch (err) {
        grid.innerHTML = `<div class="state-empty" style="grid-column:1/-1"><p style="color:var(--danger)">Failed to load series videos: ${escHtml(err.message)}</p></div>`;
      }
      return;
    }

    const params = new URLSearchParams({
      page: state.specialChip === 'recently-uploaded' ? 1 : state.page,
      limit: state.specialChip === 'recently-uploaded' ? 20 : 40,
      sort: state.sort,
      ...(state.category !== 'all' ? { category: state.category } : {}),
      ...(state.search ? { search: state.search } : {}),
      ...(state.personId ? { person_id: state.personId } : {}),
      ...(state.channelId ? { channelId: state.channelId } : {}),
    });

    try {
      const [data, progressList] = await Promise.all([
        api(`/api/videos?${params}`),
        api('/api/user/progress').catch(() => []),
      ]);

      if (data.channel) globalChannelProfile = data.channel;

      // Build progress lookup: video_id → % watched
      userProgress = {};
      progressList.forEach((p) => {
        if (p.duration > 0) userProgress[p.video_id] = (p.last_position / p.duration) * 100;
      });

      state.total = data.total;
      state.pages = data.pages;

      const countEl = document.getElementById('video-count');
      if (countEl) countEl.textContent = `${data.total} video${data.total !== 1 ? 's' : ''}`;

      if (!data.videos.length) {
        grid.innerHTML = `
          <div class="state-empty" style="grid-column:1/-1">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="15" height="10" rx="2"/><polygon points="17 9 22 7 22 17 17 15"/></svg>
            <p>${state.personId
              ? `No videos found for ${escHtml(state.personName || 'this person')}.`
              : state.search
                ? `No results for "${escHtml(state.search)}"`
                : 'No videos found.'}</p>
          </div>`;
      } else {
        grid.innerHTML = data.videos.map(renderVideoCard).join('');
      }

      updateHomeSelectionUi();
      if (state.specialChip === 'recently-uploaded') {
        document.getElementById('pagination').innerHTML = '';
      } else {
        renderPagination();
      }
    } catch (err) {
      grid.innerHTML = `<div class="state-empty" style="grid-column:1/-1"><p style="color:var(--danger)">Failed to load videos: ${escHtml(err.message)}</p></div>`;
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  const incomingParams = new URLSearchParams(window.location.search);
  const incomingPersonRaw = incomingParams.get('personId') || incomingParams.get('person');
  const incomingPersonName = (incomingParams.get('person_name') || incomingParams.get('personName') || '').trim();
  const incomingPersonId = Number.parseInt(String(incomingPersonRaw || ''), 10);
  const incomingChannelId = incomingParams.get('channelId') || incomingParams.get('channel');
  const incomingMode = incomingParams.get('mode');

  if (Number.isInteger(incomingPersonId) && incomingPersonId > 0) {
    state.mode = 'browse';
    state.category = 'all';
    state.personId = incomingPersonId;
    state.personName = incomingPersonName;
    state.seriesId = null;
    state.seriesName = '';
    state.page = 1;

    // Keep query-driven filtering one-time so refresh returns to normal browse.
    window.history.replaceState({}, document.title, '/');
  } else if (incomingChannelId) {
    state.mode = 'channel_profile';
    state.channelId = incomingChannelId;
    window.history.replaceState({}, document.title, '/');
  } else if (incomingMode && ['browse', 'history', 'favorites', 'people', 'series', 'channels'].includes(incomingMode)) {
    state.mode = incomingMode;
    window.history.replaceState({}, document.title, '/');
  }

  setupHoverPreview();
  syncUI();
  updateSearchClearButton();
  if (state.mode === 'people') loadPeopleDirectory();
  else if (state.mode === 'series' && !state.seriesId) loadSeriesDirectory();
  else if (state.mode === 'channels') loadChannelsDirectory();
  else if (state.mode === 'channel_profile') {
    renderChannelPage(state.channelId);
  } else {
    loadVideos();
  }

  // ── Hover preview ─────────────────────────────────────────────────────────
  function setupHoverPreview() {
    const FORCE_DIRECT_PLAY_KEY = 'forceDirectPlay';
    const grid = document.querySelector('main.main-content') || document.getElementById('video-grid');
    if (!grid) return;

    // Match watch.js: default force-direct to ON so hover previews work on first
    // visit to browse. Otherwise the key stays unset until the user opens a video.
    if (!localStorage.getItem(FORCE_DIRECT_PLAY_KEY)) {
      localStorage.setItem(FORCE_DIRECT_PLAY_KEY, '1');
    }

    // Same semantics as watch.js isForceDirectPlay(): admins follow the Direct Play
    // toggle (off = no stream previews); viewers are always treated as direct play.
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

    grid.addEventListener('mouseover', (e) => {
      const card = e.target.closest('.video-card');
      if (!card || card === hoverCard) return;

      clearPreview(hoverCard);
      hoverCard = card;

      if (!isForceDirectPlayForPreviews()) return;

      const key = card.dataset.selectKey;
      const videoId = key && key.startsWith('video:') ? key.slice(6) : null;
      if (!videoId) return;

      hoverDelayTimer = setTimeout(() => {
        hoverDelayTimer = null;
        const thumb = card.querySelector('.card-thumb');
        if (!thumb || card !== hoverCard) return;

        const token = getToken();
        const src = `/api/videos/${videoId}/stream?preview=1&token=${encodeURIComponent(token || '')}`;

        const vid = document.createElement('video');
        vid.className = 'hover-preview';
        vid.muted = true;
        vid.playsInline = true;
        vid.src = src;
        thumb.appendChild(vid);
        vid.play().catch(() => {});

        previewStopTimer = setTimeout(() => {
          vid.pause();
          vid.src = '';
          vid.remove();
        }, 10000);
      }, 1000);
    });

    grid.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.video-card');
      if (!card || card !== hoverCard) return;
      const to = e.relatedTarget;
      if (to && card.contains(to)) return;
      clearPreview(hoverCard);
      hoverCard = null;
    });

    // ── Mobile portrait: play when card is closest to screen center ─────────
    function setupMobilePreview() {
      function isMobilePortrait() {
        return window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches;
      }

      let mobileCard = null;
      let mobileDelayTimer = null;
      let mobileStopTimer = null;

      function clearMobilePreview(card) {
        if (mobileDelayTimer) { clearTimeout(mobileDelayTimer); mobileDelayTimer = null; }
        if (mobileStopTimer) { clearTimeout(mobileStopTimer); mobileStopTimer = null; }
        if (card) {
          const vid = card.querySelector('.hover-preview');
          if (vid) { vid.pause(); vid.src = ''; vid.remove(); }
        }
      }

      function getMostCenteredCard() {
        const cards = Array.from(grid.querySelectorAll('.video-card'));
        const mid = window.innerHeight / 2;
        let best = null;
        let bestDist = Infinity;
        for (const card of cards) {
          const rect = card.getBoundingClientRect();
          // only consider cards that are at least half visible
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          const cardMid = (rect.top + rect.bottom) / 2;
          const dist = Math.abs(cardMid - mid);
          if (dist < bestDist) { bestDist = dist; best = card; }
        }
        return best;
      }

      let scrollRafId = null;

      function onScroll() {
        if (!isMobilePortrait()) return;
        if (!isForceDirectPlayForPreviews()) return;

        if (scrollRafId) return;
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = null;
          const centered = getMostCenteredCard();
          if (!centered || centered === mobileCard) return;

          clearMobilePreview(mobileCard);
          mobileCard = centered;

          const key = centered.dataset.selectKey;
          const videoId = key && key.startsWith('video:') ? key.slice(6) : null;
          if (!videoId) return;

          mobileDelayTimer = setTimeout(() => {
            mobileDelayTimer = null;
            // Re-check it's still the most centered
            if (centered !== mobileCard) return;
            const thumb = centered.querySelector('.card-thumb');
            if (!thumb) return;

            const token = getToken();
            const src = `/api/videos/${videoId}/stream?preview=1&token=${encodeURIComponent(token || '')}`;

            const vid = document.createElement('video');
            vid.className = 'hover-preview';
            vid.muted = true;
            vid.playsInline = true;
            vid.src = src;
            thumb.appendChild(vid);
            vid.play().catch(() => {});

            mobileStopTimer = setTimeout(() => {
              vid.pause();
              vid.src = '';
              vid.remove();
            }, 10000);
          }, 1500);
        });
      }

      window.addEventListener('scroll', onScroll, { passive: true });
      // Also handle when grid re-renders (page load / filter change)
      const mutObs = new MutationObserver(() => {
        clearMobilePreview(mobileCard);
        mobileCard = null;
        onScroll();
      });
      mutObs.observe(grid, { childList: true });
    }

    setupMobilePreview();
  }

  // ── Dialogs / announcements ────────────────────────────────────────────────
  (async function checkDialogs() {
    try {
      const dialogs = await api('/api/dialogs/pending');
      if (!dialogs.length) return;

      const overlay   = document.getElementById('dialog-overlay');
      const titleEl   = document.getElementById('dialog-title');
      const bodyEl    = document.getElementById('dialog-body');
      const ackBtn    = document.getElementById('dialog-ack-btn');
      const counterEl = document.getElementById('dialog-counter');
      const langWrap  = document.getElementById('dialog-lang-switch');
      const langEnBtn = document.getElementById('btn-lang-en') || document.getElementById('dialog-lang-en');
      const langPlBtn = document.getElementById('btn-lang-pl') || document.getElementById('dialog-lang-pl');
      if (!overlay) return;

      let current = 0;
      const browserLang = ((navigator.languages && navigator.languages[0]) || navigator.language || 'en').toLowerCase();
      let selectedLang = browserLang.startsWith('pl') ? 'pl' : 'en';

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

      function getDialogCopy(d, lang) {
        const hasPl = Boolean(d.title_pl || d.body_pl);
        if (lang === 'pl' && hasPl) {
          return {
            title: d.title_pl || d.title,
            body: d.body_pl || d.body,
            hasPl,
          };
        }
        return {
          title: d.title,
          body: d.body,
          hasPl,
        };
      }

      function showDialog(idx) {
        const d = dialogs[idx];
        const copy = getDialogCopy(d, selectedLang);
        if (selectedLang === 'pl' && !copy.hasPl) selectedLang = 'en';
        const finalCopy = getDialogCopy(d, selectedLang);
        titleEl.textContent = finalCopy.title;
        bodyEl.innerHTML = renderDialogBody(finalCopy.body);

        if (langWrap && langEnBtn && langPlBtn) {
          langWrap.style.display = 'flex';
          langPlBtn.disabled = !finalCopy.hasPl;
          langEnBtn.classList.toggle('active', selectedLang === 'en');
          langPlBtn.classList.toggle('active', selectedLang === 'pl');
        }

        if (dialogs.length > 1) {
          counterEl.textContent = `${idx + 1} of ${dialogs.length}`;
        } else {
          counterEl.textContent = '';
        }
        if (selectedLang === 'pl') {
          ackBtn.textContent = (idx < dialogs.length - 1) ? 'Rozumiem - Dalej' : 'Rozumiem';
        } else {
          ackBtn.textContent = (idx < dialogs.length - 1) ? 'Got it - Next' : 'Got it';
        }
        overlay.classList.add('open');
      }

      langEnBtn?.addEventListener('click', () => {
        selectedLang = 'en';
        showDialog(current);
      });
      langPlBtn?.addEventListener('click', () => {
        selectedLang = 'pl';
        showDialog(current);
      });

      ackBtn.addEventListener('click', async () => {
        const d = dialogs[current];
        // Fire-and-forget acknowledge
        api(`/api/dialogs/${d.id}/ack`, { method: 'POST' }).catch(() => {});
        current++;
        if (current < dialogs.length) {
          showDialog(current);
        } else {
          overlay.classList.remove('open');
        }
      });

      showDialog(0);
    } catch { /* non-fatal — don't block the app */ }
  })();
})();
