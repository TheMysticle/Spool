'use strict';

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getUserById, getFriends } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET;
const HEARTBEAT_INTERVAL = 30000;
const SYNC_DRIFT_TOLERANCE = 1.5; // seconds
const MAX_PARTY_SIZE = 8;

// ── State ────────────────────────────────────────────────────────────────────
// userId → Set<WebSocket>
const onlineUsers = new Map();
// partyId → { hostId, videoId, members: Map<userId, { ws, username, displayName, avatarPath, buffering }>, createdAt }
const watchParties = new Map();
// userId → partyId (quick lookup)
const userPartyMap = new Map();
// userId → { timeout, partyId } (grace period for page navigations)
const pendingLeaves = new Map();
const RECONNECT_GRACE_MS = 15000;

let wss = null;

function initWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    // Parse token from query string
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const user = getUserById(payload.userId);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.userId = user.id;
      ws.username = user.username;
      ws.displayName = user.display_name || user.username;
      ws.avatarPath = user.avatar_path;
      ws.isAlive = true;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    // ── Cancel any pending leave (user navigated between pages) ──────────
    const pendingLeave = pendingLeaves.get(ws.userId);
    if (pendingLeave) {
      clearTimeout(pendingLeave.timeout);
      pendingLeaves.delete(ws.userId);
      // Re-associate the user's WS in their party
      const partyId = pendingLeave.partyId;
      const party = watchParties.get(partyId);
      if (party && party.members.has(ws.userId)) {
        const member = party.members.get(ws.userId);
        member.ws = ws;
      }
    }

    // ── Track online presence ──────────────────────────────────────────────
    if (!onlineUsers.has(ws.userId)) {
      onlineUsers.set(ws.userId, new Set());
    }
    onlineUsers.get(ws.userId).add(ws);

    // Notify friends that this user is online
    broadcastPresence(ws.userId, true);

    // Send initial online friends list
    sendOnlineFriends(ws);

    // ── Heartbeat ──────────────────────────────────────────────────────────
    ws.on('pong', () => { ws.isAlive = true; });

    // ── Message handling ───────────────────────────────────────────────────
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'party:create':
          handlePartyCreate(ws, msg);
          break;
        case 'party:invite':
          handlePartyInvite(ws, msg);
          break;
        case 'party:join':
          handlePartyJoin(ws, msg);
          break;
        case 'party:rejoin':
          handlePartyRejoin(ws, msg);
          break;
        case 'party:leave':
          handlePartyLeave(ws, true);
          break;
        case 'party:sync':
          handlePartySync(ws, msg);
          break;
        case 'party:buffering':
          handlePartyBuffering(ws, true);
          break;
        case 'party:ready':
          handlePartyBuffering(ws, false);
          break;
        case 'party:kick':
          handlePartyKick(ws, msg);
          break;
        case 'party:chat':
          handlePartyChat(ws, msg);
          break;
        case 'party:video_change':
          handlePartyVideoChange(ws, msg);
          break;
        case 'party:status':
          handlePartyStatus(ws, msg);
          break;
        case 'party:request_sync':
          handlePartyRequestSync(ws, msg);
          break;
        case 'party:suggest_video':
          handlePartySuggestVideo(ws, msg);
          break;
        case 'party:invite_response':
          handlePartyInviteResponse(ws, msg);
          break;
        default:
          break;
      }
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    ws.on('close', () => {
      const sockets = onlineUsers.get(ws.userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          onlineUsers.delete(ws.userId);
          broadcastPresence(ws.userId, false);
        }
      }
      // Start grace period instead of immediately leaving party
      schedulePartyLeave(ws);
    });
  });

  // ── Heartbeat interval ─────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeat));

  console.log('[WS] WebSocket server initialised');
}

// ── Presence helpers ─────────────────────────────────────────────────────────
function broadcastPresence(userId, online) {
  const friends = getFriends(userId);
  const friendIds = friends.map(f => f.id);

  const msg = JSON.stringify({
    type: 'presence',
    userId,
    online,
  });

  for (const friendId of friendIds) {
    const sockets = onlineUsers.get(friendId);
    if (sockets) {
      for (const s of sockets) {
        safeSend(s, msg);
      }
    }
  }
}

function sendOnlineFriends(ws) {
  const friends = getFriends(ws.userId);
  const onlineFriendIds = friends
    .filter(f => onlineUsers.has(f.id))
    .map(f => f.id);

  safeSend(ws, JSON.stringify({
    type: 'presence_list',
    onlineUserIds: onlineFriendIds,
  }));
}

