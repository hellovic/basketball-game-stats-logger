/**
 * Roster import tests.
 *
 * Pasting a roster is how a team actually gets set up on game day: the scorer
 * copies two columns out of a spreadsheet and pastes them in. That text can be
 * tab-, comma- or space-separated, may or may not carry a header, and is often
 * pasted with the trailing newline the copy picked up — so the parser has to
 * accept all of that without mangling a name, while still refusing input it
 * genuinely cannot read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRosterText } from '../app/js/rosterimport.js';

/** The roster the user actually pasted, header and all. */
const SAMPLE = `Player\tNumber
陳大文\t55
李小明\t4
王小美\t32
張家豪\t11
黃麗珍\t3
周文輝\t27
吳雅思\t12
鄭俊宇\t99
許小雨\t13
馬凱婷\t87
劉嘉敏\t22
趙子晴\t42`;

test('reads the tab-separated sample with a header', () => {
  const result = parseRosterText(SAMPLE);

  assert.equal(result.error, null);
  assert.equal(result.hasHeader, true);
  assert.equal(result.delimiter, 'tab');
  assert.equal(result.players.length, 12);
  assert.deepEqual(result.players[0], { number: '55', name: '陳大文', active: true });
  assert.deepEqual(result.players[11], { number: '42', name: '趙子晴', active: true });
  assert.deepEqual(result.ignoredColumns, []);
  assert.deepEqual(result.warnings, []);
});

test('reads the same roster with no header, comma separated', () => {
  const result = parseRosterText('陳大文,55\n李小明,4\n王小美,32');

  assert.equal(result.error, null);
  assert.equal(result.hasHeader, false);
  assert.equal(result.delimiter, 'comma');
  assert.deepEqual(result.players, [
    { number: '55', name: '陳大文', active: true },
    { number: '4', name: '李小明', active: true },
    { number: '32', name: '王小美', active: true },
  ]);
});

test('accepts space-aligned columns pasted out of a document', () => {
  const result = parseRosterText('陳大文   55\n李小明   4');

  assert.equal(result.error, null);
  assert.equal(result.delimiter, 'spaces');
  assert.deepEqual(result.players, [
    { number: '55', name: '陳大文', active: true },
    { number: '4', name: '李小明', active: true },
  ]);
});

test('tolerates a UTF-8 BOM and Windows line endings', () => {
  const result = parseRosterText('\uFEFFPlayer,Number\r\n陳大文,55\r\n李小明,4\r\n');

  assert.equal(result.error, null);
  assert.equal(result.players.length, 2);
  assert.equal(result.players[0].name, '陳大文', 'the BOM must not stick to the first name');
});

test('ignores blank lines and whole-line comments', () => {
  const result = parseRosterText('# 2026 squad\n\n陳大文,55\n\n李小明,4\n\n// spare\n');

  assert.equal(result.players.length, 2);
});

test('keeps a comma inside a quoted name', () => {
  const result = parseRosterText('"Reed, James",4\n"A. Cole",7');

  assert.equal(result.players.length, 2);
  assert.equal(result.players[0].name, 'Reed, James');
  assert.equal(result.players[1].name, 'A. Cole');
});

test('doubles a quote inside a quoted name into one literal quote', () => {
  const result = parseRosterText('"Jam""es",4');

  assert.equal(result.players[0].name, 'Jam"es');
});

test('reads a header whose columns are in the other order', () => {
  const result = parseRosterText('Number\tPlayer\n55\t陳大文\n4\t李小明');

  assert.equal(result.hasHeader, true);
  assert.deepEqual(result.players, [
    { number: '55', name: '陳大文', active: true },
    { number: '4', name: '李小明', active: true },
  ]);
});

test('reads a Chinese header', () => {
  const result = parseRosterText('姓名\t背號\n陳大文\t55\n李小明\t4');

  assert.equal(result.hasHeader, true);
  assert.deepEqual(result.players[0], { number: '55', name: '陳大文', active: true });
});

test('recognises a header even when its wording is unknown', () => {
  // No number parses in the first row, so it cannot be player data; called
  // "Player" to keep the columns meaningful if the data itself is swapped.
  const result = parseRosterText('Nom\tNuméro\n陳大文\t55\n李小明\t4');

  assert.equal(result.hasHeader, true);
  assert.equal(result.players.length, 2);
  assert.equal(result.players[0].name, '陳大文');
});

