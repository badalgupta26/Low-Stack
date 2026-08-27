const socket = io();

let myId = null;
let roomCode = null;
let latestState = null;
let selectedHandIds = new Set();
let selectedPick = null; // { source: 'deck' } or { source: 'open', cardId }

const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  over: document.getElementById('screen-over'),
};

function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
}

function suitChar(suit) {
  return { S: '♠', H: '♥', D: '♦', C: '♣' }[suit];
}
function suitColor(suit) {
  return suit === 'H' || suit === 'D' ? 'red' : 'black';
}

function cardEl(card, { selectable = false, selected = false, disabled = false, onClick = null } = {}) {
  const el = document.createElement('div');
  el.className = `card ${suitColor(card.suit)}${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}`;
  el.innerHTML = `<div>${card.rank}</div><div>${suitChar(card.suit)}</div>`;
  if (selectable && !disabled && onClick) el.addEventListener('click', onClick);
  return el;
}

// ---------- persistence for refresh / rejoin ----------
function saveSession() {
  if (roomCode && myId) {
    sessionStorage.setItem('ls_code', roomCode);
    sessionStorage.setItem('ls_pid', myId);
  }
}
function clearSession() {
  sessionStorage.removeItem('ls_code');
  sessionStorage.removeItem('ls_pid');
}

// ---------- GOOGLE SIGN-IN ----------
// Replace this with your own Client ID from Google Cloud Console.
const GOOGLE_CLIENT_ID = '1052396653922-601rbgj96os9856f5spaphosvee8g1a2.apps.googleusercontent.com';

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = decodeURIComponent(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function handleGoogleCredential(response) {
  const data = decodeJwt(response.credential);
  if (!data) return;
  const profile = { name: data.name, picture: data.picture };
  localStorage.setItem('ls_google_profile', JSON.stringify(profile));
  applyGoogleProfile(profile);
}
window.handleGoogleCredential = handleGoogleCredential;

function applyGoogleProfile(profile) {
  const nameInput = document.getElementById('input-name');
  if (nameInput && !nameInput.value) nameInput.value = profile.name.slice(0, 16);
  const qjInput = document.getElementById('qj-name');
  if (qjInput && !qjInput.value) qjInput.value = profile.name.slice(0, 16);
  renderGoogleBadge('google-badge', profile);
  renderGoogleBadge('google-badge-qj', profile);
}

function renderGoogleBadge(elementId, profile) {
  const badge = document.getElementById(elementId);
  if (!badge) return;
  badge.innerHTML = `
    <img src="${profile.picture}" alt="" class="google-avatar" />
    <span>Signed in as ${escapeHtml(profile.name)}</span>
    <a href="#" class="google-signout">Not you?</a>
  `;
  badge.classList.remove('hidden');
  const signinBtn = document.getElementById('google-signin-btn');
  if (signinBtn) signinBtn.classList.add('hidden');
  badge.querySelector('.google-signout').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem('ls_google_profile');
    document.querySelectorAll('.google-badge').forEach((b) => b.classList.add('hidden'));
    if (signinBtn) signinBtn.classList.remove('hidden');
    if (document.getElementById('input-name')) document.getElementById('input-name').value = '';
    if (document.getElementById('qj-name')) document.getElementById('qj-name').value = '';
  });
}

function initGoogleSignIn() {
  const cached = localStorage.getItem('ls_google_profile');
  if (cached) {
    try { applyGoogleProfile(JSON.parse(cached)); } catch (e) { /* ignore */ }
  }
  if (GOOGLE_CLIENT_ID.startsWith('YOUR_')) return; // not configured yet
  if (!window.google || !google.accounts || !google.accounts.id) return;

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
    auto_select: true,
  });
  const btnContainer = document.getElementById('google-signin-btn');
  if (btnContainer && !cached) {
    google.accounts.id.renderButton(btnContainer, { theme: 'outline', size: 'medium', shape: 'pill' });
  }
}

window.addEventListener('load', () => {
  initGoogleSignIn();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
  }

  const code = sessionStorage.getItem('ls_code');
  const pid = sessionStorage.getItem('ls_pid');
  if (code && pid) {
    socket.emit('rejoin', { code, playerId: pid }, (res) => {
      if (res.ok) {
        roomCode = res.code;
        myId = res.playerId;
      } else {
        clearSession();
        checkQuickJoin();
      }
    });
  } else {
    checkQuickJoin();
  }
});