function isUserOnline(userId) {
  return onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
}

// ── Watch Party handlers ─────────────────────────────────────────────────────
function handlePartyCreate(ws, msg) {
  // Check if user is already in a party
  if (userPartyMap.has(ws.userId)) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'You are already in a watch party.' }));
    return;
  }

  const partyId = crypto.randomBytes(8).toString('hex');
  const party = {
    hostId: ws.userId,
    videoId: msg.videoId || null,
    videoTitle: msg.videoTitle || '',
    members: new Map(),
    createdAt: Date.now(),
  };

  party.members.set(ws.userId, {
    ws,
    username: ws.username,
    displayName: ws.displayName,
    avatarPath: ws.avatarPath,
    buffering: false,
    browsing: false,
  });

  watchParties.set(partyId, party);
  userPartyMap.set(ws.userId, partyId);

  safeSend(ws, JSON.stringify({
    type: 'party:created',
    partyId,
    hostId: ws.userId,
    videoId: party.videoId,
    videoTitle: party.videoTitle,
  }));
}

function handlePartyInvite(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'You are not in a watch party.' }));
    return;
  }

  const party = watchParties.get(partyId);
  if (!party) return;

  if (party.members.size >= MAX_PARTY_SIZE) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'Party is full (max 8).' }));
    return;
  }

  const targetUserId = msg.userId;
  if (!targetUserId || !isUserOnline(targetUserId)) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'User is not online.' }));
    return;
  }

  // Check they're friends
  const friends = getFriends(ws.userId);
  if (!friends.some(f => f.id === targetUserId)) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'You can only invite friends.' }));
    return;
  }

  // Send invite to the target user
  const targetSockets = onlineUsers.get(targetUserId);
  if (targetSockets) {
    const inviteMsg = JSON.stringify({
      type: 'party:invite',
      partyId,
      fromUserId: ws.userId,
      fromUsername: ws.displayName,
      fromAvatarPath: ws.avatarPath,
      videoId: party.videoId,
      videoTitle: party.videoTitle,
    });
    for (const s of targetSockets) {
      safeSend(s, inviteMsg);
    }
  }

  safeSend(ws, JSON.stringify({ type: 'party:invite_sent', userId: targetUserId }));
}

function handlePartyInviteResponse(ws, msg) {
  if (msg.accepted && msg.partyId) {
    handlePartyJoin(ws, { partyId: msg.partyId });
  }
}

function handlePartyRejoin(ws, msg) {
  const partyId = msg.partyId;
  const party = watchParties.get(partyId);
  if (!party) {
    // Party is gone
    safeSend(ws, JSON.stringify({ type: 'party:left' }));
    userPartyMap.delete(ws.userId);
    return;
  }

  if (party.members.has(ws.userId)) {
    // Already in the party (reconnect handled in connection handler),
    // just re-send the full state
    const member = party.members.get(ws.userId);
    member.ws = ws;

    const membersList = [];
    for (const [uid, m] of party.members) {
      membersList.push({
        userId: uid,
        username: m.username,
        displayName: m.displayName,
        avatarPath: m.avatarPath,
        buffering: m.buffering,
        browsing: m.browsing,
        isHost: uid === party.hostId,
      });
    }

    safeSend(ws, JSON.stringify({
      type: 'party:joined',
      partyId,
      hostId: party.hostId,
      videoId: party.videoId,
      videoTitle: party.videoTitle,
      members: membersList,
    }));
  } else {
    // Not in the party anymore, try to join
    handlePartyJoin(ws, { partyId });
  }
}

