/**
 * Derivation and store tests.
 *
 * The whole point of this app is that the scoreboard, the scoresheet and the
 * box score can never disagree, so these tests target exactly that: one set of
 * events must produce consistent values everywhere, and undoing or deleting an
 * event must leave no residue in any derived number.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addEvent,
  addPlayer,
  createGame,
  deleteEvent,
  deserialize,
  eventsNewestFirst,
  loadState,
  makeId,
  playersOf,
  saveState,
  serialize,
  setClock,
  setPeriod,
  setTeamPeriodTotal,
  undoLastEvent,
  updateTeam,
} from '../app/js/store.js';
import {
  computeGame,
  consistencyWarnings,
  derivedPeriodPoints,
  floorReport,
  listPeriods,
  periodScore,
  playerLine,
  teamLine,
  teamTotal,
} from '../app/js/derive.js';
import { clock, pct, periodLabel } from '../app/js/format.js';
import { pointsFor } from '../app/js/stats.js';

test('a typed team total scores for the team and for nobody in particular', () => {
  const game = createGame();
  const teamId = game.homeTeamId;
  const player = addPlayer(game, teamId, { number: '9', name: 'A. Cole' });

  setPeriod(game, 2);
  setTeamPeriodTotal(game, teamId, 2, 18);

  // The scoreboard, the quarter strip and the team totals all take it.
  assert.equal(periodScore(game, teamId, 2), 18);
  assert.equal(teamTotal(game, teamId), 18);
  assert.equal(computeGame(game).scores[teamId], 18);
  assert.equal(computeGame(game).teamTotals[teamId].points, 18);

  // No player line does: the points belong to the team, and inventing a player
  // to hold them is exactly what this saves the scorer from doing.
  assert.equal(playerLine(game, player.id).points, 0);
  assert.equal(computeGame(game).playerLines[player.id].points, 0);

  // It is an ordinary entry, so it undoes like one.
  undoLastEvent(game);
  assert.equal(periodScore(game, teamId, 2), 0);
});

test('a period with both a typed total and player entries is flagged', () => {
  const game = createGame();
  const teamId = game.homeTeamId;
  const player = addPlayer(game, teamId, { number: '9', name: 'A. Cole' });

  // Retyping the number the board shows is the whole point, so nothing is
  // blocked — but a period with both is a double count, and saying so is how a
  // scorer finds it afterwards rather than at the final buzzer.
  setPeriod(game, 1);
  setTeamPeriodTotal(game, teamId, 1, 18);
  assert.deepEqual(
    consistencyWarnings(game).filter((w) => /typed total/.test(w.message)),
    [],
    'a typed total on its own is not a problem',
  );

  addEvent(game, {
    teamId,
    playerId: player.id,
    stat: '2PT',
    result: 'made',
    period: 1,
  });

  const warnings = consistencyWarnings(game).filter((w) => /typed total/.test(w.message));
  assert.equal(warnings.length, 1, 'the double count is named once');
  assert.match(warnings[0].message, /Q1/, 'and names the period');
  assert.equal(periodScore(game, teamId, 1), 20, 'the scoreboard counts both');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fixed game: two teams, two players each, no events. */
function fixture() {
  const game = createGame();
  updateTeam(game, game.homeTeamId, { name: 'North', abbreviation: 'NOR' });
  updateTeam(game, game.awayTeamId, { name: 'Riverside', abbreviation: 'RIV' });

  const players = {};
  players.home1 = addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  players.home2 = addPlayer(game, game.homeTeamId, { number: '7', name: 'A. Cole' });
  players.away1 = addPlayer(game, game.awayTeamId, { number: '12', name: 'M. Diaz' });
  players.away2 = addPlayer(game, game.awayTeamId, { number: '23', name: 'K. Boyd' });

  return { game, players };
}

/**
 * `log(game, stat, result, { player, team, period })`.
 *
 * When a player is given, their own team wins — an explicit `team` is only
 * meaningful for the team-level entries that have no player, which is exactly
 * the rule `addEvent` enforces.
 */
