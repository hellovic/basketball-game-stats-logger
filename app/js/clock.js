/**
 * Game clock.
 *
 * The clock is a manual convenience for the scorer, not a scoreboard feed, so
 * the rules are deliberately simple and its state is derived rather than
 * tracked by hand.
 *
 * Two rules matter, and both exist because of a real defect:
 *
 * 1. **The clock refills from the period length when started from zero.** It
 *    used to count down from whatever it held, so in a new game (where it holds
 *    0) the very first tick hit zero and stopped the clock instantly. A clock
 *    reading 00:00 is at an intermission, not mid-period, so starting one means
 *    starting a period.
 * 2. **Reaching zero advances the period.** The scorer is usually still typing
 *    when the period ends, so the clock moving on by itself is one less thing to
 *    notice mid-game.
 *
 * No DOM access, so this is unit tested directly.
 */

import { clock, periodLabel } from './format.js';

/** A quarter, in seconds. */
export const DEFAULT_PERIOD_SECONDS = 10 * 60;

/** A half, in seconds. */
export const DEFAULT_HALF_SECONDS = 20 * 60;

/** Overtime is shorter than regulation and does not grow per period. */
export const DEFAULT_OVERTIME_SECONDS = 5 * 60;

export const PERIOD_LENGTHS = [
  { seconds: 6 * 60, label: '6 minutes' },
  { seconds: 8 * 60, label: '8 minutes' },
  { seconds: DEFAULT_PERIOD_SECONDS, label: '10 minutes' },
  { seconds: 12 * 60, label: '12 minutes' },
  { seconds: DEFAULT_HALF_SECONDS, label: '20 minutes' },
];

/** The clock face. */
export function display(seconds) {
  return clock(seconds);
}

/**
 * Read a typed clock value.
 *
 * Accepts what a scorer would actually type at a table:
 *
 *   7:30, 07:30, :45   minutes and seconds
 *   450                seconds, so a raw count can be typed straight in
 *   0                  zero, meaning "fill this period when started"
 *
 * Anything after the colon is seconds, so "3:1" is three minutes *one* second —
 * the same reading as everywhere else. Write "3:10" for three minutes ten.
 *
 * Returns `{ seconds, error }` and never throws: a typo is a normal thing to
 * type, so it is reported and the previous value is kept.
 */
export function parseInput(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { seconds: null, error: 'Enter a clock time.' };

  const colon = raw.match(/^(\d*):(\d{0,2})$/);
  if (colon) {
    const minutes = colon[1] === '' ? 0 : Number(colon[1]);
    const seconds = colon[2] === '' ? 0 : Number(colon[2]);
    if (seconds > 59) {
      return { seconds: null, error: 'Seconds must be 59 or less.' };
    }
    return { seconds: minutes * 60 + seconds, error: null };
  }

  if (/^\d+$/.test(raw)) {
    return { seconds: Number(raw), error: null };
  }

  return {
    seconds: null,
    error: 'Enter a time like 7:30, or a number of seconds.',
  };
}

/** True once the period number is past regulation. */
export function isOvertime(period, periodsPerGame) {
  return period > (periodsPerGame || 4);
}

export function label(period, periodsPerGame) {
  return periodLabel(period, periodsPerGame || 4);
}

/** The default regulation length for a given game structure. */
export function defaultPeriodSeconds(periodsPerGame) {
  return periodsPerGame === 2 ? DEFAULT_HALF_SECONDS : DEFAULT_PERIOD_SECONDS;
}

/**
 * How long a period lasts, in seconds.
 *
 * Overtime is always short. Regulation follows the configured period length,
 * defaulting to a quarter or a half according to the game structure.
 */
export function periodLength(game) {
  if (isOvertime(game.currentPeriod, game.periodsPerGame)) {
    return DEFAULT_OVERTIME_SECONDS;
  }
  if (typeof game.periodSeconds === 'number' && game.periodSeconds > 0) {
    return game.periodSeconds;
  }
  return defaultPeriodSeconds(game.periodsPerGame);
}

/**
 * The clock value to start a period with.
 *
 * `fromZero` records that the clock was refilled rather than resumed, so the UI
 * can say so and the scorer is not left wondering where ten minutes came from.
 */
export function startValue(game) {
  const remaining = game.clock?.seconds ?? 0;
  if (remaining > 0) {
    return { seconds: remaining, fromZero: false };
  }
  return { seconds: periodLength(game), fromZero: true };
}

/**
 * The state after one second ticks by.
 *
 * Returns what the clock should hold, whether it is still running, and whether
 * the period just ended. Kept pure so the app only has to apply the result.
 */
export function tick(game) {
  const next = (game.clock?.seconds ?? 0) - 1;

  if (next > 0) {
    return { seconds: next, running: true, periodEnded: false };
  }

  return {
    seconds: 0,
    running: false,
    periodEnded: true,
    nextPeriod: (game.currentPeriod || 1) + 1,
  };
}
