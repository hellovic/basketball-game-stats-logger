/**
 * Export tests.
 *
 * Export is the only durable copy of a game, because localStorage is scoped to
 * one browser on one device. The CSV has to open cleanly in a spreadsheet, so
 * the quoting and the column set are worth pinning down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boxScoreCsv,
  buildCsv,
  buildFileName,
  csvField,
  download,
  gameJson,
  importGame,
  playByPlayCsv,
  summaryCsv,
  toCsv,
} from '../app/js/export.js';
import { addEvent, addPlayer, createGame, updateTeam } from '../app/js/store.js';

function fixture() {
  const game = createGame();
  game.date = '2026-01-17';
  updateTeam(game, game.homeTeamId, { name: 'Northside', abbreviation: 'NOR' });
  updateTeam(game, game.awayTeamId, { name: 'Riverside', abbreviation: 'RIV' });

  const home1 = addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  const home2 = addPlayer(game, game.homeTeamId, { number: '7', name: 'A. Cole' });
  const away1 = addPlayer(game, game.awayTeamId, { number: '12', name: 'M. Diaz' });

  return { game, home1, home2, away1 };
}

function log(game, stat, result, { team = 'home', player = null, period = 1 } = {}) {
  const playerObj = typeof player === 'string' ? game.players.find((p) => p.id === player) : player;
  const slot = playerObj ? (playerObj.teamId === game.homeTeamId ? 'home' : 'away') : team;
  const teamId = slot === 'home' ? game.homeTeamId : game.awayTeamId;
  const outcome = addEvent(game, {
    teamId,
    playerId: playerObj?.id ?? null,
    stat,
    result,
    period,
  });
  assert.equal(outcome.error, null, outcome.error);
  return outcome.event;
}

/** Parse CSV text into a grid of strings, honouring quoted fields. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // handled with the following \n
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CSV primitives
// ---------------------------------------------------------------------------

test('csvField quotes only when it has to', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('J. Reed'), 'J. Reed');
  assert.equal(csvField(42), '42');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField('Reed, J.'), '"Reed, J."');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
});

test('toCsv joins rows with CRLF for spreadsheet compatibility', () => {
  assert.equal(toCsv([['a', 'b'], ['c', 'd']]), 'a,b\r\nc,d');
});

// ---------------------------------------------------------------------------
// Box score
// ---------------------------------------------------------------------------

test('box score has one row per player plus a team totals row', () => {
  const { game, home1, home2, away1 } = fixture();

  log(game, '2PT', 'made', { player: home1 });
  log(game, '2PT', 'missed', { player: home1 });
  log(game, '3PT', 'made', { player: home2 });
  log(game, 'REB', 'DEF', { player: home2 });
  log(game, '3PT', 'made', { player: away1, period: 2 });
  log(game, 'REB', 'OFF', { player: away1, period: 2 });

  const rows = parseCsv(boxScoreCsv(game));
  const header = rows[0];

  assert.equal(header[0], 'Team');
  assert.equal(header[3], 'PTS');
  assert.ok(header.includes('OREB'));
  assert.ok(header.includes('FG%'));

  const byName = Object.fromEntries(rows.slice(1).map((row) => [row[2], row]));
  const cols = Object.fromEntries(header.map((name, index) => [name, index]));

  // Away is written first, so the layout is stable: away, away totals, home,
  // home totals, with the totals row labelled clearly.
  assert.deepEqual(
    rows.slice(1).map((row) => row[2]),
    ['M. Diaz', 'TEAM TOTALS', 'J. Reed', 'A. Cole', 'TEAM TOTALS'],
  );

  const reed = byName['J. Reed'];
  assert.equal(reed[cols.PTS], '2');
  assert.equal(reed[cols['2PM']], '1');
  assert.equal(reed[cols['2PA']], '2');
  assert.equal(reed[cols['FG%']], '50.0');

  const cole = byName['A. Cole'];
  assert.equal(cole[cols.PTS], '3');
  assert.equal(cole[cols.REB], '1');
  assert.equal(cole[cols['FG%']], '100.0');
  // A player with no free throw attempts exports a blank percentage rather
  // than a misleading zero.
  assert.equal(cole[cols['FT%']], '');

  const awayTotal = rows.find((row) => row[2] === 'TEAM TOTALS' && row[0] === 'Riverside');
  assert.equal(awayTotal[cols.PTS], '3');
  // The team-level rebound counts for the team even with no player attached.
  assert.equal(awayTotal[cols.REB], '1');
});

test('a game with no events still exports a usable header and totals', () => {
  const { game } = fixture();
  const rows = parseCsv(boxScoreCsv(game));

  assert.equal(rows[0][0], 'Team');
  // header + 3 players + a totals row for each of the two teams
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.length === rows[0].length));
});

// ---------------------------------------------------------------------------
// Play-by-play
// ---------------------------------------------------------------------------

test('play-by-play lists every event oldest first with readable descriptions', () => {
  const { game, home1 } = fixture();

  const first = log(game, '3PT', 'made', { player: home1, period: 1 });
  first.ts = Date.UTC(2026, 0, 17, 19, 30, 0);
  const second = log(game, 'REB', 'OFF', { player: home1, period: 2 });
  second.ts = Date.UTC(2026, 0, 17, 19, 40, 0);

  const rows = parseCsv(playByPlayCsv(game));
  assert.equal(rows[0].length, 8);
  assert.equal(rows.length, 3);

  assert.equal(rows[1][0], '1');
  assert.equal(rows[1][2], 'Q1');
  assert.equal(rows[1][4], '#4 J. Reed');
  assert.equal(rows[1][5], 'Made 3PT');
  assert.equal(rows[1][7], '3');

  assert.equal(rows[2][2], 'Q2');
  assert.equal(rows[2][5], 'Offensive rebound');
  assert.equal(rows[2][7], '0');
});

test('the play-by-play time column is elapsed game time, not the time of day', () => {
  const { game, home1 } = fixture();
  // 425 seconds left of a ten-minute period: 175 seconds played.
  game.clock = { running: true, seconds: 425 };

  const first = log(game, '3PT', 'made', { player: home1, period: 1 });
  // A wall-clock timestamp that looks nothing like a game clock: if this leaked
  // into the export the column would read "20:58:52".
  first.ts = Date.UTC(2026, 0, 17, 20, 58, 52);

  // Later in the same period, so the elapsed value must be larger: the column
  // counts up towards the period length while the clock counts down from it.
  game.clock = { running: true, seconds: 100 };
  log(game, 'REB', 'DEF', { player: home1, period: 1 });

  const rows = parseCsv(playByPlayCsv(game));
  assert.deepEqual(rows[0].slice(1, 3), ['Game time', 'Period']);
  assert.equal(rows[1][1], '02:55', 'the column should count up from 00:00');
  assert.equal(rows[2][1], '08:20', 'a later play should read a larger elapsed time');
});

test('an entry saved before clocks were recorded shows a blank time, not 00:00', () => {
  const { game, home1 } = fixture();
  const first = log(game, '2PT', 'made', { player: home1, period: 1 });
  delete first.clockSeconds;

  const rows = parseCsv(playByPlayCsv(game));
  assert.equal(rows[1][1], '', 'an unknown clock is empty, not full time');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test('summary shows the quarter grid and the leading scorers', () => {
  const { game, home1, away1 } = fixture();
  log(game, '2PT', 'made', { player: home1, period: 1 });
  log(game, '3PT', 'made', { player: home1, period: 3 });
  log(game, 'FT', 'made', { player: away1, period: 4 });

  const rows = parseCsv(summaryCsv(game));
  assert.deepEqual(rows[0], ['Team', 'Q1', 'Q2', 'Q3', 'Q4', 'Total']);

  const northside = rows.find((row) => row[0] === 'Northside');
  assert.deepEqual(northside.slice(1, 5), ['2', '0', '3', '0']);
  assert.equal(northside[5], '5');

  const scorersIndex = rows.findIndex((row) => row[0] === 'Top scorers');
  assert.ok(scorersIndex > 0);
  // Home1 has 5 points, away1 has 1, so the order is deterministic.
  assert.equal(rows[scorersIndex + 1][0], '#4 J. Reed');
  assert.equal(rows[scorersIndex + 1][1], '5');
  assert.equal(rows[scorersIndex + 2][1], '1');
});

test('summary skips players who did not score', () => {
  const { game, home1 } = fixture();
  log(game, 'REB', 'DEF', { player: home1 });

  const rows = parseCsv(summaryCsv(game));
  const scorersIndex = rows.findIndex((row) => row[0] === 'Top scorers');
  // Nothing but the heading, since nobody scored.
  assert.equal(rows.length, scorersIndex + 1);
});

// ---------------------------------------------------------------------------
// File names and dispatch
// ---------------------------------------------------------------------------

test('file names name the matchup, the date and the export kind', () => {
  const { game } = fixture();
  assert.equal(buildFileName(game, 'box-score'), '2026-01-17_RIV-at-NOR_box-score.csv');
  assert.equal(buildFileName(game, 'play-by-play', 'csv'), '2026-01-17_RIV-at-NOR_play-by-play.csv');
  assert.equal(buildFileName(game, 'game', 'json'), '2026-01-17_RIV-at-NOR_game.json');
});

test('buildCsv rejects an unknown export kind', () => {
  const { game } = fixture();
  assert.throws(() => buildCsv(game, 'nonsense'), /Unknown export kind/);
});

// ---------------------------------------------------------------------------
// JSON round trip
// ---------------------------------------------------------------------------

test('JSON export re-imports to an identical game', () => {
  const { game, home1 } = fixture();
  log(game, '2PT', 'made', { player: home1, period: 1 });

  const json = gameJson(game);
  const { game: restored, error } = importGame(json);

  assert.equal(error, null);
  assert.deepEqual(restored, game);
  assert.equal(restored.events.length, game.events.length);
  assert.equal(restored.players.length, game.players.length);
});

test('a corrupt or unrelated file is rejected with a clear message', () => {
  assert.match(importGame('{ not json').error, /not a valid game export/);
  assert.match(importGame('').error, /not a valid game export/);
  assert.match(importGame('{"hello":"world"}').error, /not a valid game export/);
  assert.match(
    importGame(JSON.stringify({ game: { players: [], events: null } })).error,
    /not a valid game export/,
  );
});

// ---------------------------------------------------------------------------
// Browser-only download
// ---------------------------------------------------------------------------

test('download refuses to run outside a browser', () => {
  // The tests run in Node, where there is no document to click.
  assert.throws(() => download('x.csv', 'a,b'), /only available in a browser/);
});
