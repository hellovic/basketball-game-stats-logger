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

/** A short local time for an event row, e.g. "19:42:07". */
export function eventTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour12: false });
}

/** Guard against undefined/empty values reaching the DOM as "undefined". */
export function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}
