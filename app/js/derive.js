/**
 * Derivation engine.
 *
 * Everything the UI shows as a total is computed here from the raw event list.
 * No totals are ever stored, which is what makes undo and mid-game corrections
 * exact: delete an event and every period score, team total and player line
 * recomputes from scratch.
 *
 * This module is intentionally free of DOM access so the tests can import it.
 */

import { SHOOTING, REBOUND, STATS, eventPoints, getStat, isShooting } from './stats.js';
import { periodLabel } from './format.js';

/** Is this event attributed to a specific player? */
function hasPlayer(event) {
  return Boolean(event.playerId);
}

/**
 * Is this event one of the "team-level" entries used for opponent rebounds and
 * team turnovers? Those deliberately carry no player so they never inflate a
 * player's line while still occupying the correct team total.
 */
export function isTeamLevel(event) {
  return !hasPlayer(event);
}

/** An empty accumulator for one player or one team. */
function emptyLine() {
  const line = {
    points: 0,
    reb: 0,
    rebOff: 0,
    rebDef: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    to: 0,
    pf: 0,
    fgMade: 0,
    fgAtt: 0,
    ftMade: 0,
    ftAtt: 0,
  };
  for (const stat of STATS) {
    if (isShooting(stat.key)) {
      line[stat.key] = { made: 0, missed: 0 };
    }
  }
  return line;
}

function addEventToLine(line, event) {
  const stat = getStat(event.stat);
  if (!stat) return;

  const made = event.result === 'made';
  line.points += eventPoints(event);

  if (stat.kind === SHOOTING) {
    line[stat.key][made ? 'made' : 'missed'] += 1;
    if (event.stat === 'FT') {
      line.ftAtt += 1;
      if (made) line.ftMade += 1;
    } else {
      line.fgAtt += 1;
      if (made) line.fgMade += 1;
    }
  } else if (stat.kind === REBOUND) {
    line.reb += 1;
    if (event.result === 'OFF') line.rebOff += 1;
    else line.rebDef += 1;
  } else {
    const key = event.stat.toLowerCase();
    if (key in line) line[key] += 1;
  }
}

/** Attach the derived percentages without storing them. */
function withPercentages(line) {
  return {
    ...line,
    fgPct: line.fgAtt === 0 ? null : line.fgMade / line.fgAtt,
    ftPct: line.ftAtt === 0 ? null : line.ftMade / line.ftAtt,
  };
}

/**
 * Every period that has any event, plus at least `minimumPeriods` periods (and
 * at least `currentPeriod`), in ascending order. This is why overtime simply
 * appears: logging an event in period 5 makes period 5 exist.
 */
export function listPeriods(game) {
  const seen = new Set();
  for (const event of game.events) seen.add(event.period);
  const highest = seen.size === 0 ? 0 : Math.max(...seen);
  const total = Math.max(
    highest,
    game.periodsPerGame || 4,
    isFinite(game.currentPeriod) ? game.currentPeriod : 1,
  );
  const periods = [];
  for (let p = 1; p <= total; p += 1) periods.push(p);
  return periods;
}

/** Raw points scored by a team in one period, ignoring overrides. */
export function derivedPeriodPoints(game, teamId, period) {
  let points = 0;
  for (const event of game.events) {
    if (event.teamId !== teamId || event.period !== period) continue;
    points += eventPoints(event);
  }
  return points;
}

/**
 * Points shown for a team in one period. Always derived from the logged
 * events: there is no manual override, so the scoreboard, scoresheet and box
 * score cannot disagree.
 */
export function periodScore(game, teamId, period) {
  return derivedPeriodPoints(game, teamId, period);
}

/** Running total for a team: the sum of its period scores. */
export function teamTotal(game, teamId) {
  let total = 0;
  for (const period of listPeriods(game)) total += periodScore(game, teamId, period);
  return total;
}

/**
 * The quarter-by-quarter grid shown on the scoreboard and the scoresheet. Every
 * cell is derived from logged events, so there is nothing to flag.
 *
 * Home leads, matching the scoreboard above it: the home side is the left-hand
 * block and the top row of the strip, so the two read as the same order.
 */
export function periodGrid(game) {
  const periods = listPeriods(game);
  const rows = [game.homeTeamId, game.awayTeamId].filter(Boolean).map((teamId) => {
    const cells = periods.map((period) => ({
      period,
      value: periodScore(game, teamId, period),
    }));
    return {
      teamId,
      cells,
      total: cells.reduce((sum, cell) => sum + cell.value, 0),
    };
  });
  return { periods, rows };
}

/** Full stat line for one player, derived from their events. */
export function playerLine(game, playerId) {
  const line = emptyLine();
  let events = 0;
  for (const event of game.events) {
    if (event.playerId !== playerId) continue;
    addEventToLine(line, event);
    events += 1;
  }
  return withPercentages({ ...line, playerId, events });
}

