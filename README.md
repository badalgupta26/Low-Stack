# Least Score

A small multiplayer web app recreating the old Least Score card game — bare-bones
UI, room codes, 2–5 players.

## Run it locally

1. Install [Node.js](https://nodejs.org) if you don't have it (v18+).
2. Open a terminal in this folder.
3. Install dependencies (one-time):
   ```
   npm install
   ```
4. Start the server:
   ```
   npm start
   ```
5. Open http://localhost:3000 in your browser.

## Play with friends on the same wifi

1. Find your computer's local IP address (e.g. `192.168.1.23`).
2. Friends on the same wifi open `http://192.168.1.23:3000` on their phones.
3. One person creates a room and shares the 4-letter code; everyone else joins with it.

## Play with friends anywhere (put it online)

Deploy this folder to a host like Railway, Render, or Fly.io (all support
Node.js + WebSockets out of the box). Once deployed you'll get a public URL
you can share the same way.

## Rules implemented

- 5-card starting hand. A = 1, number cards = face value, J/Q/K = 10.
- On your turn: discard a valid group, then pick one card — either from the
  pile the previous player just discarded, or from the closed deck.
- Valid discard groups: single card, pair, two pairs / four of a kind,
  3-card same-suit run, 5-card same-suit run, 5-card flush.
- Three of a kind (same rank, not a run) cannot be discarded as a group.
- Ace can complete A-2-3 or Q-K-A, but not K-A-2.
- Declare when you think your hand score is lowest:
  - Correct: you score 0, everyone else takes (their score − yours).
  - Incorrect: you take a 20-point penalty plus the gap to the real lowest
    score; everyone else takes their own hand score.
- Players are eliminated once their running total reaches the chosen
  threshold (25 / 50 / 100). Game ends when one player remains.

## Notes

- Game state lives in server memory — if the server restarts, active rooms
  are lost. Fine for casual games with friends; let me know if you want
  persistence added before you rely on it for something bigger.