function log(game, stat, result, { team = 'home', player = null, period = 1, clockSeconds } = {}) {
  const playerObj =
    typeof player === 'string' ? game.players.find((p) => p.id === player) : player;
  const slot = playerObj ? (playerObj.teamId === game.homeTeamId ? 'home' : 'away') : team;
  const teamId = slot === 'home' ? game.homeTeamId : game.awayTeamId;
  const outcome = addEvent(game, {
    teamId,
    playerId: playerObj?.id ?? null,
    stat,
    result,
    period,
    clockSeconds,
  });
  assert.equal(outcome.error, null, `logging ${stat}/${result} failed: ${outcome.error}`);
  return outcome.event;
}

/**
 * `sub(game, { off, on, period, clockSeconds })`.
 *
 * A lineup change is an event like any other, and it is the clock it carries —
 * not the order it was recorded in — that decides how long a stint lasted.
 */
function sub(game, { off = null, on = null, period = 1, clockSeconds = 0 } = {}) {
  const teamId = off
    ? game.players.find((player) => player.id === off).teamId
    : game.players.find((player) => player.id === on).teamId;
  const outcome = addEvent(game, {
    teamId,
    playerId: off,
    subInId: on,
    stat: 'SUB',
    period,
    clockSeconds,
  });
  assert.equal(outcome.error, null, `sub failed: ${outcome.error}`);
  return outcome.event;
}

// ---------------------------------------------------------------------------
// Stat catalog
// ---------------------------------------------------------------------------

test('points are awarded only for made shots', () => {
  assert.equal(pointsFor('2PT', 'made'), 2);
  assert.equal(pointsFor('3PT', 'made'), 3);
  assert.equal(pointsFor('FT', 'made'), 1);
  assert.equal(pointsFor('2PT', 'missed'), 0);
  assert.equal(pointsFor('3PT', 'missed'), 0);
  assert.equal(pointsFor('AST', null), 0);
  assert.equal(pointsFor('REB', 'OFF'), 0);
});

// ---------------------------------------------------------------------------
// Period scores
// ---------------------------------------------------------------------------

test('period scores sum made shots and ignore misses', () => {
  const { game, players } = fixture();

  log(game, '2PT', 'made', { player: players.home1, period: 1 });
  log(game, '3PT', 'made', { player: players.home2, period: 1 });
  log(game, 'FT', 'made', { player: players.home1, period: 1 });
  log(game, '2PT', 'missed', { player: players.home2, period: 1 });

  // 2 + 3 + 1 = 6, with the miss contributing nothing.
  assert.equal(derivedPeriodPoints(game, game.homeTeamId, 1), 6);
  assert.equal(periodScore(game, game.homeTeamId, 1), 6);
  assert.equal(teamTotal(game, game.homeTeamId), 6);
});

test('team totals accumulate across separate periods', () => {
  const { game, players } = fixture();

  log(game, '2PT', 'made', { player: players.home1, period: 1 });
  log(game, '3PT', 'made', { player: players.home1, period: 2 });
  log(game, 'FT', 'made', { player: players.home1, period: 4 });
  log(game, '3PT', 'made', { player: players.away1, period: 2 });

  assert.equal(periodScore(game, game.homeTeamId, 1), 2);
  assert.equal(periodScore(game, game.homeTeamId, 2), 3);
  assert.equal(periodScore(game, game.homeTeamId, 4), 1);
  assert.equal(periodScore(game, game.homeTeamId, 3), 0);
  assert.equal(teamTotal(game, game.homeTeamId), 6);
  assert.equal(teamTotal(game, game.awayTeamId), 3);

  const derived = computeGame(game);
  assert.equal(derived.scoresBySlot.home, 6);
  assert.equal(derived.scoresBySlot.away, 3);
});

test('periods cover the configured game length even with no events', () => {
  const { game } = fixture();
  assert.deepEqual(listPeriods(game), [1, 2, 3, 4]);

  game.periodsPerGame = 2;
  assert.deepEqual(listPeriods(game), [1, 2]);
});

test('overtime appears only once something is logged there', () => {
  const { game, players } = fixture();
  assert.deepEqual(listPeriods(game), [1, 2, 3, 4]);

  log(game, '3PT', 'made', { player: players.home1, period: 5 });
  assert.deepEqual(listPeriods(game), [1, 2, 3, 4, 5]);
  assert.equal(periodScore(game, game.homeTeamId, 5), 3);
  assert.equal(teamTotal(game, game.homeTeamId), 3);
});