/**
 * Team totals including team-level events, so it always equals the sum of team
 * points regardless of whether the scorer attributed every entry to a player.
 */
export function teamLine(game, teamId) {
  const line = emptyLine();
  let teamEvents = 0;
  for (const event of game.events) {
    if (event.teamId !== teamId) continue;
    addEventToLine(line, event);
    if (isTeamLevel(event)) teamEvents += 1;
  }
  return withPercentages({ ...line, teamId, teamEvents });
}

/**
 * The whole derived picture for a game, in one pass over the events.
 *
 * Returns the period grid, per-player lines (keyed by player id) and per-team
 * lines, plus the point values used by the box score columns.
 */
export function computeGame(game) {
  const playerLines = {};
  for (const player of game.players) {
    playerLines[player.id] = emptyLine();
  }

  const teamLines = {};
  for (const player of game.players) {
    if (!(player.teamId in teamLines)) teamLines[player.teamId] = emptyLine();
  }
  for (const teamId of [game.awayTeamId, game.homeTeamId]) {
    if (teamId && !(teamId in teamLines)) teamLines[teamId] = emptyLine();
  }

  for (const event of game.events) {
    if (!(event.teamId in teamLines)) teamLines[event.teamId] = emptyLine();
    addEventToLine(teamLines[event.teamId], event);
    if (hasPlayer(event)) {
      if (!(event.playerId in playerLines)) playerLines[event.playerId] = emptyLine();
      addEventToLine(playerLines[event.playerId], event);
    }
  }

  const lines = {};
  for (const [playerId, line] of Object.entries(playerLines)) {
    lines[playerId] = withPercentages({ ...line, playerId });
  }
  const teamTotals = {};
  for (const [teamId, line] of Object.entries(teamLines)) {
    teamTotals[teamId] = withPercentages({ ...line, teamId });
  }

  return {
    grid: periodGrid(game),
    playerLines: lines,
    teamTotals,
    // Keyed by team id, matching grid.rows, so callers can cross-check
    // `row.total === scores[row.teamId]` without knowing which slot it is.
    scores: {
      [game.awayTeamId]: teamTotal(game, game.awayTeamId),
      [game.homeTeamId]: teamTotal(game, game.homeTeamId),
    },
    scoresBySlot: {
      away: teamTotal(game, game.awayTeamId),
      home: teamTotal(game, game.homeTeamId),
    },
  };
}

/**
 * Soft data-quality warnings. These never block entry — a scorer logging live
 * cannot stop to resolve a query — they surface after the fact so a mistake can
 * be found and corrected.
 */
export function consistencyWarnings(game) {
  const warnings = [];
  const derived = computeGame(game);

  for (const player of game.players) {
    const line = derived.playerLines[player.id];
    if (!line) continue;
    for (const stat of STATS) {
      if (!isShooting(stat.key)) continue;
      const tally = line[stat.key];
      const attempts = tally.made + tally.missed;
      if (tally.made > attempts) {
        warnings.push({
          level: 'warn',
          message: `${player.name} has more made ${stat.label} than attempts recorded.`,
        });
      }
    }
  }

  // A roster player with scoring events but no longer on the roster would make
  // the box score silently disagree with the scoreboard.
  const roster = new Set(game.players.map((p) => p.id));
  const unknown = new Set();
  for (const event of game.events) {
    if (hasPlayer(event) && !roster.has(event.playerId)) unknown.add(event.playerId);
  }
  if (unknown.size > 0) {
    warnings.push({
      level: 'warn',
      message:
        `${unknown.size} recorded event${unknown.size === 1 ? '' : 's'} belong to a ` +
        'player who is no longer on the roster, so the team totals include points ' +
        'that no player line shows.',
    });
  }

  // A typed team total is added on top of that team's player entries for the
  // period, which is right when it is the only thing recorded and a double count
  // when it is not. Nothing is blocked — a scorer mid-game has no time to
  // untangle it — but it is named afterwards so it can be corrected.
  for (const teamId of [game.awayTeamId, game.homeTeamId].filter(Boolean)) {
    for (const period of listPeriods(game)) {
      const inPeriod = (event) =>
        event.teamId === teamId && event.period === period;
      const typed = game.events.some((e) => inPeriod(e) && e.stat === 'TEAM_TOTAL');
      if (!typed) continue;

      const fromPlayers = game.events.filter(
        (e) => inPeriod(e) && e.stat !== 'TEAM_TOTAL' && eventPoints(e) > 0,
      ).length;
      if (fromPlayers === 0) continue;

      const team = game.teams[teamId]?.name || 'A team';
      const when = periodLabel(period, game.periodsPerGame);
      warnings.push({
        level: 'warn',
        message:
          `${team} has a typed total and ${fromPlayers} scoring ` +
          `entr${fromPlayers === 1 ? 'y' : 'ies'} in ${when}, so the scoreboard ` +
          'counts both.',
      });
    }
  }

  return warnings;
}
