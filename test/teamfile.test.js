/**
 * Team file tests.
 *
 * A team file is the portable half of the saved-team story: the in-app library
 * is stuck in one browser, while the file can be mailed to another coach or
 * carried to another machine. That means the format has to survive a round trip
 * exactly, and it has to reject the wrong kind of file with a message that tells
 * the user what to do instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEAM_FILE_FORMAT,
  TEAM_FILE_VERSION,
  parseTeamFile,
  teamFileJson,
  teamFileName,
  teamFromGame,
} from '../app/js/teamfile.js';
import { addPlayer, createGame, mergeRoster, playersOf, updateTeam } from '../app/js/store.js';

function fixture() {
  const game = createGame();
  updateTeam(game, game.homeTeamId, { name: 'Northside', abbreviation: 'NOR' });
  addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  addPlayer(game, game.homeTeamId, { number: '23', name: 'T. Nguyen' });
  return game;
}

/** A team object shaped like `teamFromGame` output. */
function savedTeam() {
  const game = fixture();
  return teamFromGame(game, game.homeTeamId, 'Northside');
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test('a team is captured with its roster in jersey-number order', () => {
  const game = createGame();
  updateTeam(game, game.homeTeamId, { name: 'Northside', abbreviation: 'NOR' });
  addPlayer(game, game.homeTeamId, { number: '23', name: 'T. Nguyen' });
  addPlayer(game, game.homeTeamId, { number: '4', name: 'J. Reed' });
  addPlayer(game, game.awayTeamId, { number: '12', name: 'M. Diaz' });

  const team = teamFromGame(game, game.homeTeamId, 'Northside Varsity');

  assert.equal(team.name, 'Northside Varsity');
  assert.equal(team.abbreviation, 'NOR');
  // Numeric order, not lexical: 4 before 23.
  assert.deepEqual(
    team.players.map((p) => p.number),
    ['4', '23'],
  );
  assert.equal(team.players.length, 2, 'only this team is captured');
});

test('capturing falls back to the team name and rejects an unknown team', () => {
  const game = fixture();
  assert.equal(teamFromGame(game, game.homeTeamId, '').name, 'Northside');
  assert.equal(teamFromGame(game, 'nope', 'x'), null);
  assert.equal(teamFromGame(null, 'nope', 'x'), null);
});

test('an exported team file is valid JSON in the documented shape', () => {
  const team = savedTeam();
  const parsed = JSON.parse(teamFileJson(team, { appVersion: '0.2.0' }));

  assert.equal(parsed.format, TEAM_FILE_FORMAT);
  assert.equal(parsed.version, TEAM_FILE_VERSION);
  assert.equal(parsed.appVersion, '0.2.0');
  assert.equal(parsed.team.name, 'Northside');
  assert.equal(parsed.team.abbreviation, 'NOR');
  assert.deepEqual(
    parsed.team.players.map((p) => `${p.number} ${p.name}`),
    ['4 J. Reed', '23 T. Nguyen'],
  );
});

test('the exported team carries only what a team file needs', () => {
  const team = savedTeam();
  const parsed = JSON.parse(teamFileJson(team));

  // Internal ids are deliberately not exported: they mean nothing in another
  // browser, and `mergeRoster` regenerates them on load.
  assert.deepEqual(Object.keys(parsed.team).sort(), ['abbreviation', 'color', 'name', 'players']);
  assert.equal(parsed.team.color, 'blue', 'the colour travels with the team');
  for (const player of parsed.team.players) {
    assert.deepEqual(Object.keys(player).sort(), ['active', 'name', 'number']);
  }
});

test('a colour the format does not know is left out rather than written through', () => {
  const parsed = JSON.parse(
    teamFileJson({ name: 'Northside', players: [{ number: '4', name: 'J. Reed' }], color: 'chartreuse' }),
  );
  assert.equal('color' in parsed.team, false, 'an unknown colour is dropped');

  // A team saved without one says nothing, so the importer leaves the colour
  // this team already wears alone.
  const plain = JSON.parse(
    teamFileJson({ name: 'Northside', players: [{ number: '4', name: 'J. Reed' }] }),
  );
  assert.equal('color' in plain.team, false);
});

test('exporting normalises the fields the importer depends on', () => {
  const parsed = JSON.parse(
    teamFileJson({
      name: '  Spaced Out  ',
      abbreviation: 'longabbrev',
      players: [{ number: 4, name: '  J. Reed ' }],
    }),
  );

  assert.equal(parsed.team.name, 'Spaced Out');
  assert.equal(parsed.team.abbreviation, 'LONG');
  assert.equal(parsed.team.players[0].number, '4');
  assert.equal(parsed.team.players[0].name, 'J. Reed');
  assert.equal(parsed.team.players[0].active, true);
});

test('an unnamed team still exports with a usable name', () => {
  const parsed = JSON.parse(teamFileJson({ players: [{ number: '4', name: 'A' }] }));
  assert.equal(parsed.team.name, 'Team');
});

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

test('file names are readable and filesystem safe', () => {
  assert.equal(teamFileName({ name: 'Northside' }), 'Northside_team.json');
  assert.equal(teamFileName({ name: 'North Side Varsity' }), 'North-Side-Varsity_team.json');
  // Anything that could break a path or a URL is collapsed.
  assert.equal(teamFileName({ name: 'A/B:C*D?' }), 'A-B-C-D_team.json');
  assert.equal(teamFileName({ name: '../../etc/passwd' }), 'etc-passwd_team.json');
  assert.equal(teamFileName({ name: '' }), 'team_team.json');
  assert.equal(teamFileName({}), 'team_team.json');
});

test('file names keep non-Latin scripts, so saves cannot overwrite each other', () => {
  // An ASCII-only slug turned every Chinese name into `team_team.json`, so
  // saving the second team silently overwrote the first.
  assert.equal(teamFileName({ name: '陳大文' }), '陳大文_team.json');
  assert.equal(teamFileName({ name: 'Sunrise 2026' }), 'Sunrise-2026_team.json');
  assert.equal(teamFileName({ name: 'Águilas' }), 'Águilas_team.json');
  assert.notEqual(
    teamFileName({ name: '陳大文' }),
    teamFileName({ name: '李小明' }),
    'two different Chinese team names must produce two different file names',
  );
  // A hostile non-Latin name is still neutralised.
  assert.equal(teamFileName({ name: '../../etc/passwd' }), 'etc-passwd_team.json');
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('a round trip through a file preserves the team exactly', () => {
  const team = savedTeam();
  const { team: restored, error } = parseTeamFile(teamFileJson(team));

  assert.equal(error, null);
  assert.equal(restored.name, 'Northside');
  assert.equal(restored.abbreviation, 'NOR');
  assert.deepEqual(restored.players, team.players.map(({ number, name, active }) => ({
    number,
    name,
    active,
  })));
});

test('a restored team loads into a game as a working roster', () => {
  const { team } = parseTeamFile(teamFileJson(savedTeam()));

  const target = createGame();
  mergeRoster(target, target.homeTeamId, team);

  assert.equal(target.teams[target.homeTeamId].name, 'Northside');
  assert.deepEqual(
    playersOf(target, target.homeTeamId).map((p) => `${p.number} ${p.name}`),
    ['4 J. Reed', '23 T. Nguyen'],
  );
});

test('a bare team object loads without the file wrapper', () => {
  const { team, error } = parseTeamFile(
    JSON.stringify({ name: 'Riverside', abbreviation: 'RIV', players: [{ number: '12', name: 'M. Diaz' }] }),
  );

  assert.equal(error, null);
  assert.equal(team.name, 'Riverside');
  assert.equal(team.players.length, 1);
});

test('extra unknown fields are ignored rather than fatal', () => {
  const { team, error } = parseTeamFile(
    JSON.stringify({
      format: TEAM_FILE_FORMAT,
      version: 99,
      somethingNew: true,
      team: {
        name: 'Northside',
        coach: 'Someone',
        players: [{ number: '4', name: 'J. Reed', position: 'G', id: 'player_x' }],
      },
    }),
  );

  assert.equal(error, null);
  assert.equal(team.name, 'Northside');
  assert.deepEqual(team.players, [{ number: '4', name: 'J. Reed', active: true }]);
});

test('blank roster entries are dropped and missing names fall back to the number', () => {
  const { team, error } = parseTeamFile(
    JSON.stringify({
      name: 'Northside',
      players: [
        { number: '4', name: 'J. Reed' },
        { number: '', name: '' },
        { number: '', name: '   ' },
        { number: '23' },
        { name: 'No Number' },
      ],
    }),
  );

  assert.equal(error, null);
  assert.deepEqual(team.players, [
    { number: '4', name: 'J. Reed', active: true },
    { number: '23', name: '#23', active: true },
    { number: '', name: 'No Number', active: true },
  ]);
});

test('a team with no name uses a sensible fallback', () => {
  const { team } = parseTeamFile(JSON.stringify({ players: [{ number: '4', name: 'J. Reed' }] }));
  assert.equal(team.name, 'Imported team');
});

// ---------------------------------------------------------------------------
// Rejections — each has to say something useful
// ---------------------------------------------------------------------------

test('non-JSON and empty files are rejected', () => {
  assert.match(parseTeamFile('not json at all').error, /not valid JSON/);
  assert.match(parseTeamFile('').error, /empty/);
  assert.match(parseTeamFile('   ').error, /empty/);
  assert.match(parseTeamFile(null).error, /empty/);
});

test('a JSON file that is not a team is rejected', () => {
  assert.match(parseTeamFile('{"hello":"world"}').error, /no name and no players/);
  assert.match(parseTeamFile('[]').error, /does not contain a team/);
  assert.match(parseTeamFile('"a string"').error, /not a team export/);
  assert.match(parseTeamFile('42').error, /not a team export/);
});

test('a team file with no players is rejected, naming the team', () => {
  const { team, error } = parseTeamFile(JSON.stringify({ name: 'Northside', players: [] }));
  assert.equal(team, null);
  assert.match(error, /Northside/);
  assert.match(error, /no players/);
});

test('a full game backup is detected and pointed at the right importer', () => {
  // Exporting a game produces { schemaVersion, game: {...} }.
  const game = fixture();
  const gameBackup = JSON.stringify({ schemaVersion: 1, game });

  const { team, error } = parseTeamFile(gameBackup);
  assert.equal(team, null);
  assert.match(error, /full game backup/);
  assert.match(error, /Load game/);

  // Also caught when the format marker is present.
  assert.match(
    parseTeamFile(JSON.stringify({ format: 'game-stats-logger/game', game })).error,
    /full game backup/,
  );
});

test('malformed player entries do not throw', () => {
  const { team, error } = parseTeamFile(
    JSON.stringify({
      name: 'Odd',
      players: [null, 'string', 42, { number: '4', name: 'Good' }, []],
    }),
  );

  assert.equal(error, null);
  assert.deepEqual(team.players, [{ number: '4', name: 'Good', active: true }]);
});

test('a players field that is not an array is treated as empty', () => {
  assert.match(
    parseTeamFile(JSON.stringify({ name: 'Northside', players: 'nope' })).error,
    /no players/,
  );
});
