/* friends.js — Friends panel UI with tabs: Friends, Requests, Watch Party */
'use strict';

(function () {
  if (!getToken()) return;

  let friendsPanelOpen = false;
  let activeTab = 'friends'; // 'friends' | 'requests' | 'party'
  let friendsList = [];
  let incomingRequests = [];
  let sentRequests = [];
  let chatMessages = [];

  // ── Create panel HTML ──────────────────────────────────────────────────
  function ensureFriendsPanel() {
    if (document.getElementById('friends-panel')) return;
    const html = `
      <div class="friends-panel-overlay" id="friends-panel-overlay"></div>
      <div class="friends-panel" id="friends-panel">
        <div class="fp-header">
          <h3>Friends</h3>
          <button class="btn-icon" id="fp-close" type="button" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="fp-tabs">
          <button class="fp-tab active" data-tab="friends">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Friends
          </button>
          <button class="fp-tab" data-tab="requests">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
            Requests
            <span class="fp-tab-badge" id="fp-requests-badge" style="display:none">0</span>
          </button>
          <button class="fp-tab" data-tab="party" id="fp-party-tab" style="display:none">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Watch Party
          </button>
        </div>
        <div class="fp-body" id="fp-body">
          <!-- Content injected by JS -->
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);

    // Event listeners
    document.getElementById('fp-close').addEventListener('click', closeFriendsPanel);
    document.getElementById('friends-panel-overlay').addEventListener('click', closeFriendsPanel);

    document.querySelectorAll('.fp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderActiveTab();
      });
    });
  }

  // ── Open/Close panel ───────────────────────────────────────────────────
  function openFriendsPanel() {
    ensureFriendsPanel();
    const panel = document.getElementById('friends-panel');
    const overlay = document.getElementById('friends-panel-overlay');
    if (!panel) return;
    panel.classList.add('open');
    overlay.classList.add('open');
    friendsPanelOpen = true;
    loadFriendsData();
  }

  function closeFriendsPanel() {
    const panel = document.getElementById('friends-panel');
    const overlay = document.getElementById('friends-panel-overlay');
    if (panel) panel.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    friendsPanelOpen = false;
  }

  window.openFriendsPanel = openFriendsPanel;
  window.closeFriendsPanel = closeFriendsPanel;

  // ── Data loading ───────────────────────────────────────────────────────
  async function loadFriendsData() {
    try {
      const [friendsData, requestsData] = await Promise.all([
        api('/api/friends'),
        api('/api/friends/requests'),
      ]);
      friendsList = friendsData.friends || [];
      incomingRequests = requestsData.incoming || [];
      sentRequests = requestsData.sent || [];

      // Update badge
      const badge = document.getElementById('fp-requests-badge');
      if (badge) {
        if (incomingRequests.length > 0) {
          badge.textContent = incomingRequests.length;
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }

      renderActiveTab();
    } catch (e) {
      console.error('[Friends] Failed to load data:', e);
    }
  }

  // ── Tab rendering ──────────────────────────────────────────────────────
  function renderActiveTab() {
    const body = document.getElementById('fp-body');
    if (!body) return;

    // Show party tab if in a party
    const partyTab = document.getElementById('fp-party-tab');
    if (partyTab) {
      partyTab.style.display = WatchParty.isInParty() ? '' : 'none';
    }

    switch (activeTab) {
      case 'friends':
        renderFriendsTab(body);
        break;
      case 'requests':
        renderRequestsTab(body);
        break;
      case 'party':
        renderPartyTab(body);
        break;
    }
  }

  // ── Friends Tab ────────────────────────────────────────────────────────
  function renderFriendsTab(body) {
    const token = getToken();
    const inParty = WatchParty.isInParty();

    let html = `
      <div class="fp-add-friend">
        <div class="fp-search-row">
          <input type="text" class="fp-search-input" id="fp-add-username" placeholder="Add friend by username..." maxlength="64" autocomplete="off" />
          <button class="btn btn-primary btn-sm" id="fp-add-btn" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add
          </button>
        </div>
        <p class="fp-add-error" id="fp-add-error"></p>
      </div>
    `;

    if (friendsList.length === 0) {
      html += `<div class="fp-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <p>No friends yet</p>
        <span>Add friends by their username to get started</span>
      </div>`;
    } else {
      // Sort: online first
      const sorted = [...friendsList].sort((a, b) => {
        const aOnline = WatchParty.isFriendOnline(a.id) ? 1 : 0;
        const bOnline = WatchParty.isFriendOnline(b.id) ? 1 : 0;
        return bOnline - aOnline;
      });

      html += '<div class="fp-friend-list">';
      for (const friend of sorted) {
        const online = WatchParty.isFriendOnline(friend.id);
        const initial = (friend.display_name || friend.username || '?')[0].toUpperCase();
        const avatarUrl = friend.avatar_path && token
          ? `/api/users/avatar/${friend.id}?token=${encodeURIComponent(token)}&t=${Date.now()}`
          : null;

        html += `
          <div class="fp-friend-card" data-user-id="${friend.id}">
            <div class="fp-friend-avatar${online ? ' online' : ''}">
              ${avatarUrl
                ? `<img src="${avatarUrl}" alt="" loading="lazy" decoding="async" />`
                : `<span>${escHtml(initial)}</span>`
              }
              <div class="fp-status-dot${online ? ' online' : ''}"></div>
            </div>
            <div class="fp-friend-info">
              <span class="fp-friend-name">${escHtml(friend.display_name || friend.username)}</span>
              <span class="fp-friend-status">${online ? 'Online' : 'Offline'}</span>
            </div>
            <div class="fp-friend-actions">
              ${online && inParty ? `<button class="fp-action-btn fp-invite-btn" data-uid="${friend.id}" title="Invite to Watch Party">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>` : ''}
              ${online && !inParty ? `<button class="fp-action-btn fp-watch-btn" data-uid="${friend.id}" title="Start Watch Party">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>` : ''}
              <button class="fp-action-btn fp-remove-btn" data-uid="${friend.id}" title="Remove Friend">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        `;
      }
      html += '</div>';
    }

    body.innerHTML = html;

    // Bind add friend
    const addBtn = document.getElementById('fp-add-btn');
    const addInput = document.getElementById('fp-add-username');
    if (addBtn && addInput) {
      const doAdd = async () => {
        const username = addInput.value.trim();
        const errEl = document.getElementById('fp-add-error');
        if (!username) return;
        try {
          await api('/api/friends/request', {
            method: 'POST',
            body: JSON.stringify({ username }),
          });
          addInput.value = '';
          if (errEl) errEl.textContent = '';
          toast('Friend request sent!', 'success');
          loadFriendsData();
        } catch (e) {
          if (errEl) errEl.textContent = e.message;
        }
      };
      addBtn.addEventListener('click', doAdd);
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doAdd();
      });
    }

    // Bind remove buttons
    body.querySelectorAll('.fp-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = parseInt(btn.dataset.uid, 10);
        if (!confirm('Remove this friend?')) return;
        try {
          await api(`/api/friends/${uid}`, { method: 'DELETE' });
          toast('Friend removed.', 'success');
          loadFriendsData();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Bind invite buttons
    body.querySelectorAll('.fp-invite-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        WatchParty.inviteToParty(parseInt(btn.dataset.uid, 10));
      });
    });

    // Bind start watch party buttons
    body.querySelectorAll('.fp-watch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const videoId = Number(new URLSearchParams(location.search).get('id')) || null;
        const videoTitle = document.querySelector('#overlay-video-title')?.textContent || '';
        WatchParty.createParty(videoId, videoTitle);
        // After creation, invite this friend
        const uid = parseInt(btn.dataset.uid, 10);
        setTimeout(() => {
          WatchParty.inviteToParty(uid);
          activeTab = 'party';
          const partyTabEl = document.querySelector('.fp-tab[data-tab="party"]');
          if (partyTabEl) {
            document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
            partyTabEl.classList.add('active');
          }
          renderActiveTab();
        }, 300);
      });
    });
  }

  // ── Requests Tab ───────────────────────────────────────────────────────
  function renderRequestsTab(body) {
    const token = getToken();
    let html = '';

    if (incomingRequests.length > 0) {
      html += '<h4 class="fp-section-title">Incoming Requests</h4>';
      html += '<div class="fp-request-list">';
      for (const req of incomingRequests) {
        const initial = (req.display_name || req.username || '?')[0].toUpperCase();
        const avatarUrl = req.avatar_path && token
          ? `/api/users/avatar/${req.id}?token=${encodeURIComponent(token)}&t=${Date.now()}`
          : null;
        html += `
          <div class="fp-request-card">
            <div class="fp-friend-avatar">
              ${avatarUrl
                ? `<img src="${avatarUrl}" alt="" loading="lazy" />`
                : `<span>${escHtml(initial)}</span>`
              }
            </div>
            <div class="fp-friend-info">
              <span class="fp-friend-name">${escHtml(req.display_name || req.username)}</span>
              <span class="fp-friend-status">@${escHtml(req.username)}</span>
            </div>
            <div class="fp-request-actions">
              <button class="btn btn-primary btn-sm fp-accept-btn" data-uid="${req.id}">Accept</button>
              <button class="btn btn-ghost btn-sm fp-deny-btn" data-uid="${req.id}">Deny</button>
            </div>
          </div>
        `;
      }
      html += '</div>';
    }

    if (sentRequests.length > 0) {
      html += '<h4 class="fp-section-title" style="margin-top:16px">Sent Requests</h4>';
      html += '<div class="fp-request-list">';
      for (const req of sentRequests) {
        const initial = (req.display_name || req.username || '?')[0].toUpperCase();
        const avatarUrl = req.avatar_path && token
          ? `/api/users/avatar/${req.id}?token=${encodeURIComponent(token)}&t=${Date.now()}`
          : null;
        html += `
          <div class="fp-request-card">
            <div class="fp-friend-avatar">
              ${avatarUrl
                ? `<img src="${avatarUrl}" alt="" loading="lazy" />`
                : `<span>${escHtml(initial)}</span>`
              }
            </div>
            <div class="fp-friend-info">
              <span class="fp-friend-name">${escHtml(req.display_name || req.username)}</span>
              <span class="fp-friend-status">Pending</span>
            </div>
            <div class="fp-request-actions">
              <button class="btn btn-ghost btn-sm fp-cancel-btn" data-uid="${req.id}">Cancel</button>
            </div>
          </div>
        `;
      }
      html += '</div>';
    }

    if (incomingRequests.length === 0 && sentRequests.length === 0) {
      html += `<div class="fp-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
        <p>No pending requests</p>
      </div>`;
    }

    body.innerHTML = html;

    // Bind accept/deny/cancel buttons
    body.querySelectorAll('.fp-accept-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/friends/accept/${btn.dataset.uid}`, { method: 'POST' });
          toast('Friend request accepted!', 'success');
          loadFriendsData();
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    body.querySelectorAll('.fp-deny-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/friends/deny/${btn.dataset.uid}`, { method: 'POST' });
          toast('Friend request denied.', 'success');
          loadFriendsData();
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    body.querySelectorAll('.fp-cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/friends/cancel/${btn.dataset.uid}`, { method: 'POST' });
          toast('Request cancelled.', 'success');
          loadFriendsData();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  // ── Watch Party Tab ────────────────────────────────────────────────────
  function renderPartyTab(body) {
    if (!WatchParty.isInParty()) {
      body.innerHTML = `<div class="fp-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <p>No active watch party</p>
        <span>Start one from a friend's profile</span>
      </div>`;
      return;
    }

    const members = WatchParty.getPartyMembers();
    const isHost = WatchParty.isPartyHost();
    const token = getToken();
    const currentUserId = getUser()?.id;

    let html = `
      <div class="fp-party-info">
        <div class="fp-party-video">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>${escHtml(WatchParty.getPartyVideoTitle() || 'No video selected')}</span>
        </div>
        <div class="fp-party-id">Party ID: ${escHtml(WatchParty.getPartyId()?.slice(0, 8) || '')}</div>
      </div>

      <h4 class="fp-section-title">Members (${members.size})</h4>
      <div class="fp-member-list">
    `;

    for (const [uid, m] of members) {
      const avatarUrl = m.avatarPath && token
        ? `/api/users/avatar/${uid}?token=${encodeURIComponent(token)}&t=${Date.now()}`
        : null;
      const initial = (m.displayName || m.username || '?')[0].toUpperCase();
      const isMe = uid === currentUserId;

      html += `
        <div class="fp-member-card ${m.buffering ? 'buffering' : ''}">
          <div class="fp-friend-avatar online">
            ${avatarUrl
              ? `<img src="${avatarUrl}" alt="" loading="lazy" />`
              : `<span>${escHtml(initial)}</span>`
            }
            <div class="fp-status-dot online"></div>
          </div>
          <div class="fp-friend-info">
            <span class="fp-friend-name">${escHtml(m.displayName)}${isMe ? ' (You)' : ''}${m.isHost ? ' ★' : ''}</span>
            <span class="fp-friend-status">${m.buffering ? '⏳ Buffering...' : '✓ Ready'}</span>
          </div>
          ${isHost && !isMe ? `<button class="fp-action-btn fp-kick-btn" data-uid="${uid}" title="Remove from party">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>` : ''}
        </div>
      `;
    }

    html += '</div>';

    // Invite more friends
    const onlineFriends = friendsList.filter(f =>
      WatchParty.isFriendOnline(f.id) && !members.has(f.id)
    );
    if (onlineFriends.length > 0) {
      html += '<h4 class="fp-section-title" style="margin-top:12px">Invite Friends</h4><div class="fp-invite-list">';
      for (const f of onlineFriends) {
        html += `<button class="fp-quick-invite" data-uid="${f.id}">
          <span>+ ${escHtml(f.display_name || f.username)}</span>
        </button>`;
      }
      html += '</div>';
    }

    // Chat
    html += `
      <div class="fp-party-chat">
        <h4 class="fp-section-title">Chat</h4>
        <div class="fp-chat-messages" id="fp-chat-messages">
          ${chatMessages.length === 0
            ? '<div class="fp-chat-empty">No messages yet</div>'
            : chatMessages.map(m => `
              <div class="fp-chat-msg">
                <strong>${escHtml(m.displayName)}</strong>
                <span>${escHtml(m.text)}</span>
              </div>
            `).join('')
          }
        </div>
        <div class="fp-chat-input-row">
          <input type="text" class="fp-chat-input" id="fp-chat-input" placeholder="Send a message..." maxlength="500" autocomplete="off" />
          <button class="btn btn-primary btn-sm" id="fp-chat-send" type="button">Send</button>
        </div>
      </div>
    `;

    // Leave button
    html += `
      <div class="fp-party-footer">
        <button class="btn btn-danger btn-sm" id="fp-leave-party" type="button">
          ${isHost ? 'End Party' : 'Leave Party'}
        </button>
      </div>
    `;

    body.innerHTML = html;

    // Scroll chat to bottom
    const chatEl = document.getElementById('fp-chat-messages');
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

    // Bind actions
    body.querySelectorAll('.fp-kick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        WatchParty.kickMember(parseInt(btn.dataset.uid, 10));
      });
    });

    body.querySelectorAll('.fp-quick-invite').forEach(btn => {
      btn.addEventListener('click', () => {
        WatchParty.inviteToParty(parseInt(btn.dataset.uid, 10));
        btn.disabled = true;
        btn.textContent = 'Invited!';
      });
    });

    document.getElementById('fp-leave-party')?.addEventListener('click', () => {
      WatchParty.leaveParty();
    });

    const chatInput = document.getElementById('fp-chat-input');
    const chatSend = document.getElementById('fp-chat-send');
    const doSendChat = () => {
      const text = chatInput?.value.trim();
      if (!text) return;
      WatchParty.sendChat(text);
      chatInput.value = '';
    };
    chatSend?.addEventListener('click', doSendChat);
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSendChat();
    });
  }

  // ── Add Friends button to user dropdown ────────────────────────────────
  function ensureFriendsMenuItem() {
    const dropdown = document.getElementById('user-dropdown');
    if (!dropdown || document.getElementById('friends-menu-btn')) return;
    const logoutBtn = document.getElementById('logout-btn');
    if (!logoutBtn) return;

    const friendsBtn = document.createElement('button');
    friendsBtn.className = 'dropdown-item';
    friendsBtn.id = 'friends-menu-btn';
    friendsBtn.type = 'button';
    friendsBtn.setAttribute('role', 'menuitem');
    friendsBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
        <circle cx="9" cy="7" r="4"></circle>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
      </svg>
      Friends
    `;

    friendsBtn.addEventListener('click', () => {
      dropdown.classList.remove('show');
      const trigger = document.getElementById('user-menu-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      openFriendsPanel();
    });

    // Insert before the first divider or settings button
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      dropdown.insertBefore(friendsBtn, settingsBtn);
    } else {
      dropdown.insertBefore(friendsBtn, logoutBtn);
    }
  }

  // ── Notification bell integration ──────────────────────────────────────
  // Hook into the handleNotifClick for friend_request type
  const originalHandleNotifClick = window.handleNotifClick;
  window.handleNotifClick = async (id, videoId, type, userId) => {
    if (type === 'friend_request') {
      openFriendsPanel();
      activeTab = 'requests';
      const reqTab = document.querySelector('.fp-tab[data-tab="requests"]');
      if (reqTab) {
        document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
        reqTab.classList.add('active');
      }
      renderActiveTab();
      return;
    }
    if (originalHandleNotifClick) {
      return originalHandleNotifClick(id, videoId);
    }
  };

  // ── Listen for party events to update UI ───────────────────────────────
  window.addEventListener('party:created', () => {
    if (friendsPanelOpen) renderActiveTab();
  });
  window.addEventListener('party:joined', (e) => {
    activeTab = 'party';
    
    // Load persisted chat history from server
    if (e.detail && Array.isArray(e.detail.messages)) {
      chatMessages = [...e.detail.messages];
    } else {
      chatMessages = [];
    }

    if (friendsPanelOpen) {
      const partyTabEl = document.querySelector('.fp-tab[data-tab="party"]');
      if (partyTabEl) {
        document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
        partyTabEl.classList.add('active');
      }
      renderActiveTab();
    }
  });
  
  window.addEventListener('party:state', (e) => {
    // Load persisted chat history from server when state is refreshed
    if (e.detail && Array.isArray(e.detail.messages)) {
      chatMessages = [...e.detail.messages];
    } else {
      chatMessages = [];
    }
    if (friendsPanelOpen && activeTab === 'party') renderActiveTab();
  });

  window.addEventListener('party:member_changed', () => {
    if (friendsPanelOpen && activeTab === 'party') renderActiveTab();
  });
  window.addEventListener('party:ended', () => {
    if (friendsPanelOpen) {
      activeTab = 'friends';
      const friendsTabEl = document.querySelector('.fp-tab[data-tab="friends"]');
      if (friendsTabEl) {
        document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
        friendsTabEl.classList.add('active');
      }
      renderActiveTab();
    }
  });
  window.addEventListener('party:chat', (e) => {
    const msg = e.detail;
    chatMessages.push(msg);
    if (chatMessages.length > 100) chatMessages.shift();
    if (friendsPanelOpen && activeTab === 'party') {
      const chatEl = document.getElementById('fp-chat-messages');
      if (chatEl) {
        const emptyEl = chatEl.querySelector('.fp-chat-empty');
        if (emptyEl) emptyEl.remove();
        chatEl.insertAdjacentHTML('beforeend', `
          <div class="fp-chat-msg">
            <strong>${escHtml(msg.displayName)}</strong>
            <span>${escHtml(msg.text)}</span>
          </div>
        `);
        chatEl.scrollTop = chatEl.scrollHeight;
      }
    }
  });

  window.addEventListener('friends:presence', () => {
    if (friendsPanelOpen && activeTab === 'friends') renderActiveTab();
  });
  window.addEventListener('friends:presence_list', () => {
    if (friendsPanelOpen && activeTab === 'friends') renderActiveTab();
  });

  // ── Initialize ─────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // Small delay to let shared.js add other menu items first
    setTimeout(ensureFriendsMenuItem, 200);
  });

  // Escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && friendsPanelOpen) {
      closeFriendsPanel();
    }
  });
})();
