/**
 * The order the game happened in.
 *
 * An entry is stamped with the clock reading at the moment it was tapped, and
 * kept in the order it was tapped — which stops being the same thing as soon as
 * a scorer corrects a time or adds a play they noticed they had missed. Every
 * reader that walks the log in sequence walks it in *game* order instead: by
 * period, then by how far into that period, with the order things were typed
 * breaking a tie.
 *
 * The tie matters more than it looks. A substitution and the basket that
 * followed it can share a clock reading, and only the order they were entered
 * says which five were on the floor to be credited for it.
 */

import { elapsedInPeriod } from './clock.js';

/** Compare two entries by when they happened, oldest first. */
export function compareByGameTime(game, a, b) {
  if (a.period !== b.period) return (a.period ?? 0) - (b.period ?? 0);

  const left = elapsedInPeriod(game, a) ?? 0;
  const right = elapsedInPeriod(game, b) ?? 0;
  if (left !== right) return left - right;

  return (a.ts ?? 0) - (b.ts ?? 0);
}

/** Every entry, oldest first, in the order the game happened. */
export function eventsInGameOrder(game) {
  return [...game.events].sort((a, b) => compareByGameTime(game, a, b));
}
