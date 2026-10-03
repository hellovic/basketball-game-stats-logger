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

import { LINEUP, getStat, isShooting, isTeamTotal } from './stats.js';
import { defaultPeriodSeconds } from './clock.js';
import { eventsInGameOrder } from './order.js';

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
    /** Start time as HH:MM. Blank until the scorer sets it: a wrong-looking
     *  default is worse than an empty field, which asks to be filled in. */
    time: '',
    venue: '',
    periodsPerGame: 4,
    /** Regulation period length in seconds; the clock refills from it. */
    periodSeconds: defaultPeriodSeconds(4),
    currentPeriod: 1,
    clock: { running: false, seconds: 0 },
    /**
     * When the game was closed off, or null while it is still being played.
     *
     * The finished clock is what makes this worth storing rather than
     * inferring: a game whose clock sits at 00:00 of its last period is a game
     * whose minutes are complete, and saying so explicitly is what lets the
     * difference between "finished" and "left in the middle" travel with the
     * file.
     */
    finishedAt: null,
    homeTeamId,
    awayTeamId,
    teams: {
      // The colour is a key from the app's palette, not a colour value, so a
      // team always has a readable accent and a tint that goes with it.
      [homeTeamId]: { id: homeTeamId, name: 'Home', abbreviation: 'HOM', color: 'blue' },
      [awayTeamId]: { id: awayTeamId, name: 'Away', abbreviation: 'AWY', color: 'red' },
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

/**
 * Put each team on the other side.
 *
 * Only the two ids are exchanged. Players and entries point at a team id rather
 * than at a side, so a team's name, abbreviation, roster and points all travel
 * with it and nothing has to be rewritten — which also means this is its own
 * undo: swapping twice is where you started.
 */
export function swapSides(game) {
  const home = game.homeTeamId;
  game.homeTeamId = game.awayTeamId;
  game.awayTeamId = home;
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

/**
 * A fresh game built on this one: the settings, and whichever sides are kept.
 *
 * The next game of a league or a tournament is the same venue and the same
 * rules as the one before it, and often the same two clubs — so setting that up
 * again by hand is the tedious part of the evening. Only identity and
 * configuration are copied: every number belongs to a game that has been
 * played, and none of it can follow.
 *
 * A kept team stays on the side it was on, and its players get new ids — they
 * are new entries in a new game, and a shared id would tie two games together
 * through a history neither of them has.
 */
export function copyGameAsNew(game, { keepHome = true, keepAway = true } = {}) {
  const next = createGame({
    date: game.date,
    time: game.time,
    venue: game.venue,
    periodsPerGame: game.periodsPerGame,
    periodSeconds: game.periodSeconds,
  });

  for (const slot of ['home', 'away']) {
    if (slot === 'home' ? !keepHome : !keepAway) continue;

    const fromId = slot === 'home' ? game.homeTeamId : game.awayTeamId;
    const toId = slot === 'home' ? next.homeTeamId : next.awayTeamId;
    const team = game.teams?.[fromId];
    if (!team) continue;

    next.teams[toId] = {
      id: toId,
      name: team.name,
      abbreviation: team.abbreviation,
      ...(team.color ? { color: team.color } : {}),
    };

    for (const player of game.players.filter((entry) => entry.teamId === fromId)) {
      next.players.push({
        id: makeId('player'),
        teamId: toId,
        number: player.number,
        name: player.name,
        active: player.active !== false,
      });
    }
  }

  return next;
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
 * Add players to a team without touching the ones already there.
 *
 * This is deliberately NOT `mergeRoster(game, teamId, {...existing, ...added})`:
 * that path re-creates every incoming player through `makePlayer`, and an
 * existing player passed through it is only kept if their id is still absent
 * from `game.players`. The ids ARE already there, so all of them would be
 * reassigned and every event they had logged would be orphaned. Appending keeps
 * both the roster and the event log intact.
 */
export function appendRoster(game, teamId, savedTeam) {
  const used = new Set(game.players.map((player) => player.id));
  const added = (savedTeam.players || []).map((saved) => makePlayer(saved, teamId, used));

  game.players = [...game.players, ...added];
  touch(game);
  return game;
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
    // A team keeps the colour it came with; a file that says nothing about one
    // leaves whatever this team already wears.
    if (savedTeam.color) team.color = savedTeam.color;
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

  // A substitution names two players — or one, at the tip-off or when a player
  // leaves with nobody coming on. It is checked here, before the rule that every
  // event has a player, because a starter has no player coming off.
  if (stat.kind === LINEUP) {
    const off = event.playerId || null;
    const on = event.subInId || null;
    if (!off && !on) return 'A substitution needs a player coming off or coming on.';
    if (off && on && off === on) return 'A player cannot come on for themselves.';

    if (game) {
      for (const playerId of [off, on]) {
        if (!playerId) continue;
        const player = game.players.find((entry) => entry.id === playerId);
        if (!player) return 'That player is no longer on the roster.';
        if (player.teamId !== event.teamId) {
          return `${player.name} is not on that team.`;
        }
      }
    }
    return null;
  }

  // The one entry that scores without naming a player: the scorer typed the
  // team's total for the period. It is checked here so every other event can
  // still assume it has a player.
  if (isTeamTotal(stat.key)) {
    if (event.playerId) return 'A team total stands for the whole team and takes no player.';
    const points = Number(event.points);
    if (!Number.isFinite(points) || points <= 0) return 'A team total needs a number of points.';
    return null;
  }

  // A stat with no player belongs to the team: it is how a side with no roster,
  // or a rebound nobody claimed, gets a line of its own. Everything else names a
  // player, and catching a player/team mismatch there prevents the box score and
  // the scoreboard from silently disagreeing: the points would land on one team
  // while the player line showed up on the other.
  if (!event.playerId) return null;
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
 * Record one stat.
 *
 * Every event is attributed to a player on the event's team, which is what
 * keeps the scoreboard and the box score in agreement: a number reaches the
 * scoreboard only through an entry somebody owns.
 *
 * `ts` is accepted so a seeded sample game can produce a believable, stable
 * play-by-play timeline instead of every event sharing one timestamp.
 *
 * `clockSeconds` is the game clock at the moment of the tap. It is captured
 * from the running clock by default, so the play-by-play reads in game time.
 * The sample passes its own value, because it builds the whole game up front,
 * before the clock has ever moved.
 */
export function addEvent(
  game,
  {
    teamId,
    playerId,
    subInId,
    stat,
    result = null,
    period,
    source = 'entry',
    ts,
    id,
    clockSeconds,
    points,
  },
) {
  const event = {
    id: id || makeId('event'),
    ts: ts ?? Date.now(),
    // The clock, not the wall clock: a scorer needs to know when in the game
    // the play happened, and the real-world time of the tap says nothing.
    clockSeconds: clockSeconds ?? game.clock?.seconds ?? 0,
    period: period || game.currentPeriod || 1,
    teamId,
    playerId: playerId || null,
    stat,
    result: result ?? null,
    source,
  };

  // The player coming on, for the one entry that has two players in it. Written
  // only when it is given, so no other event carries a field it cannot use.
  if (subInId !== undefined) event.subInId = subInId || null;

  // Only a team total carries its own value; every other stat takes its points
  // from the catalog, so the field is written only when one is given.
  if (points !== undefined) event.points = Math.max(0, Math.floor(Number(points) || 0));

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

/**
 * The team total the scorer typed for one team in one period, or null when
 * nothing was typed. Null rather than 0 so the box can show an empty field
 * instead of claiming the team scored nothing.
 */
export function teamPeriodTotal(game, teamId, period) {
  const event = game.events.find(
    (e) => e.stat === 'TEAM_TOTAL' && e.teamId === teamId && e.period === period,
  );
  return event ? Math.max(0, Math.floor(Number(event.points) || 0)) : null;
}

/**
 * Set — or clear — a team's score for one period.
 *
 * One entry per team per period, replaced rather than appended: the scorer types
 * the number already on the board, so typing it a second time means the first
 * number was wrong, not that the team scored twice. A blank box or a zero
 * removes the entry, which is how a mistake is taken back.
 */
export function setTeamPeriodTotal(game, teamId, period, points) {
  if (!game.teams[teamId]) return game;

  const value = Math.max(0, Math.floor(Number(points) || 0));
  const existing = game.events.find(
    (e) => e.stat === 'TEAM_TOTAL' && e.teamId === teamId && e.period === period,
  );

  if (value === 0) {
    if (existing) deleteEvent(game, existing.id);
    return game;
  }

  if (existing) {
    existing.points = value;
    return touch(game);
  }

  addEvent(game, { teamId, playerId: null, stat: 'TEAM_TOTAL', period, points: value });
  return game;
}

/**
 * Events in game order: oldest first, then insertion order for equal stamps.
 *
 * The order the CSV of the play-by-play is written in, and the reason a
 * corrected time moves a row to the place in the log where it belongs.
 */
export function eventsInOrder(game) {
  return eventsInGameOrder(game);
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
 * Mark the game finished, or open it again.
 *
 * Only the timestamp is stored. Everything a finished game means is read from
 * it and from the clock the ending set, so reopening has nothing to unwind —
 * and the stamp travels with the file, which is what tells a reader of an
 * export whether the numbers are the whole game or a game still in progress.
 */
export function setFinished(game, finishedAt) {
  game.finishedAt = finishedAt ?? null;
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
    game.time ??= '';
    game.clock ??= { running: false, seconds: 0 };
    game.currentPeriod ??= 1;
    game.periodsPerGame ??= 4;
    game.periodSeconds ??= defaultPeriodSeconds(game.periodsPerGame);

    // A game saved before teams had colours takes the defaults once, by side.
    // From then on the colour belongs to the team rather than to whichever end
    // of the scoreboard it happens to be standing at.
    for (const [teamId, team] of Object.entries(game.teams)) {
      if (!team || typeof team !== 'object') continue;
      team.color ??= teamId === game.homeTeamId ? 'blue' : 'red';
    }
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
