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
  updateTeam,
} from '../app/js/store.js';
import { DEFAULT_HALF_SECONDS, DEFAULT_PERIOD_SECONDS } from '../app/js/clock.js';
import { listPeriods, periodScore } from '../app/js/derive.js';

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

test('a serialised game round trips with all settings intact', () => {
  const game = createGame();
  setPeriodsPerGame(game, 2);
  setPeriodSeconds(game, 6 * 60);

  assert.deepEqual(deserialize(serialize(game)), game);
});