// ---------------------------------------------------------------------------
// Player box score
// ---------------------------------------------------------------------------

test('player line tracks points, rebounds and shooting splits', () => {
  const { game, players } = fixture();
  const reed = players.home1;

  log(game, '2PT', 'made', { player: reed, period: 1 });
  log(game, '2PT', 'made', { player: reed, period: 1 });
  log(game, '2PT', 'missed', { player: reed, period: 1 });
  log(game, '3PT', 'made', { player: reed, period: 2 });
  log(game, '3PT', 'missed', { player: reed, period: 2 });
  log(game, 'FT', 'made', { player: reed, period: 2 });
  log(game, 'FT', 'missed', { player: reed, period: 2 });
  log(game, 'REB', 'OFF', { player: reed, period: 1 });
  log(game, 'REB', 'DEF', { player: reed, period: 1 });
  log(game, 'REB', 'DEF', { player: reed, period: 2 });
  log(game, 'AST', null, { player: reed, period: 1 });
  log(game, 'STL', null, { player: reed, period: 3 });
  log(game, 'BLK', null, { player: reed, period: 3 });
  log(game, 'TO', null, { player: reed, period: 3 });
  log(game, 'PF', null, { player: reed, period: 2 });

  const line = playerLine(game, reed.id);

  // 4 + 3 + 1 = 8
  assert.equal(line.points, 8);
  assert.deepEqual(line['2PT'], { made: 2, missed: 1 });
  assert.deepEqual(line['3PT'], { made: 1, missed: 1 });
  assert.deepEqual(line.FT, { made: 1, missed: 1 });

  // FG% counts 2PT and 3PT together: 3 made of 5.
  assert.equal(line.fgMade, 3);
  assert.equal(line.fgAtt, 5);
  assert.equal(line.fgPct, 0.6);
  assert.equal(line.ftMade, 1);
  assert.equal(line.ftAtt, 2);
  assert.equal(line.ftPct, 0.5);

  // 3P% is its own split: 1 made of 2.
  assert.equal(line.fg3Pct, 0.5);
  // eFG% gives a three half a make more than a two: (3 + 0.5) / 5.
  assert.equal(line.efgPct, 0.7);
  // TS% weighs the two free throws as 0.44 of a possession each: 8 / (2 * 5.88).
  assert.equal(Math.round(line.tsPct * 1000) / 1000, 0.68);
  // EFF is what was added minus what the misses and turnovers cost:
  // (8 + 3 + 1 + 1 + 1) - (2 missed field goals + 1 missed free throw + 1 TO).
  assert.equal(line.eff, 10);

  // Rebounds land in the total as well as the split.
  assert.equal(line.reb, 3);
  assert.equal(line.rebOff, 1);
  assert.equal(line.rebDef, 2);
  assert.equal(line.ast, 1);
  assert.equal(line.stl, 1);
  assert.equal(line.blk, 1);
  assert.equal(line.to, 1);
  assert.equal(line.pf, 1);
});

test('a player with only misses has zero points but real attempts', () => {
  const { game, players } = fixture();
  const cole = players.home2;

  log(game, '2PT', 'missed', { player: cole });
  log(game, '3PT', 'missed', { player: cole });
  log(game, 'FT', 'missed', { player: cole });

  const line = playerLine(game, cole.id);
  assert.equal(line.points, 0);
  assert.equal(line.fgMade, 0);
  assert.equal(line.fgAtt, 2);
  assert.equal(line.fgPct, 0);
  assert.equal(line.ftAtt, 1);
  assert.equal(line.ftPct, 0);
  assert.equal(line.fg3Pct, 0);
  assert.equal(line.efgPct, 0);
  assert.equal(line.tsPct, 0);
  // Three misses and no points: efficiency goes below zero rather than stopping
  // at it, which is the whole point of the number.
  assert.equal(line.eff, -3);
  assert.equal(teamTotal(game, game.homeTeamId), 0);

  // No attempts anywhere should read as "—", not 0%.
  const { game: fresh, players: freshPlayers } = fixture();
  assert.equal(playerLine(fresh, freshPlayers.home1.id).fgPct, null);
  assert.equal(playerLine(fresh, freshPlayers.home1.id).fg3Pct, null);
  assert.equal(playerLine(fresh, freshPlayers.home1.id).efgPct, null);
  assert.equal(playerLine(fresh, freshPlayers.home1.id).tsPct, null);
  assert.equal(pct(playerLine(fresh, freshPlayers.home1.id).fgPct), '—');

  // A line with nothing in it is worth zero efficiency, not "no efficiency":
  // the number always exists, unlike a rate with no attempts behind it.
  assert.equal(playerLine(fresh, freshPlayers.home1.id).eff, 0);
});