function handlePartyJoin(ws, msg) {
  const partyId = msg.partyId;
  const party = watchParties.get(partyId);
  if (!party) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'Party not found.' }));
    return;
  }

  if (party.members.size >= MAX_PARTY_SIZE) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'Party is full.' }));
    return;
  }

  // Leave existing party if in one
  if (userPartyMap.has(ws.userId)) {
    handlePartyLeave(ws);
  }

  party.members.set(ws.userId, {
    ws,
    username: ws.username,
    displayName: ws.displayName,
    avatarPath: ws.avatarPath,
    buffering: false,
    browsing: false,
  });
  userPartyMap.set(ws.userId, partyId);

  // Notify the joining user
  const membersList = [];
  for (const [uid, m] of party.members) {
    membersList.push({
      userId: uid,
      username: m.username,
      displayName: m.displayName,
      avatarPath: m.avatarPath,
      buffering: m.buffering,
      browsing: m.browsing,
      isHost: uid === party.hostId,
    });
  }

  safeSend(ws, JSON.stringify({
    type: 'party:joined',
    partyId,
    hostId: party.hostId,
    videoId: party.videoId,
    videoTitle: party.videoTitle,
    members: membersList,
    justJoined: true,
  }));

  // Notify existing members
  broadcastToParty(partyId, {
    type: 'party:member_joined',
    userId: ws.userId,
    username: ws.username,
    displayName: ws.displayName,
    avatarPath: ws.avatarPath,
  }, ws.userId);
}

// Schedule a delayed party leave (grace period for page navigation)
function schedulePartyLeave(ws) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  // Only schedule if this was the user's last open socket
  const sockets = onlineUsers.get(ws.userId);
  if (sockets && sockets.size > 0) return; // Still has other tabs open

  // Don't double-schedule
  if (pendingLeaves.has(ws.userId)) return;

  const timeout = setTimeout(() => {
    pendingLeaves.delete(ws.userId);
    handlePartyLeave(ws, false);
  }, RECONNECT_GRACE_MS);

  pendingLeaves.set(ws.userId, { timeout, partyId });
}

function handlePartyLeave(ws, intentional = false) {
  // Cancel any pending leave timer
  const pending = pendingLeaves.get(ws.userId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingLeaves.delete(ws.userId);
  }

  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party) {
    userPartyMap.delete(ws.userId);
    return;
  }

  party.members.delete(ws.userId);
  userPartyMap.delete(ws.userId);

  if (intentional) {
    safeSend(ws, JSON.stringify({ type: 'party:left' }));
  }

  if (party.members.size === 0) {
    watchParties.delete(partyId);
    return;
  }

  // If the host left, transfer host to first remaining member
  if (party.hostId === ws.userId) {
    const newHostId = party.members.keys().next().value;
    party.hostId = newHostId;
    broadcastToParty(partyId, {
      type: 'party:host_changed',
      newHostId,
    });
  }

  // Notify remaining members
  broadcastToParty(partyId, {
    type: 'party:member_left',
    userId: ws.userId,
    username: ws.username,
    displayName: ws.displayName,
  });

  checkBufferingState(partyId);
}

function handlePartySync(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  const member = party?.members.get(ws.userId);
  if (member?.browsing) return; // browsing members shouldn't drive party playback

  // Relay the sync event to all other party members
  broadcastToParty(partyId, {
    type: 'party:sync',
    action: msg.action, // 'play', 'pause', 'seek'
    currentTime: msg.currentTime,
    fromUserId: ws.userId,
    fromUsername: ws.displayName,
    timestamp: Date.now(),
  }, ws.userId);
}

function handlePartyBuffering(ws, isBuffering) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party) return;

  const member = party.members.get(ws.userId);
  if (member) {
    member.buffering = isBuffering;
    broadcastToParty(partyId, {
      type: 'party:member_changed',
      action: 'status',
      userId: ws.userId,
      buffering: isBuffering,
    });
  }

  if (isBuffering) {
    if (!member?.browsing) {
      broadcastToParty(partyId, {
        type: 'party:waiting',
        userId: ws.userId,
        displayName: ws.displayName,
        waiting: true,
      });
    }
  } else {
    // Check if all members are ready
    checkBufferingState(partyId);
  }
}

function checkBufferingState(partyId) {
  const party = watchParties.get(partyId);
  if (!party) return;

  // Browsing members shouldn't block the video
  const bufferingMembers = [];
  for (const [uid, m] of party.members) {
    if (m.buffering && !m.browsing) {
      bufferingMembers.push({ userId: uid, displayName: m.displayName });
    }
  }

  if (bufferingMembers.length === 0) {
    // Everyone is ready, resume
    broadcastToParty(partyId, {
      type: 'party:waiting',
      waiting: false,
      syncTime: party.videoSyncMode ? party.syncTime : undefined,
    });
    party.videoSyncMode = false;
  } else {
    // Still waiting for someone
    const names = bufferingMembers.map(m => m.displayName).join(', ');
    broadcastToParty(partyId, {
      type: 'party:waiting',
      waiting: true,
      userId: bufferingMembers[0].userId,
      displayName: names,
      videoSync: party.videoSyncMode || false,
    });
  }
}

