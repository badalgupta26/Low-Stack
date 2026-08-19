const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { buildDeck, shuffle, validateGroup, handScore } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;

/** rooms[code] = {
 *   code, maxScore, hostId, phase: 'lobby'|'playing'|'roundOver'|'gameOver',
 *   players: [{id, name, socketId, connected, hand:[], cumulative, active}],
 *   deck: [], openPile: [], openPileOwnerId: null, deadPile: [],
 *   currentIndex: 0, movesPlayed: 0, roundNumber: 1,
 *   lastMoves: { [playerId]: {discarded:[], picked:card} },
 *   lastRoundResult: null
 * }
 */
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function activePlayers(room) {
  return room.players.filter(p => p.active);
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    active: p.active,
    cumulative: p.cumulative,
    handCount: p.hand.length,
  };
}

function roomStateFor(room, playerId) {
  const me = room.players.find(p => p.id === playerId);
  const currentPlayer = room.phase === 'playing' ? room.players[room.currentIndex] : null;
  return {
    code: room.code,
    phase: room.phase,
    maxScore: room.maxScore,
    turnTimerSeconds: room.turnTimerSeconds,
    deckCount: room.deck.length,
    openPile: room.openPile,
    currentPlayerId: currentPlayer ? currentPlayer.id : null,
    canDeclare: currentPlayer ? canPlayerDeclare(room, currentPlayer) : false,
    turnDeadline: room.turnDeadline || null,
    movesPlayed: room.movesPlayed,
    roundNumber: room.roundNumber,
    hostId: room.hostId,
    players: room.players.map(publicPlayer),
    myHand: me ? me.hand : [],
    myId: playerId,
    lastMoves: room.lastMoves,
    lastRoundResult: room.lastRoundResult,
  };
}

function canPlayerDeclare(room, player) {
  if (room.roundNumber <= 1) return false; // no declaring in the first round
  if (player.hasPlayedThisRound) return false; // not after you've already played this round
  return true;
}

function broadcastState(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', roomStateFor(room, p.id));
  }
}

function dealNewRound(room) {
  room.deck = shuffle(buildDeck());
  room.openPile = [];
  room.openPileOwnerId = null;
  room.deadPile = [];
  room.movesPlayed = 0;
  room.lastMoves = {};
  room.lastRoundResult = null;

  for (const p of activePlayers(room)) {
    p.hand = room.deck.splice(0, 5);
    p.hasPlayedThisRound = false;
  }
  // first active player starts
  const active = activePlayers(room);
  room.currentIndex = room.players.findIndex(p => p.id === active[0].id);
  room.phase = 'playing';
  startTurnTimer(room);
}

function clearTurnTimer(room) {
  if (room.turnTimeoutHandle) {
    clearTimeout(room.turnTimeoutHandle);
    room.turnTimeoutHandle = null;
  }
  room.turnDeadline = null;
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.turnTimerSeconds) return; // no timer selected for this room
  room.turnDeadline = Date.now() + room.turnTimerSeconds * 1000;
  room.turnTimeoutHandle = setTimeout(() => autoPlayTurn(room), room.turnTimerSeconds * 1000);
}

// If a player runs out of time, auto-discard their lowest single card and
// draw from the closed deck, then move on to the next player.
function autoPlayTurn(room) {
  if (room.phase !== 'playing') return;
  const player = room.players[room.currentIndex];
  if (!player || player.hand.length === 0) return;

  const idx = room.currentIndex;
  const lowest = [...player.hand].sort((a, b) => a.value - b.value)[0];
  const oldOpenPile = room.openPile;

  ensureDeck(room, 1);
  let pickedCard;
  if (room.deck.length > 0) {
    pickedCard = room.deck.pop();
  } else if (oldOpenPile && oldOpenPile.length > 0) {
    pickedCard = oldOpenPile[0];
  } else {
    // nothing to pick, just skip discarding too
    room.currentIndex = nextActiveIndex(room, idx);
    startTurnTimer(room);
    broadcastState(room);
    return;
  }

  if (oldOpenPile && oldOpenPile.length > 0) {
    const rest = oldOpenPile.filter(c => c.id !== pickedCard.id);
    room.deadPile = room.deadPile.concat(rest);
  }

  player.hand = player.hand.filter(c => c.id !== lowest.id);
  player.hand.push(pickedCard);
  player.hasPlayedThisRound = true;

  room.openPile = [lowest];
  room.openPileOwnerId = player.id;
  room.lastMoves[player.id] = { discarded: [lowest], picked: pickedCard, autoPlayed: true };
  room.movesPlayed += 1;

  room.currentIndex = nextActiveIndex(room, idx);
  startTurnTimer(room);
  broadcastState(room);
}

