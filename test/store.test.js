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
  deserialize,
  loadState,
  playersOf,
  saveState,
  serialize,
  setClock,
  setClockRunning,
  setPeriod,
  setPeriodSeconds,
  setPeriodsPerGame,
  setTeamPeriodTotal,
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
