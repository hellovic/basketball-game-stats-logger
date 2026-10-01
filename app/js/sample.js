/**
 * A realistic sample game used to seed the app on first run.
 *
 * The design review depends on seeing a fully populated screen, and an empty
 * app is also a confusing first impression. Rather than duplicating markup in a
 * separate mockup file, the real app loads this and one button clears it.
 *
 * Ids and timestamps are fixed so the seed is deterministic: the same game
 * every time, and the play-by-play reads in a believable order.
 */

import { addEvent, createGame, updateTeam } from './store.js';
import { periodLength } from './clock.js';

const BASE_TIME = Date.UTC(2026, 0, 17, 19, 30, 0);

const HOME_TEAM = 'team_home_northside';
const AWAY_TEAM = 'team_away_riverside';

const ROSTER = {
  home: [
    { id: 'player_h4', number: '4', name: 'J. Reed' },
    { id: 'player_h7', number: '7', name: 'A. Cole' },
    { id: 'player_h11', number: '11', name: 'D. Okafor' },
    { id: 'player_h23', number: '23', name: 'T. Nguyen' },
    { id: 'player_h32', number: '32', name: 'S. Whitfield' },
    { id: 'player_h15', number: '15', name: 'M. Ferrer' },
    { id: 'player_h41', number: '41', name: 'A. Bergstrom' },
  ],
  away: [
    { id: 'player_a5', number: '5', name: 'M. Diaz' },
    { id: 'player_a8', number: '8', name: 'R. Feldman' },
    { id: 'player_a12', number: '12', name: 'K. Boyd' },
    { id: 'player_a21', number: '21', name: 'L. Mwangi' },
    { id: 'player_a34', number: '34', name: 'P. Alvarez' },
    { id: 'player_a2', number: '2', name: 'T. Okonkwo' },
    { id: 'player_a44', number: '44', name: 'D. Lindqvist' },
  ],
};

/**
 * The five each side starts with, and the changes it makes.
 *
 * A game with nobody on the floor has no minutes and no plus/minus, and the
 * sample exists to show what a populated screen looks like — so it carries a
 * bench and a substitution or two, the same way it carries a score.
 */
const LINEUP_EVENTS = [
  { t: 0, team: 'home', on: 'player_h4' },
  { t: 0, team: 'home', on: 'player_h7' },
  { t: 0, team: 'home', on: 'player_h11' },
  { t: 0, team: 'home', on: 'player_h23' },
  { t: 0, team: 'home', on: 'player_h32' },
  { t: 0, team: 'away', on: 'player_a5' },
  { t: 0, team: 'away', on: 'player_a8' },
  { t: 0, team: 'away', on: 'player_a12' },
  { t: 0, team: 'away', on: 'player_a21' },
  { t: 0, team: 'away', on: 'player_a34' },
  // The bench gets a run in the second quarter, and again in the third — both
  // before the moment the clock is sitting at, so the sample has players on the
  // floor rather than substitutions that have not happened yet.
  { t: 12.5, team: 'home', off: 'player_h32', on: 'player_h15' },
  { t: 14.0, team: 'away', off: 'player_a8', on: 'player_a2' },
  { t: 21.2, team: 'home', off: 'player_h15', on: 'player_h41' },
  { t: 21.8, team: 'away', off: 'player_a2', on: 'player_a44' },
];

/**
 * A hand-built timeline. `t` is the offset in minutes from tip-off, which is
 * what gives the play-by-play its ordering and its clock times.
 */
const TIMELINE = [
  // --- Q1 ---------------------------------------------------------------
  { t: 0.5, team: 'away', player: 'player_a5', stat: '3PT', result: 'made' },
  { t: 1.1, team: 'home', player: 'player_h4', stat: '2PT', result: 'made' },
  { t: 2.0, team: 'home', player: 'player_h7', stat: '3PT', result: 'made', assist: 'player_h4' },
  { t: 3.4, team: 'home', player: 'player_h4', stat: 'REB', result: 'DEF' },
  { t: 4.2, team: 'home', player: 'player_h4', stat: '2PT', result: 'made' },
  { t: 5.0, team: 'away', player: 'player_a12', stat: '2PT', result: 'made' },
  { t: 5.8, team: 'away', player: 'player_a21', stat: 'REB', result: 'DEF' },
  { t: 6.5, team: 'home', player: 'player_h23', stat: '2PT', result: 'made' },
  { t: 7.2, team: 'away', player: 'player_a8', stat: 'TO', result: null },
  { t: 8.0, team: 'home', player: 'player_h11', stat: 'REB', result: 'OFF' },
  { t: 9.1, team: 'home', player: 'player_h23', stat: '2PT', result: 'made' },

  // --- Q2 ---------------------------------------------------------------
  { t: 11.0, team: 'home', player: 'player_h11', stat: '2PT', result: 'made' },
  { t: 12.0, team: 'away', player: 'player_a5', stat: '3PT', result: 'made', assist: 'player_a12' },
  { t: 13.2, team: 'away', player: 'player_a34', stat: 'BLK', result: null },
  { t: 14.0, team: 'home', player: 'player_h32', stat: 'FT', result: 'made' },
  { t: 15.0, team: 'away', player: 'player_a12', stat: '2PT', result: 'made' },
  { t: 16.2, team: 'home', player: 'player_h11', stat: '2PT', result: 'made' },
  { t: 17.0, team: 'home', player: 'player_h4', stat: '3PT', result: 'made' },
  { t: 18.1, team: 'away', player: 'player_a8', stat: 'REB', result: 'DEF' },
  { t: 19.0, team: 'away', player: 'player_a34', stat: '2PT', result: 'made' },

  // --- Q3 (the period in progress) --------------------------------------
  { t: 21.0, team: 'away', player: 'player_a5', stat: '3PT', result: 'made' },
  { t: 22.0, team: 'home', player: 'player_h4', stat: '2PT', result: 'made', assist: 'player_h7' },
  { t: 23.0, team: 'away', player: 'player_a12', stat: '2PT', result: 'made' },
  { t: 24.0, team: 'home', player: 'player_h11', stat: 'REB', result: 'DEF' },
  { t: 25.0, team: 'home', player: 'player_h11', stat: '2PT', result: 'made' },
  { t: 26.0, team: 'away', player: 'player_a21', stat: 'STL', result: null },
  { t: 27.0, team: 'away', player: 'player_a21', stat: '2PT', result: 'made' },
  { t: 28.0, team: 'home', player: 'player_h7', stat: '3PT', result: 'made', assist: 'player_h23' },
  // Misses matter: they are what make the FG% and FT% columns meaningful, and
  // a sample with only makes would hide that whole part of the design.
  { t: 28.6, team: 'away', player: 'player_a34', stat: '2PT', result: 'missed' },
  { t: 29.0, team: 'home', player: 'player_h32', stat: 'PF', result: null },
  { t: 29.4, team: 'home', player: 'player_h4', stat: '3PT', result: 'missed' },
  { t: 29.7, team: 'away', player: 'player_a34', stat: '2PT', result: 'made' },
];