// ---------- QUICK JOIN (via WhatsApp link with ?room=CODE) ----------
function checkQuickJoin() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = (params.get('room') || '').toUpperCase();
  if (!roomParam) return;
  document.getElementById('normal-home-blocks').classList.add('hidden');
  document.getElementById('quickjoin-block').classList.remove('hidden');
  document.getElementById('qj-code').textContent = roomParam;

  document.getElementById('btn-qj-continue').addEventListener('click', () => {
    const name = document.getElementById('qj-name').value.trim() || 'Player';
    socket.emit('joinRoom', { name, code: roomParam }, (res) => {
      if (!res.ok) {
        document.getElementById('qj-error').textContent = res.error || 'Could not join that room.';
        return;
      }
      roomCode = res.code;
      myId = res.playerId;
      saveSession();
      // clean the URL so a refresh doesn't re-trigger quick join
      window.history.replaceState({}, '', window.location.pathname);
    });
  });
}

// ---------- HOME ----------
document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim() || 'Player';
  const maxScore = document.getElementById('select-maxscore').value;
  const turnTimerSeconds = Number(document.getElementById('select-timer').value) || null;
  const playerLimit = Number(document.getElementById('select-playerlimit').value) || 5;
  socket.emit('createRoom', { name, maxScore, turnTimerSeconds, playerLimit }, (res) => {
    if (!res.ok) return showHomeError(res.error);
    roomCode = res.code;
    myId = res.playerId;
    saveSession();
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim() || 'Player';
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code) return showHomeError('Enter a room code.');
  socket.emit('joinRoom', { name, code }, (res) => {
    if (!res.ok) return showHomeError(res.error);
    roomCode = res.code;
    myId = res.playerId;
    saveSession();
  });
});

function showHomeError(msg) {
  document.getElementById('home-error').textContent = msg || 'Something went wrong.';
}

// ---------- LOBBY ----------
document.getElementById('btn-start').addEventListener('click', () => socket.emit('startGame'));
document.getElementById('btn-leave-lobby').addEventListener('click', (e) => {
  e.preventDefault();
  leaveGame();
});

// ---------- GAME ----------
document.getElementById('btn-refresh').addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
document.getElementById('btn-quit').addEventListener('click', (e) => { e.preventDefault(); leaveGame(); });
document.getElementById('btn-rules').addEventListener('click', (e) => { e.preventDefault(); openRulesModal(); });

// ---------- HOW TO PLAY MODAL ----------
function openRulesModal() {
  document.getElementById('rules-modal').classList.remove('hidden');
}
function closeRulesModal() {
  document.getElementById('rules-modal').classList.add('hidden');
}
document.getElementById('btn-how-to-play').addEventListener('click', (e) => { e.preventDefault(); openRulesModal(); });
document.getElementById('btn-how-to-play-lobby').addEventListener('click', (e) => { e.preventDefault(); openRulesModal(); });
document.getElementById('btn-close-rules').addEventListener('click', (e) => { e.preventDefault(); closeRulesModal(); });
document.getElementById('rules-modal').addEventListener('click', (e) => {
  if (e.target.id === 'rules-modal') closeRulesModal();
});

document.getElementById('btn-move').addEventListener('click', () => {
  clearGameError();
  if (selectedHandIds.size === 0) return setGameError('Select at least one card to discard.');
  if (!selectedPick) return setGameError('Tap the deck or a table card to pick.');
  socket.emit('move', { discardIds: Array.from(selectedHandIds), pick: selectedPick });
  selectedHandIds.clear();
  selectedPick = null;
});

document.getElementById('btn-declare').addEventListener('click', () => {
  clearGameError();
  const ok = window.confirm('Are you sure you want to declare?');
  if (!ok) return;
  socket.emit('declare');
});

// ---------- ROUND / GAME OVER ----------
document.getElementById('btn-newround').addEventListener('click', () => socket.emit('newRound'));
document.getElementById('btn-exit').addEventListener('click', (e) => { e.preventDefault(); leaveGame(); });

function leaveGame() {
  socket.emit('leaveRoom');
  clearSession();
  roomCode = null;
  myId = null;
  latestState = null;
  location.reload();
}

function setGameError(msg) { document.getElementById('game-error').textContent = msg; }
function clearGameError() { document.getElementById('game-error').textContent = ''; }

// ---------- SOCKET STATE HANDLER ----------
socket.on('state', (state) => {
  latestState = state;
  render(state);
});

socket.on('errorMsg', (msg) => {
  if (screens.game.classList.contains('hidden')) {
    showHomeError(msg);
  } else {
    setGameError(msg);
  }
});

socket.on('kicked', () => {
  clearSession();
  roomCode = null;
  myId = null;
  latestState = null;
  for (const k in screens) screens[k].classList.add('hidden');
  document.getElementById('app').innerHTML = `
    <section class="screen">
      <h1>You've been removed</h1>
      <p>The host has kicked you from this game. The rest of the players continue without you.</p>
      <a href="${window.location.pathname}">Back to home</a>
    </section>
  `;
});

