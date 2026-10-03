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
 * A duration on the game clock, e.g. "07:32".
 *
 * Used for elapsed time in the play-by-play: the clock counts down, but the log
 * reads forwards, so callers pass how far into the period the play happened.
 *
 * Blank when the value is missing, which is the case for a game saved before
 * the clock was recorded. An empty cell is honest; "00:00" would claim the play
 * happened at the opening tip.
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

/**
 * "2026-01-17" to "17/01/2026", the form the read-out pills use.
 *
 * Nothing is inferred here: an unparseable or empty value comes back as an
 * empty string so the caller can show a dash rather than a wrong date.
 */
export function displayDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!match) return '';
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** "14:30" to "02:30 PM". Empty or malformed input comes back empty. */
export function displayTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return '';

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return '';

  const suffix = hours < 12 ? 'AM' : 'PM';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(twelve).padStart(2, '0')}:${match[2]} ${suffix}`;
}

/**
 * "4 quarters • 10 mins" for the structure pill.
 *
 * The noun follows the number of periods, because a two-period game is played
 * in halves and calling them quarters would be wrong in the gym.
 */
/** "4 quarters" or "2 halves": the structure without its period length. */
export function periodsLabel(periods) {
  const count = Number(periods);
  if (!Number.isFinite(count) || count <= 0) return '';
  const noun = count === 4 ? 'quarters' : count === 2 ? 'halves' : 'periods';
  return `${count} ${noun}`;
}

export function structureLabel(periods, periodSeconds) {
  const structure = periodsLabel(periods);
  if (!structure) return '';

  const seconds = Number(periodSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return structure;

  const minutes = Math.round(seconds / 60);
  return `${structure} • ${minutes} min${minutes === 1 ? '' : 's'}`;
}
