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
        case 'party:leave':
          handlePartyLeave(ws);
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
      // Remove from party if in one
      handlePartyLeave(ws);
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
    // Auto-join the party
    handlePartyJoin(ws, { partyId: msg.partyId });
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

  // Notify existing members
  broadcastToParty(partyId, {
    type: 'party:member_joined',
    userId: ws.userId,
    username: ws.username,
    displayName: ws.displayName,
    avatarPath: ws.avatarPath,
  }, ws.userId);
}

function handlePartyLeave(ws) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party) {
    userPartyMap.delete(ws.userId);
    return;
  }

  party.members.delete(ws.userId);
  userPartyMap.delete(ws.userId);

  safeSend(ws, JSON.stringify({ type: 'party:left' }));

  if (party.members.size === 0) {
    // Party is empty, clean up
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

  // Check if anyone was waiting on this user buffering
  checkBufferingState(partyId);
}

function handlePartySync(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

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
  }

  if (isBuffering) {
    // Tell everyone to pause and show "Waiting for..."
    broadcastToParty(partyId, {
      type: 'party:waiting',
      userId: ws.userId,
      displayName: ws.displayName,
      waiting: true,
    });
  } else {
    // Check if all members are ready
    checkBufferingState(partyId);
  }
}

function checkBufferingState(partyId) {
  const party = watchParties.get(partyId);
  if (!party) return;

  const bufferingMembers = [];
  for (const [uid, m] of party.members) {
    if (m.buffering) {
      bufferingMembers.push({ userId: uid, displayName: m.displayName });
    }
  }

  if (bufferingMembers.length === 0) {
    // Everyone is ready, resume
    broadcastToParty(partyId, {
      type: 'party:waiting',
      waiting: false,
    });
  } else {
    // Still waiting for someone
    broadcastToParty(partyId, {
      type: 'party:waiting',
      waiting: true,
      userId: bufferingMembers[0].userId,
      displayName: bufferingMembers[0].displayName,
    });
  }
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

  const text = String(msg.text || '').trim().slice(0, 500);
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

function handlePartyVideoChange(ws, msg) {
  const partyId = userPartyMap.get(ws.userId);
  if (!partyId) return;

  const party = watchParties.get(partyId);
  if (!party) return;

  party.videoId = msg.videoId || null;
  party.videoTitle = msg.videoTitle || '';

  broadcastToParty(partyId, {
    type: 'party:video_change',
    videoId: msg.videoId,
    videoTitle: msg.videoTitle,
    fromUserId: ws.userId,
    fromUsername: ws.displayName,
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
