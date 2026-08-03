/* watchparty.js — WebSocket client for presence & watch party sync */
'use strict';

(function () {
  // ── State ────────────────────────────────────────────────────────────────
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 30000;
  const onlineFriendIds = new Set();

  // Watch party state
  let currentPartyId = null;
  let currentPartyMembers = new Map(); // userId → { username, displayName, avatarPath, buffering, isHost }
  let isInParty = false;
  let isHost = false;
  let partyVideoId = null;
  let partyVideoTitle = null;
  let isBrowsing = false;
  let pendingInvite = null;

  // ── WebSocket connection ─────────────────────────────────────────────────
  function connect() {
    const token = getToken();
    if (!token) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/?token=${encodeURIComponent(token)}`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[WS] Failed to create WebSocket:', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
      console.log('[WS] Connected');
      window.dispatchEvent(new CustomEvent('ws:connected'));

      // Auto-join party if we arrived via an invite link (?party=...)
      const urlParams = new URLSearchParams(location.search);
      const pendingPartyId = urlParams.get('party');
      if (pendingPartyId) {
        send({ type: 'party:join', partyId: pendingPartyId });
        // Clean the party param from the URL so refreshes don't re-join
        urlParams.delete('party');
        const clean = urlParams.toString();
        const newUrl = location.pathname + (clean ? '?' + clean : '') + location.hash;
        history.replaceState(null, '', newUrl);
      } else {
        // Rejoin party from session if we navigated between pages
        const savedPartyId = sessionStorage.getItem('wp_partyId');
        if (savedPartyId) {
          send({ type: 'party:rejoin', partyId: savedPartyId });
        }
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      ws = null;
      window.dispatchEvent(new CustomEvent('ws:disconnected'));
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        connect();
      }
    }, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ── Message handler ──────────────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'presence':
        if (msg.online) {
          onlineFriendIds.add(msg.userId);
        } else {
          onlineFriendIds.delete(msg.userId);
        }
        window.dispatchEvent(new CustomEvent('friends:presence', { detail: msg }));
        break;

      case 'presence_list':
        onlineFriendIds.clear();
        (msg.onlineUserIds || []).forEach(id => onlineFriendIds.add(id));
        window.dispatchEvent(new CustomEvent('friends:presence_list', { detail: msg }));
        break;

      case 'party:created':
        currentPartyId = msg.partyId;
        isInParty = true;
        isHost = true;
        partyVideoId = msg.videoId;
        partyVideoTitle = msg.videoTitle;
        currentPartyMembers.clear();
        const user = getUser();
        if (user) {
          currentPartyMembers.set(user.id, {
            username: user.username,
            displayName: user.display_name || user.username,
            avatarPath: user.avatar_path,
            buffering: false,
            isHost: true,
          });
        }
        window.dispatchEvent(new CustomEvent('party:created', { detail: msg }));
        savePartyToSession();
        break;

      case 'party:joined':
        currentPartyId = msg.partyId;
        isInParty = true;
        isHost = msg.hostId === (getUser()?.id);
        partyVideoId = msg.videoId;
        partyVideoTitle = msg.videoTitle;
        currentPartyMembers.clear();
        msg.members.forEach(m => {
          currentPartyMembers.set(m.userId, {
            username: m.username,
            displayName: m.displayName,
            avatarPath: m.avatarPath,
            buffering: m.buffering,
            browsing: m.browsing,
            isHost: m.isHost,
          });
        });
        window.dispatchEvent(new CustomEvent('party:joined', { detail: msg }));
        savePartyToSession();

        // If this is a fresh join from an invite, redirect to the video if we aren't there
        if (msg.justJoined && partyVideoId) {
          const curId = Number(new URLSearchParams(location.search).get('id'));
          const onWatch = /\/watch\.html$/i.test(location.pathname);
          if (!onWatch || curId !== partyVideoId) {
            location.href = `/watch.html?id=${partyVideoId}`;
            return;
          }
        }

        // If we just navigated to a new video while in a party, tell everyone
        autoSyncVideoOnRejoin();
        break;

      case 'party:member_joined':
        currentPartyMembers.set(msg.userId, {
          username: msg.username,
          displayName: msg.displayName,
          avatarPath: msg.avatarPath,
          buffering: msg.buffering || false,
          browsing: msg.browsing || false,
          isHost: false,
        });
        window.dispatchEvent(new CustomEvent('party:member_changed', { detail: { action: 'joined', ...msg } }));
        break;

      case 'party:member_left':
        currentPartyMembers.delete(msg.userId);
        window.dispatchEvent(new CustomEvent('party:member_changed', { detail: { action: 'left', ...msg } }));
        break;

      case 'party:member_changed':
        const member = currentPartyMembers.get(msg.userId);
        if (member) {
          if (typeof msg.browsing === 'boolean') member.browsing = msg.browsing;
          if (typeof msg.buffering === 'boolean') member.buffering = msg.buffering;
          window.dispatchEvent(new CustomEvent('party:member_changed', { detail: msg }));
        }
        break;

      case 'party:host_changed':
        isHost = msg.newHostId === (getUser()?.id);
        for (const [uid, m] of currentPartyMembers) {
          m.isHost = uid === msg.newHostId;
        }
        window.dispatchEvent(new CustomEvent('party:host_changed', { detail: msg }));
        break;

      case 'party:left':
      case 'party:kicked':
        const wasKicked = msg.type === 'party:kicked';
        currentPartyId = null;
        isInParty = false;
        isHost = false;
        currentPartyMembers.clear();
        clearPartyFromSession();
        window.dispatchEvent(new CustomEvent('party:ended', { detail: { kicked: wasKicked } }));
        if (wasKicked) toast('You were removed from the watch party.', 'error');
        break;

      case 'party:sync':
        window.dispatchEvent(new CustomEvent('party:sync', { detail: msg }));
        break;

      case 'party:waiting':
        window.dispatchEvent(new CustomEvent('party:waiting', { detail: msg }));
        break;

      case 'party:invite':
        pendingInvite = msg;
        showPartyInvite(msg);
        break;

      case 'party:invite_sent':
        toast('Watch party invite sent!', 'success');
        break;

      case 'party:error':
        toast(msg.error || 'Watch party error.', 'error');
        break;

      case 'party:video_change':
        partyVideoId = msg.videoId;
        partyVideoTitle = msg.videoTitle;
        window.dispatchEvent(new CustomEvent('party:video_change', { detail: msg }));
        // Navigate if we're not already on this video
        if (msg.videoId) {
          const curId = Number(new URLSearchParams(location.search).get('id'));
          const onWatch = /\/watch\.html$/i.test(location.pathname);
          if (!onWatch || curId !== msg.videoId) {
            location.href = `/watch.html?id=${msg.videoId}`;
          }
        }
        break;

      case 'party:chat':
        window.dispatchEvent(new CustomEvent('party:chat', { detail: msg }));
        break;

      case 'party:suggest_video':
        showPartySuggest(msg);
        break;
        
      case 'party:provide_sync':
        window.dispatchEvent(new CustomEvent('party:provide_sync', { detail: msg }));
        break;

      default:
        break;
    }
  }
  // ── Auto-sync video when rejoining on a different video ─────────────────
  function autoSyncVideoOnRejoin() {
    const isWatchPage = /\/watch\.html$/i.test(location.pathname);
    if (!isInParty) return;

    if (!isWatchPage) {
      WatchParty.setBrowsingStatus(true);
      return;
    }
    
    WatchParty.setBrowsingStatus(false);

    const pageVideoId = Number(new URLSearchParams(location.search).get('id'));
    if (!pageVideoId) return;

    if (pageVideoId !== partyVideoId) {
      if (isHost) {
        // If host navigates, broadcast the change
        const title = document.querySelector('#overlay-video-title')?.textContent
                   || document.title
                   || '';
        const playerTime = window.videojs ? (window.videojs.getPlayer('video-player')?.currentTime() || 0) : 0;
        send({ type: 'party:video_change', videoId: pageVideoId, videoTitle: title, currentTime: playerTime });
        partyVideoId = pageVideoId;
        partyVideoTitle = title;
        send({ type: 'party:ready' });
      } else {
        // If guest navigates, mark as browsing because they are off-sync
        WatchParty.setBrowsingStatus(true);
      }
    } else {
      // Rejoined the right video, request sync state from others
      send({ type: 'party:request_sync' });
    }
  }

  function showPartySuggest(msg) {
    let el = document.getElementById('wp-suggest-popup');
    if (el) el.remove();

    el = document.createElement('div');
    el.id = 'wp-suggest-popup';
    el.className = 'wp-invite-toast';
    el.innerHTML = `
      <div class="wp-invite-header">
        <strong>${escHtml(msg.displayName)}</strong> suggests a video:
      </div>
      <div class="wp-invite-info" style="margin-bottom: 12px; margin-top: 12px;">
        <div class="wp-invite-title" style="font-size: 0.95rem;">${escHtml(msg.videoTitle)}</div>
      </div>
      <div class="wp-invite-actions">
        <button class="btn btn-primary" id="wp-suggest-approve">Approve Swap</button>
        <button class="btn btn-secondary" id="wp-suggest-decline">Dismiss</button>
      </div>
      </div>
    `;
    
    let container = document.getElementById('wp-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'wp-toast-container';
      container.style.cssText = 'position: fixed; top: 80px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; pointer-events: none;';
      document.body.appendChild(container);
    }
    container.appendChild(el);

    document.getElementById('wp-suggest-approve').onclick = () => {
      el.remove();
      const isWatchPage = /\/watch\.html$/i.test(location.pathname);
      if (isWatchPage && typeof window.navigateToVideo === 'function') {
        // navigateToVideo will automatically call WatchParty.changeVideo internally
        window.navigateToVideo(msg.videoId);
      } else {
        WatchParty.changeVideo(msg.videoId, msg.videoTitle, 0);
        location.href = `/watch.html?id=${msg.videoId}`;
      }
    };
    document.getElementById('wp-suggest-decline').onclick = () => {
      el.remove();
    };
  }

  // ── Party invite toast ───────────────────────────────────────────────────
  function showPartyInvite(msg) {
    // Remove any existing invite toast
    document.getElementById('wp-invite-toast')?.remove();

    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.id = 'wp-invite-toast';
    el.className = 'wp-invite-toast';

    const token = getToken();
    const avatarUrl = msg.fromAvatarPath && token
      ? `/api/users/avatar/${msg.fromUserId}?token=${encodeURIComponent(token)}&t=${Date.now()}`
      : null;
    const initial = (msg.fromUsername || '?')[0].toUpperCase();

    el.innerHTML = `
      <div class="wp-invite-header">
        <div class="wp-invite-avatar">${avatarUrl
          ? `<img src="${avatarUrl}" alt="" />`
          : escHtml(initial)
        }</div>
        <div class="wp-invite-info">
          <strong>${escHtml(msg.fromUsername)}</strong>
          <span>invited you to watch</span>
          <em>${escHtml(msg.videoTitle || 'a video')}</em>
        </div>
      </div>
      <div class="wp-invite-actions">
        <button class="btn btn-primary btn-sm" id="wp-invite-accept">Join</button>
        <button class="btn btn-ghost btn-sm" id="wp-invite-decline">Decline</button>
      </div>
    `;

    container.appendChild(el);

    document.getElementById('wp-invite-accept').addEventListener('click', () => {
      el.remove();
      if (msg.videoId) {
        const currentVideoId = Number(new URLSearchParams(location.search).get('id'));
        const isWatchPage = /\/watch\.html$/i.test(location.pathname);
        if (isWatchPage && currentVideoId === msg.videoId) {
          // Already on the right video — just join directly
          send({ type: 'party:join', partyId: msg.partyId });
        } else {
          // Navigate to the video; auto-join happens via onopen after reconnect
          location.href = `/watch.html?id=${msg.videoId}&party=${msg.partyId}`;
        }
      } else {
        // No video — join in-place
        send({ type: 'party:join', partyId: msg.partyId });
      }
    });

    document.getElementById('wp-invite-decline').addEventListener('click', () => {
      send({ type: 'party:invite_response', accepted: false, partyId: msg.partyId });
      el.remove();
    });

    // Auto-dismiss after 30 seconds
    setTimeout(() => el.remove(), 30000);
  }

  // ── Session persistence helpers ─────────────────────────────────────────
  function savePartyToSession() {
    if (currentPartyId) {
      sessionStorage.setItem('wp_partyId', currentPartyId);
    }
  }

  function clearPartyFromSession() {
    sessionStorage.removeItem('wp_partyId');
  }

  // ── Public API (exposed on window) ───────────────────────────────────────
  // Hook SPA navigation to detect when leaving watch.html
  const originalPushState = history.pushState;
  history.pushState = function(...args) {
    const ret = originalPushState.apply(this, args);
    if (isInParty) autoSyncVideoOnRejoin();
    return ret;
  };
  window.addEventListener('popstate', () => {
    if (isInParty) autoSyncVideoOnRejoin();
  });

  window.WatchParty = {
    connect,
    send,
    isConnected: () => ws && ws.readyState === WebSocket.OPEN,
    getOnlineFriendIds: () => onlineFriendIds,
    isFriendOnline: (userId) => onlineFriendIds.has(userId),

    // Party actions
    createParty: (videoId, videoTitle) => send({ type: 'party:create', videoId, videoTitle }),
    inviteToParty: (userId) => send({ type: 'party:invite', userId }),
    leaveParty: () => {
      clearPartyFromSession();
      send({ type: 'party:leave' });
    },
    kickMember: (userId) => send({ type: 'party:kick', userId }),
    sendChat: (text) => send({ type: 'party:chat', text }),
    setBrowsingStatus: (browsing) => {
      isBrowsing = browsing;
      send({ type: 'party:status', browsing });
      
      let container = document.getElementById('wp-floating-actions');
      if (browsing && partyVideoId) {
        if (!container) {
          container = document.createElement('div');
          container.id = 'wp-floating-actions';
          container.className = 'wp-floating-actions';
          document.body.appendChild(container);
        }
        container.innerHTML = '';
        
        const isWatchPage = /\/watch\.html$/i.test(location.pathname);
        const curId = Number(new URLSearchParams(location.search).get('id'));

        // Return to Party Button
        const returnBtn = document.createElement('button');
        returnBtn.className = 'btn wp-return-btn';
        returnBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Return to Party`;
        returnBtn.onclick = () => location.href = `/watch.html?id=${partyVideoId}`;
        container.appendChild(returnBtn);

        // Suggest Video Button (only if on a video page and not the host)
        if (isWatchPage && curId && curId !== partyVideoId && !isHost) {
          const suggestBtn = document.createElement('button');
          suggestBtn.className = 'btn wp-suggest-btn-persistent';
          suggestBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z"></path></svg> Suggest to Party`;
          suggestBtn.onclick = () => {
             const title = document.querySelector('#overlay-video-title')?.textContent || document.title || '';
             WatchParty.suggestVideo(curId, title);
             toast('Suggestion sent to Host!', 'success');
             suggestBtn.remove();
          };
          container.appendChild(suggestBtn);
        }
      } else if (container) {
        container.remove();
      }
    },
    changeVideo: (videoId, videoTitle, currentTime = 0) => send({ type: 'party:video_change', videoId, videoTitle, currentTime }),
    suggestVideo: (videoId, videoTitle) => send({ type: 'party:suggest_video', videoId, videoTitle }),

    // Sync actions (called by video player)
    sendSync: (action, currentTime) => {
      if (!isInParty || isBrowsing) return;
      send({ type: 'party:sync', action, currentTime });
    },
    sendBuffering: () => { if (isInParty) send({ type: 'party:buffering' }); },
    sendReady: () => { if (isInParty) send({ type: 'party:ready' }); },

    // State getters
    isInParty: () => isInParty,
    isBrowsing: () => isBrowsing,
    isPartyHost: () => isHost,
    getPartyId: () => currentPartyId,
    getPartyMembers: () => currentPartyMembers,
    getPartyVideoId: () => partyVideoId,
    getPartyVideoTitle: () => partyVideoTitle,
  };

  // Auto-connect when page loads if user is logged in
  if (getToken()) {
    // Delay slightly to ensure DOM is ready
    setTimeout(connect, 500);
  }
})();
