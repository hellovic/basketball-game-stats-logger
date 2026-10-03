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
import { addEvent, addPlayer, createGame, setClock, setPeriod, updateTeam } from '../app/js/store.js';

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

/** A lineup change, for the games that carry one. */
function sub(game, { off = null, on = null, period = 1, clockSeconds = 0 } = {}) {
  const teamId = (off ?? on) && game.players.find((p) => p.id === (off ?? on)).teamId;
  const outcome = addEvent(game, {
    teamId,
    playerId: off,
    subInId: on,
    stat: 'SUB',
    period,
    clockSeconds,
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

  // The expanded box's rates export too, after the counting columns so a
  // spreadsheet built on the earlier ones keeps its references.
  assert.equal(header[header.length - 6], '3P%');
  assert.equal(header[header.length - 5], 'eFG%');
  assert.equal(header[header.length - 4], 'TS%');
  assert.equal(header[header.length - 3], 'EFF');
  // Minutes and plus/minus land at the very end, and stay empty in a game where
  // no lineup was recorded rather than reading as zero.
  assert.equal(header[header.length - 2], 'MIN');
  assert.equal(header[header.length - 1], '+/-');
  assert.equal(reed[cols.MIN], '');
  assert.equal(reed[cols['+/-']], '');
  assert.equal(header.indexOf('PF') < header.indexOf('3P%'), true);

  // A. Cole: one three, no other shot, so 100% from three and 150% effective
  // (a made three is worth half a make more than a two).
  assert.equal(cole[cols['3P%']], '100.0');
  assert.equal(cole[cols['eFG%']], '150.0');
  assert.equal(cole[cols['TS%']], '150.0');
  // 3 points and a rebound, with nothing missed and no turnover.
  assert.equal(cole[cols.EFF], '4');

  // J. Reed: one of two from the field, both twos, and nothing else.
  assert.equal(reed[cols['3P%']], '');
  assert.equal(reed[cols['eFG%']], '50.0');
  assert.equal(reed[cols['TS%']], '50.0');
  assert.equal(reed[cols.EFF], '1');

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

test('the summary carries the settings, the score and both rosters', () => {
  const { game, home1, away1 } = fixture();
  game.time = '19:30';
  game.venue = 'Northside Sports Hall';
  log(game, '2PT', 'made', { player: home1, period: 1 });
  log(game, '3PT', 'made', { player: home1, period: 3 });
  log(game, 'FT', 'made', { player: away1, period: 4 });

  const rows = parseCsv(summaryCsv(game));
  const setting = (label) => rows.find((row) => row[0] === label)?.[1];

  // What the game was played under, and whether it is whole.
  assert.equal(setting('Date'), '2026-01-17');
  assert.equal(setting('Time'), '19:30');
  assert.equal(setting('Venue'), 'Northside Sports Hall');
  assert.equal(setting('Periods'), '4 quarters');
  assert.equal(setting('Period length'), '10 minutes');
  assert.equal(setting('Status'), 'In progress');

  // The score, as the quarter grid it has always been.
  const grid = rows.findIndex((row) => row[0] === 'Team' && row[1] === 'Q1');
  assert.deepEqual(rows[grid], ['Team', 'Q1', 'Q2', 'Q3', 'Q4', 'Total']);
  assert.deepEqual(rows[grid + 1], ['Northside', '2', '0', '3', '0', '5']);

  // Both rosters, one player per row — including the ones who did not score,
  // which is the whole difference between a roster and a leaderboard.
  const rosterAt = rows.findIndex((row) => row[0] === 'Team' && row[1] === 'Abbrev.');
  assert.deepEqual(rows[rosterAt], ['Team', 'Abbrev.', 'Number', 'Player']);
  const roster = rows.slice(rosterAt + 1).filter((row) => row[0]);
  assert.deepEqual(roster, [
    ['Northside', 'NOR', '4', 'J. Reed'],
    ['Northside', 'NOR', '7', 'A. Cole'],
    ['Riverside', 'RIV', '12', 'M. Diaz'],
  ]);

  // And no leaderboard: the box score already has every line.
  assert.equal(rows.some((row) => row[0] === 'Top scorers'), false);
});

test('a side with nobody on it is still named in the rosters', () => {
  // A game built by hand: one side filled in, the other not.
  const game = createGame();
  game.date = '2026-01-17';
  updateTeam(game, game.homeTeamId, { name: 'Northside', abbreviation: 'NOR' });
  updateTeam(game, game.awayTeamId, { name: 'Riverside', abbreviation: 'RIV' });
  addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });

  const rows = parseCsv(summaryCsv(game));
  const rosterAt = rows.findIndex((row) => row[0] === 'Team' && row[1] === 'Abbrev.');
  const roster = rows.slice(rosterAt + 1).filter((row) => row[0]);

  // Riverside has no players here and still appears, with the side blank rather
  // than absent, so neither team can be missing from the file by accident.
  assert.deepEqual(roster, [
    ['Northside', 'NOR', '4', 'J. Reed'],
    ['Riverside', 'RIV', '', ''],
  ]);
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

// ---------------------------------------------------------------------------
// Minutes and plus/minus in the exports
// ---------------------------------------------------------------------------

test('the box score carries minutes and plus/minus when a lineup was recorded', () => {
  const { game, home1, home2, away1 } = fixture();

  // Both sides start with one player named, and the clock is running.
  setClock(game, 600);
  sub(game, { on: home1.id, period: 1, clockSeconds: 600 });
  sub(game, { on: away1.id, period: 1, clockSeconds: 600 });

  // Nine minutes in, the home player swaps: 9:00 on the clock means one minute
  // left, so home1 has played nine minutes and home2 takes over from there.
  setClock(game, 60);
  sub(game, { off: home1.id, on: home2.id, period: 1, clockSeconds: 60 });

  // A three goes in while the substitute is on, four minutes into the second.
  setPeriod(game, 2);
  setClock(game, 360);
  log(game, '3PT', 'made', { player: home2, period: 2 });

  const rows = parseCsv(boxScoreCsv(game));
  const cols = Object.fromEntries(rows[0].map((name, index) => [name, index]));
  const byName = Object.fromEntries(rows.slice(1).map((row) => [row[2], row]));

  assert.equal(cols.MIN > cols.EFF, true, 'minutes sit after efficiency');
  assert.equal(byName['J. Reed'][cols.MIN], '9:00', 'on from the tip-off until the swap');
  assert.equal(byName['J. Reed'][cols['+/-']], '0');
  assert.equal(byName['A. Cole'][cols.MIN], '5:00', 'and on from the swap to the live clock');
  assert.equal(byName['A. Cole'][cols['+/-']], '3', 'the three that went in while they were on');
  assert.equal(byName['M. Diaz'][cols.MIN], '14:00', 'on throughout, so the clock so far');
  assert.equal(byName['M. Diaz'][cols['+/-']], '-3', 'and the other side of it');
  assert.equal(byName['TEAM TOTALS'][cols.MIN], '', 'a team has no single minutes figure');
});

test('the play-by-play names both players in a substitution', () => {
  const { game, home1, home2 } = fixture();
  sub(game, { off: home1.id, on: home2.id, period: 1, clockSeconds: 480 });

  const rows = parseCsv(playByPlayCsv(game));
  const row = rows.find((line) => line[5].startsWith('Substitution'));
  assert.ok(row, 'the substitution is in the log');
  assert.equal(row[4], '#4 J. Reed', 'the player column is whoever came off');
  assert.match(row[5], /#7 A. Cole on/);
  assert.match(row[5], /#4 J. Reed off/);
});