test('the derived rates are the same arithmetic on a team line as on a player line', () => {
  const { game, players } = fixture();
  const { home1, home2 } = players;

  log(game, '2PT', 'made', { player: home1 });
  log(game, '3PT', 'made', { player: home1 });
  log(game, '3PT', 'missed', { player: home1 });
  log(game, 'FT', 'made', { player: home2 });
  log(game, 'FT', 'missed', { player: home2 });
  log(game, 'REB', 'OFF', { player: home2 });
  log(game, 'AST', null, { player: home2 });
  log(game, 'TO', null, { player: home1 });

  const team = teamLine(game, game.homeTeamId);
  const combined = computeGame(game);
  const fromPlayers = combined.playerLines[home1.id];

  // 6 points: a two, a three and a free throw, on 2 of 3 from the field and
  // 1 of 2 from the line.
  assert.equal(team.points, 6);
  assert.equal(team.fgPct, 2 / 3);
  assert.equal(team.fg3Pct, 0.5);
  assert.equal(team.ftPct, 0.5);
  assert.equal(team.efgPct, 2.5 / 3);
  assert.equal(team.eff, 6 + 1 + 1 - (1 + 1 + 1));

  // The team line is the sum of the two players', rates included, because it is
  // the same formula over the same events.
  assert.equal(team.points, combined.playerLines[home1.id].points + combined.playerLines[home2.id].points);
  assert.equal(team.eff, fromPlayers.eff + combined.playerLines[home2.id].eff);
});

// ---------------------------------------------------------------------------
// Team totals versus player lines
// ---------------------------------------------------------------------------

test('team total equals the sum of player lines when every event has a player', () => {
  const { game, players } = fixture();

  log(game, '2PT', 'made', { player: players.home1 });
  log(game, '3PT', 'made', { player: players.home2 });
  log(game, 'REB', 'DEF', { player: players.home1 });
  log(game, 'AST', null, { player: players.home2 });

  const derived = computeGame(game);
  const fromPlayers = [players.home1, players.home2].reduce(
    (sum, player) => sum + derived.playerLines[player.id].points,
    0,
  );

  assert.equal(fromPlayers, derived.scoresBySlot.home);
  assert.equal(derived.teamTotals[game.homeTeamId].points, derived.scoresBySlot.home);
  assert.equal(derived.teamTotals[game.homeTeamId].reb, 1);
  assert.equal(derived.teamTotals[game.homeTeamId].ast, 1);
});

// ---------------------------------------------------------------------------
// Undo and corrections
// ---------------------------------------------------------------------------

test('undo is exact: every derived value returns to its prior state', () => {
  const { game, players } = fixture();
  const reed = players.home1;

  log(game, '2PT', 'made', { player: reed, period: 1 });
  log(game, '3PT', 'made', { player: reed, period: 2 });

  const before = computeGame(game);

  log(game, 'REB', 'DEF', { player: reed, period: 2 });
  assert.equal(computeGame(game).scoresBySlot.home, 5);
  assert.equal(playerLine(game, reed.id).reb, 1);

  const removed = undoLastEvent(game);
  assert.equal(removed.stat, 'REB');

  const after = computeGame(game);
  assert.deepEqual(after.scores, before.scores);
  assert.equal(after.playerLines[reed.id].reb, 0);
  assert.equal(after.playerLines[reed.id].points, before.playerLines[reed.id].points);
  assert.deepEqual(
    after.grid.rows.map((row) => row.cells.map((cell) => cell.value)),
    before.grid.rows.map((row) => row.cells.map((cell) => cell.value)),
  );
});

test('undoing a made shot removes its points from the quarter', () => {
  const { game, players } = fixture();
  log(game, '3PT', 'made', { player: players.home1, period: 3 });
  assert.equal(periodScore(game, game.homeTeamId, 3), 3);

  undoLastEvent(game);
  assert.equal(periodScore(game, game.homeTeamId, 3), 0);
  assert.equal(teamTotal(game, game.homeTeamId), 0);
});