/** The timeline is written against ten-minute periods. */
const PERIOD_MINUTES = 10;

/** Which period a timeline entry belongs to. */
function periodOf(offsetMinutes) {
  return Math.floor(offsetMinutes / PERIOD_MINUTES) + 1;
}

/**
 * Seconds left on the game clock at a timeline offset.
 *
 * The sample records a real clock value per event so its play-by-play reads in
 * game time like a live game, instead of every row showing the single clock the
 * game happened to be created with.
 */
function clockAt(game, offsetMinutes) {
  const elapsed = (offsetMinutes % PERIOD_MINUTES) * 60;
  return Math.max(0, Math.round(periodLength(game) - elapsed));
}

/**
 * Build the seeded game. `addEvent` is reused rather than hand-writing event
 * objects, so the sample is validated by the same rules as real entry — if the
 * sample were malformed, the app would fail to load it rather than hide it.
 */
export function sampleGame() {
  const game = createGame({
    id: 'game_sample',
    date: '2026-01-17',
    time: '14:30',
    venue: 'Riverside Gymnasium',
    periodsPerGame: 4,
    currentPeriod: 3,
    clock: { running: false, seconds: 412 },
  });

  game.homeTeamId = HOME_TEAM;
  game.awayTeamId = AWAY_TEAM;
  game.teams = {
    [HOME_TEAM]: { id: HOME_TEAM, name: 'Northside', abbreviation: 'NOR', color: 'blue' },
    [AWAY_TEAM]: { id: AWAY_TEAM, name: 'Riverside', abbreviation: 'RIV', color: 'red' },
  };
  updateTeam(game, HOME_TEAM, { name: 'Northside', abbreviation: 'NOR' });

  game.players = [];
  for (const [slot, roster] of Object.entries(ROSTER)) {
    const teamId = slot === 'home' ? HOME_TEAM : AWAY_TEAM;
    for (const player of roster) {
      game.players.push({ ...player, teamId, active: true });
    }
  }

  game.events = [];

  // The lineup changes are interleaved with the plays by their minute offset,
  // because who is on the floor when a basket goes in is what plus/minus reads.
  const script = [
    ...TIMELINE,
    ...LINEUP_EVENTS.map((entry) => ({ ...entry, stat: 'SUB' })),
  ].sort((a, b) => a.t - b.t);

  for (const entry of script) {
    const teamId = entry.team === 'home' ? HOME_TEAM : AWAY_TEAM;
    const ts = BASE_TIME + Math.round(entry.t * 60 * 1000);
    const period = periodOf(entry.t);

    if (entry.stat === 'SUB') {
      addEvent(game, {
        teamId,
        playerId: entry.off ?? null,
        subInId: entry.on ?? null,
        stat: 'SUB',
        period,
        ts,
        clockSeconds: clockAt(game, entry.t),
      });
      continue;
    }

    addEvent(game, {
      teamId,
      playerId: entry.player,
      stat: entry.stat,
      result: entry.result,
      period,
      ts,
      clockSeconds: clockAt(game, entry.t),
    });

    // An assist is a separate one-tap entry in the real app, so record it as
    // its own event rather than a field on the shot.
    if (entry.assist) {
      addEvent(game, {
        teamId,
        playerId: entry.assist,
        stat: 'AST',
        result: null,
        period,
        ts: ts + 1000,
        clockSeconds: clockAt(game, entry.t),
      });
    }
  }

  game.currentPeriod = 3;
  game.createdAt = BASE_TIME;
  game.updatedAt = BASE_TIME;

  return game;
}

export { HOME_TEAM, AWAY_TEAM, ROSTER, TIMELINE, BASE_TIME };
