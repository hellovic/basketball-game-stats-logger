/**
 * Stat catalog.
 *
 * A single source of truth for every statistic the app can record: how it is
 * labelled, how it is abbreviated in the box score, whether it is a shooting
 * stat (and therefore worth a "made" / "missed" pair), and how many points a
 * make is worth.
 *
 * Everything else in the app derives its behaviour from this table, so adding
 * a stat here is the only change needed to record it.
 */

export const SHOOTING = 'shooting';
export const REBOUND = 'rebound';
export const COUNTING = 'counting';

export const STATS = [
  {
    key: '2PT',
    kind: SHOOTING,
    label: '2PT',
    longLabel: '2-point field goal',
    short: '2P',
    points: 2,
  },
  {
    key: '3PT',
    kind: SHOOTING,
    label: '3PT',
    longLabel: '3-point field goal',
    short: '3P',
    points: 3,
  },
  {
    key: 'FT',
    kind: SHOOTING,
    label: 'FT',
    longLabel: 'Free throw',
    short: 'FT',
    points: 1,
  },
  {
    key: 'REB',
    kind: REBOUND,
    label: 'REB',
    longLabel: 'Rebound',
    short: 'REB',
    points: 0,
  },
  {
    key: 'AST',
    kind: COUNTING,
    label: 'AST',
    longLabel: 'Assist',
    short: 'AST',
    points: 0,
  },
  {
    key: 'STL',
    kind: COUNTING,
    label: 'STL',
    longLabel: 'Steal',
    short: 'STL',
    points: 0,
  },
  {
    key: 'BLK',
    kind: COUNTING,
    label: 'BLK',
    longLabel: 'Block',
    short: 'BLK',
    points: 0,
  },
  {
    key: 'TO',
    kind: COUNTING,
    label: 'TO',
    longLabel: 'Turnover',
    short: 'TO',
    points: 0,
  },
  {
    key: 'PF',
    kind: COUNTING,
    label: 'PF',
    longLabel: 'Personal foul',
    short: 'PF',
    points: 0,
  },
];

const BY_KEY = new Map(STATS.map((s) => [s.key, s]));

/** Look up a stat definition by its key, or null when the key is unknown. */
export function getStat(key) {
  return BY_KEY.get(key) || null;
}

/** True when the stat is a shot and therefore has made / missed outcomes. */
export function isShooting(key) {
  const stat = getStat(key);
  return Boolean(stat && stat.kind === SHOOTING);
}

/** Points awarded for a made shot. Counting and rebound stats are worth zero. */
export function pointsFor(key, result) {
  const stat = getStat(key);
  if (!stat || stat.kind !== SHOOTING) return 0;
  return result === 'made' ? stat.points : 0;
}

/** Human label for an event, e.g. "Missed 3PT" or "Defensive rebound". */
export function describeEvent(key, result) {
  const stat = getStat(key);
  if (!stat) return 'Unknown stat';
  if (stat.kind === SHOOTING) {
    return `${result === 'made' ? 'Made' : 'Missed'} ${stat.label}`;
  }
  if (stat.kind === REBOUND) {
    return result === 'OFF' ? 'Offensive rebound' : 'Defensive rebound';
  }
  return stat.longLabel;
}

/**
 * The ordered set of one-tap buttons shown on a player card.
 * Each entry is { key, result, label, title, kind }.
 */
export function entryButtons() {
  const buttons = [];
  for (const stat of STATS) {
    if (stat.kind === SHOOTING) {
      buttons.push({
        key: stat.key,
        result: 'made',
        label: `+${stat.points}`,
        title: `Made ${stat.label}`,
        kind: 'made',
      });
      buttons.push({
        key: stat.key,
        result: 'missed',
        label: 'miss',
        title: `Missed ${stat.label}`,
        kind: 'miss',
      });
    } else if (stat.kind === REBOUND) {
      buttons.push({
        key: stat.key,
        result: 'OFF',
        label: 'OFF',
        title: 'Offensive rebound',
        kind: 'count',
      });
      buttons.push({
        key: stat.key,
        result: 'DEF',
        label: 'DEF',
        title: 'Defensive rebound',
        kind: 'count',
      });
    } else {
      buttons.push({
        key: stat.key,
        result: null,
        label: stat.label,
        title: stat.longLabel,
        kind: 'count',
      });
    }
  }
  return buttons;
}
