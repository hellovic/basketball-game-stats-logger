/**
 * Small display helpers. Kept separate from the rendering code so they can be
 * unit tested without a DOM.
 */

/** "Q3" for periods 1..4, "OT" / "OT2" beyond that. */
export function periodLabel(period, periodsPerGame = 4) {
  if (period <= periodsPerGame) {
    return periodsPerGame === 2 ? `H${period}` : `Q${period}`;
  }
  const overtime = period - periodsPerGame;
  return overtime === 1 ? 'OT' : `OT${overtime}`;
}

/** Percentage from a 0..1 ratio, or an em dash when there were no attempts. */
export function pct(ratio) {
  if (ratio === null || ratio === undefined || !isFinite(ratio)) return '—';
  return `${Math.round(ratio * 1000) / 10}%`.replace('.0%', '%');
}

/** "3-7" style made-attempted column, or "0-0". */
export function madeAttempted(made, att) {
  return `${made}-${att}`;
}

/** Seconds to "MM:SS", clamped at zero. */
export function clock(totalSeconds) {
  if (!isFinite(totalSeconds) || totalSeconds < 0) return '00:00';
  const whole = Math.floor(totalSeconds);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The game clock at the moment of an entry, e.g. "07:32".
 *
 * Blank when the value is missing, which is the case for a game saved before
 * the clock was recorded. An empty cell is honest; "00:00" would claim the play
 * happened on the buzzer.
 */
export function eventClock(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return '';
  return clock(seconds);
}

/** Guard against undefined/empty values reaching the DOM as "undefined". */
export function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}
