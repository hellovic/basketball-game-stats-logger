/**
 * Export.
 *
 * The app keeps everything in localStorage, which is scoped to one browser on
 * one device. Export is therefore the backup and the portability story: it is
 * how a game survives cleared site data, and how it moves to another device.
 *
 * The formatting functions return plain strings so the tests can assert on the
 * output directly; only `download` touches the DOM.
 */

import { describeEvent, eventPoints } from './stats.js';
import { computeGame } from './derive.js';
import { eventClock, periodLabel, safeText } from './format.js';
import { elapsedInPeriod } from './clock.js';
import { eventsInOrder, deserialize, serialize } from './store.js';

/**
 * Quote a CSV field when it contains a comma, quote or newline, doubling any
 * embedded quotes per RFC 4180.
 */
export function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Join rows of already-raw values into CSV text with CRLF line endings. */
export function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

/**
 * Build a download name.
 *
 * `kind` distinguishes a team export from a full game backup; the default keeps
 * the existing game naming.
 */
export function fileName(game, kind, extension) {
  const away = game.teams?.[game.awayTeamId]?.abbreviation || 'AWY';
  const home = game.teams?.[game.homeTeamId]?.abbreviation || 'HOM';
  const date = safeText(game.date, 'game');
  return `${date}_${away}-at-${home}_${kind}.${extension}`;
}

/**
 * Player box score: one row per player, then a team totals row.
 * Percentages and minutes are not included as columns the scorer types —
 * percentages are derived, and minutes are a manual entry elsewhere.
 */
export function boxScoreCsv(game) {
  const derived = computeGame(game);

  const header = [
    'Team',
    'Number',
    'Player',
    'PTS',
    '2PM',
    '2PA',
    '3PM',
    '3PA',
    'FTM',
    'FTA',
    'FGM',
    'FGA',
    'FG%',
    'FT%',
    'REB',
    'OREB',
    'DREB',
    'AST',
    'STL',
    'BLK',
    'TO',
    'PF',
    // The derived rates sit at the end rather than beside FG% and FT%, so a
    // spreadsheet built on the earlier columns keeps its references.
    '3P%',
    'eFG%',
    'TS%',
    'EFF',
  ];

  const rows = [header];

  const teamIds = [game.awayTeamId, game.homeTeamId].filter(Boolean);
  for (const teamId of teamIds) {
    const team = game.teams?.[teamId] || {};
    const roster = game.players
      .filter((player) => player.teamId === teamId)
      .sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0));

    for (const player of roster) {
      const line = derived.playerLines[player.id];
      if (!line) continue;
      rows.push(playerRow(team.name || team.abbreviation || 'Team', player.number, player.name, line));
    }

    const teamLineValues = derived.teamTotals[teamId];
    if (teamLineValues) {
      rows.push(playerRow(team.name || 'Team', '', 'TEAM TOTALS', teamLineValues));
    }
  }

  return toCsv(rows);
}

function playerRow(teamName, number, playerName, line) {
  return [
    teamName,
    number,
    playerName,
    line.points,
    line['2PT'].made,
    line['2PT'].made + line['2PT'].missed,
    line['3PT'].made,
    line['3PT'].made + line['3PT'].missed,
    line.ftMade,
    line.ftAtt,
    line.fgMade,
    line.fgAtt,
    line.fgPct === null ? '' : (line.fgPct * 100).toFixed(1),
    line.ftPct === null ? '' : (line.ftPct * 100).toFixed(1),
    line.reb,
    line.rebOff,
    line.rebDef,
    line.ast,
    line.stl,
    line.blk,
    line.to,
    line.pf,
    percent(line.fg3Pct),
    percent(line.efgPct),
    percent(line.tsPct),
    line.eff,
  ];
}

/**
 * A percentage as the number a spreadsheet wants, to one decimal like the
 * FG% and FT% columns beside it, and empty when there was nothing to shoot.
 */
function percent(ratio) {
  return ratio === null || ratio === undefined ? '' : (ratio * 100).toFixed(1);
}

/**
 * Play-by-play: the append-only event log, oldest first. This is the audit
 * trail — it can be used to rebuild a game even if a total is disputed.
 */