function nextActiveIndex(room, fromIndex) {
  const n = room.players.length;
  let i = fromIndex;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    if (room.players[i].active) return i;
  }
  return fromIndex;
}

function ensureDeck(room, count) {
  if (room.deck.length >= count) return;
  // reshuffle dead pile back into the deck if we run low
  if (room.deadPile.length > 0) {
    room.deck = room.deck.concat(shuffle(room.deadPile));
    room.deadPile = [];
  }
}

io.on('connection', socket => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.on('createRoom', ({ name, maxScore, turnTimerSeconds }, cb) => {
    try {
      const code = genCode();
      const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
      const room = {
        code,
        maxScore: [25, 50, 100].includes(Number(maxScore)) ? Number(maxScore) : 100,
        turnTimerSeconds: [30, 60].includes(Number(turnTimerSeconds)) ? Number(turnTimerSeconds) : null,
        hostId: playerId,
        phase: 'lobby',
        players: [{ id: playerId, name: (name || 'Player').slice(0, 16), socketId: socket.id, connected: true, hand: [], cumulative: 0, active: true, hasPlayedThisRound: false }],
        deck: [],
        openPile: [],
        openPileOwnerId: null,
        deadPile: [],
        currentIndex: 0,
        movesPlayed: 0,
        roundNumber: 1,
        lastMoves: {},
        lastRoundResult: null,
        turnDeadline: null,
        turnTimeoutHandle: null,
      };
      rooms[code] = room;
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = playerId;
      cb({ ok: true, code, playerId });
      broadcastState(room);
    } catch (e) {
      cb({ ok: false, error: 'Could not create room.' });
    }
  });

  socket.on('joinRoom', ({ name, code }, cb) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return cb({ ok: false, error: 'Room not found.' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Game already in progress.' });
    if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: 'Room is full (max 5 players).' });

    const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
    room.players.push({ id: playerId, name: (name || 'Player').slice(0, 16), socketId: socket.id, connected: true, hand: [], cumulative: 0, active: true, hasPlayedThisRound: false });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    cb({ ok: true, code: room.code, playerId });
    broadcastState(room);
  });

  socket.on('rejoin', ({ code, playerId }, cb) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return cb({ ok: false, error: 'Room not found.' });
    const player = room.players.find(p => p.id === playerId);
    if (!player) return cb({ ok: false, error: 'Player not found in room.' });
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    cb({ ok: true, code: room.code, playerId });
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS) {
      socket.emit('errorMsg', 'Need at least 2 players to start.');
      return;
    }
    dealNewRound(room);
    broadcastState(room);
  });

  socket.on('move', ({ discardIds, pick }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== 'playing') return;
    const idx = room.currentIndex;
    const player = room.players[idx];
    if (!player || player.id !== socket.data.playerId) {
      socket.emit('errorMsg', "It's not your turn.");
      return;
    }

    const discardCards = (discardIds || []).map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (discardCards.length !== (discardIds || []).length) {
      socket.emit('errorMsg', 'Invalid card selection.');
      return;
    }
    const check = validateGroup(discardCards);
    if (!check.valid) {
      socket.emit('errorMsg', check.reason || 'Invalid group.');
      return;
    }

    // Resolve the pick BEFORE the new discard replaces the open pile
    let pickedCard = null;
    const oldOpenPile = room.openPile;

    if (pick && pick.source === 'open') {
      if (!oldOpenPile || oldOpenPile.length === 0) {
        socket.emit('errorMsg', 'There is no open pile to pick from yet.');
        return;
      }
      pickedCard = oldOpenPile.find(c => c.id === pick.cardId);
      if (!pickedCard) {
        socket.emit('errorMsg', 'That card is not available to pick.');
        return;
      }
    } else {
      ensureDeck(room, 1);
      if (room.deck.length === 0) {
        socket.emit('errorMsg', 'No cards left to draw.');
        return;
      }
      pickedCard = room.deck.pop();
    }

    // remaining un-picked cards from the old open pile go dead
    if (oldOpenPile && oldOpenPile.length > 0) {
      const rest = oldOpenPile.filter(c => c.id !== pickedCard.id);
      room.deadPile = room.deadPile.concat(rest);
    }

    // remove discarded cards from hand, add picked card
    const discardIdSet = new Set(discardCards.map(c => c.id));
    player.hand = player.hand.filter(c => !discardIdSet.has(c.id));
    player.hand.push(pickedCard);

    room.openPile = discardCards;
    room.openPileOwnerId = player.id;
    room.lastMoves[player.id] = { discarded: discardCards, picked: pickedCard };
    room.movesPlayed += 1;
    player.hasPlayedThisRound = true;

    room.currentIndex = nextActiveIndex(room, idx);
    startTurnTimer(room);
    broadcastState(room);
  });

  socket.on('declare', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== 'playing') return;
    const player = room.players[room.currentIndex];
    if (!player || player.id !== socket.data.playerId) {
      socket.emit('errorMsg', "It's not your turn.");
      return;
    }
    if (room.roundNumber <= 1) {
      socket.emit('errorMsg', 'You cannot declare during the first round.');
      return;
    }
    if (player.hasPlayedThisRound) {
      socket.emit('errorMsg', 'You cannot declare after already playing this round.');
      return;
    }

    clearTurnTimer(room);

    const active = activePlayers(room);
    const scores = {};
    for (const p of active) scores[p.id] = handScore(p.hand);

    const declarerScore = scores[player.id];
    const minScore = Math.min(...Object.values(scores));
    const correct = declarerScore <= minScore;

    // Scoring rules:
    //  - Correct declare: declarer scores 0, everyone else scores
    //    (their hand score - declarer's hand score).
    //  - Incorrect declare: declarer takes a 20 point penalty plus the
    //    gap to the real lowest score; everyone else scores 0 for the round.
    const roundAdd = {};
    if (correct) {
      roundAdd[player.id] = 0;
      for (const p of active) {
        if (p.id === player.id) continue;
        roundAdd[p.id] = Math.max(0, scores[p.id] - declarerScore);
      }
    } else {
      roundAdd[player.id] = 20 + (declarerScore - minScore);
      for (const p of active) {
        if (p.id === player.id) continue;
        roundAdd[p.id] = 0;
      }
    }

    for (const p of active) {
      p.cumulative += roundAdd[p.id];
    }
    for (const p of active) {
      if (p.cumulative >= room.maxScore) p.active = false;
    }

    const stillActive = activePlayers(room);
    const rankSorted = active
      .map(p => ({ id: p.id, name: p.name, roundScore: scores[p.id], cumulative: p.cumulative }))
      .sort((a, b) => a.cumulative - b.cumulative)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    room.lastRoundResult = {
      declarerId: player.id,
      declarerName: player.name,
      correct,
      results: rankSorted,
    };

    if (stillActive.length <= 1) {
      room.phase = 'gameOver';
    } else {
      room.phase = 'roundOver';
    }
    broadcastState(room);
  });

  socket.on('newRound', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.phase !== 'roundOver') return;
    room.roundNumber += 1;
    dealNewRound(room);
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });

  function handleDisconnect(sock) {
    const room = rooms[sock.data.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === sock.data.playerId);
    if (player) {
      player.connected = false;
      player.socketId = null;
    }
    // clean up empty rooms
    if (room.players.every(p => !p.connected)) {
      clearTurnTimer(room);
      delete rooms[room.code];
    } else {
      broadcastState(room);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Least Score server running on http://localhost:${PORT}`);
});
