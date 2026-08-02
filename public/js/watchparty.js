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
  let partyVideoTitle = '';
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
        (msg.members || []).forEach(m => {
          currentPartyMembers.set(m.userId, {
            username: m.username,
            displayName: m.displayName,
            avatarPath: m.avatarPath,
            buffering: m.buffering,
            isHost: m.isHost,
          });
        });
        window.dispatchEvent(new CustomEvent('party:joined', { detail: msg }));
        savePartyToSession();

        // If we just navigated to a new video while in a party, tell everyone
        autoSyncVideoOnRejoin();
        break;

      case 'party:member_joined':
        currentPartyMembers.set(msg.userId, {
          username: msg.username,
          displayName: msg.displayName,
          avatarPath: msg.avatarPath,
          buffering: false,
          isHost: false,
        });
        window.dispatchEvent(new CustomEvent('party:member_changed', { detail: { action: 'joined', ...msg } }));
        break;

      case 'party:member_left':
        currentPartyMembers.delete(msg.userId);
        window.dispatchEvent(new CustomEvent('party:member_changed', { detail: { action: 'left', ...msg } }));
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

      default:
        break;
    }
  }
  // ── Auto-sync video when rejoining on a different video ─────────────────
  function autoSyncVideoOnRejoin() {
    const isWatchPage = /\/watch\.html$/i.test(location.pathname);
    if (!isWatchPage || !isInParty) return;

    const pageVideoId = Number(new URLSearchParams(location.search).get('id'));
    if (!pageVideoId) return;

    // If we're on a different video than the party knows about, broadcast the change
    if (pageVideoId !== partyVideoId) {
      const title = document.querySelector('#overlay-video-title')?.textContent
                 || document.title
                 || '';
      // Small delay to let the page finish loading the video title
      setTimeout(() => {
        const videoTitle = document.querySelector('#overlay-video-title')?.textContent || title;
        const playerTime = window.videojs ? (window.videojs.getPlayer('video-player')?.currentTime() || 0) : 0;
        send({ type: 'party:video_change', videoId: pageVideoId, videoTitle, currentTime: playerTime });
        partyVideoId = pageVideoId;
        partyVideoTitle = videoTitle;
        // Our video is already loaded, so tell the server we're ready
        setTimeout(() => send({ type: 'party:ready' }), 200);
      }, 500);
    }
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
    changeVideo: (videoId, videoTitle) => send({ type: 'party:video_change', videoId, videoTitle }),

    // Sync actions (called by video player)
    sendSync: (action, currentTime) => {
      if (!isInParty) return;
      send({ type: 'party:sync', action, currentTime });
    },
    sendBuffering: () => { if (isInParty) send({ type: 'party:buffering' }); },
    sendReady: () => { if (isInParty) send({ type: 'party:ready' }); },

    // State getters
    isInParty: () => isInParty,
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
