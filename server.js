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
const EMPTY_ROOM_GRACE_MS = 10 * 60 * 1000; // keep an empty/all-disconnected room alive for 10 minutes

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
    playerLimit: room.playerLimit,
    deckCount: room.deck.length,
    openPile: room.openPile,
    currentPlayerId: currentPlayer ? currentPlayer.id : null,
    canDeclare: currentPlayer ? canPlayerDeclare(room, currentPlayer) : false,
    turnDeadline: room.turnDeadline || null,
    roundOverDeadline: room.roundOverDeadline || null,
    movesPlayed: room.movesPlayed,
    roundNumber: room.roundNumber,
    hostId: room.hostId,
    players: room.players.map(publicPlayer),
    myHand: me ? me.hand : [],
    myId: playerId,
    lastMoves: room.lastMoves,
    lastRoundResult: room.lastRoundResult,
    pendingKick: publicPendingKick(room),
  };
}

function canPlayerDeclare(room, player) {
  const active = activePlayers(room);
  const everyoneHasMoved = active.every(p => room.playersMovedThisRound && room.playersMovedThisRound.has(p.id));
  return everyoneHasMoved;
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
  room.playersMovedThisRound = new Set();
  clearRoundOverTimer(room);

  for (const p of activePlayers(room)) {
    p.hand = room.deck.splice(0, 5);
    p.hasPlayedThisRound = false;
  }
  // clear out any eliminated/inactive players' old hand so their screen
  // doesn't keep showing stale cards from a round they're no longer in
  for (const p of room.players) {
    if (!p.active) p.hand = [];
  }
  // place one random card face-up on the table so the first player has an
  // open-pile option in addition to the closed deck
  if (room.deck.length > 0) {
    room.openPile = room.deck.splice(0, 1);
    room.openPileOwnerId = null;
  }
  // rotate who starts each round among the currently active players
  const active = activePlayers(room);
  room.roundStartPos = ((room.roundStartPos || 0) % active.length + active.length) % active.length;
  const starter = active[room.roundStartPos];
  room.currentIndex = room.players.findIndex(p => p.id === starter.id);
  room.roundStartPos = (room.roundStartPos + 1) % active.length;

  room.phase = 'playing';
  startTurnTimer(room);
}

function clearRoundOverTimer(room) {
  if (room.roundOverTimeoutHandle) {
    clearTimeout(room.roundOverTimeoutHandle);
    room.roundOverTimeoutHandle = null;
  }
  room.roundOverDeadline = null;
}

const ROUND_OVER_AUTO_SECONDS = 10;