function handlePartyStatus(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party) return;

  const member = party.members.get(ws.userId);
  if (!member) return;

  if (typeof msg.browsing === 'boolean') {
    member.browsing = msg.browsing;
    if (msg.browsing) {
      // If they are browsing, they are not buffering the party video
      member.buffering = false;
    }
  }

  broadcastToParty(partyId, {
    type: 'party:member_changed',
    action: 'status',
    userId: ws.userId,
    browsing: member.browsing,
  });

  // Re-check buffering state in case their browsing state affected the buffer wait
  checkBufferingState(partyId);
}

function handlePartyKick(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party || party.hostId !== ws.userId) {
    safeSend(ws, JSON.stringify({ type: 'party:error', error: 'Only the host can kick members.' }));
    return;
  }

  const targetUserId = msg.userId;
  const targetMember = party.members.get(targetUserId);
  if (!targetMember) return;

  // Notify kicked user
  safeSend(targetMember.ws, JSON.stringify({ type: 'party:kicked' }));

  party.members.delete(targetUserId);
  userPartyMap.delete(targetUserId);

  // Notify remaining members
  broadcastToParty(partyId, {
    type: 'party:member_left',
    userId: targetUserId,
    username: targetMember.username,
    displayName: targetMember.displayName,
    kicked: true,
  });

  checkBufferingState(partyId);
}

function handlePartyChat(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const text = (msg.text || '').trim().substring(0, 500);
  if (!text) return;

  broadcastToParty(partyId, {
    type: 'party:chat',
    userId: ws.userId,
    displayName: ws.displayName,
    avatarPath: ws.avatarPath,
    text,
    timestamp: Date.now(),
  });
}

function handlePartyRequestSync(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party) return;

  let provider = null;
  // If the requester is not the host, ask the host
  if (party.hostId !== ws.userId && party.members.has(party.hostId)) {
    const hostMember = party.members.get(party.hostId);
    if (!hostMember.browsing) provider = hostMember.ws;
  }
  
  // If host is unavailable or host is the requester, ask any non-browsing, non-buffering member
  if (!provider) {
    for (const [uid, m] of party.members) {
      if (uid !== ws.userId && !m.browsing && !m.buffering) {
        provider = m.ws;
        break;
      }
    }
  }

  if (provider) {
    safeSend(provider, JSON.stringify({ type: 'party:provide_sync', requesterId: ws.userId }));
  }
}

function handlePartySuggestVideo(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party || !party.hostId) return;

  const hostWs = party.members.get(party.hostId)?.ws;
  if (!hostWs) return;

  // Send the suggestion ONLY to the host
  safeSend(hostWs, JSON.stringify({
    type: 'party:suggest_video',
    userId: ws.userId,
    displayName: ws.displayName,
    videoId: msg.videoId,
    videoTitle: msg.videoTitle,
  }));
}

function handlePartyVideoChange(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party) return;
  
  // Only the host can officially change the party's video
  if (party.hostId !== ws.userId) {
    return;
  }

  party.videoId = msg.videoId || null;
  party.videoTitle = msg.videoTitle || '';
  party.syncTime = msg.currentTime || 0;
  party.videoSyncMode = true;

  // Mark ALL members as buffering — everyone needs to load the new video
  for (const [uid, m] of party.members) {
    m.buffering = true;
  }

  // Tell other members to navigate to the new video
  broadcastToParty(partyId, {
    type: 'party:video_change',
    videoId: msg.videoId,
    videoTitle: msg.videoTitle,
    currentTime: party.syncTime,
    fromUserId: ws.userId,
    fromUsername: ws.displayName,
  }, ws.userId);

  // Tell ALL members (including sender) to wait
  broadcastToParty(partyId, {
    type: 'party:waiting',
    waiting: true,
    displayName: 'everyone to load the video',
    videoSync: true,
  });
}

// ── Utility ──────────────────────────────────────────────────────────────────
function broadcastToParty(partyId, msgObj, excludeUserId = null) {
  const party = watchParties.get(partyId);
  if (!party) return;

  const msg = JSON.stringify(msgObj);
  for (const [uid, m] of party.members) {
    if (uid === excludeUserId) continue;
    safeSend(m.ws, msg);
  }
}

function safeSend(ws, msg) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(msg);
  }
}

module.exports = { initWebSocket, isUserOnline };