function render(state) {
  if (state.phase === 'lobby') {
    renderLobby(state);
    showScreen('lobby');
  } else if (state.phase === 'playing') {
    renderGame(state);
    showScreen('game');
  } else if (state.phase === 'roundOver' || state.phase === 'gameOver') {
    renderOver(state);
    showScreen('over');
  }
}

function renderLobby(state) {
  document.getElementById('lobby-code').textContent = state.code;
  document.getElementById('lobby-limit').textContent = `${state.players.length}/${state.playerLimit}`;

  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${state.code}`;
  const waText = `Join my Low Stack game! Tap this link, enter your name, and you're in: ${joinUrl}`;
  document.getElementById('btn-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(waText)}`;

  const body = document.getElementById('lobby-players');
  body.innerHTML = '';
  const isHost = state.myId === state.hostId;
  state.players.forEach(p => {
    const tr = document.createElement('tr');
    if (p.id === state.myId) tr.classList.add('me');
    const kickCell = (isHost && p.id !== state.myId)
      ? `<td><button class="kick-btn" data-kick="${p.id}">Kick</button></td>`
      : '<td></td>';
    tr.innerHTML = `<td>${escapeHtml(p.name)}${p.id === state.hostId ? ' (host)' : ''}</td><td>${p.connected ? 'Ready' : 'Disconnected'}</td>${kickCell}`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-kick]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!window.confirm('Remove this player from the room?')) return;
      socket.emit('kickPlayer', { targetPlayerId: btn.dataset.kick });
    });
  });
  const startBtn = document.getElementById('btn-start');
  startBtn.classList.toggle('hidden', !isHost);
  startBtn.disabled = state.players.length < 2;
  document.getElementById('lobby-hint').textContent = isHost
    ? (state.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready to start.')
    : 'Waiting for host to start the game…';
}

function renderGame(state) {
  document.getElementById('game-title').textContent = 'Hand in progress';
  document.getElementById('meta-maxscore').textContent = state.maxScore;
  document.getElementById('meta-deck').textContent = state.deckCount;

  const isMyTurn = state.currentPlayerId === state.myId;
  const currentPlayer = state.players.find(p => p.id === state.currentPlayerId);
  document.getElementById('meta-turn').textContent = isMyTurn
    ? 'Your turn'
    : `Current player: ${currentPlayer ? currentPlayer.name : ''}`;

  renderTimer(state);

  // Open pile (table)
  const openWrap = document.getElementById('open-pile');
  openWrap.innerHTML = '';
  if (!state.openPile || state.openPile.length === 0) {
    const none = document.createElement('div');
    none.style.fontSize = '12px';
    none.style.color = '#8a8a90';
    none.textContent = '(empty)';
    openWrap.appendChild(none);
  } else {
    state.openPile.forEach(card => {
      const disabled = !isMyTurn;
      const selected = selectedPick && selectedPick.source === 'open' && selectedPick.cardId === card.id;
      const el = cardEl(card, {
        selectable: true,
        selected,
        disabled,
        onClick: () => {
          if (!isMyTurn) return;
          selectedPick = { source: 'open', cardId: card.id };
          renderGame(latestState);
        },
      });
      openWrap.appendChild(el);
    });
  }

  // Deck
  const deckEl = document.getElementById('deck-card');
  deckEl.classList.toggle('selected', !!(selectedPick && selectedPick.source === 'deck'));
  deckEl.classList.toggle('disabled', !isMyTurn);
  deckEl.onclick = () => {
    if (!isMyTurn) return;
    selectedPick = { source: 'deck' };
    renderGame(latestState);
  };

  // Hand
  const handWrap = document.getElementById('hand-row');
  handWrap.innerHTML = '';
  state.myHand.forEach(card => {
    const selected = selectedHandIds.has(card.id);
    const el = cardEl(card, {
      selectable: true,
      selected,
      disabled: !isMyTurn,
      onClick: () => {
        if (!isMyTurn) return;
        if (selectedHandIds.has(card.id)) selectedHandIds.delete(card.id);
        else selectedHandIds.add(card.id);
        renderGame(latestState);
      },
    });
    handWrap.appendChild(el);
  });

  const myTotal = state.myHand.reduce((sum, c) => sum + c.value, 0);
  document.getElementById('hand-total').textContent = `(Total: ${myTotal})`;

  document.getElementById('btn-move').disabled = !isMyTurn;
  document.getElementById('btn-declare').disabled = !isMyTurn || !state.canDeclare;

  const hintEl = document.getElementById('declare-hint');
  if (isMyTurn && !state.canDeclare) {
    hintEl.textContent = "You can't declare until every player has taken at least one turn this round.";
  } else {
    hintEl.textContent = '';
  }

  // Score table
  const body = document.getElementById('score-body');
  body.innerHTML = '';
  const isHostInGame = state.myId === state.hostId;
  const ranked = state.players
    .map(p => ({ ...p }))
    .sort((a, b) => a.cumulative - b.cumulative);
  state.players.forEach(p => {
    const tr = document.createElement('tr');
    if (p.id === state.myId) tr.classList.add('me');
    if (p.id === state.currentPlayerId) tr.classList.add('turn');
    const lm = state.lastMoves && state.lastMoves[p.id];
    const discardedTxt = lm ? lm.discarded.map(c => c.rank + suitChar(c.suit)).join(' ') : '';
    const pickedTxt = lm ? (lm.pickedSource === 'deck' ? '🂠 deck' : lm.picked.rank + suitChar(lm.picked.suit)) : '';
    const rank = ranked.findIndex(r => r.id === p.id) + 1;
    const kickCell = (isHostInGame && p.id !== state.myId && p.active)
      ? `<td><button class="kick-btn" data-kick="${p.id}">Kick</button></td>`
      : '<td></td>';
    tr.innerHTML = `<td>${escapeHtml(p.name)}${p.active ? '' : ' (out)'}</td><td>${discardedTxt}</td><td>${pickedTxt}</td><td>${p.cumulative}</td><td>${rank}</td>${kickCell}`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-kick]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!window.confirm('Remove this player from the game? They will be treated as eliminated.')) return;
      socket.emit('kickPlayer', { targetPlayerId: btn.dataset.kick });
    });
  });

  document.getElementById('moves-played').textContent = `Moves played: ${state.movesPlayed}`;
  clearGameError();
}