test('keeps the first row as a player when it looks like data', () => {
  const result = parseRosterText('陳大文,55\n李小明,4');

  assert.equal(result.hasHeader, false);
  assert.equal(result.players.length, 2);
});

test('reports an extra Group column as ignored rather than dropping it silently', () => {
  const result = parseRosterText('Player\tGroup\tNumber\n陳大文\tU14\t55\n李小明\tU17\t4');

  assert.equal(result.error, null);
  assert.deepEqual(result.players, [
    { number: '55', name: '陳大文', active: true },
    { number: '4', name: '李小明', active: true },
  ]);
  assert.deepEqual(result.ignoredColumns, ['Group']);
});

test('finds the number column when there is no header to go by', () => {
  const result = parseRosterText('陳大文,U14,55\n李小明,U17,4');

  assert.equal(result.error, null);
  assert.equal(result.players.length, 2);
  // The jersey number is column three; "U14" must not be read as a number.
  assert.deepEqual(result.players, [
    { number: '55', name: '陳大文', active: true },
    { number: '4', name: '李小明', active: true },
  ]);
});

test('strips a leading # from a jersey number', () => {
  const result = parseRosterText('陳大文,#55\n李小明,#4');

  assert.deepEqual(result.players, [
    { number: '55', name: '陳大文', active: true },
    { number: '4', name: '李小明', active: true },
  ]);
});

test('keeps a non-numeric jersey number instead of discarding the player', () => {
  const result = parseRosterText('Player,Number\n陳大文,A5\n李小明,4');

  assert.equal(result.players.length, 2);
  assert.equal(result.players[0].number, 'A5');
});

test('warns about a shared jersey number but still imports it', () => {
  const result = parseRosterText('陳大文,55\n李小明,55\n王小美,4');

  assert.equal(result.error, null);
  assert.equal(result.players.length, 3, 'a shared number is legal, so import proceeds');
  assert.match(result.warnings.join(' '), /55/);
});

test('keeps a named player whose jersey number is blank, and says so', () => {
  const result = parseRosterText('陳大文,\n李小明,4');

  assert.equal(result.error, null);
  assert.equal(result.players.length, 2);
  assert.deepEqual(result.players[0], { number: '', name: '陳大文', active: true });
  assert.match(result.warnings.join(' '), /no jersey number/i);
});

test('skips a row with a number but no name, and says so', () => {
  const result = parseRosterText('陳大文,55\n,4\n李小明,7');

  assert.deepEqual(
    result.players.map((player) => player.name),
    ['陳大文', '李小明'],
  );
  assert.match(result.warnings.join(' '), /no player name/i);
});

test('rejects empty input', () => {
  assert.equal(parseRosterText('').error, 'The roster is empty.');
  assert.equal(parseRosterText('   \n  \n').error, 'The roster is empty.');
  assert.equal(parseRosterText(null).error, 'The roster is empty.');
});

test('rejects a single-column paste and shows the expected shape', () => {
  const result = parseRosterText('陳大文\n李小明\n王小美');

  assert.match(result.error, /player and a number/i);
  assert.match(result.error, /陳大文,55/);
  assert.equal(result.players.length, 0);
});

test('points JSON pasted into the text box at the file importer', () => {
  const result = parseRosterText('{"format":"game-stats-logger/team","team":{"players":[]}}');

  assert.match(result.error, /looks like JSON/i);
  assert.match(result.error, /Load team from file/);
});

test('rejects a header with no rows under it', () => {
  const result = parseRosterText('Player,Number');

  assert.equal(result.error, 'No players were found in that roster.');
});

test('parses every player from the sample into the shape mergeRoster expects', () => {
  const { players } = parseRosterText(SAMPLE);

  for (const player of players) {
    assert.equal(typeof player.name, 'string');
    assert.equal(typeof player.number, 'string');
    assert.equal(player.active, true);
    assert.notEqual(player.name.trim(), '');
  }
  // No duplicate names in this roster; numbers are all present.
  assert.equal(new Set(players.map((player) => player.name)).size, players.length);
  assert.equal(players.every((player) => /^\d+$/.test(player.number)), true);
});
