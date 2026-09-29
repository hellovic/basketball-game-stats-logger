/**
 * Application state.
 *
 * The game is event-sourced: `game.events` is the single source of truth and
 * every total in the UI is derived from it. Mutations here are the only way the
 * event list changes, which keeps undo and corrections exact and makes
 * persistence a single serialisation of one object.
 *
 * No DOM access in this module, so the tests can drive it directly.
 */

import { getStat, isShooting } from './stats.js';
import { defaultPeriodSeconds } from './clock.js';

const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'game-stats-logger/state/v1';

let idCounter = 0;

/**
 * Stable-enough id generator. Prefers crypto.randomUUID where available and
 * falls back to a counter plus timestamp, which is plenty for a local app and
 * avoids a dependency.
 */
export function makeId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** A brand new, empty game with two placeholder teams. */
export function createGame(overrides = {}) {
  const homeTeamId = makeId('team');
  const awayTeamId = makeId('team');
  const now = Date.now();

  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId('game'),
    date: new Date(now).toISOString().slice(0, 10),
    venue: '',
    periodsPerGame: 4,
    /** Regulation period length in seconds; the clock refills from it. */
    periodSeconds: defaultPeriodSeconds(4),
    currentPeriod: 1,
    clock: { running: false, seconds: 0 },
    homeTeamId,
    awayTeamId,
    teams: {
      [homeTeamId]: { id: homeTeamId, name: 'Home', abbreviation: 'HOM' },
      [awayTeamId]: { id: awayTeamId, name: 'Away', abbreviation: 'AWY' },
    },
    players: [],
    events: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * State mutations return NEW references for the fields they touch, so the
 * renderer can diff cheaply, but the game object itself is small enough that a
 * shallow clone per mutation is not worth optimising around.
 */
function touch(game) {
  game.updatedAt = Date.now();
  return game;
}

// ---------------------------------------------------------------------------
// Teams and players
// ---------------------------------------------------------------------------

export function updateTeam(game, teamId, patch) {
  const team = game.teams[teamId];
  if (!team) return game;
  game.teams[teamId] = { ...team, ...patch };
  return touch(game);
}

/** Players belonging to a team, in jersey-number order. */
export function playersOf(game, teamId) {
  return game.players
    .filter((player) => player.teamId === teamId)
    .sort((a, b) => numberValue(a.number) - numberValue(b.number));
}

function numberValue(number) {
  const parsed = parseInt(number, 10);
  return isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

export function addPlayer(game, teamId, { number = '', name = '' } = {}) {
  if (!game.teams[teamId]) return null;
  const player = {
    id: makeId('player'),
    teamId,
    number: String(number).trim(),
    name: String(name).trim() || `#${String(number).trim() || '?'}`,
    active: true,
  };
  game.players.push(player);
  touch(game);
  return player;
}

export function removePlayer(game, playerId) {
  const index = game.players.findIndex((player) => player.id === playerId);
  if (index === -1) return null;
  const [removed] = game.players.splice(index, 1);
  touch(game);
  return removed;
}

/**
 * Build a roster entry from a saved library team, keeping the saved id when it
 * is free.
 *
 * `used` is the set of player ids already in the game.
 */
function makePlayer(saved, teamId, used) {
  const id =
    saved.id && !used.has(saved.id) ? saved.id : makeId('player');
  used.add(id);
  return {
    id,
    teamId,
    number: String(saved.number ?? '').trim(),
    name: String(saved.name ?? '').trim(),
    active: saved.active !== false,
  };
}

/**
 * Load a saved team's name, abbreviation and roster into a game slot.
 *
 * Written as a pure function of the game and the saved team so it can be tested
 * without any storage. Saved player ids are reused when they are free, so
 * events recorded in an earlier game against the same roster keep pointing at
 * the right player; ids that would collide are regenerated, because two players
 * sharing an id would silently merge their stat lines.
 */
export function mergeRoster(game, teamId, savedTeam) {
  const used = new Set(game.players.map((player) => player.id));

  // Only this team's slot is replaced. The other team and the event log are
  // left completely alone, so loading a roster mid-game is safe.
  const others = game.players.filter((player) => player.teamId !== teamId);
  const incoming = (savedTeam.players || []).map((saved) => makePlayer(saved, teamId, used));

  game.players = [...others, ...incoming];

  const team = game.teams[teamId];
  if (team) {
    if (savedTeam.name) team.name = savedTeam.name;
    if (savedTeam.abbreviation) team.abbreviation = savedTeam.abbreviation;
  }

  touch(game);
  return game;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Validate an event before it reaches the list. Rejecting bad input here means
 * the derivation engine can assume well-formed events.
 *
 * `game` is optional so the pure shape checks can be reused without a game.
 */
export function validateEvent(event, game = null) {
  const stat = getStat(event.stat);
  if (!stat) return 'Unknown statistic.';
  if (isShooting(stat.key)) {
    if (event.result !== 'made' && event.result !== 'missed') {
      return `${stat.label} needs a made or missed result.`;
    }
  } else if (stat.kind === 'rebound') {
    if (event.result !== 'OFF' && event.result !== 'DEF') {
      return 'A rebound needs an offensive or defensive side.';
    }
  } else if (event.result !== null && event.result !== undefined) {
    return `${stat.label} does not take a result.`;
  }
  if (!event.teamId) return 'An event needs a team.';

  // Catching a player/team mismatch here prevents the box score and the
  // scoreboard from silently disagreeing: the points would land on one team
  // while the player line showed up on the other.
  if (!event.playerId) return 'An event needs a player.';
  if (game) {
    const player = game.players.find((p) => p.id === event.playerId);
    if (!player) return 'That player is no longer on the roster.';
    if (player.teamId !== event.teamId) {
      return `${player.name} is not on that team.`;
    }
  }

  return null;
}

/**
 * Record one stat. Every event is attributed to a player on the event's team;
 * a stat nobody can be credited with is not recorded at all.
 *
 * `ts` is accepted so a seeded sample game can produce a believable, stable
 * play-by-play timeline instead of every event sharing one timestamp.
 */
export function addEvent(
  game,
  { teamId, playerId, stat, result = null, period, source = 'entry', ts, id },
) {
  const event = {
    id: id || makeId('event'),
    ts: ts ?? Date.now(),
    period: period || game.currentPeriod || 1,
    teamId,
    playerId: playerId || null,
    stat,
    result: result ?? null,
    source,
  };

  const problem = validateEvent(event, game);
  if (problem) return { event: null, error: problem };

  game.events.push(event);
  // Logging in a later period implies the game has advanced that far.
  if (event.period > (game.currentPeriod || 1)) game.currentPeriod = event.period;
  touch(game);
  return { event, error: null };
}

/** Undo the most recently recorded event. Returns the removed event or null. */
export function undoLastEvent(game) {
  if (game.events.length === 0) return null;
  const removed = game.events.pop();
  touch(game);
  return removed;
}

/** Remove a specific event — the correction path for a mistap found later. */
export function deleteEvent(game, eventId) {
  const index = game.events.findIndex((event) => event.id === eventId);
  if (index === -1) return null;
  const [removed] = game.events.splice(index, 1);
  touch(game);
  return removed;
}

/** Change an existing event's team, player, stat or result in place. */
export function updateEvent(game, eventId, patch) {
  const event = game.events.find((e) => e.id === eventId);
  if (!event) return { event: null, error: 'Event not found.' };
  const next = { ...event, ...patch, source: 'correction' };
  const problem = validateEvent(next, game);
  if (problem) return { event: null, error: problem };
  Object.assign(event, next);
  touch(game);
  return { event, error: null };
}

/** Events in game order: oldest first, then insertion order for equal stamps. */
export function eventsInOrder(game) {
  return [...game.events].sort((a, b) => a.ts - b.ts || 0);
}

/** Events newest-first, which is the order the play-by-play reads. */
export function eventsNewestFirst(game) {
  return eventsInOrder(game).reverse();
}

// ---------------------------------------------------------------------------
// Clock and period
// ---------------------------------------------------------------------------

/**
 * Switch between quarters and halves.
 *
 * The period length follows the structure unless the scorer has already picked a
 * specific length: a half is not a quarter, so a 10-minute period would be
 * wrong the moment the game became two halves. Comparing against the *old*
 * default is what distinguishes "not chosen" from "chosen and happens to match".
 */
export function setPeriodsPerGame(game, periodsPerGame) {
  const previousDefault = defaultPeriodSeconds(game.periodsPerGame);
  const nextDefault = defaultPeriodSeconds(periodsPerGame);

  game.periodsPerGame = periodsPerGame === 2 ? 2 : 4;
  if (game.periodSeconds === previousDefault) {
    game.periodSeconds = nextDefault;
  }
  return touch(game);
}

export function setPeriod(game, period) {
  const next = Math.max(1, Math.floor(period));
  game.currentPeriod = next;
  return touch(game);
}

export function setPeriodSeconds(game, seconds) {
  if (!isFinite(seconds) || seconds <= 0) return game;
  game.periodSeconds = Math.floor(seconds);
  return touch(game);
}

export function setClock(game, seconds) {
  game.clock = { ...game.clock, seconds: Math.max(0, Math.floor(seconds)) };
  return touch(game);
}

export function setClockRunning(game, running) {
  game.clock = { ...game.clock, running: Boolean(running) };
  return touch(game);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * localStorage is wrapped because it throws in some privacy modes and on some
 * file:// setups. A storage failure must degrade to an in-memory session rather
 * than breaking the app mid-game.
 */
function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function serialize(game) {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, game });
}

export function deserialize(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const game = parsed?.game ?? parsed;
    if (!game || !Array.isArray(game.events) || !Array.isArray(game.players)) return null;
    // Fill in fields an older save may predate. A save written by an older
    // version may also carry `scoreOverrides`; it is ignored, so a game with a
    // manually corrected period now reports only its logged events.
    delete game.scoreOverrides;
    game.teams ??= {};
    game.clock ??= { running: false, seconds: 0 };
    game.currentPeriod ??= 1;
    game.periodsPerGame ??= 4;
    game.periodSeconds ??= defaultPeriodSeconds(game.periodsPerGame);
    return game;
  } catch {
    return null;
  }
}

export function saveState(game, store = storage()) {
  if (!store) return { ok: false, error: 'Storage unavailable.' };
  try {
    store.setItem(STORAGE_KEY, serialize(game));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export function loadState(store = storage()) {
  if (!store) return null;
  try {
    return deserialize(store.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearState(store = storage()) {
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    /* nothing useful to do */
  }
}

export { STORAGE_KEY, SCHEMA_VERSION };