test('undo on an empty game is a no-op', () => {
  const { game } = fixture();
  assert.equal(undoLastEvent(game), null);
  assert.equal(game.events.length, 0);
});

test('deleting a mid-game event recomputes later periods correctly', () => {
  const { game, players } = fixture();
  const reed = players.home1;

  log(game, '2PT', 'made', { player: reed, period: 1 });
  const middle = log(game, '3PT', 'made', { player: reed, period: 2 });
  log(game, 'FT', 'made', { player: reed, period: 3 });

  assert.equal(teamTotal(game, game.homeTeamId), 6);

  const removed = deleteEvent(game, middle.id);
  assert.equal(removed.stat, '3PT');

  assert.equal(periodScore(game, game.homeTeamId, 1), 2);
  assert.equal(periodScore(game, game.homeTeamId, 2), 0);
  assert.equal(periodScore(game, game.homeTeamId, 3), 1);
  assert.equal(teamTotal(game, game.homeTeamId), 3);
  assert.equal(playerLine(game, reed.id).points, 3);
  assert.deepEqual(playerLine(game, reed.id)['3PT'], { made: 0, missed: 0 });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('invalid events are rejected rather than corrupting the log', () => {
  const { game } = fixture();

  const unknown = addEvent(game, { teamId: game.homeTeamId, stat: 'NOPE', result: null });
  assert.match(unknown.error, /Unknown statistic/);

  const badShot = addEvent(game, { teamId: game.homeTeamId, stat: '2PT', result: 'maybe' });
  assert.match(badShot.error, /made or missed/);

  const badRebound = addEvent(game, { teamId: game.homeTeamId, stat: 'REB', result: 'UP' });
  assert.match(badRebound.error, /offensive or defensive/);

  const badCount = addEvent(game, { teamId: game.homeTeamId, stat: 'AST', result: 'made' });
  assert.match(badCount.error, /does not take a result/);

  assert.equal(game.events.length, 0);
});

test('logging in a later period advances the current period', () => {
  const { game, players } = fixture();
  setPeriod(game, 1);
  log(game, '2PT', 'made', { player: players.home1, period: 3 });
  assert.equal(game.currentPeriod, 3);
});

test('an event cannot be attributed to a player on the other team', () => {
  const { game, players } = fixture();

  // Would put 3 points on the away score while showing them on a home player.
  const mismatched = addEvent(game, {
    teamId: game.awayTeamId,
    playerId: players.home1.id,
    stat: '3PT',
    result: 'made',
    period: 1,
  });

  assert.match(mismatched.error, /not on that team/);
  assert.equal(game.events.length, 0);
  assert.equal(computeGame(game).scoresBySlot.away, 0);
});

test('an event cannot name a player who left the roster', () => {
  const { game, players } = fixture();
  const ghost = players.home1.id;
  game.players = game.players.filter((player) => player.id !== ghost);

  const outcome = addEvent(game, {
    teamId: game.homeTeamId,
    playerId: ghost,
    stat: '2PT',
    result: 'made',
    period: 1,
  });

  assert.match(outcome.error, /no longer on the roster/);
  assert.equal(game.events.length, 0);
});

// ---------------------------------------------------------------------------
// Play-by-play ordering
// ---------------------------------------------------------------------------

test('events read newest-first in the play-by-play', () => {
  const { game, players } = fixture();
  log(game, '2PT', 'made', { player: players.home1 });
  log(game, 'AST', null, { player: players.home2 });
  log(game, 'REB', 'DEF', { player: players.home1 });

  const ordered = eventsNewestFirst(game);
  assert.equal(ordered.length, 3);
  assert.equal(ordered[0].stat, 'REB');
  assert.equal(ordered[2].stat, '2PT');
});

// ---------------------------------------------------------------------------
// Roster helpers
// ---------------------------------------------------------------------------

test('players are listed by jersey number, numeric not lexical', () => {
  const game = createGame();
  addPlayer(game, game.homeTeamId, { number: '23', name: 'Twenty Three' });
  addPlayer(game, game.homeTeamId, { number: '4', name: 'Four' });
  addPlayer(game, game.homeTeamId, { number: '10', name: 'Ten' });

  const numbers = playersOf(game, game.homeTeamId).map((player) => player.number);
  assert.deepEqual(numbers, ['4', '10', '23']);
});

test('a player with no name falls back to their number', () => {
  const game = createGame();
  const player = addPlayer(game, game.homeTeamId, { number: '9' });
  assert.equal(player.name, '#9');
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** An in-memory stand-in for localStorage. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

test('a game round-trips through serialisation without losing anything', () => {
  const { game, players } = fixture();
  log(game, '2PT', 'made', { player: players.home1, period: 2 });
  log(game, 'REB', 'OFF', { player: players.home2, period: 2 });

  const restored = deserialize(serialize(game));
  assert.deepEqual(restored, game);
  assert.equal(computeGame(restored).scoresBySlot.home, computeGame(game).scoresBySlot.home);
});

test('state saves to and loads from storage', () => {
  const { game, players } = fixture();
  log(game, '3PT', 'made', { player: players.home1, period: 4 });

  const store = fakeStorage();
  const saved = saveState(game, store);
  assert.equal(saved.ok, true);

  const loaded = loadState(store);
  assert.equal(loaded.id, game.id);
  assert.equal(loaded.events.length, 1);
  assert.equal(teamTotal(loaded, loaded.homeTeamId), 3);
});

test('corrupt or missing stored state falls back to null instead of throwing', () => {
  assert.equal(deserialize('not json at all'), null);
  assert.equal(deserialize(''), null);
  assert.equal(deserialize(JSON.stringify({ game: { nope: true } })), null);
  assert.equal(loadState(fakeStorage()), null);
});

test('storage failures degrade instead of crashing', () => {
  const hostile = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
    removeItem() {
      throw new Error('denied');
    },
  };

  const { game } = fixture();
  const saved = saveState(game, hostile);
  assert.equal(saved.ok, false);
  assert.match(saved.error, /quota/);
  assert.equal(loadState(hostile), null);
});

test('ids are unique', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(makeId('x'));
  assert.equal(ids.size, 500);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('period labels handle quarters, halves and overtime', () => {
  assert.equal(periodLabel(1), 'Q1');
  assert.equal(periodLabel(4), 'Q4');
  assert.equal(periodLabel(5), 'OT');
  assert.equal(periodLabel(6), 'OT2');
  assert.equal(periodLabel(1, 2), 'H1');
  assert.equal(periodLabel(2, 2), 'H2');
});

test('percentages and clocks format predictably', () => {
  assert.equal(pct(0.6), '60%');
  assert.equal(pct(0.615), '61.5%');
  assert.equal(pct(0), '0%');
  assert.equal(pct(null), '—');
  assert.equal(pct(undefined), '—');

  assert.equal(clock(0), '00:00');
  assert.equal(clock(65), '01:05');
  assert.equal(clock(600), '10:00');
  assert.equal(clock(-5), '00:00');
  assert.equal(clock(Infinity), '00:00');
});

// ---------------------------------------------------------------------------
// Cross-check: the scoreboard, scoresheet and box score must always agree
// ---------------------------------------------------------------------------

test('period scores, grid totals and box score all reconcile on a mixed game', () => {
  const { game, players } = fixture();
  const { home1, home2, away1 } = players;

  // A messy quarter: makes, misses and counting stats for several players.
  log(game, '2PT', 'made', { player: home1, period: 1 });
  log(game, '2PT', 'missed', { player: home1, period: 1 });
  log(game, '3PT', 'made', { player: home2, period: 1 });
  log(game, 'FT', 'made', { player: home2, period: 1 });
  log(game, 'REB', 'OFF', { player: home1, period: 1 });
  log(game, 'TO', null, { player: home2, period: 1 });
  log(game, 'REB', 'DEF', { player: home2, period: 1 });

  log(game, '3PT', 'made', { player: away1, team: 'away', period: 1 });
  log(game, '2PT', 'made', { player: away1, team: 'away', period: 2 });
  log(game, 'PF', null, { player: away1, team: 'away', period: 2 });

  const derived = computeGame(game);

  for (const row of derived.grid.rows) {
    const cellSum = row.cells.reduce((sum, cell) => sum + cell.value, 0);
    assert.equal(cellSum, row.total);
    assert.equal(row.total, derived.scores[row.teamId]);
    assert.equal(row.total, teamTotal(game, row.teamId));
  }

  // Home: 2 + 3 + 1 = 6. Away: 3 + 2 = 5.
  assert.equal(derived.scoresBySlot.home, 6);
  assert.equal(derived.scoresBySlot.away, 5);

  // Home team rebounds: 1 offensive (home1) + 1 defensive (team-level) = 2.
  assert.equal(derived.teamTotals[game.homeTeamId].reb, 2);
  assert.equal(derived.playerLines[home1.id].reb, 1);
});

// ---------------------------------------------------------------------------
// Minutes on the floor and plus/minus
// ---------------------------------------------------------------------------

test('nobody is tracked until a lineup is recorded', () => {
  const { game } = fixture();
  const report = floorReport(game);

  assert.equal(report.tracked, false, 'a game with no substitutions has no floor');
  assert.deepEqual(report.onCourt, {});
});

test('minutes run from a player coming on to coming off, across the period break', () => {
  const { game, players } = fixture();
  const { home1, home2 } = players;

  // home1 starts the game and plays the first eight minutes; the clock in the
  // second period is stopped at 6:00 left.
  setPeriod(game, 1);
  sub(game, { on: home1.id, period: 1, clockSeconds: 600 });
  // At 8:00 elapsed in the first period, home1 comes off for home2 — a stint
  // that runs over the period break.
  sub(game, { off: home1.id, on: home2.id, period: 1, clockSeconds: 120 });

  // The game has moved on: the second period, with 6:00 left on the clock.
  setPeriod(game, 2);
  setClock(game, 360);

  const report = floorReport(game);

  assert.equal(report.tracked, true);
  assert.equal(report.minutes[home1.id], 8 * 60, 'eight minutes in the first period');
  // home2 is still on, so their stint runs to the live clock: the rest of the
  // first period, plus the four minutes played so far in the second.
  assert.equal(report.minutes[home2.id], 2 * 60 + 4 * 60);
});

test('a clock left behind the last entry does not shorten the on-court time', () => {
  const { game, players } = fixture();
  const { home1, home2 } = players;

  // The five are out, and the play is logged to 9:50 of the first period. The
  // clock, though, was left at 5:00 — stopped for a stoppage, corrected, or
  // left where an older correction was typed.
  sub(game, { on: home1.id, period: 1, clockSeconds: 600 });
  sub(game, { on: home2.id, period: 1, clockSeconds: 600 });
  log(game, '2PT', 'made', { player: home1, period: 1, clockSeconds: 10 });
  setClock(game, 300);

  const report = floorReport(game);

  // Both stints run to the last reading rather than to the clock: the five
  // minutes of play after the clock stopped belong to whoever was out there.
  assert.equal(report.minutes[home1.id], 9 * 60 + 50);
  assert.equal(report.minutes[home2.id], 9 * 60 + 50);

  // And the same game with the clock at the end of the period counts the whole
  // quarter, which is what the reading could not tell us on its own.
  setClock(game, 0);
  assert.equal(floorReport(game).minutes[home1.id], 10 * 60);
});

test('a player who comes on after the clock was left still gets their minutes', () => {
  const { game, players } = fixture();
  const { home1, home2 } = players;

  sub(game, { on: home1.id, period: 1, clockSeconds: 600 });
  log(game, '2PT', 'made', { player: home1, period: 1, clockSeconds: 10 });
  setClock(game, 300);
  // A change recorded at 7:00, later than the clock was left: the stint that
  // follows it used to be dropped for ending before it started.
  sub(game, { off: home1.id, on: home2.id, period: 1, clockSeconds: 180 });

  const report = floorReport(game);
  assert.equal(report.minutes[home2.id], 2 * 60 + 50, '7:00 to 9:50 on the floor');
  assert.equal(report.minutes[home1.id], 7 * 60, 'and the one who came off keeps theirs');
});

test('a clock lagging the last entry is named, and only while it lags', () => {
  const { game, players } = fixture();
  const { home1 } = players;

  sub(game, { on: home1.id, period: 1, clockSeconds: 600 });
  log(game, '2PT', 'made', { player: home1, period: 1, clockSeconds: 10 });

  // Nothing to say while the clock is where the play ended.
  assert.deepEqual(consistencyWarnings(game).filter((w) => /clock reads/.test(w.message)), []);

  // Left at 5:00 with entries to 9:50, and the note says what is at stake.
  setClock(game, 300);
  const warnings = consistencyWarnings(game).filter((w) => /clock reads/.test(w.message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /05:00 in Q1/);
  assert.match(warnings[0].message, /09:50/);
  assert.match(warnings[0].message, /04:50 short/);

  // A clock ahead of the play is the ordinary case, not a problem.
  setClock(game, 0);
  assert.deepEqual(consistencyWarnings(game).filter((w) => /clock reads/.test(w.message)), []);

  // And with no lineup there are no minutes to be short of.
  const { game: blank, players: blankPlayers } = fixture();
  sub(blank, { on: blankPlayers.home1.id, period: 1, clockSeconds: 600 });
  log(blank, '2PT', 'made', { player: blankPlayers.home1, period: 1, clockSeconds: 10 });
  setClock(blank, 300);
  const bare = fixture();
  bare.game.clock.seconds = 10;
  log(bare.game, '2PT', 'made', { player: bare.players.home1, period: 1, clockSeconds: 10 });
  setClock(bare.game, 300);
  assert.deepEqual(
    consistencyWarnings(bare.game).filter((w) => /clock reads/.test(w.message)),
    [],
    'no lineup, no minutes to be short of',
  );
});

test('a period the clock never ran contributes no minutes', () => {
  const { game, players } = fixture();
  const { home1 } = players;

  // Every reading is zero: the scorer never started the clock.
  sub(game, { on: home1.id, period: 1, clockSeconds: 0 });
  log(game, '2PT', 'made', { player: home1, period: 1 });
  sub(game, { off: home1.id, period: 1, clockSeconds: 0 });

  const report = floorReport(game);

  assert.equal(report.minutes[home1.id], 0, 'no clock, no minutes');
  assert.deepEqual(report.untimedPeriods, [1], 'and the period is named');
});

test('plus/minus credits the five on the floor and debits the other five', () => {
  const { game, players } = fixture();
  const { home1, home2, away1, away2 } = players;

  sub(game, { on: home1.id, period: 1, clockSeconds: 600 });
  sub(game, { on: away1.id, period: 1, clockSeconds: 600 });

  // Home scores a three while both are out there.
  log(game, '3PT', 'made', { player: home1, period: 1 });
  assert.deepEqual(
    [floorReport(game).plusMinus[home1.id], floorReport(game).plusMinus[away1.id]],
    [3, -3],
  );

  // The away side answers, and then a player who was sitting down comes on for
  // the last basket of the run — while a home player watches it from the bench.
  log(game, '2PT', 'made', { player: away1, team: 'away', period: 1 });
  sub(game, { off: away1.id, on: away2.id, period: 1, clockSeconds: 300 });
  log(game, '2PT', 'made', { player: home2, period: 1 });

  const report = floorReport(game);

  assert.equal(report.plusMinus[home1.id], 3 - 2 + 2, 'both home baskets, less the away one');
  assert.equal(report.plusMinus[away1.id], -3 + 2, 'on for the three against, and the two for');
  assert.equal(report.plusMinus[away2.id], -2, 'only the basket after they came on');
  assert.equal(
    report.plusMinus[home2.id],
    0,
    'a player on the bench takes nothing from the baskets they watched',
  );
});

test('a substitution is refused when it makes no sense', () => {
  const { game, players } = fixture();
  const { home1, home2, away1 } = players;

  const attempt = (fields) =>
    addEvent(game, { teamId: game.homeTeamId, stat: 'SUB', ...fields });

  assert.match(attempt({}).error ?? '', /coming off or coming on/);
  assert.equal(attempt({ playerId: home1.id }).error, null, 'off with no replacement');
  assert.equal(attempt({ subInId: home2.id }).error, null, 'on with nobody coming off');
  assert.match(
    attempt({ playerId: home1.id, subInId: home1.id }).error ?? '',
    /come on for themselves/,
  );
  assert.match(
    attempt({ playerId: home1.id, subInId: away1.id }).error ?? '',
    /not on that team/,
    'a substitute has to come from the same bench',
  );
});
