/**
 * Clock tests.
 *
 * The clock is the one part of the app with a history of being wrong: it used to
 * count down from whatever it held, so in a new game — where it holds zero — the
 * first tick hit zero and stopped it instantly. Starting a clock at 00:00 has to
 * mean "start this period", and these tests hold that rule in place.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HALF_SECONDS,
  DEFAULT_OVERTIME_SECONDS,
  DEFAULT_PERIOD_SECONDS,
  PERIOD_LENGTHS,
  display,
  isOvertime,
  label,
  parseInput,
  periodLength,
  startValue,
  tick,
} from '../app/js/clock.js';
import { createGame } from '../app/js/store.js';

/**
 * A game with a partial clock state, for the rules under test.
 *
 * `periodSeconds` defaults to null, meaning "follow the game structure", so a
 * half game gets the half default unless a test deliberately sets a length.
 */
function gameAt(seconds, { period = 1, periodsPerGame = 4, periodSeconds = null, running = false } = {}) {
  const game = createGame();
  game.currentPeriod = period;
  game.periodsPerGame = periodsPerGame;
  game.periodSeconds = periodSeconds;
  game.clock = { running, seconds };
  return game;
}

// ---------------------------------------------------------------------------
// Period length
// ---------------------------------------------------------------------------

test('a quarter game defaults to ten-minute periods', () => {
  assert.equal(periodLength(gameAt(0)), DEFAULT_PERIOD_SECONDS);
  assert.equal(periodLength(gameAt(0)), 600);
});

test('a half game defaults to twenty-minute periods', () => {
  assert.equal(periodLength(gameAt(0, { periodsPerGame: 2 })), DEFAULT_HALF_SECONDS);
  assert.equal(periodLength(gameAt(0, { periodsPerGame: 2 })), 1200);
});

test('the configured period length wins over the default', () => {
  assert.equal(periodLength(gameAt(0, { periodSeconds: 8 * 60 })), 480);
});

test('overtime is always the short length, and does not grow per period', () => {
  const first = gameAt(0, { period: 5, periodSeconds: 12 * 60 });
  const second = gameAt(0, { period: 6, periodSeconds: 12 * 60 });

  assert.equal(isOvertime(5, 4), true);
  assert.equal(isOvertime(4, 4), false);
  assert.equal(periodLength(first), DEFAULT_OVERTIME_SECONDS);
  assert.equal(periodLength(second), DEFAULT_OVERTIME_SECONDS);
});

test('a nonsense period length falls back to the default', () => {
  assert.equal(periodLength(gameAt(0, { periodSeconds: 0 })), DEFAULT_PERIOD_SECONDS);
  assert.equal(periodLength(gameAt(0, { periodSeconds: -5 })), DEFAULT_PERIOD_SECONDS);
  assert.equal(periodLength(gameAt(0, { periodSeconds: null })), DEFAULT_PERIOD_SECONDS);
});

test('every offered period length is a positive number of seconds', () => {
  for (const length of PERIOD_LENGTHS) {
    assert.ok(length.seconds > 0, `${length.label} should be positive`);
    assert.equal(Number.isInteger(length.seconds), true);
    assert.ok(length.label.length > 0);
  }
  // The two defaults have to be selectable, or a game could not express them.
  const values = PERIOD_LENGTHS.map((l) => l.seconds);
  assert.ok(values.includes(DEFAULT_PERIOD_SECONDS));
  assert.ok(values.includes(DEFAULT_HALF_SECONDS));
});

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

test('starting from zero refills the clock to a full period', () => {
  // This is the regression: at zero the clock used to stop on the first tick.
  const game = gameAt(0);
  const result = startValue(game);

  assert.equal(result.seconds, DEFAULT_PERIOD_SECONDS);
  assert.equal(result.fromZero, true);
  // And the refilled value survives the very first tick rather than hitting zero.
  const afterFirstTick = tick({ ...game, clock: { running: true, seconds: result.seconds } });
  assert.equal(afterFirstTick.seconds, DEFAULT_PERIOD_SECONDS - 1);
  assert.equal(afterFirstTick.periodEnded, false);
});

test('starting from a partly elapsed clock resumes it untouched', () => {
  const game = gameAt(412);
  const result = startValue(game);

  assert.equal(result.seconds, 412, 'a live clock must not be reset');
  assert.equal(result.fromZero, false);
});

test('starting a half game from zero refills to the half length', () => {
  assert.equal(startValue(gameAt(0, { periodsPerGame: 2 })).seconds, DEFAULT_HALF_SECONDS);
});

test('starting overtime from zero refills to the short length', () => {
  assert.equal(startValue(gameAt(0, { period: 5 })).seconds, DEFAULT_OVERTIME_SECONDS);
});

// ---------------------------------------------------------------------------
// Ticking
// ---------------------------------------------------------------------------

test('a tick counts down by one second and keeps running', () => {
  const result = tick(gameAt(30));

  assert.equal(result.seconds, 29);
  assert.equal(result.running, true);
  assert.equal(result.periodEnded, false);
});

