// ---------------------------------------------------------------------------
// Least Score - game engine
// Rules implemented per the published Least Score rules:
//  - 5 card starting hand
//  - A = 1, number cards = face value, J/Q/K = 10
//  - On a turn: discard a valid group, then pick 1 card (from the pile the
//    previous player just discarded, or from the closed deck)
//  - Valid discard groups: single card, pair (2 same rank), 3-card sequence,
//    5-card sequence, or 5-card same-suit flush
//  - 3-of-a-kind (same rank, different suit, not a run) is NOT a valid group
//  - Ace can complete A-2-3 or Q-K-A, but not K-A-2
//  - Declare: if your hand score is the lowest, you score 0 and everyone
//    else takes (their score - yours). If you're wrong, you take a 20 point
//    penalty plus the difference to the real lowest score; everyone else
//    just takes their own hand score.
//  - Players are eliminated once their cumulative score reaches the chosen
//    threshold (25 / 50 / 100).
// ---------------------------------------------------------------------------

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function cardValue(rank) {
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: suit + rank, suit, rank, value: cardValue(rank) });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// normal order A=1..K=13, alt order used for Q-K-A style runs (A=14)
const NORMAL_ORDER = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13 };

// A run only needs consecutive ranks with no duplicates — suits can be mixed.
// (Q-K-A and A-2-3 both count; K-A-2 does not, since neither ordering of A lines up.)
function isConsecutiveRun(cards) {
  const tryOrder = (aValue) => {
    const vals = cards
      .map(c => (c.rank === 'A' ? aValue : NORMAL_ORDER[c.rank]))
      .sort((a, b) => a - b);
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] - vals[i - 1] !== 1) return false;
    }
    // no duplicate ranks in a run
    return new Set(vals).size === vals.length;
  };

  return tryOrder(1) || tryOrder(14);
}

// Validates a proposed discard group. Returns { valid, type, reason }
function validateGroup(cards) {
  if (!cards || cards.length === 0) return { valid: false, reason: 'Select at least one card.' };

  if (cards.length === 1) {
    return { valid: true, type: 'single' };
  }

  if (cards.length === 2) {
    if (cards[0].rank === cards[1].rank) return { valid: true, type: 'pair' };
    return { valid: false, reason: 'Two cards must be a pair (same rank).' };
  }

  if (cards.length === 3) {
    // explicitly block 3-of-a-kind (same rank, not a run)
    const allSameRank = cards.every(c => c.rank === cards[0].rank);
    if (allSameRank) return { valid: false, reason: 'Three of a kind cannot be discarded as a group.' };
    if (isConsecutiveRun(cards)) return { valid: true, type: 'run3' };
    return { valid: false, reason: 'Three cards must be a sequence (e.g. 2-3-4), any suits.' };
  }

  if (cards.length === 4) {
    return { valid: false, reason: 'Four cards is not a valid group. Use a pair (2), a sequence (3 or 5), or a flush (5).' };
  }

  if (cards.length === 5) {
    const allSameSuit = cards.every(c => c.suit === cards[0].suit);
    if (allSameSuit) return { valid: true, type: 'flush5' };
    if (isConsecutiveRun(cards)) return { valid: true, type: 'run5' };
    return { valid: false, reason: 'Five cards must be a same-suit flush, or a sequence (any suits).' };
  }

  return { valid: false, reason: 'Invalid number of cards selected.' };
}

function handScore(hand) {
  return hand.reduce((sum, c) => sum + c.value, 0);
}

module.exports = { buildDeck, shuffle, validateGroup, handScore, cardValue };
