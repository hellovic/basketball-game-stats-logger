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

import { LINEUP, SHOOTING, REBOUND, STATS, eventPoints, getStat, isShooting } from './stats.js';
import { clock, periodLabel } from './format.js';
import { elapsedInPeriod, periodLength } from './clock.js';

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

/**
 * Attach the derived rates without storing them.
 *
 * Every one of these is a read of the same line, so nothing here can drift from
 * the raw counts beside it — which is the whole reason the box score is
 * computed rather than kept.
 *
 * `withPercentages` keeps its name because that is what the callers ask for;
 * the last two entries are a rate and a score rather than a percentage.
 */
function withPercentages(line) {
  const threes = line['3PT'];
  const threesAtt = threes.made + threes.missed;

  // True shooting weighs every trip to the line as 0.44 of a possession, which
  // is the standard way to fold free throws into a single shooting number.
  const trueShooting = 2 * (line.fgAtt + 0.44 * line.ftAtt);

  return {
    ...line,
    fgPct: line.fgAtt === 0 ? null : line.fgMade / line.fgAtt,
    ftPct: line.ftAtt === 0 ? null : line.ftMade / line.ftAtt,
    fg3Pct: threesAtt === 0 ? null : threes.made / threesAtt,
    // Effective field goal: a three is worth half a make more than a two.
    efgPct: line.fgAtt === 0 ? null : (line.fgMade + 0.5 * threes.made) / line.fgAtt,
    tsPct: trueShooting === 0 ? null : line.points / trueShooting,
    // FIBA's efficiency, the number on a scoresheet: what the player added
    // minus what the misses and turnovers cost. It can go negative.
    eff:
      line.points + line.reb + line.ast + line.stl + line.blk -
      (line.fgAtt - line.fgMade + (line.ftAtt - line.ftMade) + line.to),
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
    // Minutes on the floor and plus/minus, with the five each team has out
    // there now. Derived with everything else, so a deleted substitution takes
    // its minutes with it.
    floor: floorReport(game),
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
 * Seconds of game clock before the given period starts.
 *
 * Minutes are measured on this timeline rather than on a counter that ticks
 * while the clock runs: the scorer can correct the clock at any point in a game,
 * and a stint measured between two timestamps survives that, where an
 * accumulator would not.
 */
function periodStart(game, period) {
  let total = 0;
  for (let earlier = 1; earlier < period; earlier += 1) {
    total += periodLength(game, earlier);
  }
  return total;
}

/**
 * How far into a period its last recorded reading sits, or null for none.
 *
 * This is where the evidence ends rather than where the clock was left: the
 * readings are stamped when an entry is made, so the furthest of them is the
 * latest moment the scorer demonstrably had the game running.
 */
function furthestReading(game, period) {
  let furthest = null;
  for (const event of game.events) {
    if (event.period !== period) continue;
    const at = elapsedInPeriod(game, event);
    if (at !== null && (furthest === null || at > furthest)) furthest = at;
  }
  return furthest;
}

/** Where an event sits on that timeline. */
function eventSeconds(game, event) {
  return periodStart(game, event.period) + (elapsedInPeriod(game, event) ?? 0);
}

/**
 * Who was on the floor, and what that is worth.
 *
 * Two numbers come out of one pass over the events, because both need the same
 * fact — who was on the floor when a thing happened — and neither is stored:
 * delete a substitution and the minutes and the plus/minus both recompute, the
 * same as every other total in the app.
 *
 * The clock is what makes minutes real. A period whose readings never leave the
 * start of the period was never run, so it contributes no time to anybody; that
 * is reported rather than papered over with wall-clock guesses. Plus/minus needs
 * no clock at all — it is points for and against while a player was on — so it
 * stays correct even in a game that was never timed.
 */
export function floorReport(game) {
  const periods = listPeriods(game);
  const minutes = {};
  const plusMinus = {};
  for (const player of game.players) {
    minutes[player.id] = 0;
    plusMinus[player.id] = 0;
  }

  // A period is timed as soon as one reading sits inside it: at 0 or at the full
  // length the clock has not moved, so there is nothing to measure against. Two
  // cases have no reading to judge from — a period the game has already moved
  // past, and the one being played right now — and both are taken as timed
  // unless the live clock says otherwise, because the alternative is to throw
  // away the minutes in a period nobody disputed.
  const interior = (reading, length) =>
    typeof reading === 'number' && reading > 0 && reading < length;

  const timed = new Set();
  for (const period of periods) {
    const length = periodLength(game, period);
    const inPeriod = game.events.filter((event) => event.period === period);

    if (inPeriod.length === 0) {
      const current = game.currentPeriod || 1;
      if (period < current || (period === current && interior(game.clock?.seconds, length))) {
        timed.add(period);
      }
      continue;
    }

    if (inPeriod.some((event) => interior(event.clockSeconds, length))) timed.add(period);
  }

  const untimedPeriods = periods.filter(
    (period) =>
      !timed.has(period) && game.events.some((event) => event.period === period),
  );

  const onFloor = new Map();
  const cameOnAt = new Map();
  let tracked = false;

  const floorOf = (teamId) => {
    if (!onFloor.has(teamId)) onFloor.set(teamId, new Set());
    return onFloor.get(teamId);
  };

  // Credit a stint, split at the period boundaries it crosses so an untimed
  // period inside it can be left out.
  const closeStint = (playerId, from, to) => {
    if (!(playerId in minutes) || to <= from) return;
    for (const period of periods) {
      if (!timed.has(period)) continue;
      const start = periodStart(game, period);
      const overlap = Math.max(0, Math.min(to, start + periodLength(game, period)) - Math.max(from, start));
      minutes[playerId] += overlap;
    }
  };

  for (const event of game.events) {
    const stat = getStat(event.stat);

    if (stat && stat.kind === LINEUP) {
      tracked = true;
      const at = eventSeconds(game, event);
      const floor = floorOf(event.teamId);

      if (event.playerId && floor.has(event.playerId)) {
        floor.delete(event.playerId);
        closeStint(event.playerId, cameOnAt.get(event.playerId) ?? at, at);
        cameOnAt.delete(event.playerId);
      }
      if (event.subInId && !floor.has(event.subInId)) {
        floor.add(event.subInId);
        cameOnAt.set(event.subInId, at);
      }
      continue;
    }

    const points = eventPoints(event);
    if (points <= 0) continue;

    // Plus/minus is read off the floor as it stands: the five out there while
    // the ball goes in take the credit, the other five take the debit.
    for (const [teamId, players] of onFloor) {
      const swing = teamId === event.teamId ? points : -points;
      for (const playerId of players) {
        if (playerId in plusMinus) plusMinus[playerId] += swing;
      }
    }
  }

  // A stint still open at the end runs to the live clock, so minutes read as
  // "so far" during a game rather than only settling at the next substitution.
  //
  // The clock is not always ahead of the play, though: a scorer stops it for a
  // stoppage and forgets to start it again, corrects it, or leaves it where an
  // older correction was typed. An open stint therefore ends at whichever is
  // later — the clock, or the furthest reading in the period — because a clock
  // left five minutes behind the last entry would otherwise hand the last five
  // minutes of the game to nobody at all.
  const openPeriod = game.currentPeriod || 1;
  const liveElapsed = elapsedInPeriod(game, {
    period: openPeriod,
    clockSeconds: game.clock?.seconds ?? 0,
  });
  const now =
    periodStart(game, openPeriod) +
    Math.max(liveElapsed ?? 0, furthestReading(game, openPeriod) ?? 0);
  for (const [, players] of onFloor) {
    for (const playerId of players) {
      closeStint(playerId, cameOnAt.get(playerId) ?? now, now);
    }
  }

  // Who is on the floor right now, as plain data: the entry table shades those
  // rows and the substitution flow offers only the ones that make sense.
  const onCourt = {};
  for (const [teamId, players] of onFloor) onCourt[teamId] = [...players];

  return { tracked, minutes, plusMinus, untimedPeriods, onCourt };
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

  // Minutes come from the clock as much as from the log, so a clock left behind
  // the last entry silently shortens everyone's time on court — and the clock is
  // one edit away from being anywhere. Nothing is blocked (a scorer is mid-game
  // and has no time to untangle it) but it is named while the table is still set
  // up, rather than found in the report afterwards.
  if (derived.floor.tracked) {
    const period = game.currentPeriod || 1;
    const live = elapsedInPeriod(game, { period, clockSeconds: game.clock?.seconds ?? 0 });
    const furthest = furthestReading(game, period);
    // A few seconds of slack, because the clock is read a moment before the tap
    // lands and a reading one second 'behind' is not a mistake.
    if (live !== null && furthest !== null && furthest - live > 5) {
      warnings.push({
        level: 'warn',
        message:
          `The clock reads ${clock(game.clock?.seconds ?? 0)} in ${periodLabel(period, game.periodsPerGame)} ` +
          `but the last entry is at ${clock(furthest)}, so on-court minutes are ` +
          `${clock(furthest - live)} short until they agree.`,
      });
    }
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
