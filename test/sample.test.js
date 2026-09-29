/**
 * Sample game tests.
 *
 * The seed game is hand-authored data, and it is the first thing anyone sees
 * when they open the app. If it were malformed or its arithmetic did not
 * reconcile, the app would look broken on first load — so its shape and its
 * totals are asserted rather than assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AWAY_TEAM, HOME_TEAM, ROSTER, TIMELINE, sampleGame } from '../app/js/sample.js';
import {
  computeGame,
  consistencyWarnings,
  listPeriods,
  playerLine,
  teamTotal,
} from '../app/js/derive.js';
import { deserialize, playersOf, serialize } from '../app/js/store.js';

test('the seed game is well formed', () => {
  const game = sampleGame();

  assert.equal(game.homeTeamId, HOME_TEAM);
  assert.equal(game.awayTeamId, AWAY_TEAM);
  assert.equal(game.teams[HOME_TEAM].name, 'Northside');
  assert.equal(game.teams[AWAY_TEAM].name, 'Riverside');
  assert.equal(game.periodsPerGame, 4);
  assert.equal(game.currentPeriod, 3);

  // A full roster per side, and each player on their own team.
  assert.equal(playersOf(game, HOME_TEAM).length, ROSTER.home.length);
  assert.equal(playersOf(game, AWAY_TEAM).length, ROSTER.away.length);
});

test('every seeded event belongs to a player on its own team', () => {
  const game = sampleGame();

  for (const event of game.events) {
    assert.ok(game.teams[event.teamId], `event ${event.id} has a known team`);
    if (!event.playerId) continue;
    const player = game.players.find((p) => p.id === event.playerId);
    assert.ok(player, `event ${event.id} names a real player`);
    assert.equal(player.teamId, event.teamId, `${player.name} must be on the event's team`);
  }
});

test('the seed game produces no consistency warnings', () => {
  const game = sampleGame();
  assert.deepEqual(consistencyWarnings(game), []);
});

test('seeded events are timestamped in a believable game order', () => {
  const game = sampleGame();
  const periods = game.events.map((event) => event.period);

  // The timeline is authored by minute offset, so periods must not run backwards.
  for (let i = 1; i < periods.length; i += 1) {
    assert.ok(
      periods[i] >= periods[i - 1],
      `period should not go backwards: ${periods[i - 1]} then ${periods[i]}`,
    );
  }

  const stamps = game.events.map((event) => event.ts);
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(stamps[i] >= stamps[i - 1], 'timestamps should be non-decreasing');
  }

  // Comfortably more than a token handful, so the views look populated.
  assert.ok(game.events.length >= TIMELINE.length);
  assert.ok(game.events.length > 20);
});

test('the seeded totals reconcile across every view', () => {
  const game = sampleGame();
  const derived = computeGame(game);

  // The quarter grid is complete for a four-quarter game.
  assert.deepEqual(listPeriods(game), [1, 2, 3, 4]);

  for (const row of derived.grid.rows) {
    const cellSum = row.cells.reduce((sum, cell) => sum + cell.value, 0);
    assert.equal(cellSum, row.total, 'the row total must equal the sum of its quarters');
    assert.equal(row.total, derived.scores[row.teamId], 'and must match the scoreboard');
    assert.equal(row.total, teamTotal(game, row.teamId));
  }

  // Scoring lives in the first three periods; the fourth is still to be played.
  const home = derived.grid.rows.find((row) => row.teamId === HOME_TEAM);
  const away = derived.grid.rows.find((row) => row.teamId === AWAY_TEAM);
  assert.equal(home.cells[3].value, 0);
  assert.equal(away.cells[3].value, 0);
  assert.ok(home.total > 0 && away.total > 0);

  // Player points must add up to the team's score.
  const homeFromPlayers = playersOf(game, HOME_TEAM).reduce(
    (sum, player) => sum + playerLine(game, player.id).points,
    0,
  );
  assert.equal(homeFromPlayers, derived.scores[HOME_TEAM]);

  const awayFromPlayers = playersOf(game, AWAY_TEAM).reduce(
    (sum, player) => sum + playerLine(game, player.id).points,
    0,
  );
  assert.equal(awayFromPlayers, derived.scores[AWAY_TEAM]);
});

test('the seed game exercises the whole stat catalog', () => {
  const game = sampleGame();
  const stats = new Set(game.events.map((event) => event.stat));

  for (const stat of ['2PT', '3PT', 'FT', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF']) {
    assert.ok(stats.has(stat), `the sample should include at least one ${stat}`);
  }
  // Both a make and a miss, so the format between them is visible.
  assert.ok(
    game.events.some((e) => e.result === 'made') && game.events.some((e) => e.result === 'missed'),
    'the sample should include both makes and misses',
  );
});

test('the seed game survives a save and load round trip', () => {
  const game = sampleGame();
  const restored = deserialize(serialize(game));

  assert.deepEqual(restored, game);
  assert.equal(computeGame(restored).scores[HOME_TEAM], computeGame(game).scores[HOME_TEAM]);
});