export function playByPlayCsv(game) {
  const header = ['#', 'Game time', 'Period', 'Team', 'Player', 'Event', 'Result', 'Points'];

  const rows = [header];

  eventsInOrder(game).forEach((event, index) => {
    const team = game.teams?.[event.teamId] || {};
    const player = event.playerId
      ? game.players.find((p) => p.id === event.playerId)
      : null;

    const points = eventPoints(event);

    rows.push([
      index + 1,
      eventClock(elapsedInPeriod(game, event)),
      periodLabel(event.period, game.periodsPerGame),
      team.name || team.abbreviation || '',
      player ? `${player.number ? `#${player.number} ` : ''}${player.name}` : 'TEAM',
      describeEvent(event.stat, event.result),
      event.result ?? '',
      points,
    ]);
  });

  return toCsv(rows);
}

/** A leaderboard-style summary, handy for sharing one game's result. */
export function summaryCsv(game) {
  const derived = computeGame(game);
  const rows = [['Team', 'Q1', 'Q2', 'Q3', 'Q4', 'Total']];

  const periods = derived.grid.periods || [];
  const header = ['Team'];
  for (const period of periods) header.push(periodLabel(period, game.periodsPerGame));
  header.push('Total');
  rows[0] = header;

  for (const row of derived.grid.rows) {
    const team = game.teams?.[row.teamId] || {};
    rows.push([team.name || team.abbreviation || 'Team', ...row.cells.map((c) => c.value), row.total]);
  }

  // Top scorers underneath, separated by a blank row.
  rows.push([]);
  rows.push(['Top scorers', 'PTS']);
  const scorers = game.players
    .map((player) => ({ player, line: derived.playerLines[player.id] }))
    .filter((entry) => entry.line && entry.line.points > 0)
    .sort((a, b) => b.line.points - a.line.points)
    .slice(0, 5);

  for (const { player, line } of scorers) {
    rows.push([`${player.number ? `#${player.number} ` : ''}${player.name}`, line.points]);
  }

  return toCsv(rows);
}

/** The full game state, so nothing is lost and it can be re-imported later. */
export function gameJson(game) {
  return JSON.stringify(JSON.parse(serialize(game)), null, 2);
}

const EXPORTERS = {
  'box-score': { csv: boxScoreCsv, label: 'box score' },
  'play-by-play': { csv: playByPlayCsv, label: 'play-by-play' },
  summary: { csv: summaryCsv, label: 'summary' },
};

export function buildCsv(game, kind) {
  const exporter = EXPORTERS[kind];
  if (!exporter) throw new Error(`Unknown export kind: ${kind}`);
  return exporter.csv(game);
}

export function buildFileName(game, kind, extension = 'csv') {
  return fileName(game, kind, extension);
}

/**
 * Trigger a client-side download. GitHub Pages serves static files only, so
 * every export has to be produced in the browser like this.
 *
 * A BOM is prepended to CSV so Excel opens UTF-8 team and player names
 * correctly instead of mojibake.
 */
export function download(filename, text, mime = 'text/csv;charset=utf-8') {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Downloading is only available in a browser.');
  }

  const parts = mime.startsWith('text/csv') ? ['\uFEFF', text] : [text];
  const blob = new Blob(parts, { type: mime });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(game, kind) {
  download(fileName(game, kind, 'csv'), buildCsv(game, kind));
}

export function downloadJson(game, kind = 'game') {
  download(
    fileName(game, kind, 'json'),
    gameJson(game),
    'application/json;charset=utf-8',
  );
}

/**
 * Validate and adopt an exported game.
 *
 * Reusing `deserialize` means an import is checked by the same rules as a
 * saved session, so a hand-edited or truncated file is rejected with a message
 * instead of replacing a live game with junk.
 */
export function importGame(fileText) {
  const game = deserialize(fileText);
  if (!game) {
    return { game: null, error: 'That file is not a valid game export.' };
  }
  if (!game.players || !Array.isArray(game.players) || !Array.isArray(game.events)) {
    return { game: null, error: 'That export is missing its roster or event log.' };
  }
  return { game, error: null };
}
