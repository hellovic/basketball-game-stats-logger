/**
 * State-level tests.
 *
 * These cover the game settings that the clock and the scoresheet both depend
 * on, where getting one value wrong quietly affects everything downstream.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addEvent,
  addPlayer,
  createGame,
  copyGameAsNew,
  deserialize,
  loadState,
  playersOf,
  saveState,
  serialize,
  setClock,
  setClockRunning,
  setPeriod,
  setFinished,
  setPeriodSeconds,
  setPeriodsPerGame,
  setTeamPeriodTotal,
  swapSides,
  teamPeriodTotal,
  updateTeam,
} from '../app/js/store.js';
import { DEFAULT_HALF_SECONDS, DEFAULT_PERIOD_SECONDS } from '../app/js/clock.js';
import { listPeriods, periodScore } from '../app/js/derive.js';

test('a typed team total is one entry per period, replaced rather than added', () => {
  const game = createGame();
  const teamId = game.homeTeamId;

  assert.equal(teamPeriodTotal(game, teamId, 1), null, 'nothing typed to begin with');
  assert.equal(
    game.events.filter((e) => e.stat === 'TEAM_TOTAL').length,
    0,
    'and no entry for it',
  );

  setTeamPeriodTotal(game, teamId, 1, 18);
  assert.equal(teamPeriodTotal(game, teamId, 1), 18);
  assert.equal(periodScore(game, teamId, 1), 18, 'the period score follows it');

  // Retyping is the correction: the scorer types the number on the board, so a
  // second number replaces the first rather than adding to it.
  setTeamPeriodTotal(game, teamId, 1, 20);
  assert.equal(teamPeriodTotal(game, teamId, 1), 20);
  assert.equal(periodScore(game, teamId, 1), 20);
  assert.equal(
    game.events.filter((e) => e.stat === 'TEAM_TOTAL').length,
    1,
    'still one entry',
  );

  // Each period keeps its own, and the other team is untouched.
  setTeamPeriodTotal(game, teamId, 2, 9);
  assert.equal(teamPeriodTotal(game, teamId, 2), 9);
  assert.equal(teamPeriodTotal(game, game.awayTeamId, 1), null);
  assert.equal(listPeriods(game).length, 4, 'periods are still the game structure');

  // Clearing takes the entry back out rather than leaving a zero behind.
  setTeamPeriodTotal(game, teamId, 1, 0);
  assert.equal(teamPeriodTotal(game, teamId, 1), null);
  assert.equal(periodScore(game, teamId, 1), 0);
  assert.equal(
    game.events.filter((e) => e.stat === 'TEAM_TOTAL').length,
    1,
    'only the period 2 entry is left',
  );

  setTeamPeriodTotal(game, teamId, 2, '');
  assert.equal(teamPeriodTotal(game, teamId, 2), null, 'a blank box clears it too');
  assert.equal(
    game.events.filter((e) => e.stat === 'TEAM_TOTAL').length,
    0,
    'and takes the entry with it',
  );
});

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

// ---------------------------------------------------------------------------
// Period structure and length
// ---------------------------------------------------------------------------

test('a new game is dated today with the start time left for the scorer', () => {
  const game = createGame();
  assert.match(game.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(game.time, '', 'the start time is asked for, not guessed');
});

test('a save from before the start time existed loads with a blank one', () => {
  const game = createGame();
  delete game.time;

  const restored = deserialize(JSON.stringify({ game }));
  assert.equal(restored.time, '');
});

test('a save from before teams had colours takes the defaults once, by side', () => {
  const game = createGame();
  delete game.teams[game.homeTeamId].color;
  delete game.teams[game.awayTeamId].color;

  const restored = deserialize(JSON.stringify({ game }));

  // From here on the colour is the team's own rather than the side's, so a swap
  // moves the colour with the team instead of repainting both.
  assert.equal(restored.teams[restored.homeTeamId].color, 'blue');
  assert.equal(restored.teams[restored.awayTeamId].color, 'red');

  // A colour already chosen survives the trip.
  const chosen = createGame();
  updateTeam(chosen, chosen.homeTeamId, { color: 'teal' });
  const again = deserialize(JSON.stringify({ game: chosen }));
  assert.equal(again.teams[again.homeTeamId].color, 'teal');
});

test('a quarter game starts with ten-minute periods', () => {
  const game = createGame();
  assert.equal(game.periodsPerGame, 4);
  assert.equal(game.periodSeconds, DEFAULT_PERIOD_SECONDS);
});

test('switching to halves moves the period length with it', () => {
  const game = createGame();
  setPeriodsPerGame(game, 2);

  assert.equal(game.periodsPerGame, 2);
  assert.equal(game.periodSeconds, DEFAULT_HALF_SECONDS, 'a half is not a quarter');
});

test('copying a game as a new one keeps the settings and the sides it is told to', () => {
  const game = createGame({
    date: '2026-02-14',
    time: '19:30',
    venue: 'Northside Gym',
    periodsPerGame: 2,
    periodSeconds: 12 * 60,
  });
  updateTeam(game, game.homeTeamId, { name: 'LCMBA Malaysia', abbreviation: 'LCM', color: 'teal' });
  updateTeam(game, game.awayTeamId, { name: 'A1 Singapore', abbreviation: 'A1', color: 'black' });

  const reed = addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  addPlayer(game, game.awayTeamId, { number: '5', name: 'M. Diaz' });
  addEvent(game, {
    teamId: game.homeTeamId,
    playerId: reed.id,
    stat: '2PT',
    result: 'made',
    period: 1,
    clockSeconds: 540,
  });
  setPeriod(game, 3);
  setClock(game, 411);
  setClockRunning(game, true);

  const next = copyGameAsNew(game, { keepHome: true, keepAway: false });

  // The settings are the night's arrangements, and they carry over.
  assert.equal(next.date, '2026-02-14');
  assert.equal(next.time, '19:30');
  assert.equal(next.venue, 'Northside Gym');
  assert.equal(next.periodsPerGame, 2);
  assert.equal(next.periodSeconds, 12 * 60);

  // The kept side is the same club, on the same side, with the same roster.
  const home = next.teams[next.homeTeamId];
  assert.equal(home.name, 'LCMBA Malaysia');
  assert.equal(home.abbreviation, 'LCM');
  assert.equal(home.color, 'teal', 'the colour belongs to the team');
  assert.deepEqual(
    playersOf(next, next.homeTeamId).map((player) => `${player.number} ${player.name}`),
    ['4 J. Reed'],
  );

  // The side that was not kept starts as the placeholder it always was.
  const away = next.teams[next.awayTeamId];
  assert.equal(away.name, 'Away');
  assert.equal(playersOf(next, next.awayTeamId).length, 0);

  // Nothing that was a fact about the finished game comes with it.
  assert.deepEqual(next.events, []);
  assert.equal(next.currentPeriod, 1);
  assert.deepEqual(next.clock, { running: false, seconds: 0 });

  // New game, new ids: a copied player is not the same entry in a new history.
  assert.notEqual(next.homeTeamId, game.homeTeamId);
  assert.notEqual(playersOf(next, next.homeTeamId)[0].id, reed.id);
});

test('copying a game does not reach back into the one it copies', () => {
  const game = createGame();
  const reed = addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  updateTeam(game, game.homeTeamId, { name: 'Northside' });

  const next = copyGameAsNew(game);

  // The two games share no objects, so editing the new one cannot rewrite the
  // one that has been played.
  updateTeam(next, next.homeTeamId, { name: 'Somewhere Else' });
  addPlayer(next, next.homeTeamId, { number: '9', name: 'A. New' });

  assert.equal(game.teams[game.homeTeamId].name, 'Northside');
  assert.equal(playersOf(game, game.homeTeamId).length, 1);
  assert.equal(playersOf(game, game.homeTeamId)[0].id, reed.id);
});

test('switching back to quarters restores the quarter length', () => {
  const game = createGame();
  setPeriodsPerGame(game, 2);
  setPeriodsPerGame(game, 4);

  assert.equal(game.periodsPerGame, 4);
  assert.equal(game.periodSeconds, DEFAULT_PERIOD_SECONDS);
});

test('a period length the scorer chose is not overwritten by a structure change', () => {
  const game = createGame();
  // 8 minutes is a deliberate choice, not either default.
  setPeriodSeconds(game, 8 * 60);
  setPeriodsPerGame(game, 2);

  assert.equal(game.periodsPerGame, 2);
  assert.equal(game.periodSeconds, 480, 'an explicit length survives');
});

test('the offered lengths survive being used', () => {
  const game = createGame();
  for (const seconds of [6 * 60, 8 * 60, 12 * 60, 20 * 60]) {
    setPeriodSeconds(game, seconds);
    assert.equal(game.periodSeconds, seconds);
  }
});

test('a nonsense period length is refused', () => {
  const game = createGame();
  setPeriodSeconds(game, 480);

  setPeriodSeconds(game, 0);
  assert.equal(game.periodSeconds, 480);
  setPeriodSeconds(game, -60);
  assert.equal(game.periodSeconds, 480);
  setPeriodSeconds(game, 'abc');
  assert.equal(game.periodSeconds, 480);
  setPeriodSeconds(game, Infinity);
  assert.equal(game.periodSeconds, 480);
});

test('an unknown period count falls back to quarters', () => {
  const game = createGame();
  setPeriodsPerGame(game, 7);
  assert.equal(game.periodsPerGame, 4);
});

test('the period count follows the game structure for the scoresheet', () => {
  const game = createGame();
  assert.deepEqual(listPeriods(game), [1, 2, 3, 4]);

  setPeriodsPerGame(game, 2);
  assert.deepEqual(listPeriods(game), [1, 2], 'a half game has two periods');
});

// ---------------------------------------------------------------------------
// Clock state
// ---------------------------------------------------------------------------

test('the clock never goes negative and starting does not fabricate time', () => {
  const game = createGame();

  setClock(game, 90);
  assert.equal(game.clock.seconds, 90);
  setClock(game, -10);
  assert.equal(game.clock.seconds, 0, 'a countdown clamps at zero');

  setClockRunning(game, true);
  assert.equal(game.clock.running, true);
  setClockRunning(game, false);
  assert.equal(game.clock.running, false);
});

test('the period never drops below one', () => {
  const game = createGame();
  setPeriod(game, 3);
  assert.equal(game.currentPeriod, 3);
  setPeriod(game, 0);
  assert.equal(game.currentPeriod, 1);
  setPeriod(game, -5);
  assert.equal(game.currentPeriod, 1);
});

// ---------------------------------------------------------------------------
// Persistence of the new fields
// ---------------------------------------------------------------------------

test('period settings survive a save and load', () => {
  const store = fakeStorage();
  const game = createGame();
  setPeriodsPerGame(game, 2);
  setPeriodSeconds(game, 8 * 60);
  setClock(game, 321);
  setClockRunning(game, true);

  saveState(game, store);
  const loaded = loadState(store);

  assert.equal(loaded.periodsPerGame, 2);
  assert.equal(loaded.periodSeconds, 480);
  assert.equal(loaded.clock.seconds, 321);
  assert.equal(loaded.clock.running, true);
});

test('an older save without a period length gets the right default', () => {
  // A save written before period seconds existed.
  const game = createGame();
  game.periodsPerGame = 2;
  delete game.periodSeconds;

  const restored = deserialize(JSON.stringify({ game }));
  assert.equal(restored.periodSeconds, DEFAULT_HALF_SECONDS, 'a half game gets the half default');
});

test('a save with no clock at all is repaired rather than crashing', () => {
  const game = createGame();
  delete game.clock;
  delete game.periodsPerGame;

  const restored = deserialize(JSON.stringify({ game }));
  assert.deepEqual(restored.clock, { running: false, seconds: 0 });
  assert.equal(restored.periodsPerGame, 4);
  assert.equal(restored.periodSeconds, DEFAULT_PERIOD_SECONDS);
});

// ---------------------------------------------------------------------------
// Scoring is unaffected by the period structure
// ---------------------------------------------------------------------------

test('periods beyond the schedule still score, so overtime works', () => {
  const game = createGame();
  const scorer = addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  updateTeam(game, game.homeTeamId, { name: 'Northside' });

  addEvent(game, {
    teamId: game.homeTeamId,
    playerId: scorer.id,
    stat: '3PT',
    result: 'made',
    period: 5,
  });

  assert.deepEqual(listPeriods(game), [1, 2, 3, 4, 5], 'overtime appears');
  assert.equal(periodScore(game, game.homeTeamId, 5), 3);
  assert.equal(playersOf(game, game.homeTeamId).length, 1);
});

test('a new event records the game clock it was logged against', () => {
  const game = createGame();
  const scorer = addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  game.clock = { running: true, seconds: 132 };

  const { event } = addEvent(game, {
    teamId: game.homeTeamId,
    playerId: scorer.id,
    stat: '2PT',
    result: 'made',
    period: 1,
  });

  assert.equal(
    event.clockSeconds,
    132,
    'the play-by-play reads in game time, so every event needs the clock it was logged at',
  );
});

test('a serialised game round trips with all settings intact', () => {
  const game = createGame();
  setPeriodsPerGame(game, 2);
  setPeriodSeconds(game, 6 * 60);

  assert.deepEqual(deserialize(serialize(game)), game);
});

test('a game starts open, and the stamp that closes it travels with the file', () => {
  const game = createGame();
  assert.equal(game.finishedAt, null, 'a new game is still being played');

  setFinished(game, 1730000000000);
  assert.equal(game.finishedAt, 1730000000000);
  assert.equal(deserialize(serialize(game)).finishedAt, 1730000000000, 'and it survives a round trip');

  setFinished(game, null);
  assert.equal(game.finishedAt, null, 'reopening is the same field, emptied');
});

test('swapping sides moves the teams and not their contents', () => {
  const game = createGame();
  const home = game.homeTeamId;
  const away = game.awayTeamId;

  updateTeam(game, home, { name: 'Northside', abbreviation: 'NOR' });
  updateTeam(game, away, { name: 'Riverside', abbreviation: 'RIV' });
  const player = addPlayer(game, home, { number: '4', name: 'J. Reed' });
  addEvent(game, { teamId: home, playerId: player.id, stat: '2PT', result: 'made' });

  swapSides(game);

  assert.equal(game.homeTeamId, away, 'the two sides exchanged');
  assert.equal(game.awayTeamId, home);
  assert.equal(game.teams[game.homeTeamId].name, 'Riverside');
  assert.equal(game.teams[game.awayTeamId].name, 'Northside');

  // Everything a team owns travels with it, because players and events point at
  // a team id rather than at a side.
  assert.deepEqual(
    playersOf(game, game.awayTeamId).map((p) => p.name),
    ['J. Reed'],
    'the roster moved with its team',
  );
  assert.equal(periodScore(game, game.awayTeamId, 1), 2, 'so did the points');
  assert.equal(periodScore(game, game.homeTeamId, 1), 0);

  // Which makes the swap its own undo.
  swapSides(game);
  assert.equal(game.homeTeamId, home);
  assert.equal(periodScore(game, home, 1), 2);
});