function startRoundOverTimer(room) {
  clearRoundOverTimer(room);
  room.roundOverDeadline = Date.now() + ROUND_OVER_AUTO_SECONDS * 1000;
  room.roundOverTimeoutHandle = setTimeout(() => {
    if (room.phase !== 'roundOver') return;
    room.roundNumber += 1;
    dealNewRound(room);
    broadcastState(room);
  }, ROUND_OVER_AUTO_SECONDS * 1000);
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
  let pickedCard, pickedSource;
  if (room.deck.length > 0) {
    pickedCard = room.deck.pop();
    pickedSource = 'deck';
  } else if (oldOpenPile && oldOpenPile.length > 0) {
    pickedCard = oldOpenPile[0];
    pickedSource = 'open';
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
  room.playersMovedThisRound.add(player.id);

  room.openPile = [lowest];
  room.openPileOwnerId = player.id;
  room.lastMoves[player.id] = { discarded: [lowest], picked: pickedCard, pickedSource, autoPlayed: true };
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

const KICK_VOTE_SECONDS = 30;

// Notifies the removed player directly, disconnects their socket from the
// room, and — if the game is in progress — advances the turn / checks for
// game-over the same way an elimination would.
function performKick(room, targetPlayerId) {
  const target = room.players.find(p => p.id === targetPlayerId);
  if (!target) return;

  const notifyAndDisconnect = () => {
    if (target.socketId) {
      io.to(target.socketId).emit('kicked');
      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket) targetSocket.leave(room.code);
    }
    target.socketId = null;
    target.connected = false;
  };

  if (room.phase === 'lobby') {
    notifyAndDisconnect();
    room.players = room.players.filter(p => p.id !== targetPlayerId);
    // host migration in case the target happened to be host in the lobby
    if (room.hostId === targetPlayerId) {
      const nextHost = room.players.find(p => p.connected) || room.players[0];
      if (nextHost) room.hostId = nextHost.id;
    }
    return;
  }

  if (!target.active) return; // already out

  const wasCurrent = room.phase === 'playing' && room.players[room.currentIndex] && room.players[room.currentIndex].id === targetPlayerId;
  const wasHost = room.hostId === targetPlayerId;
  target.active = false;
  notifyAndDisconnect();

  if (wasHost) {
    const nextHost = room.players.find(p => p.connected && p.active && p.id !== targetPlayerId) || room.players.find(p => p.connected && p.id !== targetPlayerId);
    if (nextHost) room.hostId = nextHost.id;
  }

  const stillActive = activePlayers(room);
  if (stillActive.length <= 1 && (room.phase === 'playing' || room.phase === 'roundOver')) {
    clearTurnTimer(room);
    clearRoundOverTimer(room);
    room.phase = 'gameOver';
    if (!room.lastRoundResult) {
      room.lastRoundResult = { declarerId: null, declarerName: null, correct: null, results: [], roundWinnerName: null, roundLoserName: null, eliminated: [] };
    }
    room.lastRoundResult.eliminated = (room.lastRoundResult.eliminated || []).concat([{ id: target.id, name: target.name, cumulative: target.cumulative }]);
    room.lastRoundResult.gameWinnerName = stillActive.length === 1 ? stillActive[0].name : null;
  } else if (wasCurrent) {
    room.currentIndex = nextActiveIndex(room, room.currentIndex);
    startTurnTimer(room);
  }
}

function clearPendingKickTimer(room) {
  if (room.pendingKick && room.pendingKick.timeoutHandle) {
    clearTimeout(room.pendingKick.timeoutHandle);
  }
}

function cancelPendingKick(room) {
  clearPendingKickTimer(room);
  room.pendingKick = null;
}

function publicPendingKick(room) {
  if (!room.pendingKick) return null;
  const { targetId, targetName, initiatorId, initiatorName, requiredVoterIds, votes, deadline } = room.pendingKick;
  return { targetId, targetName, initiatorId, initiatorName, requiredVoterIds, votes, deadline };
}

io.on('connection', socket => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.on('createRoom', ({ name, maxScore, turnTimerSeconds, playerLimit }, cb) => {
    try {
      const code = genCode();
      const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
      const room = {
        code,
        maxScore: [25, 50, 100].includes(Number(maxScore)) ? Number(maxScore) : 100,
        turnTimerSeconds: [30, 60].includes(Number(turnTimerSeconds)) ? Number(turnTimerSeconds) : null,
        playerLimit: [2, 3, 4, 5].includes(Number(playerLimit)) ? Number(playerLimit) : MAX_PLAYERS,
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
        playersMovedThisRound: new Set(),
        roundStartPos: 0,
        roundOverDeadline: null,
        roundOverTimeoutHandle: null,
        emptyRoomTimeoutHandle: null,
        pendingKick: null,
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
    const trimmedName = (name || 'Player').trim().slice(0, 16);

    if (room.phase !== 'lobby') {
      // Game already started — try to resume a disconnected player with a
      // matching name instead of flatly rejecting. This is what lets someone
      // get back into an in-progress game from any device using just the
      // room code and the name they originally joined with.
      const match = room.players.find(
        p => !p.connected && p.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (match) {
        match.socketId = socket.id;
        match.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = match.id;
        if (room.emptyRoomTimeoutHandle) {
          clearTimeout(room.emptyRoomTimeoutHandle);
          room.emptyRoomTimeoutHandle = null;
        }
        cb({ ok: true, code: room.code, playerId: match.id });
        broadcastState(room);
        return;
      }
      return cb({
        ok: false,
        error: 'Game already in progress. Use the exact name you joined with to resume, or wait for the next round.',
      });
    }

    if (room.players.length >= room.playerLimit) return cb({ ok: false, error: `Room is full (max ${room.playerLimit} players).` });

    const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
    room.players.push({ id: playerId, name: trimmedName, socketId: socket.id, connected: true, hand: [], cumulative: 0, active: true, hasPlayedThisRound: false });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    if (room.emptyRoomTimeoutHandle) {
      clearTimeout(room.emptyRoomTimeoutHandle);
      room.emptyRoomTimeoutHandle = null;
    }
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
    if (room.emptyRoomTimeoutHandle) {
      clearTimeout(room.emptyRoomTimeoutHandle);
      room.emptyRoomTimeoutHandle = null;
    }
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
    room.lastMoves[player.id] = { discarded: discardCards, picked: pickedCard, pickedSource: (pick && pick.source === 'open') ? 'open' : 'deck' };
    room.movesPlayed += 1;
    player.hasPlayedThisRound = true;
    room.playersMovedThisRound.add(player.id);

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
    if (!canPlayerDeclare(room, player)) {
      socket.emit('errorMsg', 'You cannot declare until every player has taken at least one turn this round.');
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
      // roundScore is the actual points this round added to each player's
      // total (roundAdd) — NOT their raw hand value. The "Total" column and
      // its rank still sort by cumulative game total, which is correct for
      // overall standings.
      .map(p => ({ id: p.id, name: p.name, roundScore: roundAdd[p.id], cumulative: p.cumulative, hand: p.hand.map(c => ({ rank: c.rank, suit: c.suit, value: c.value })) }))
      .sort((a, b) => a.cumulative - b.cumulative)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // The round's winner/loser must be based on how each player did THIS
    // round (roundScore), not on the overall cumulative standings — otherwise
    // whoever's been leading the whole game keeps getting shown as "round
    // winner" even in rounds they didn't actually win.
    const byRoundScore = [...rankSorted].sort((a, b) => a.roundScore - b.roundScore);
    const roundWinner = byRoundScore[0] || null;
    const roundLoser = byRoundScore[byRoundScore.length - 1] || null;
    const eliminatedThisRound = active.filter(p => !p.active).map(p => ({ id: p.id, name: p.name, cumulative: p.cumulative }));

    room.lastRoundResult = {
      declarerId: player.id,
      declarerName: player.name,
      correct,
      results: rankSorted,
      roundWinnerName: roundWinner ? roundWinner.name : null,
      roundLoserName: roundLoser && roundLoser.id !== (roundWinner && roundWinner.id) ? roundLoser.name : null,
      eliminated: eliminatedThisRound,
    };

    if (stillActive.length <= 1) {
      room.phase = 'gameOver';
      room.lastRoundResult.gameWinnerName = stillActive.length === 1 ? stillActive[0].name : null;
    } else {
      room.phase = 'roundOver';
      startRoundOverTimer(room);
    }
    broadcastState(room);
  });

  socket.on('newRound', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.phase !== 'roundOver') return;
    clearRoundOverTimer(room);
    room.roundNumber += 1;
    dealNewRound(room);
    broadcastState(room);
  });

  socket.on('requestKick', ({ targetPlayerId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const initiator = room.players.find(p => p.id === socket.data.playerId);
    if (!initiator) return;
    if (targetPlayerId === initiator.id) {
      socket.emit('errorMsg', "You can't kick yourself.");
      return;
    }
    const target = room.players.find(p => p.id === targetPlayerId);
    if (!target || (room.phase !== 'lobby' && !target.active)) return;
    if (room.pendingKick) {
      socket.emit('errorMsg', 'A kick vote is already in progress.');
      return;
    }

    // Everyone currently connected (in the lobby) or connected-and-active
    // (mid-game) other than the initiator and the target must agree.
    const eligible = room.players.filter(p => {
      if (p.id === initiator.id || p.id === targetPlayerId) return false;
      if (room.phase === 'lobby') return p.connected;
      return p.connected && p.active;
    });

    if (eligible.length === 0) {
      // nobody else needs to weigh in — just do it
      performKick(room, targetPlayerId);
      broadcastState(room);
      return;
    }

    room.pendingKick = {
      targetId: target.id,
      targetName: target.name,
      initiatorId: initiator.id,
      initiatorName: initiator.name,
      requiredVoterIds: eligible.map(p => p.id),
      votes: { [initiator.id]: true },
      deadline: Date.now() + KICK_VOTE_SECONDS * 1000,
      timeoutHandle: null,
    };
    room.pendingKick.timeoutHandle = setTimeout(() => {
      if (room.pendingKick && room.pendingKick.targetId === target.id) {
        cancelPendingKick(room);
        broadcastState(room);
      }
    }, KICK_VOTE_SECONDS * 1000);

    broadcastState(room);
  });

  socket.on('kickVote', ({ approve }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pendingKick) return;
    const voterId = socket.data.playerId;
    if (!room.pendingKick.requiredVoterIds.includes(voterId)) return;
    if (voterId in room.pendingKick.votes) return; // already voted

    if (!approve) {
      cancelPendingKick(room);
      broadcastState(room);
      return;
    }

    room.pendingKick.votes[voterId] = true;
    const allIn = room.pendingKick.requiredVoterIds.every(id => room.pendingKick.votes[id]);
    if (allIn) {
      const targetId = room.pendingKick.targetId;
      cancelPendingKick(room);
      performKick(room, targetId);
    }
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

    // If the disconnecting player was the host, hand hosting duties to
    // another connected player so the game isn't stuck waiting on someone
    // who's gone. Without this, only the original host could start rounds
    // or resolve kicks, and the whole room would freeze if they vanished.
    if (player && player.id === room.hostId) {
      const nextHost =
        room.players.find(p => p.connected && p.active && p.id !== player.id) ||
        room.players.find(p => p.connected && p.id !== player.id);
      if (nextHost) room.hostId = nextHost.id;
    }

    // If there's a kick vote in progress and the disconnecting player was a
    // required voter (or the target), resolve/cancel it rather than leaving
    // it stuck forever.
    if (room.pendingKick) {
      if (player && room.pendingKick.targetId === player.id) {
        cancelPendingKick(room);
      } else if (player && room.pendingKick.requiredVoterIds.includes(player.id) && !(player.id in room.pendingKick.votes)) {
        cancelPendingKick(room);
      }
    }

    // keep an empty/fully-disconnected room around for a grace period instead
    // of deleting it instantly, so a brief refresh or a host closing one tab
    // doesn't wipe out the room code for everyone else.
    if (room.players.every(p => !p.connected)) {
      if (room.emptyRoomTimeoutHandle) clearTimeout(room.emptyRoomTimeoutHandle);
      room.emptyRoomTimeoutHandle = setTimeout(() => {
        const r = rooms[room.code];
        if (r && r.players.every(p => !p.connected)) {
          clearTurnTimer(r);
          clearRoundOverTimer(r);
          delete rooms[r.code];
        }
      }, EMPTY_ROOM_GRACE_MS);
    } else {
      broadcastState(room);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Least Score server running on http://localhost:${PORT}`);
});