function renderOver(state) {
  const r = state.lastRoundResult;
  document.getElementById('over-title').textContent = state.phase === 'gameOver' ? 'Game over' : 'Round over';

  const declareLineEl = document.getElementById('over-declare-line');
  const summaryEl = document.getElementById('over-summary');
  if (r) {
    declareLineEl.textContent = r.declarerId
      ? `${r.declarerName} declared — ${r.correct ? 'correct!' : 'incorrect declaration (+20 penalty)'}`
      : '';

    const lines = [];
    if (state.phase === 'gameOver' && r.gameWinnerName) {
      lines.push(`🏆 ${r.gameWinnerName} wins the game!`);
    } else {
      if (r.roundWinnerName) lines.push(`Round winner: ${r.roundWinnerName}`);
      if (r.roundLoserName) lines.push(`Round loser: ${r.roundLoserName}`);
    }
    if (r.eliminated && r.eliminated.length > 0) {
      lines.push(`Eliminated: ${r.eliminated.map(e => `${e.name} (${e.cumulative})`).join(', ')}`);
    }
    summaryEl.innerHTML = lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  } else {
    declareLineEl.textContent = '';
    summaryEl.innerHTML = '';
  }

  const body = document.getElementById('over-body');
  body.innerHTML = '';
  if (r) {
    r.results.forEach(row => {
      const tr = document.createElement('tr');
      if (row.id === state.myId) tr.classList.add('me');
      tr.innerHTML = `<td>${escapeHtml(row.name)}</td><td>${row.roundScore}</td><td>${row.cumulative}</td><td>${row.rank}</td>`;
      body.appendChild(tr);
    });
  }

  const isHost = state.myId === state.hostId;
  const newRoundBtn = document.getElementById('btn-newround');
  newRoundBtn.classList.toggle('hidden', !(isHost && state.phase === 'roundOver'));
  if (isHost && state.phase === 'roundOver') newRoundBtn.textContent = 'Start Now';

  renderRoundOverCountdown(state);

  selectedHandIds.clear();
  selectedPick = null;
}

let roundOverInterval = null;

function renderRoundOverCountdown(state) {
  clearInterval(roundOverInterval);
  const el = document.getElementById('over-countdown');
  if (state.phase !== 'roundOver' || !state.roundOverDeadline) {
    el.textContent = '';
    return;
  }
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((state.roundOverDeadline - Date.now()) / 1000));
    el.textContent = `Next round starts automatically in ${remaining}s…`;
    if (remaining <= 0) clearInterval(roundOverInterval);
  };
  tick();
  roundOverInterval = setInterval(tick, 1000);
}

let timerInterval = null;

function renderTimer(state) {
  clearInterval(timerInterval);
  const el = document.getElementById('meta-timer');
  if (!state.turnTimerSeconds || !state.turnDeadline) {
    el.textContent = '';
    return;
  }
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
    el.textContent = `Time left: ${remaining}s`;
    if (remaining <= 0) clearInterval(timerInterval);
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