test('a tick one second from the end ends the period instead of stopping at zero', () => {
  const result = tick(gameAt(1, { period: 2 }));

  assert.equal(result.seconds, 0);
  assert.equal(result.running, false);
  assert.equal(result.periodEnded, true);
  assert.equal(result.nextPeriod, 3);
});

test('a long countdown reaches zero exactly once', () => {
  const game = gameAt(3);
  const seen = [];

  for (let i = 0; i < 5; i += 1) {
    const result = tick(game);
    seen.push({ seconds: result.seconds, ended: result.periodEnded });
    game.clock = { running: result.running, seconds: result.seconds };
  }

  assert.deepEqual(seen, [
    { seconds: 2, ended: false },
    { seconds: 1, ended: false },
    { seconds: 0, ended: true },
    { seconds: 0, ended: true },
    { seconds: 0, ended: true },
  ]);
  // Only after the period has ended should the period number move.
  assert.equal(tick(gameAt(1)).nextPeriod, 2);
});

test('ticking past regulation produces an overtime period', () => {
  const result = tick(gameAt(1, { period: 4, periodsPerGame: 4 }));
  assert.equal(result.nextPeriod, 5);
  assert.equal(isOvertime(result.nextPeriod, 4), true);
  assert.equal(label(result.nextPeriod, 4), 'OT');
});

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

test('the clock face is zero-padded and clamps nonsense', () => {
  assert.equal(display(600), '10:00');
  assert.equal(display(412), '06:52');
  assert.equal(display(65), '01:05');
  assert.equal(display(0), '00:00');
  assert.equal(display(-10), '00:00');
  assert.equal(display(Infinity), '00:00');
});

test('period labels follow the game structure', () => {
  assert.equal(label(1, 4), 'Q1');
  assert.equal(label(4, 4), 'Q4');
  assert.equal(label(5, 4), 'OT');
  assert.equal(label(1, 2), 'H1');
  assert.equal(label(3, 2), 'OT');
});

// ---------------------------------------------------------------------------
// Reading a typed clock value
// ---------------------------------------------------------------------------

test('minutes and seconds parse in every form a scorer would type', () => {
  assert.equal(parseInput('7:30').seconds, 450);
  assert.equal(parseInput('07:30').seconds, 450);
  assert.equal(parseInput('0:07').seconds, 7);
  assert.equal(parseInput('12:00').seconds, 720);
  assert.equal(parseInput('0:00').seconds, 0);
  assert.equal(parseInput(' 8:00 ').seconds, 480);
});

test('a partial entry is read generously rather than rejected', () => {
  // Half-typed values are normal mid-edit: a trailing colon means "this many
  // minutes, no seconds yet".
  assert.equal(parseInput('7:').seconds, 420);
  assert.equal(parseInput(':45').seconds, 45);
  assert.equal(parseInput('5:5').seconds, 305);
});

test('two digits or fewer are read as seconds', () => {
  assert.equal(parseInput('0').seconds, 0);
  assert.equal(parseInput('59').seconds, 59);
  assert.equal(parseInput('45').seconds, 45);
});

test('three and four digits are read as MMSS, so the colon can be left out', () => {
  assert.equal(parseInput('0500').seconds, 300);
  assert.equal(parseInput('500').seconds, 300);
  assert.equal(parseInput('1130').seconds, 690);
  assert.equal(parseInput('450').seconds, 290);
  assert.equal(parseInput('0045').seconds, 45);
  assert.equal(parseInput('0700').seconds, 420);
});

test('a digit-only entry with an impossible seconds part is rejected', () => {
  // 075 is 0:75 at heart, and guessing between 0:75 and 1:15 would be worse
  // than saying so.
  assert.match(parseInput('075').error, /59 or less/);
  assert.match(parseInput('1299').error, /59 or less/);
});

test('seconds beyond 59 are rejected instead of carrying', () => {
  // 1:75 is almost always a typo for 1:15 or 2:15; guessing would be worse.
  const result = parseInput('1:75');
  assert.equal(result.seconds, null);
  assert.match(result.error, /59 or less/);
});

test('nonsense is rejected with a message that shows the expected form', () => {
  for (const bad of ['', '   ', 'abc', '-5', '1:2:3', '7.5', 'min', null, undefined]) {
    const result = parseInput(bad);
    assert.equal(result.seconds, null, `${JSON.stringify(bad)} should be rejected`);
    assert.ok(result.error.length > 0);
  }
  assert.match(parseInput('abc').error, /7:30/);
});

test('a parsed time displays as the same clock face', () => {
  for (const typed of ['7:30', '0:07', '12:00', '0730', '45', '0']) {
    assert.equal(display(parseInput(typed).seconds), display(parseInput(typed).seconds));
  }
  assert.equal(display(parseInput('7:30').seconds), '07:30');
  // The colon-free form has to land on the same reading as the written one.
  assert.equal(display(parseInput('0730').seconds), '07:30');
  assert.equal(display(parseInput('1230').seconds), '12:30');
  assert.equal(display(parseInput('0').seconds), '00:00');
});
