/**
 * Team file format: saving a team to JSON and reading one back.
 *
 * The in-app team library (see `teamlib.js`) lives in `localStorage`, which is
 * scoped to one browser on one device. A file is the portable version: it can be
 * mailed to another coach, carried to the scorer's laptop, and it doubles as a
 * backup that survives clearing site data.
 *
 * The format is deliberately small and forgiving on read — unknown fields are
 * ignored and missing jersey numbers are tolerated — so a hand-edited file still
 * loads. `format` is checked so that pasting the *whole game* backup into the
 * team importer produces a clear message rather than a mangled roster.
 *
 * No DOM access, so this is unit tested directly.
 */

export const TEAM_FILE_FORMAT = 'game-stats-logger/team';
export const TEAM_FILE_VERSION = 1;

/**
 * Capture a team and its roster from a game, ready to be written to a file.
 *
 * Internal player ids are deliberately left behind: they would mean nothing in
 * another browser, and `mergeRoster` assigns fresh ones on load.
 */
export function teamFromGame(game, teamId, name) {
  const team = game?.teams?.[teamId];
  if (!team) return null;

  return {
    name: String(name || team.name || 'Team').trim(),
    abbreviation: String(team.abbreviation || '').trim().toUpperCase().slice(0, 4),
    players: game.players
      .filter((player) => player.teamId === teamId)
      .sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0))
      .map((player) => ({
        number: String(player.number ?? '').trim(),
        name: String(player.name ?? '').trim(),
        active: player.active !== false,
      })),
  };
}

/**
 * Wrap a team (from `teamFromGame` or the library) for saving.
 *
 * `exportedAt` and the app version are for the person reading the file later,
 * not for the importer.
 */
export function teamFileJson(team, { appVersion = null, exportedAt = Date.now() } = {}) {
  const payload = {
    format: TEAM_FILE_FORMAT,
    version: TEAM_FILE_VERSION,
    appVersion,
    exportedAt,
    team: {
      name: String(team?.name ?? '').trim() || 'Team',
      abbreviation: String(team?.abbreviation ?? '').trim().toUpperCase().slice(0, 4),
      players: (team?.players ?? []).map((player) => ({
        number: String(player?.number ?? '').trim(),
        name: String(player?.name ?? '').trim(),
        active: player?.active !== false,
      })),
    },
  };

  return JSON.stringify(payload, null, 2);
}

/** `2026-01-17_Northside_team.json`, safe for every filesystem. */
export function teamFileName(team) {
  const name =
    String(team?.name ?? '')
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'team';
  return `${name}_team.json`;
}

/** Count only genuine roster entries: a player with no number and no name. */
function isRealPlayer(player) {
  return Boolean(String(player?.number ?? '').trim() || String(player?.name ?? '').trim());
}

/**
 * Read a team file.
 *
 * Returns `{ team, error }` and never throws: a wrong file is a normal thing for
 * a user to pick, so it is reported rather than crashing the importer.
 */
export function parseTeamFile(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { team: null, error: 'That file is empty.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { team: null, error: 'That file is not valid JSON.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { team: null, error: 'That file is not a team export.' };
  }

  // Point at the right importer when someone picks the full-game backup.
  if (parsed.game || parsed.format === 'game-stats-logger/game') {
    return {
      team: null,
      error:
        'That is a full game backup, not a team. Use "Restore from JSON…" in the ' +
        'Export panel for that file.',
    };
  }

  const raw = parsed.team ?? parsed;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { team: null, error: 'That file does not contain a team.' };
  }

  const players = (Array.isArray(raw.players) ? raw.players : [])
    .filter((player) => player && typeof player === 'object' && isRealPlayer(player))
    .map((player) => ({
      number: String(player.number ?? '').trim(),
      name: String(player.name ?? '').trim(),
      active: player.active !== false,
    }));

  // A jersey number is a better fallback than a blank line in the roster.
  for (const player of players) {
    if (!player.name) player.name = player.number ? `#${player.number}` : 'Player';
  }

  const name = String(raw.name ?? '').trim();
  if (!name && players.length === 0) {
    return { team: null, error: 'That team file has no name and no players.' };
  }
  if (players.length === 0) {
    return { team: null, error: `"${name || 'That team'}" has no players in it.` };
  }

  return {
    team: {
      name: name || 'Imported team',
      abbreviation: String(raw.abbreviation ?? '').trim().toUpperCase().slice(0, 4),
      players,
    },
    error: null,
  };
}
