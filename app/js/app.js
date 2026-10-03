/**
 * UI layer.
 *
 * This is the only module that touches the DOM. It owns rendering and event
 * wiring, and delegates every calculation to `derive.js` and every mutation to
 * `store.js` so the displayed numbers are always recomputed from the event log
 * rather than patched in place.
 *
 * Re-rendering on every entry is deliberate: the views are small, and a full
 * re-render is what guarantees the scoreboard, scoresheet and box score can
 * never drift apart.
 */

import {
  addEvent,
  addPlayer,
  appendRoster,
  copyGameAsNew,
  createGame,
  deleteEvent,
  eventsNewestFirst,
  loadState,
  mergeRoster,
  playersOf,
  removePlayer,
  saveState,
  setClock,
  setClockRunning,
  setFinished,
  setPeriod,
  setPeriodsPerGame,
  setTeamPeriodTotal,
  swapSides,
  teamPeriodTotal,
  undoLastEvent,
  updateEvent,
  updateTeam,
} from './store.js';
import { LINEUP, describeEvent, entryButtons, eventPoints, getStat } from './stats.js';
import { parseTeamFile, teamFileJson, teamFileName, teamFromGame } from './teamfile.js';
import { parseRosterText } from './rosterimport.js';
import {
  computeGame,
  consistencyWarnings,
  derivedPeriodPoints,
  listPeriods,
  playerLine,
  shotAttempts,
  teamLine,
} from './derive.js';
import {
  displayDate,
  displayTime,
  eventClock,
  madeAttempted,
  pct,
  periodLabel,
  safeText,
  structureLabel,
} from './format.js';
import * as clockface from './clock.js';
import { download, downloadCsv, downloadJson, importGame } from './export.js';
import { sampleGame } from './sample.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let game = loadState();
if (!game) game = sampleGame();

let detailTeamSlot = 'home';
let toastTimer = null;
let clockTimer = null;

/**
 * Which of the three panels is currently stretched across the whole workspace,
 * or null for the ordinary two-column layout.
 *
 * The two columns are the right shape for a full game on a tablet, but any one
 * of them can want the whole width — the entry row and the box score both have
 * more columns than fit beside the other column on a smaller screen. Expanding
 * hides the other two rather than reflowing them, so nothing moves under the
 * scorer's finger while they are reading.
 */
let expandedPanel = null;

/**
 * Which column the expanded box score is sorted by, or null for roster order.
 *
 * A view choice, not part of the game: it is deliberately not saved with the
 * score, so opening an archived game never reorders it before the coach has
 * asked for anything.
 */
let boxSort = null;

/**
 * The player the box score is marking, or null.
 *
 * A reading aid, not a selection to act on: the table is wide, and a marked row
 * is one that can be followed across it without the eye slipping to the row
 * above. Like the sort, it is not saved with the game.
 */
let boxPick = null;

/**
 * The substitution being entered, or null.
 *
 * Two taps in order — who comes off, then who comes on — held here rather than
 * as a mode on the panel, because a half-finished substitution is a real state:
 * the scorer looks up, the ball goes the other way, and the banner has to be
 * able to say what it is still waiting for.
 */
let subStep = null;

/**
 * How the panel chrome names itself in tooltips and labels.
 */
const PANEL_NAMES = { entry: 'live entry', log: 'play-by-play', box: 'box score' };

/**
 * How tall Live entry's stat keys are, smallest first.
 *
 * Only Live entry has one: it is the panel a scorer works down, and the whole
 * point is fitting the roster on screen without a scroll. The default is the
 * second smallest, because a scorer would rather see two more players than have
 * a taller key — and the sizes above it are there for a scorer with fewer names
 * to fit and a finger that wants the room.
 */
const KEY_SIZES = ['tiny', 'compact', 'normal', 'roomy'];
let keySize = 'compact';

/**
 * The action waiting on a yes/no answer, or null when nothing is pending.
 *
 * Held as a closure rather than as a name to dispatch on later, so a queued
 * action cannot be run twice or swapped for a different one underneath.
 */
let pendingDanger = null;

const $ = (id) => document.getElementById(id);

function save() {
  const result = saveState(game);
  if (!result.ok) showToast('Could not save — the game is only in memory.');
  return result;
}

/**
 * Start the clock, refilling it from the period length if it is sitting at
 * 00:00. A clock at zero is between periods, so starting it starts a period.
 *
 * Starting and ticking belong together: every way into a running clock goes
 * through here, and a clock that is flagged as running without a tick pending
 * is a green face that never counts down. Logging a stat starts the clock, so
 * that is not a rare state to reach.
 */
function startClock() {
  if (game.clock.running || clockIsClosed()) return;

  const { seconds, fromZero } = clockface.startValue(game);
  setClock(game, seconds);
  setClockRunning(game, true);
  ensureClockTicking();

  if (fromZero) {
    showToast(
      `Clock set to ${clockface.display(seconds)} for ` +
        `${clockface.label(game.currentPeriod, game.periodsPerGame)}.`,
    );
  }
}

/** Start the clock if it is idle, so a live game keeps moving on its own. */
function startClockIfIdle() {
  if (!game.clock.running) startClock();
}

/**
 * Start or stop the clock, from the face.
 *
 * Tapping the readout is the move a scorer makes without looking, so that tap
 * runs the clock. While the face is open for typing a tap belongs to the text —
 * it places the cursor rather than stopping the clock mid-edit.
 */
function toggleClock() {
  if (clockIsBeingEdited()) return;

  if (game.clock.running) {
    setClockRunning(game, false);
    save();
  } else {
    startClock();
    save();
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The colours a team can wear, in the order they are offered.
 *
 * The rainbow, plus the two kit colours that are not in it. Keys, not colour
 * values: the ink and the tint are defined together in the stylesheet, because
 * two of these cannot be printed as themselves and stay readable — see the
 * palette there. Blue and red are the defaults, which is why an untouched game
 * already looks the way it did before any of this existed.
 */
const TEAM_COLORS = [
  { key: 'red', label: 'Red' },
  { key: 'orange', label: 'Orange' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'green', label: 'Green' },
  { key: 'blue', label: 'Blue' },
  { key: 'indigo', label: 'Indigo' },
  { key: 'violet', label: 'Violet' },
  { key: 'white', label: 'White' },
  { key: 'black', label: 'Black' },
];

/** The colour a team wears: what it chose, or the default for its side. */
function colorKeyFor(teamId) {
  const chosen = game.teams?.[teamId]?.color;
  if (TEAM_COLORS.some((entry) => entry.key === chosen)) return chosen;
  return teamId === game.homeTeamId ? 'blue' : 'red';
}

/** The accent colour a team should render in. */
function accentFor(teamId) {
  return `var(--team-${colorKeyFor(teamId)})`;
}

/** The tint that goes behind that accent, e.g. the raised team block. */
function softFor(teamId) {
  return `var(--team-${colorKeyFor(teamId)}-soft)`;
}

/**
 * A deeper tint of the same colour, for a whole row.
 *
 * A row has to be told apart from the row above it, not just from the page, so
 * it needs more than the faint tint a card wears.
 */
function washFor(teamId) {
  return `var(--team-${colorKeyFor(teamId)}-wash)`;
}

function teamFor(slot) {
  return game.teams[slot === 'home' ? game.homeTeamId : game.awayTeamId];
}

function teamIdFor(slot) {
  return slot === 'home' ? game.homeTeamId : game.awayTeamId;
}

function render() {
  const derived = computeGame(game);

  renderScoreboard(derived);
  renderRoster(derived);
  renderTeamFields();
  renderEntry(derived);
  renderSubbar();
  renderTeamTotal();
  renderLog(derived);
  renderBox(derived);
  renderSheet(derived);
  renderFooter();
  renderTeamLibrary();
  renderMenuState();
  renderWorkspace();

  $('undo-button').disabled = game.events.length === 0;

  renderClockRunState();

  // Running and ticking are the same fact, so a render reconciles them. Anything
  // that flips the clock — a start from a stat, an undo, an import — passes
  // through here, and nothing can leave a green face that is not counting.
  ensureClockTicking();

  renderWarnings();
}

/**
 * The at-a-glance answer to "is it running?".
 *
 * This used to be a 10px dot and nothing else, which a scorer looking up
 * mid-play never saw. Now the clock face itself carries the state — the box and
 * its digits turn blue and light up on the start — and the run button fills in,
 * so the answer is readable from across the table rather than from arm's
 * length. Stopped is the plain box it has always been, so the difference is
 * between two states rather than between two shades.
 *
 * The face is also the run control, so it says what a tap will do. While it is
 * open for typing the label belongs to the text field instead.
 */
function renderClockRunState() {
  const running = Boolean(game.clock.running);

  $('clock-box').classList.toggle('is-running', running);
  $('clock-dot').classList.toggle('is-running', running);
  $('clock-card').classList.toggle('is-finished', Boolean(game.finishedAt));
  if (!clockIsBeingEdited()) setClockFaceMode(false);
}

/**
 * Point the clock face at the job it is doing: run control, or text field.
 *
 * One element is both because they are the same number in the same place, and a
 * scorer reads it constantly. The role and the label have to follow, or a
 * screen reader would announce a text box that typing does nothing in.
 */
function setClockFaceMode(editing) {
  const face = $('clock-display');
  face.setAttribute('contenteditable', editing ? 'true' : 'false');
  face.setAttribute('role', editing ? 'textbox' : 'button');
  face.setAttribute(
    'aria-label',
    editing
      ? 'Game clock, editable'
      : game.finishedAt
        ? 'Game clock, final'
        : `Game clock, tap to ${game.clock.running ? 'stop' : 'start'}`,
  );
}

function renderScoreboard(derived) {
  const home = teamFor('home');
  const away = teamFor('away');

  // The teams' colours are set here rather than by the home/away classes, so a
  // team keeps the colour it was given even after the two sides swap.
  for (const slot of ['home', 'away']) {
    const teamId = teamIdFor(slot);
    const block = $(`team-block-${slot}`);
    if (!block || !teamId) continue;
    block.style.setProperty('--team-accent', accentFor(teamId));
    block.style.setProperty('--team-soft', softFor(teamId));
  }

  $('score-home-name').textContent = safeText(home?.name, 'Home');
  $('score-away-name').textContent = safeText(away?.name, 'Away');
  $('score-home-abbrev').textContent = safeText(home?.abbreviation, 'HOM');
  $('score-away-abbrev').textContent = safeText(away?.abbreviation, 'AWY');
  $('score-home').textContent = derived.scores[game.homeTeamId] ?? 0;
  $('score-away').textContent = derived.scores[game.awayTeamId] ?? 0;

  // Skip the clock face while it is being typed into, so a re-render cannot
  // overwrite a half-entered value.
  if (!clockIsBeingEdited()) {
    $('clock-display').textContent = clockface.display(game.clock.seconds);
  }
  $('period-display').textContent = periodLabel(game.currentPeriod, game.periodsPerGame);
}

/**
 * The team tabs and the name/abbreviation fields, which live on the settings
 * strip now that the roster no longer owns a column of its own.
 *
 * The box score carries its own pair of tabs. They are a second handle on the
 * same choice rather than a separate one, so both sets are kept in step here:
 * whichever tab was tapped, the whole app is entering that team's events.
 */
function renderTeamFields() {
  for (const slot of ['home', 'away']) {
    const selected = String(detailTeamSlot === slot);
    for (const prefix of ['team-tab', 'box-tab']) {
      const tab = $(`${prefix}-${slot}`);
      if (tab) tab.setAttribute('aria-selected', selected);
    }

    // The side being scored reads as the raised card, so it is obvious where
    // the next tap lands even before the row colours are read.
    const block = $(`team-block-${slot}`);
    if (block) {
      if (detailTeamSlot === slot) block.classList.add('is-current');
      else block.classList.remove('is-current');
    }
  }

  $('team-name-input').value = safeText(teamFor(detailTeamSlot)?.name);
  $('team-abbrev-input').value = safeText(teamFor(detailTeamSlot)?.abbreviation);
  renderTeamColors();
}

/**
 * The colour chip on the roster bar, and the swatches in the picker it opens.
 *
 * The bar keeps one chip rather than the whole palette: nine colours is a wall
 * of circles to read past on every screen when the choice is made once a game,
 * and the chip says what was chosen without having to be decoded.
 */
function renderTeamColors() {
  const teamId = teamIdFor(detailTeamSlot);
  const current = colorKeyFor(teamId);
  const team = safeText(teamFor(detailTeamSlot)?.name) || 'this team';

  const chosen = TEAM_COLORS.find((entry) => entry.key === current);
  $('team-color-dot').className = `color-chip__dot color-chip__dot--${current}`;
  $('team-color-name').textContent = chosen.label;
  $('team-color-button').setAttribute('aria-label', `Team colour for ${team}: ${chosen.label}`);

  // The swatches are named, not just coloured: "White" and "Black" have to be
  // readable as words before they are readable as circles.
  $('team-colors').innerHTML = TEAM_COLORS.map(({ key, label }) => {
    const on = key === current;
    return `<button type="button" class="swatch swatch--${key}${on ? ' is-current' : ''}"
      data-action="set-team-color" data-color="${key}"
      aria-pressed="${on}" aria-label="${label}">
      <span class="swatch__chip" aria-hidden="true"></span>
      <span class="swatch__name">${label}</span>
    </button>`;
  }).join('');

  $('color-dialog-title').textContent = `Colour for ${team}`;
  $('team-colors').setAttribute('aria-label', `Colour for ${team}`);
}

/**
 * The strip that walks a substitution through its two taps.
 *
 * It says what the next tap is for, in the panel where the taps happen, and it
 * carries the way out: a scorer who starts a substitution and then sees the
 * ball go the other way should not have to guess how to abandon it.
 */
function renderSubbar() {
  const bar = $('subbar');
  const text = $('subbar-text');

  if (!subStep) {
    bar.hidden = true;
    $('sub-entry').textContent = 'Sub';
    return;
  }

  bar.hidden = false;

  if (subStep.stage === 'start') {
    const left = 5 - subStep.picked.length;
    $('sub-entry').textContent = 'Start';
    text.textContent =
      `Tap ${left === 5 ? 'the five' : `${left} more`} starting: ` +
      (subStep.picked.length ? subStep.picked.map(nameOfPlayer).join(', ') : 'nobody yet');
    return;
  }

  $('sub-entry').textContent = 'Sub';
  text.textContent =
    subStep.stage === 'off'
      ? 'Substitution — tap the player coming off'
      : `Substitution — ${nameOfPlayer(subStep.offId)} off: tap the player coming on`;
}

/** A player's name as the scorer reads it, number first. */
function nameOfPlayer(playerId) {
  const player = game.players.find((entry) => entry.id === playerId);
  if (!player) return '';
  return `${player.number ? `#${player.number} ` : ''}${player.name}`;
}

/** The same, for a player already in hand. */
function playerLabel(player) {
  return `${player.number ? `#${player.number} ` : ''}${player.name}`;
}

/**
 * One tap of the substitution flow.
 *
 * Which tap it is decides what counts as an answer: a player already on the
 * floor cannot come on, and one sitting down cannot come off.
 */
function pickSubPlayer(playerId) {
  if (!subStep) return;

  const teamId = teamIdFor(detailTeamSlot);
  const onCourt = new Set(computeGame(game).floor.onCourt[teamId] ?? []);

  if (subStep.stage === 'start') {
    if (onCourt.has(playerId) || subStep.picked.includes(playerId)) return;
    subStep.picked.push(playerId);
    if (subStep.picked.length === 5) {
      const starters = subStep.picked;
      subStep = null;
      recordLineup(starters.map((id) => ({ teamId, subInId: id })));
      showToast('Five on the floor. Minutes and +/- will follow them.');
      return;
    }
    render();
    return;
  }

  if (subStep.stage === 'off') {
    if (!onCourt.has(playerId)) return;
    subStep = { stage: 'on', offId: playerId };
    render();
    return;
  }

  if (onCourt.has(playerId) || playerId === subStep.offId) return;
  const { offId } = subStep;
  subStep = null;
  recordLineup([{ teamId, playerId: offId, subInId: playerId }]);
  showToast(`${nameOfPlayer(playerId)} is on for ${nameOfPlayer(offId)}.`);
}

/**
 * Write one or more lineup changes and re-render.
 *
 * The starting five is five of these at the same moment; a substitution is one.
 * They go through `addEvent` like everything else, so undo and the play-by-play
 * treat them the same way as a basket does.
 */
function recordLineup(changes) {
  for (const change of changes) {
    const outcome = addEvent(game, {
      teamId: change.teamId,
      playerId: change.playerId ?? null,
      subInId: change.subInId ?? null,
      stat: 'SUB',
    });
    if (outcome.error) {
      showToast(outcome.error);
      break;
    }
  }
  save();
  render();
}

/**
 * The roster list in the Team and players dialog: one line per player, each
 * with the control that takes them off it.
 *
 * Removal lives here rather than on the entry rows because this is where a
 * roster is edited. The entry table is for recording what happens in the game,
 * and a tap on one of its rows is a stat, not a selection.
 */
function renderRoster() {
  const list = $('roster-list');
  if (!list) return;

  const roster = playersOf(game, teamIdFor(detailTeamSlot));

  list.innerHTML =
    roster.length === 0
      ? '<li class="roster-list__empty">No players yet &mdash; add one above.</li>'
      : roster
          .map((player) => {
            const name = escapeHtml(player.name);
            return `
        <li class="roster-list__row">
          <span class="roster-list__number">${escapeHtml(player.number) || '&mdash;'}</span>
          <span class="roster-list__name" title="${name}">${name}</span>
          <button type="button" class="roster-list__remove" data-action="remove-player"
                  data-player-id="${escapeHtml(player.id)}"
                  aria-label="Remove ${name}" title="Remove ${name}">&times;</button>
        </li>`;
          })
          .join('');
}

/**
 * Take one player off the roster, along with the entries they logged.
 *
 * Deleting the entries is what keeps the app's promise intact: a removed
 * player's points leave the scoreboard and the box score at the same moment, so
 * the two cannot drift apart. The alternative — keeping an entry whose player is
 * gone — leaves points that no player line accounts for, which the app reports
 * as a problem under the scoresheet.
 */
function removePlayerFromRoster(playerId) {
  const player = playersOf(game, teamIdFor(detailTeamSlot)).find(
    (candidate) => candidate.id === playerId,
  );
  if (!player) return;

  // A substitution names two players, so a player leaving the roster takes the
  // changes they were part of — either side of them — with them. Leaving one
  // behind would put a stranger on the floor and minutes against nobody.
  const theirs = (event) => event.playerId === playerId || event.subInId === playerId;
  const entries = game.events.filter(theirs).length;
  const detail =
    entries > 0
      ? `${entries} recorded ${entries === 1 ? 'entry' : 'entries'} will be deleted ` +
        'with this player, and the score and box score will drop.'
      : 'Their place in the roster is all that goes.';

  askBefore({
    title: `Remove ${player.name}?`,
    // Removing a player is not an event, so the ordinary undo (which pops the
    // last entry) cannot reverse this. The confirmation is the safety net.
    text: `${detail} Removing a player cannot be undone.`,
    confirmLabel: 'Remove player',
    run: () => {
      removePlayer(game, playerId);
      game.events = game.events.filter((event) => !theirs(event));

      save();
      render();

      showToast(
        entries > 0
          ? `${player.name} removed with ${entries} ${entries === 1 ? 'entry' : 'entries'}.`
          : `${player.name} removed.`,
      );
    },
  });
}


/**
 * One cell per key, so every button shares a table column with the heading
 * above it. A single spanning cell laid out by flexbox drifts: the buttons size
 * themselves and the headings stay where the table put them, which is what put
 * "+1" over the wrong button.
 *
 * `owner` says whose tap it is: a player, or the team itself when the sides are
 * being scored without a roster. A row whose owner is off the floor keeps its
 * cells and loses what is in them — the names still read, and the keys a player
 * on the bench cannot be scoring from are not there to be hit by mistake.
 */
function keyCells(list, group, owner) {
  return list
    .map((b) =>
      owner.benched
        ? `<td class="player-card__key player-card__keys--${group}"></td>`
        : `
          <td class="player-card__key player-card__keys--${group}">
            <button type="button"
                    class="stat-btn stat-btn--${b.kind}"
                    data-action="${owner.action}"
                    ${owner.playerId ? `data-player-id="${escapeHtml(owner.playerId)}"` : ''}
                    data-stat="${b.key}"
                    data-result="${b.result ?? ''}"
                    title="${escapeHtml(b.title)}"
                    aria-label="${escapeHtml(`${b.title} for ${owner.name}`)}">${escapeHtml(b.label)}</button>
          </td>`,
    )
    .join('');
}

/**
 * The live entry table: one row per player, and the team's own row at the foot.
 *
 * The row is a table row rather than a card because the keys, the running
 * totals and the column headings all have to line up down the page — a scorer
 * finds "the third player's rebounds" by reading one column, not by re-finding
 * a card. The fourteen columns are the player and thirteen keys.
 *
 * The team row is always there, roster or not. A side whose players are not
 * being tracked still has a score and still takes rebounds, and the team's line
 * is what the box score reads for it — so the same keys, addressed to the team
 * instead of to a name, are the difference between a scoresheet and nothing.
 */
function renderEntry(derived) {
  const container = $('player-cards');

  // Entry works for one team at a time: a scorer is entering one team's events.
  const teamId = teamIdFor(detailTeamSlot);
  const roster = playersOf(game, teamId).filter((player) => player.active !== false);
  const teamName = safeText(game.teams[teamId]?.name, 'this team');

  const accent = accentFor(teamId);

  // Who is on the floor decides both the shading on each row and which rows a
  // substitution can use.
  const onCourt = new Set(derived.floor.onCourt[teamId] ?? []);
  // A team whose five have never been named has no bench to speak of: until
  // there is a floor to be left off, every row is one the scorer may need, and
  // none of them lose their keys.
  const floorKnown = Array.isArray(derived.floor.onCourt[teamId]);
  const pickedStarters = subStep?.stage === 'start' ? new Set(subStep.picked) : new Set();

  // The keys go quiet while a substitution is being entered: the next tap is a
  // player, and a stat key under the scorer's finger is the wrong answer.
  $('panel-entry').classList.toggle('is-subbing', Boolean(subStep));

  // Every button the app can record, in catalog order. The three groups below
  // line up with the three column groups.
  const buttons = entryButtons();
  const makes = buttons.filter((b) => b.kind === 'made');
  const misses = buttons.filter((b) => b.kind === 'miss');
  const counts = buttons.filter((b) => b.kind === 'count');

  const playerRows = roster
    .map((player) => {
      const line = derived.playerLines[player.id] || playerLine(game, player.id);
      const name = escapeHtml(player.name);
      const isOn = onCourt.has(player.id) || pickedStarters.has(player.id);
      const benched = floorKnown && !isOn;

      /**
       * In the middle of a substitution only some rows are the right answer:
       * whoever is on the floor comes off, whoever is not comes on. The rest
       * are dimmed rather than hidden, so the roster stays where the scorer
       * left it.
       */
      const wanted =
        !subStep ||
        subStep.stage === 'start' ||
        (subStep.stage === 'off' ? isOn : !isOn);
      const action = subStep ? 'sub-pick' : 'player-row';

      const owner = {
        action: 'log-stat',
        playerId: player.id,
        name: player.name,
        benched,
      };

      return `
        <tr class="player-card${isOn ? ' player-card--on' : ''}${
          floorKnown && !isOn ? ' player-card--bench' : ''
        }${
          subStep && wanted ? ' player-card--wanted' : ''
        }${
          subStep && !wanted ? ' player-card--passed' : ''
        }"
            style="--accent: ${accent}; --wash: ${washFor(teamId)}" data-action="${action}"
            data-player-id="${escapeHtml(player.id)}">
          <td class="player-card__who">
            <span class="player-card__number">${escapeHtml(player.number) || '—'}</span>
            <span class="player-card__name" title="${name}">${name}</span>
          </td>
          ${keyCells(makes, 'scoring', owner)}${keyCells(misses, 'scoring', owner)}${keyCells(counts, 'other', owner)}
        </tr>`;
    })
    .join('');

  // The team's own row: no jersey, no floor, and no substitutions — it is not a
  // person. Everything else it wears is what a player's row wears, because a tap
  // on it records exactly the same kind of entry, addressed to the side.
  const teamRow = `
        <tr class="entry__team" style="--accent: ${accent}" data-team-id="${escapeHtml(teamId)}">
          <td class="player-card__who">
            <span class="player-card__number">&mdash;</span>
            <span class="player-card__name" title="Stats for ${escapeHtml(teamName)} itself, not for a player">Team</span>
          </td>
          ${keyCells(makes, 'scoring', { action: 'log-team-stat', name: 'the team' })}${keyCells(misses, 'scoring', { action: 'log-team-stat', name: 'the team' })}${keyCells(counts, 'other', { action: 'log-team-stat', name: 'the team' })}
        </tr>`;

  // A roster that has not been set up yet says so above the team row, which is
  // the row that works without one.
  const noRoster =
    roster.length === 0
      ? '<tr class="entry__empty"><td colspan="14">No players yet — tap the team ' +
        'row below, or add players under More → Team and players.</td></tr>'
      : '';

  container.innerHTML = `${noRoster}${playerRows}${teamRow}`;
}

/**
 * Reflect the expanded panel into the workspace.
 *
 * The layout itself is CSS (`is-expanded` plus `data-focus`); this only keeps
 * that attribute and the three buttons in step with the model, so a re-render
 * from any other action cannot leave a button lying about the layout.
 */
function renderWorkspace() {
  const workspace = $('workspace');
  if (!workspace) return;

  if (expandedPanel) {
    workspace.classList.add('is-expanded');
    workspace.setAttribute('data-focus', expandedPanel);
  } else {
    workspace.classList.remove('is-expanded');
    workspace.removeAttribute('data-focus');
  }

  for (const panel of ['entry', 'log', 'box']) {
    const name = PANEL_NAMES[panel];
    const expand = $(`expand-${panel}`);
    if (expand) {
      const active = expandedPanel === panel;
      expand.setAttribute('aria-pressed', String(active));
      expand.title = active
        ? `Put ${name} back beside the others`
        : `Stretch ${name} across the whole width`;
    }
  }

  const entry = $('panel-entry');
  if (entry) entry.setAttribute('data-density', keySize);

  // The ends of the range are real: a smaller key than the smallest is not a
  // thing to offer, so the button says so rather than doing nothing.
  const step = KEY_SIZES.indexOf(keySize);
  const smaller = $('key-down-entry');
  const larger = $('key-up-entry');
  if (smaller) smaller.disabled = step === 0;
  if (larger) larger.disabled = step === KEY_SIZES.length - 1;
}

/**
 * The typed team total for the side being scored, in the period being scored.
 *
 * The box shows what was typed rather than the period score, so it stays the
 * thing you edit: a blank box means nobody has typed one, and the scoreboard
 * below is whatever the entries come to.
 */
function renderTeamTotal() {
  const input = $('teamtotal-input');
  if (!input) return;

  $('teamtotal-period').textContent = periodLabel(game.currentPeriod, game.periodsPerGame);

  // Never overwrite a number that is being typed.
  if (document.activeElement === input) return;

  const typed = teamPeriodTotal(game, teamIdFor(detailTeamSlot), game.currentPeriod);
  input.value = typed === null ? '' : String(typed);
}

/**
 * Take what is in the team total box.
 *
 * One entry per team per period, replaced rather than added, so retyping is the
 * correction and an empty box takes the entry back out.
 */
function commitTeamTotal(raw) {
  const teamId = teamIdFor(detailTeamSlot);
  const text = String(raw ?? '').trim();
  setTeamPeriodTotal(game, teamId, game.currentPeriod, text === '' ? 0 : Number(text));
  save();
  render();

  const typed = teamPeriodTotal(game, teamId, game.currentPeriod);
  const team = safeText(game.teams[teamId]?.name, 'Team');
  const period = periodLabel(game.currentPeriod, game.periodsPerGame);
  showToast(
    typed === null
      ? `Cleared the ${team} total for ${period}.`
      : `${team}: ${typed} in ${period}.`,
  );
}

function renderLog(derived) {
  const list = $('log-list');

  if (game.events.length === 0) {
    list.innerHTML =
      '<li class="log__empty">' +
      '<strong class="log__empty-title">No plays recorded yet</strong>' +
      '<span class="log__empty-text">Tap any action beside a player and the ' +
      'event will appear here instantly.</span>' +
      '</li>';
    return;
  }

  // Newest first, in game order: the most recent entry is the one most likely to
  // be wrong, and a time corrected after the fact moves its row to where the
  // play actually happened rather than staying where it was typed.
  const ordered = eventsNewestFirst(game);

  list.innerHTML = ordered
    .map((event) => {
      const player = game.players.find((p) => p.id === event.playerId);
      const incoming = event.subInId
        ? game.players.find((p) => p.id === event.subInId)
        : null;
      const points = eventPoints(event);

      // A substitution is one act at the table, so it is one row: the pair is
      // named together and deleted together. Nothing else can be done to it —
      // re-attributing a swap of two players has no meaning.
      const isSub = getStat(event.stat)?.kind === LINEUP;
      if (isSub) {
        const off = player ? playerLabel(player) : null;
        const on = incoming ? playerLabel(incoming) : null;
        const who = off || on || 'TEAM';
        const what = on && off
          ? `${on} on for ${off}`
          : on
            ? `${on} onto the floor`
            : `${off} off the floor`;

        return `
        <li class="log__row log__row--team" data-event-id="${escapeHtml(event.id)}"
            style="--accent: ${accentFor(event.teamId)}">
          <span class="log__time">${timeEditor(event)}</span>
          <span class="log__period">${periodEditor(event)}</span>
          <span class="log__who">${escapeHtml(who)}</span>
          <span class="log__what">${escapeHtml(what)}</span>
          <span class="log__points"></span>
          <span class="log__reassign"></span>
          <button type="button" class="log__delete" data-action="delete-event"
                  data-event-id="${escapeHtml(event.id)}"
                  aria-label="Delete this substitution">&times;</button>
        </li>`;
      }

      const who = player
        ? `${player.number ? `#${player.number} ` : ''}${player.name}`
        : 'TEAM';

      return `
        <li class="log__row${player ? '' : ' log__row--team'}" data-event-id="${escapeHtml(event.id)}"
            style="--accent: ${accentFor(event.teamId)}">
          <span class="log__time">${timeEditor(event)}</span>
          <span class="log__period">${periodEditor(event)}</span>
          <span class="log__who">${escapeHtml(who)}</span>
          <span class="log__what">${escapeHtml(describeEvent(event.stat, event.result))}</span>
          <span class="log__points">${points > 0 ? `+${points}` : ''}</span>
          ${player ? reassignSelect(event) : '<span class="log__reassign"></span>'}
          <button type="button" class="log__delete" data-action="delete-event"
                  data-event-id="${escapeHtml(event.id)}"
                  aria-label="Delete this entry">&times;</button>
        </li>`;
    })
    .join('');
}

/**
 * When an entry happened: the time, and the period it is filed under.
 *
 * Both are read off the row, so both are corrected on the row. The time is the
 * one a scorer most often gets wrong after the fact — a play logged when it was
 * noticed rather than when it happened — and it is typed in the same shapes as
 * the clock: 7:30, 0730, or a bare count of seconds.
 */
function timeEditor(event) {
  const elapsed = clockface.elapsedInPeriod(game, event);
  return `<input class="log__time-edit" data-action="edit-event-time"
    data-event-id="${escapeHtml(event.id)}"
    value="${escapeHtml(eventClock(elapsed))}"
    inputmode="numeric" maxlength="5" autocomplete="off"
    aria-label="Time of this entry" title="When this happened, e.g. 7:30">`;
}

function periodEditor(event) {
  const options = listPeriods(game)
    .map(
      (period) =>
        `<option value="${period}"${period === event.period ? ' selected' : ''}>` +
        `${escapeHtml(periodLabel(period, game.periodsPerGame))}</option>`,
    )
    .join('');
  return `<select class="log__period-edit" data-action="edit-event-period"
    data-event-id="${escapeHtml(event.id)}"
    aria-label="Period of this entry">${options}</select>`;
}

/**
 * Re-attribute an entry to a different player on the same team.
 *
 * Mis-tapping the wrong player is the most common in-game mistake, and it is
 * far quicker to fix here than to delete the entry and re-enter it (which would
 * also lose its place in the timeline). Only players from the event's own team
 * are offered, because an event belongs to exactly one team.
 */
function reassignSelect(event) {
  const roster = playersOf(game, event.teamId);
  const options = [
    // The team itself is a place an entry can belong: a rebound logged for the
    // side can turn out to be nobody's, and the other way round.
    `<option value=""${event.playerId ? '' : ' selected'}>TEAM</option>`,
    ...roster.map(
      (player) =>
        `<option value="${escapeHtml(player.id)}"${
          player.id === event.playerId ? ' selected' : ''
        }>${escapeHtml(`${player.number ? `#${player.number} ` : ''}${player.name}`)}</option>`,
    ),
  ];

  return `<select class="log__reassign" data-action="reassign-event"
                  data-event-id="${escapeHtml(event.id)}"
                  aria-label="Re-attribute this entry">${options.join('')}</select>`;
}

/**
 * A player's jersey number as something a sort can use.
 *
 * Numbers are stored as text, because a squad has numbers that are not plain
 * numerals (U14) and rows with none at all. The first run of digits is the
 * number a scorer reads off the back of a shirt; a player without one has no
 * rank, so they sink with the blanks rather than sorting as a zero.
 */
function jerseyNumber(number) {
  const digits = String(number ?? '').match(/\d+/);
  return digits ? Number(digits[0]) : null;
}

/**
 * The roster in the order the box score should read it.
 *
 * `boxSort` holds a column key and a direction; the column itself says what to
 * compare, which is not always what it prints. A rate with nothing behind it —
 * no attempts — has no rank at all, so it sinks to the bottom in either
 * direction rather than being read as a zero and winning "worst shooter".
 *
 * The Player heading is the one that sorts on something other than what it
 * prints: a box score is looked up by number, so it counts jerseys rather than
 * names — a name is how a player is recognised, a number is how they are found.
 */
function sortBoxRoster(roster, columns, derived) {
  if (!boxSort) return roster;

  const column = columns.find((entry) => entry.key === boxSort.key);
  if (!column && boxSort.key !== 'name') return roster;

  const valueOf = (player) =>
    boxSort.key === 'name'
      ? jerseyNumber(player.number)
      : column.sort(derived.playerLines[player.id], player);
  const slope = boxSort.direction === 'desc' ? -1 : 1;

  return [...roster].sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);

    if (left === null || left === undefined) {
      return right === null || right === undefined ? 0 : 1;
    }
    if (right === null || right === undefined) return -1;

    const comparison =
      typeof left === 'string' ? left.localeCompare(right) : left - right;
    // Ties keep the roster order the array came in, which is the jersey order a
    // coach already reads.
    return slope * comparison;
  });
}

function renderBox(derived) {
  const table = $('box-table');
  const expanded = expandedPanel === 'box';

  // The mark is a player, so it cannot outlive the player's place in the game:
  // a roster replaced or a player removed drops it rather than leaving a
  // highlight on nobody.
  if (boxPick && !game.players.some((player) => player.id === boxPick)) boxPick = null;

  // Each column knows what it prints and what it sorts on — the two are not the
  // same: a made–attempted column prints "4-5" and sorts on the four.
  const columns = [
    { key: 'pts', label: 'PTS', value: (l) => l.points, sort: (l) => l.points },
    {
      key: 'fg',
      label: 'FG',
      value: (l) => madeAttempted(l.fgMade, l.fgAtt),
      sort: (l) => l.fgMade,
    },
    {
      key: '3p',
      label: '3P',
      value: (l) => madeAttempted(l['3PT'].made, l['3PT'].made + l['3PT'].missed),
      sort: (l) => l['3PT'].made,
    },
    {
      key: 'ft',
      label: 'FT',
      value: (l) => madeAttempted(l.ftMade, l.ftAtt),
      sort: (l) => l.ftMade,
    },
    { key: 'reb', label: 'REB', value: (l) => l.reb, sort: (l) => l.reb },
    { key: 'oreb', label: 'OREB', value: (l) => l.rebOff, sort: (l) => l.rebOff },
    { key: 'dreb', label: 'DREB', value: (l) => l.rebDef, sort: (l) => l.rebDef },
    { key: 'ast', label: 'AST', value: (l) => l.ast, sort: (l) => l.ast },
    { key: 'stl', label: 'STL', value: (l) => l.stl, sort: (l) => l.stl },
    { key: 'blk', label: 'BLK', value: (l) => l.blk, sort: (l) => l.blk },
    { key: 'to', label: 'TO', value: (l) => l.to, sort: (l) => l.to },
    { key: 'pf', label: 'PF', value: (l) => l.pf, sort: (l) => l.pf },
  ];

  // Everything up to here is a tally of recorded events; what follows is read
  // off those tallies.
  const countingColumns = columns.length;

  // The rates read the same line the columns beside them do, and they only fit
  // once the panel has the whole width. That is what the Full width button on
  // this panel is for, so they are added there and nowhere else: the compact box
  // a scorer watches during play stays the twelve counting columns it was.
  if (expanded) {
    columns.push(
      { key: 'fgPct', label: 'FG%', value: (l) => pct(l.fgPct), sort: (l) => l.fgPct },
      { key: 'fg3Pct', label: '3P%', value: (l) => pct(l.fg3Pct), sort: (l) => l.fg3Pct },
      { key: 'ftPct', label: 'FT%', value: (l) => pct(l.ftPct), sort: (l) => l.ftPct },
      { key: 'efgPct', label: 'eFG%', value: (l) => pct(l.efgPct), sort: (l) => l.efgPct },
      { key: 'tsPct', label: 'TS%', value: (l) => pct(l.tsPct), sort: (l) => l.tsPct },
      { key: 'eff', label: 'EFF', value: (l) => l.eff, sort: (l) => l.eff },
    );

    // Minutes and plus/minus are about time and about who was out there, not
    // about the stat line: the column reads the floor report for the player in
    // the row. A team's row has no single answer to either, so it stays blank.
    if (derived.floor.tracked) {
      const { minutes, plusMinus } = derived.floor;
      const perPlayer = (pick, format) => ({
        value: (l, player) => (player ? format(pick(player)) : '—'),
        sort: (l, player) => (player ? pick(player) : null),
      });

      columns.push(
        {
          key: 'min',
          label: 'MIN',
          ...perPlayer(
            (player) => minutes[player.id] ?? 0,
            (seconds) => clockface.display(Math.round(seconds)),
          ),
        },
        {
          key: 'plusMinus',
          label: '+/-',
          ...perPlayer(
            (player) => plusMinus[player.id] ?? 0,
            (swing) => (swing > 0 ? `+${swing}` : String(swing)),
          ),
        },
      );
    }
  }

  // Everything after the counting columns is derived rather than recorded, so it
  // is ruled off to keep the eye from reading a rate as a tally.
  const cellClass = (index) => (index >= countingColumns ? ' class="is-advanced"' : '');

  // A heading is a button while the panel has the room to sort by it. Tapping
  // the column a coach reads a box score for — points, efficiency — should be
  // the fastest way to answer "who is on top", so the first tap sorts it that
  // way round and the second turns it over.
  const headCell = (key, label, index, title = label) => {
    const advanced = cellClass(index);
    if (!expanded) return `<th${advanced}>${label}</th>`;

    const active = boxSort?.key === key;
    const direction = active ? boxSort.direction : null;
    const arrow = direction ? (direction === 'desc' ? '&#8595;' : '&#8593;') : '';
    const ariaSort = direction === 'desc' ? 'descending' : direction ? 'ascending' : 'none';

    return (
      `<th${advanced} aria-sort="${ariaSort}">` +
      `<button type="button" class="box__sort${active ? ' is-sorted' : ''}"` +
      ` data-action="sort-box" data-column="${key}"` +
      ` title="Sort by ${title}">${label}` +
      `<span class="box__sort-arrow" aria-hidden="true">${arrow}</span></button></th>`
    );
  };

  const head = `<thead><tr>${headCell('name', 'Player', -1, 'jersey number')}${columns
    .map(({ key, label }, index) => headCell(key, label, index))
    .join('')}</tr></thead>`;

  const currentTeamId = teamIdFor(detailTeamSlot);
  const currentCount = playersOf(game, currentTeamId).length;
  $('box-team-name').textContent = `${safeText(game.teams[currentTeamId]?.name) || 'Team'} · ${currentCount} player${
    currentCount === 1 ? '' : 's'
  }`;
  // The headings only become buttons with the room the full width gives them, so
  // the hint is where the panel says so.
  $('box-hint').textContent = expanded ? 'Tap a heading to sort' : 'Both teams, every column';

  const body = [game.awayTeamId, game.homeTeamId]
    .filter(Boolean)
    .map((teamId) => {
      const team = game.teams[teamId];
      const teamLineValues = derived.teamTotals[teamId] || teamLine(game, teamId);

      // Sorting happens inside each team rather than across both: the table is
      // read team by team, and a heading that jumped between them would be
      // harder to follow than the roster order it replaces.
      const roster = sortBoxRoster(playersOf(game, teamId), columns, derived);

      // Both teams stay in one table so the two totals can be read against each
      // other; the heading of the team being entered is marked so it is obvious
      // where the next tap will land — in that team's own colour, which is what
      // the scoreboard and the strip above it are using for the same team.
      const heading = `<tr class="team-heading${
        teamId === currentTeamId ? ' is-current' : ''
      }" style="--team-accent: ${accentFor(teamId)}; --team-soft: ${softFor(teamId)}">
        <td colspan="${columns.length + 1}">${escapeHtml(team?.name || 'Team')}</td></tr>`;

      const playerRows = roster
        .map((player) => {
          const line = derived.playerLines[player.id];
          if (!line) return '';
          const picked = boxPick === player.id;
          const name = `${escapeHtml(player.number) ? `#${escapeHtml(player.number)} ` : ''}${escapeHtml(player.name)}`;

          // The row is the target — a coach marking a player is reading down a
          // line that runs the width of the table — and the name is a button so
          // the same mark can be set from the keyboard and announced.
          return `<tr class="box__row${picked ? ' is-picked' : ''}"
                      data-action="pick-box-row" data-player-id="${escapeHtml(player.id)}">
            <td class="js-name"><button type="button" class="box__name"
              data-action="pick-box-row" data-player-id="${escapeHtml(player.id)}"
              aria-pressed="${picked ? 'true' : 'false'}">${name}</button></td>
            ${columns
              .map(
                ({ value }, index) =>
                  `<td${cellClass(index)}>${escapeHtml(value(line, player))}</td>`,
              )
              .join('')}
          </tr>`;
        })
        .join('');

      // The shot profile is the same roster in the same order, so a sort by a
      // column moves both halves together, and the two can be read down one
      // after the other.
      const shots = roster.map((player) => ({
        player,
        shots: shotAttempts(game, player.id),
      }));
      const taken = shots.reduce((total, row) => total + row.shots.attempts, 0);
      const scored = shots.reduce((total, row) => total + row.shots.made, 0);

      const totals = `<tr class="row--team">
        <td>Team totals</td>
        ${columns
          .map(
            ({ value }, index) =>
              `<td${cellClass(index)}>${escapeHtml(value(teamLineValues, null))}</td>`,
          )
          .join('')}
      </tr>`;

      return {
        table: heading + playerRows + totals,
        profile: shotTeamRows(teamId, team, shots, taken, scored),
      };
    });

  table.innerHTML = `${head}<tbody>${body.map((rows) => rows.table).join('')}</tbody>`;

  // The profile is what the full width buys, so it is built only while the panel
  // has it: with the box open the clock re-renders this table once a second, and
  // there is nothing stale left behind when it closes.
  const profile = $('shot-profile');
  const rows = body.map((team) => team.profile).join('');
  profile.hidden = !expanded;
  profile.innerHTML = expanded ? shotHeading() + shotTable(rows) : '';
}

/**
 * What the profile is and how to read it: the squares are the app's own
 * language for a shot, so the legend is the keys a scorer already taps — solid
 * for a make, an outline for a miss.
 */
function shotHeading() {
  return `
  <p class="shot__label">Shot profile</p>
  <p class="shot__note">
    <span class="shot__chip is-made" aria-hidden="true"></span>made &middot;
    <span class="shot__chip" aria-hidden="true"></span>missed &middot;
    one square per attempt, in the order they were taken
  </p>`;
}

/**
 * The frame the profile is read in: one set of headings over both teams, the
 * same shape as the box score above it, so the two can be read down one after
 * the other.
 */
function shotTable(rows) {
  return `
  <table class="shot__table">
    <thead>
      <tr>
        <th scope="col">Player</th>
        <th scope="col">Two-point</th>
        <th scope="col">Three-point</th>
        <th scope="col">Free throw</th>
        <th scope="col" class="shot__made">Made</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * One team's stretch of the profile: a heading, then a row per player.
 *
 * One square per attempt, in the order they were taken, wearing the app's own
 * language for a shot — solid is a make, an outline is a miss, the same as the
 * keys on the entry row.
 */
function shotTeamRows(teamId, team, rows, taken, scored) {
  const chips = (list) =>
    list.length === 0
      ? '<span class="shot__none">&mdash;</span>'
      : list
          .map((shot) => `<span class="shot__chip${shot.made ? ' is-made' : ''}" title="${shot.made ? 'Made' : 'Missed'} in ${escapeHtml(periodLabel(shot.period, game.periodsPerGame))}"></span>`)
          .join('');

  const head = `
    <tr class="shot__team" style="--team-accent: ${accentFor(teamId)}; --team-soft: ${softFor(teamId)}">
      <th scope="rowgroup" colspan="4">${escapeHtml(team?.name || 'Team')}</th>
      <th scope="col" class="shot__made"><span class="shot__count">${scored} / ${taken}</span></th>
    </tr>`;

  return (
    head +
    rows
      .map(({ player, shots }) => {
        const name = `${player.number ? `#${escapeHtml(player.number)} ` : ''}${escapeHtml(player.name)}`;
        return `
    <tr class="shot__row">
      <th scope="row">${name}</th>
      <td class="shot__cell">${chips(shots.two)}</td>
      <td class="shot__cell">${chips(shots.three)}</td>
      <td class="shot__cell">${chips(shots.free)}</td>
      <td class="shot__cell shot__made">${
        shots.attempts === 0 ? '&mdash;' : `${shots.made} / ${shots.attempts}`
      }</td>
    </tr>`;
      })
      .join('')
  );
}

function renderSheet(derived) {
  const table = $('sheet-table');
  const periods = listPeriods(game);

  const head = `<thead><tr><th>Team</th>${periods
    .map((p) => `<th>${escapeHtml(periodLabel(p, game.periodsPerGame))}</th>`)
    .join('')}<th>Total</th></tr></thead>`;

  const body = derived.grid.rows
    .map((row) => {
      const team = game.teams[row.teamId];
      const cells = row.cells
        .map((cell) => `<td>${cell.value}</td>`)
        .join('');

      return `<tr>
        <td class="js-name" style="--accent: ${accentFor(row.teamId)}">
          <span class="sheet__team-dot" aria-hidden="true"></span>${escapeHtml(team?.name || 'Team')}
        </td>
        ${cells}
        <td class="row--team-total">${escapedNumber(row.total)}</td>
      </tr>`;
    })
    .join('');

  table.innerHTML = `${head}<tbody>${body}</tbody>`;
}

function escapedNumber(value) {
  return Number.isFinite(value) ? String(value) : '0';
}

function renderFooter() {
  $('game-date').value = safeText(game.date);
  $('game-time').value = safeText(game.time);
  $('game-venue').value = safeText(game.venue);
  $('game-periods').value = String(game.periodsPerGame);

  $('game-period-length').innerHTML = clockface.PERIOD_LENGTHS.map(
    (length) =>
      `<option value="${length.seconds}"${
        length.seconds === game.periodSeconds ? ' selected' : ''
      }>${escapeHtml(length.label)}</option>`,
  ).join('');

  // The strip above the sheet is a read-out, not a form. Everything editable
  // lives in the settings dialog; these pills only say what the game is, and
  // tapping one opens the dialog on the matching question.
  $('game-date-display').textContent = displayDate(game.date) || '—';
  $('game-time-display').textContent = displayTime(game.time) || '—';
  $('game-venue-display').textContent = safeText(game.venue) || '—';
  $('game-structure-display').textContent =
    structureLabel(game.periodsPerGame, game.periodSeconds) || '—';
  $('game-status').textContent = `${game.events.length} entr${
    game.events.length === 1 ? 'y' : 'ies'
  }`;

  // A finished game says so where the rest of the game's facts are read, so
  // an export taken later is not mistaken for one taken mid-quarter.
  $('game-final').hidden = !game.finishedAt;

  // Shown so a stale cached bundle is obvious at a glance when something looks
  // out of date. The build stamp is the discriminator: if you are expecting a
  // fix and this still reads the old stamp, the browser is running old code.
  const version = document.querySelector('meta[name="app-version"]')?.content;
  const build = document.querySelector('meta[name="app-build"]')?.content;
  const stamp = version ? `v${version}${build ? ` · ${build}` : ''}` : '';

  $('app-version').textContent = stamp;
  $('about-version').textContent = stamp;
}

/**
 * Saving needs at least one player, so the button reflects that rather than
 * failing after the fact.
 */
function renderTeamLibrary() {
  const count = playersOf(game, teamIdFor(detailTeamSlot)).length;
  const button = $('save-team-button');
  button.disabled = count === 0;
  button.title =
    count === 0 ? 'Add at least one player before saving this team' : '';
}

/**
 * Surface data problems. Shown under the scoresheet so they are visible while
 * reviewing the numbers, not buried in a settings page.
 */
function renderWarnings() {
  const note = $('warning-note');
  const parts = consistencyWarnings(game).map((warning) => warning.message);

  note.hidden = parts.length === 0;
  note.textContent = parts.join(' ');
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function showToast(message, { undo = false } = {}) {
  const toast = $('toast');

  clearTimeout(toastTimer);

  toast.innerHTML = `<span>${escapeHtml(message)}</span>${
    undo ? '<button type="button" class="toast__undo" data-action="undo">Undo</button>' : ''
  }<button type="button" class="toast__close" data-action="dismiss-toast"
     aria-label="Dismiss" title="Dismiss">&times;</button>`;
  toast.hidden = false;

  toastTimer = setTimeout(hideToast, undo ? 6000 : 2800);
}

/** Hide the toast now and cancel its auto-dismiss timer. */
function hideToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  $('toast').hidden = true;
}

function announce(message) {
  $('live-region').textContent = message;
}

/**
 * Flash the row an edit landed on.
 *
 * Correcting a time re-files the entry, so the row a scorer was looking at is
 * no longer where they left it. One flash says where it went.
 */
function flashLogRow(eventId) {
  const row = document.querySelector(`.log__row[data-event-id="${CSS.escape(eventId)}"]`);
  if (!row) return;
  row.classList.add('is-hit');
  setTimeout(() => row.classList.remove('is-hit'), 600);
}

/** Flash a row so a tap is visibly acknowledged. */
function flashRow(selector) {
  const row = document.querySelector(selector);
  if (!row) return;
  row.classList.add('is-hit');
  setTimeout(() => row.classList.remove('is-hit'), 220);
}

/** The same, for a player's row. */
function flashCard(playerId) {
  flashRow(`.player-card[data-player-id="${CSS.escape(playerId)}"]`);
}

/** And for the team's. */
function flashTeamRow() {
  flashRow('.entry__team');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function logStat(playerId, stat, result) {
  const player = game.players.find((p) => p.id === playerId);
  if (!player) return;

  const outcome = addEvent(game, {
    teamId: player.teamId,
    playerId,
    stat,
    result: result === '' ? null : result,
    period: game.currentPeriod,
  });

  if (outcome.error) {
    showToast(outcome.error);
    return;
  }

  startClockIfIdle();
  save();
  render();
  flashCard(playerId);

  const descriptor = describeEvent(stat, result === '' ? null : result);
  const points = result === 'made' ? (getStat(stat)?.points ?? 0) : 0;
  showToast(`${player.name}: ${descriptor}${points ? ` (+${points})` : ''}`, { undo: true });
  announce(`${player.name} ${descriptor}`);
}


/**
 * Record a stat against the team itself.
 *
 * A side being scored without a roster — the opponent whose players nobody
 * tracks, or a squad that has not been typed in yet — still has a score and
 * still takes rebounds, and the team's line is where that belongs. The entry
 * carries no player, which is what keeps it out of every player's line while
 * still counting for the team.
 */
function logTeamStat(stat, result) {
  const teamId = teamIdFor(detailTeamSlot);
  const outcome = addEvent(game, {
    teamId,
    playerId: null,
    stat,
    result: result === '' ? null : result,
    period: game.currentPeriod,
  });

  if (outcome.error) {
    showToast(outcome.error);
    return;
  }

  startClockIfIdle();
  save();
  render();
  flashTeamRow();

  const teamName = safeText(game.teams[teamId]?.name, 'The team');
  const descriptor = describeEvent(stat, result === '' ? null : result);
  const points = result === 'made' ? (getStat(stat)?.points ?? 0) : 0;
  showToast(`${teamName}: ${descriptor}${points ? ` (+${points})` : ''}`, { undo: true });
  announce(`${teamName} ${descriptor}`);
}

function performUndo() {
  const removed = undoLastEvent(game);
  if (!removed) return;
  save();
  render();
  const player = removed.playerId
    ? game.players.find((p) => p.id === removed.playerId)
    : null;
  showToast(`Undid ${describeEvent(removed.stat, removed.result)}${player ? ` for ${player.name}` : ''}`);
}

function handleDelete(eventId) {
  const removed = deleteEvent(game, eventId);
  if (!removed) return;
  save();
  render();
  const player = removed.playerId
    ? game.players.find((p) => p.id === removed.playerId)
    : null;
  showToast(
    `Deleted ${describeEvent(removed.stat, removed.result)}${player ? ` for ${player.name}` : ''}`,
  );
}

/** Move an entry from one player to another on the same team. */
function reassignEvent(eventId, playerId) {
  const previous = game.events.find((event) => event.id === eventId);
  if (!previous) return;

  const outcome = updateEvent(game, eventId, { playerId: playerId || null });
  if (outcome.error) {
    showToast(outcome.error);
    render();
    return;
  }

  save();
  render();

  const target = game.players.find((p) => p.id === playerId);
  const to = target ? target.name : `the ${safeText(game.teams[previous.teamId]?.name, 'team')} line`;
  showToast(`Moved ${describeEvent(previous.stat, previous.result)} to ${to}.`);
}

function addPlayerFromForm(event) {
  event.preventDefault();
  const number = $('new-number').value.trim();
  const name = $('new-name').value.trim();

  if (number === '' && name === '') {
    showToast('Enter a jersey number or a name.');
    return;
  }

  const player = addPlayer(game, teamIdFor(detailTeamSlot), { number, name });
  if (!player) {
    showToast('Could not add that player.');
    return;
  }

  save();
  render();
  $('new-number').value = '';
  $('new-name').value = '';
  $('new-number').focus();
  announce(`Added ${player.name}`);
}

// ---------------------------------------------------------------------------
// Team files
// ---------------------------------------------------------------------------

/** Version marker from the document, recorded inside an exported team file. */
function appVersion() {
  return document.querySelector('meta[name="app-version"]')?.content || null;
}

/**
 * Save the current team to a JSON file.
 *
 * The button is disabled with an empty roster, so this re-checks only to cover
 * the keyboard path rather than to handle a normal user error.
 */
function saveTeamToFile() {
  const teamId = teamIdFor(detailTeamSlot);
  const count = playersOf(game, teamId).length;

  if (count === 0) {
    showToast('Add at least one player before saving the team.');
    return;
  }

  const team = teamFromGame(game, teamId, teamFor(detailTeamSlot)?.name);
  if (!team) {
    showToast('That team no longer exists.');
    return;
  }

  download(teamFileName(team), teamFileJson(team, { appVersion: appVersion() }), 'application/json;charset=utf-8');
  showToast(`Saved ${team.name} — ${team.players.length} players, as a JSON file.`);
}

function openLoadTeamFile() {
  $('team-file-input').click();
}

/**
 * Read a picked roster file and ask for confirmation.
 *
 * A `.json` team file and a `.csv` roster are two spellings of the same thing,
 * so both land in the same confirmation dialog. Nothing is applied until the
 * user confirms, because the import replaces the current roster and that is a
 * destructive action to trigger from a file picker.
 */
async function loadRosterFromFile(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    showToast('Could not read that file.');
    return;
  }

  // Decide by extension, not by MIME type: a CSV exported from Excel or
  // Numbers arrives as `application/octet-stream` surprisingly often.
  if (/\.json$/i.test(file.name)) {
    const { team, error } = parseTeamFile(text);
    if (error) {
      showToast(error);
      return;
    }
    openRosterImport(team, file.name);
    return;
  }

  const result = parseRosterText(text);
  if (result.error) {
    showToast(result.error);
    return;
  }

  const current = teamFor(detailTeamSlot);
  const players = result.players.map((player, index) => ({
    ...player,
    // Reuse an existing id when a player of the same name is already here, so
    // events logged earlier against that player keep pointing at them.
    id: existingPlayerId(current?.id, player.name) || `import_${index}_${player.number || 'x'}`,
  }));

  openRosterImport(
    { name: current?.name || '', abbreviation: current?.abbreviation || '', players },
    file.name,
    describeRosterImport(result),
  );
}

/** The id of a same-named player already on a team, so a reload keeps history. */
function existingPlayerId(teamId, name) {
  if (!teamId || !name) return null;
  const match = game.players.find(
    (player) => player.teamId === teamId && player.name.trim() === name.trim(),
  );
  return match ? match.id : null;
}

/** A sentence describing what the parser understood, warnings included. */
function describeRosterImport(result) {
  const bits = [];
  if (result.hasHeader) bits.push('a header row');
  if (result.delimiter) bits.push(`${result.delimiter}-separated columns`);
  if (result.ignoredColumns.length > 0) bits.push(`ignored ${result.ignoredColumns.join(', ')}`);

  const parts = [];
  if (bits.length > 0) parts.push(`Read as ${bits.join(', ')}.`);
  if (result.warnings.length > 0) parts.push(result.warnings.join(' '));
  return parts.join(' ');
}

/** The parsed team waiting for the user to confirm replacing the roster. */
let pendingTeam = null;
/** Where the roster came from, for the confirmation wording and the toast. */
let pendingSource = '';
/** What the import understood: a sentence, or '' for a plain team file. */
let pendingDetail = '';

/**
 * Whether the pending import adds to the roster or replaces it.
 *
 * Read from the dialog on demand rather than captured when the dialog opens:
 * the user chooses *after* it opens, so a stored value would record whatever
 * the radio held before they touched it.
 */
function selectionMode() {
  return $('load-mode-add')?.checked ? 'add' : 'replace';
}

/** Forget the pending import. Also what Cancel does. */
function closeImportDialogs() {
  $('load-team-dialog').hidden = true;
  $('paste-roster-dialog').hidden = true;
  $('paste-roster-error').hidden = true;
  pendingTeam = null;
  pendingSource = '';
  pendingDetail = '';
}

/** Which roster the sidebar is showing right now. */
function detailTeam() {
  return teamFor(detailTeamSlot);
}

function openRosterImport(team, source, detail = '') {
  if (!team || !Array.isArray(team.players) || team.players.length === 0) {
    showToast('No players were found in that roster.');
    return;
  }

  pendingTeam = team;
  pendingSource = source;
  pendingDetail = detail;

  // The paste box is closed here rather than left open: both dialogs share the
  // same stacking level, and the paste box comes later in the document, so
  // leaving it open would hide the confirmation behind it and look like the
  // button did nothing at all.
  $('paste-roster-dialog').hidden = true;

  // A file replaces, matching the wording of the button that opened it. A paste
  // is a deliberate edit, so both choices are offered, starting from replace.
  const isPaste = source === 'the pasted roster';
  // The title should not say "from a file" when nothing was read from a file.
  $('load-team-title').textContent = isPaste ? 'Use the pasted roster' : 'Load a team from a file';
  $('load-mode-replace').checked = true;
  $('load-mode-add').checked = false;
  $('load-team-mode').hidden = !isPaste;

  renderRosterImportSummary();
  $('load-team-dialog').hidden = false;
}

/**
 * Write the confirmation sentence for the current team and mode.
 *
 * A replace discards the whole roster, so it says so plainly; the entries those
 * players logged stay in the score and play-by-play, which is the opposite of
 * what the roster's own ✕ does and is worth stating outright.
 */
function renderRosterImportSummary() {
  const team = detailTeam();
  const existing = playersOf(game, teamIdFor(detailTeamSlot));
  const current = existing.length;
  const incoming = pendingTeam.players.length;
  const adding = selectionMode() === 'add';
  const entriesForCurrent = game.events.filter((event) =>
    existing.some((player) => player.id === event.playerId),
  ).length;

  let what;
  if (adding) {
    what =
      `Add ${incoming} player${incoming === 1 ? '' : 's'} to ` +
      `${current} already on ${team?.name || 'this team'}.`;
  } else if (current === 0) {
    what =
      `Load ${incoming} player${incoming === 1 ? '' : 's'} onto ${team?.name || 'this team'}.`;
  } else {
    what =
      `Replace the ${current} player${current === 1 ? '' : 's'} on ` +
      `${team?.name || 'this team'} with ${incoming}.`;
    if (entriesForCurrent > 0) {
      what +=
        ` Their ${entriesForCurrent} recorded entr${entriesForCurrent === 1 ? 'y' : 'ies'} ` +
        `stay in the score and the play-by-play.`;
    }
  }

  const from = pendingSource ? ` From ${pendingSource}.` : '';
  $('load-team-target').textContent = `${what}${from} The other team and the game log are untouched.`;
  if (pendingDetail) $('load-team-target').textContent += ` ${pendingDetail}`;

  $('confirm-load-team').textContent = adding ? 'Add players' : current > 0 ? 'Replace roster' : 'Load team';
}

/** Open the paste box, reusing whatever was typed last time. */
function openPasteRoster() {
  $('paste-roster-error').hidden = true;
  $('paste-roster-dialog').hidden = false;
  // Focus is set after the dialog is visible; a hidden field cannot take it.
  $('roster-paste-text').focus();
}

/** Read the paste box and open the same confirmation the file importer uses. */
function importPastedRoster() {
  const result = parseRosterText($('roster-paste-text').value);
  const error = $('paste-roster-error');

  if (result.error) {
    error.textContent = result.error;
    error.hidden = false;
    return;
  }

  error.hidden = true;
  const current = detailTeam();
  // Keep the team's own name: a paste supplies players, not an identity.
  openRosterImport(
    {
      name: current?.name || '',
      abbreviation: current?.abbreviation || '',
      players: result.players,
    },
    'the pasted roster',
    describeRosterImport(result),
  );
}

function confirmLoadTeam() {
  if (!pendingTeam) {
    closeImportDialogs();
    return;
  }

  const team = pendingTeam;
  // Captured before closing, which clears the pending state.
  const source = pendingSource;
  const adding = selectionMode() === 'add' && pendingSource === 'the pasted roster';
  const teamId = teamIdFor(detailTeamSlot);

  if (adding) {
    // No name in the payload, so the team's identity is left alone.
    appendRoster(game, teamId, { players: team.players });
  } else {
    mergeRoster(game, teamId, team);
  }

  save();
  closeImportDialogs();
  render();
  showToast(
    `${adding ? 'Added' : 'Loaded'} ${team.players.length} player` +
      `${team.players.length === 1 ? '' : 's'}` +
      `${source ? ` from ${source}` : ''} — ${currentTeamName()}.`,
  );
}

/** The viewed team's name, for the toast that follows an import. */
function currentTeamName() {
  return teamFor(detailTeamSlot)?.name || 'the team';
}


/**
 * A sentence naming what a destructive action is about to discard.
 *
 * The point of the confirmation is that the answer is given against a number
 * rather than a vague warning about "the current game".
 */
function atStake() {
  const entries = game.events.length;
  if (entries === 0) return 'Nothing has been recorded yet, so nothing is lost.';
  return `${entries} recorded ${entries === 1 ? 'entry' : 'entries'} will be discarded.`;
}

/**
 * Ask before something that throws away recorded work.
 *
 * `run` fires only on Confirm, and is dropped either way, so a queued action can
 * never be set off by a later, unrelated click.
 */
function askBefore({ title, text, confirmLabel, run }) {
  pendingDanger = run;
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-go').textContent = confirmLabel;

  // Every dialog shares one stacking level, so the others are cleared: whichever
  // sits later in the document would otherwise cover this one and swallow the
  // click on Confirm, which looks exactly like a dead button.
  closeImportDialogs();

  $('confirm-dialog').hidden = false;
  $('confirm-go').focus();
}

/** Dismiss the confirmation without doing anything. */
function closeDanger() {
  pendingDanger = null;
  $('confirm-dialog').hidden = true;
}

/** Run whatever the confirmation was guarding, then close it. */
function runDanger() {
  const run = pendingDanger;
  closeDanger();
  if (run) run();
}

function startNewGame() {
  askBefore({
    title: 'Start a blank game?',
    text:
      'The game on screen will be replaced by an empty one, and both rosters ' +
      `with it. ${atStake()} Export the game first if you need a copy.`,
    confirmLabel: 'Start a blank game',
    run: () => {
      // A new game is usually the same day, so the date and time carry over.
      game = createGame({ date: game.date, time: game.time, periodsPerGame: game.periodsPerGame });
      detailTeamSlot = 'home';
      save();
      render();
      showToast('New game ready. Load your saved teams to set the rosters.');
    },
  });
}

/**
 * Set up the next game from this one.
 *
 * The dialog carries the two questions only the coach can answer — which sides
 * to bring over, and whether to take a backup first — and says what is kept, so
 * the choices are read rather than remembered.
 */
function openCopyGame() {
  const roster = (slot) => playersOf(game, teamIdFor(slot)).length;
  const describe = (slot) => {
    const team = teamFor(slot);
    const count = roster(slot);
    return `${safeText(team?.name) || 'The ' + slot + ' team'} · ${count} player${
      count === 1 ? '' : 's'
    }`;
  };

  $('copy-home-label').textContent = describe('home');
  $('copy-away-label').textContent = describe('away');
  $('copy-keep-home').checked = true;
  $('copy-keep-away').checked = true;
  // Offered, and offered checked: the copy replaces the game on this device,
  // and a backup costs one file.
  $('copy-export').checked = true;

  $('copy-game-kept').textContent =
    `Settings kept: ${structureLabel(game.periodsPerGame, game.periodSeconds)}` +
    `${safeText(game.venue) ? ` · ${game.venue}` : ''} · ${displayDate(game.date)}.`;
  $('copy-game-stake').textContent = atStake();

  // Two dialogs share one stacking level, so this one opens on its own.
  closeDialogs();
  openDialog('copy-game-dialog');
}

function confirmCopyGame() {
  const keepHome = $('copy-keep-home').checked;
  const keepAway = $('copy-keep-away').checked;

  if ($('copy-export').checked) downloadJson(game);

  game = copyGameAsNew(game, { keepHome, keepAway });
  detailTeamSlot = 'home';

  // View state belongs to the game that has just been filed away.
  boxSort = null;
  boxPick = null;
  expandedPanel = null;

  save();
  closeDialogs();
  render();
  showToast(
    keepHome || keepAway
      ? 'New game ready — same settings, scores cleared.'
      : 'New game ready. Both rosters start empty.',
  );
}

function loadSample() {
  askBefore({
    title: 'Reload the sample game?',
    text: `The game on screen will be replaced by the sample. ${atStake()}`,
    confirmLabel: 'Reload the sample',
    run: () => {
      game = sampleGame();
      detailTeamSlot = 'home';
      save();
      render();
      showToast('Sample game loaded.');
    },
  });
}

async function importFromFile(file) {
  try {
    const text = await file.text();
    const { game: imported, error } = importGame(text);
    if (error) {
      showToast(error);
      return;
    }
    // Confirmed once the file is known to be readable: asking before the picker
    // would put the question before there is anything to answer about.
    askBefore({
      title: 'Load this game?',
      text: `The game on screen will be replaced by ${file.name}. ${atStake()}`,
      confirmLabel: 'Load it',
      run: () => {
        game = imported;
        detailTeamSlot = 'home';
        save();
        render();
        showToast(`Loaded the game from ${file.name}.`);
      },
    });
  } catch {
    showToast('Could not read that file.');
  }
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** True while the scorer is typing a clock time. */
function clockIsBeingEdited() {
  return $('clock-display').getAttribute('contenteditable') === 'true';
}

/**
 * Make the clock face editable.
 *
 * A running clock is paused first: letting it tick away underneath an edit would
 * fight the typist, and resuming afterwards is one tap.
 */
function beginClockEdit() {
  const display = $('clock-display');
  if (clockIsBeingEdited() || clockIsClosed()) return;

  if (game.clock.running) {
    setClockRunning(game, false);
    save();
    renderClockRunState();
    showToast('Clock paused while you set the time.');
  }

  setClockFaceMode(true);
  display.focus();

  const range = document.createRange?.();
  const selection = window.getSelection?.();
  if (range && selection) {
    range.selectNodeContents(display);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/**
 * Apply a typed clock time. Returns true when the value was accepted.
 *
 * The clock is always left stopped: the scorer sets a time and then decides
 * whether to resume, which is the same order as a real scorer's table.
 */
function commitClockEdit() {
  const display = $('clock-display');
  if (!clockIsBeingEdited()) return true;

  const { seconds, error } = clockface.parseInput(display.textContent);

  if (seconds === null) {
    showToast(error);
    display.textContent = clockface.display(game.clock.seconds);
    // Leave it open so the typo can be corrected in place.
    return false;
  }

  setClockFaceMode(false);
  setClock(game, seconds);
  setClockRunning(game, false);
  save();
  render();
  // render() skips the clock face while it is being edited, so normalise it here.
  display.textContent = clockface.display(game.clock.seconds);
  showToast(
    seconds === 0
      ? `Clock cleared. It will fill to ${clockface.display(clockface.periodLength(game))} when you start it.`
      : `Clock set to ${clockface.display(seconds)}. Tap the clock to count down.`,
  );
  return true;
}

function tickClock() {
  if (!game.clock.running) return;

  const result = clockface.tick(game);

  if (!result.periodEnded) {
    setClock(game, result.seconds);
    // Only the clock face changes each second; a full render would rebuild every
    // card once a second for no reason.
    if (!clockIsBeingEdited()) {
      $('clock-display').textContent = clockface.display(result.seconds);
    }

    // The one exception is a box score that is on screen with a lineup behind
    // it: minutes on the floor are running, and a coach watching them should
    // see them run. It is one table, once a second, only while it is open.
    if (expandedPanel === 'box' && computeGame(game).floor.tracked) {
      renderBox(computeGame(game));
    }
    return;
  }

  // The period ended while the scorer was still recording, so move the game on
  // rather than waiting to be told.
  setClock(game, 0);
  setClockRunning(game, false);
  setPeriod(game, result.nextPeriod);

  const { seconds } = clockface.startValue(game);
  setClock(game, seconds);

  save();
  render();
  showToast(
    `End of ${clockface.label(result.nextPeriod - 1, game.periodsPerGame)} — ` +
      `now on ${clockface.label(game.currentPeriod, game.periodsPerGame)}, ` +
      `clock set to ${clockface.display(seconds)}.`,
  );
}

/**
 * Keep the ticking timeout in step with the clock.
 *
 * A self-rescheduling timeout rather than a permanent interval, so an idle app
 * is not waking up once a second all game.
 *
 * Safe to call whenever anything might have changed the clock, and called from
 * render() for that reason: it makes "running" and "a tick is pending" the same
 * fact rather than two that have to be kept in agreement by hand. A pending tick
 * is left alone rather than pushed back, so a scorer tapping through entries
 * between ticks cannot stall the countdown by re-rendering.
 */
function ensureClockTicking() {
  if (!game.clock.running) {
    clearTimeout(clockTimer);
    clockTimer = null;
    return;
  }

  if (clockTimer !== null) return;

  clockTimer = setTimeout(() => {
    clockTimer = null;
    if (game.clock.running) {
      tickClock();
      // Persist about once a second while running rather than on every tick, so
      // a long game does not thrash localStorage.
      save();
    }
    ensureClockTicking();
  }, 1000);
}

// Coming back to the tab is when a tick that was lost to a sleeping tablet
// shows: the clock is green and the digits have not moved. Rebuilding it is
// cheap and idempotent.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ensureClockTicking();
});

// ---------------------------------------------------------------------------
// The More menu and the dialogs it opens
// ---------------------------------------------------------------------------

/** Every dialog in this app is a plain element that is either hidden or not. */
function openDialog(id) {
  $(id).hidden = false;
}

function closeDialogs() {
  for (const id of [
    'settings-dialog',
    'about-dialog',
    'color-dialog',
    'roster-dialog',
    'copy-game-dialog',
    'export-dialog',
  ]) {
    $(id).hidden = true;
  }
}

function closeMenu() {
  const menu = $('more-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('more-button').setAttribute('aria-expanded', 'false');
}

function toggleMenu() {
  const menu = $('more-menu');
  const opening = menu.hidden;
  menu.hidden = !opening;
  $('more-button').setAttribute('aria-expanded', String(opening));
  if (opening) renderMenuState();
}

/**
 * The one menu item whose wording follows the game: ending a game and reopening
 * one are the same door, so it carries whichever way it currently leads.
 */
function renderMenuState() {
  const finished = Boolean(game.finishedAt);
  $('menu-end-label').textContent = finished ? 'Reopen the game' : 'End game';
  $('menu-end-sub').textContent = finished
    ? 'Carry on from where the clock stopped'
    : 'Close the game off at 00:00 of the last period';
}



// ---------------------------------------------------------------------------
// Finishing the game
// ---------------------------------------------------------------------------

/**
 * Is the clock closed to changes because the game has been finished?
 *
 * Ending a game is only a clock move and a stamp, so the way back is to say so
 * rather than to hunt for an undo. Every clock control asks this first, and the
 * answer names the way out instead of leaving a tap looking broken.
 */
function clockIsClosed() {
  if (!game.finishedAt) return false;
  showToast('The game is finished — reopen it to change the clock.');
  return true;
}

/**
 * Close the game off at the end of the period it is standing in.
 *
 * The clock is what decides how much of the last period was played, so ending a
 * game is really a clock move: to 00:00 of that period, stopped. Minutes and
 * plus/minus then settle at the final buzzer — including the seconds after the
 * last entry, which no reading could speak for on its own.
 */
function endGame() {
  const last = clockface.label(game.currentPeriod || 1, game.periodsPerGame);
  askBefore({
    title: `End the game at ${last} 00:00?`,
    text: 'The clock goes to 00:00 and the game is marked final, so minutes and +/- stop at the final buzzer. Nothing is deleted, and the game can be reopened.',
    confirmLabel: 'End the game',
    run: () => {
      setClockRunning(game, false);
      setClock(game, 0);
      setFinished(game, Date.now());
      save();
      render();
      showToast(`Game finished at ${last} 00:00.`);
    },
  });
}

/** Open a finished game again, leaving the clock where the ending put it. */
function reopenGame() {
  setFinished(game, null);
  save();
  render();
  showToast('Game reopened — the clock is stopped at 00:00.');
}

// ---------------------------------------------------------------------------
// Press and hold on a team block
// ---------------------------------------------------------------------------

/**
 * Open Team and players on one side of the board.
 *
 * The dialog edits whichever side the tabs have selected, so this selects the
 * side first: a scorer who holds up the away block is asking about the away
 * team, and the panel behind the dialog follows them there.
 */
function openTeamRoster(slot) {
  closeMenu();

  if (slot === 'home' || slot === 'away') {
    detailTeamSlot = slot;
    // A substitution belongs to the roster it was started from.
    subStep = null;
  }
  render();

  openDialog('roster-dialog');

  // The cursor lands in the team name, which is the one field a scorer is most
  // likely to want and the one that is awkward to reach on a tablet.
  const field = $('team-name-input');
  field.focus();
  field.select();
}

/**
 * How long a team block has to be held before it opens that team's roster.
 *
 * Long enough that a tap which lingers is still a tap, short enough that the
 * scorer does not think the app has missed them.
 */
const HOLD_MS = 500;

/** How far a finger may wander before the press counts as a drag instead. */
const HOLD_SLOP = 12;

/** The press being watched: where it started and which side it is over. */
let holdPress = null;
let holdTimer = null;

/** Stop watching a press, whatever happens to it. */
function endHold() {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  holdPress = null;
}

/**
 * Start watching a press on a team block.
 *
 * The block is two controls in one: a tap switches the side being scored, a
 * hold opens that team's players. Nothing here cancels the tap — the click the
 * browser sends when the finger lifts means the same thing either way, so a
 * hold leaves the board showing the team whose roster it just opened.
 */
function beginHold(event) {
  const block = event.target?.closest?.('[data-hold="roster"]');
  if (!block) return;

  endHold();
  holdPress = {
    slot: block.dataset.teamSlot,
    x: event.clientX ?? 0,
    y: event.clientY ?? 0,
  };
  holdTimer = setTimeout(() => {
    const slot = holdPress?.slot;
    holdTimer = null;
    holdPress = null;
    if (slot) openTeamRoster(slot);
  }, HOLD_MS);
}

/** Give up on the hold if the finger slides: that is a drag, not a press. */
function moveHold(event) {
  if (!holdPress) return;
  const dx = (event.clientX ?? 0) - holdPress.x;
  const dy = (event.clientY ?? 0) - holdPress.y;
  if (Math.hypot(dx, dy) > HOLD_SLOP) endHold();
}

// Watched from the document rather than bound to the blocks, because the
// board re-renders under the finger and a press that outlives its element
// would otherwise be lost.
document.addEventListener('pointerdown', beginHold);
document.addEventListener('pointermove', moveHold);
document.addEventListener('pointerup', endHold);
document.addEventListener('pointercancel', endHold);

// A long press is the roster shortcut, not a link menu: iOS would otherwise
// drop its own callout on top of the dialog the hold is opening.
document.addEventListener('contextmenu', (event) => {
  if (event.target?.closest?.('[data-hold="roster"]')) event.preventDefault();
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  // Anything outside the More menu dismisses it, the way a menu is expected to
  // behave. Checked before the action lookup so clicking another tool closes
  // the menu and still runs that tool.
  if (!event.target.closest('#more-menu') && !event.target.closest('#more-button')) {
    closeMenu();
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'log-stat':
      // Half-way through a substitution the next tap is a player, not a key.
      // The keys are dimmed and made inert while the banner is up, so a tap
      // that lands on one cannot be mistaken for the answer the app wants.
      if (subStep) break;
      logStat(target.dataset.playerId, target.dataset.stat, target.dataset.result);
      break;
    case 'log-team-stat':
      // Half-way through a substitution the next tap is a player, not a key.
      if (subStep) break;
      logTeamStat(target.dataset.stat, target.dataset.result);
      break;
    case 'toggle-expand': {
      const panel = target.dataset.panel;
      expandedPanel = expandedPanel === panel ? null : panel;
      render();
      break;
    }
    case 'sort-box': {
      const key = target.dataset.column;
      // A stat heading is tapped to put the biggest number on top, which is how
      // a box score is read, and a second tap turns the same heading round. The
      // Player heading counts jerseys instead: a roster is printed 4, 7, 11, so
      // that one counts up.
      const first = key === 'name' ? 'asc' : 'desc';
      const same = boxSort?.key === key && boxSort.direction === first;
      boxSort = { key, direction: same ? (first === 'asc' ? 'desc' : 'asc') : first };
      render();
      break;
    }
    case 'pick-box-row': {
      // Tapping a row marks it; tapping it again lets it go, and tapping round
      // the table moves the mark rather than stacking marks up.
      const playerId = target.dataset.playerId;
      boxPick = boxPick === playerId ? null : playerId;
      render();
      break;
    }
    case 'key-smaller':
    case 'key-larger': {
      const step = KEY_SIZES.indexOf(keySize) + (action === 'key-larger' ? 1 : -1);
      keySize = KEY_SIZES[Math.min(KEY_SIZES.length - 1, Math.max(0, step))];
      render();
      break;
    }
    case 'toggle-menu':
      toggleMenu();
      break;
    case 'open-settings':
      closeMenu();
      openDialog('settings-dialog');
      break;
    case 'open-roster':
      // Setting up the two teams is the first thing a scorer does and then not
      // again, so it sits in the menu rather than owning a row of the screen.
      openTeamRoster(detailTeamSlot);
      break;
    case 'swap-sides': {
      closeMenu();
      swapSides(game);
      save();
      render();
      showToast(
        `Swapped: ${safeText(teamFor('home')?.name, 'Home')} are now at home.`,
      );
      break;
    }
    case 'open-export':
      // The files are set up once a game and then left alone, so they belong
      // with the other dialogs rather than in a bar across the scoring area.
      closeMenu();
      openDialog('export-dialog');
      break;
    case 'end-game':
      // One item, two jobs: the label says which, and the game says which
      // label is true.
      closeMenu();
      if (game.finishedAt) reopenGame();
      else endGame();
      break;
    case 'open-about':
      closeMenu();
      openDialog('about-dialog');
      break;
    case 'undo':
      performUndo();
      break;
    case 'dismiss-toast':
      hideToast();
      break;
    case 'delete-event':
      handleDelete(target.dataset.eventId);
      break;
    case 'remove-player':
      removePlayerFromRoster(target.dataset.playerId);
      break;
    case 'select-team':
      detailTeamSlot = target.dataset.teamSlot;
      // A substitution belongs to the roster it was started from.
      subStep = null;
      render();
      break;
    case 'start-sub': {
      // Nothing on the floor yet means this is the five who start the game.
      const onCourt = computeGame(game).floor.onCourt[teamIdFor(detailTeamSlot)] ?? [];
      subStep = onCourt.length === 0 ? { stage: 'start', picked: [] } : { stage: 'off' };
      render();
      break;
    }
    case 'sub-pick':
      pickSubPlayer(target.dataset.playerId);
      break;
    case 'cancel-sub':
      subStep = null;
      render();
      break;
    case 'set-team-color': {
      const key = target.dataset.color;
      if (!TEAM_COLORS.some((entry) => entry.key === key)) break;
      // Saved on the team, not on the side: swapping home and away carries it
      // with the team, which is what "our colours" means to a coach.
      updateTeam(game, teamIdFor(detailTeamSlot), { color: key });
      save();
      closeDialogs();
      render();
      break;
    }
    case 'open-team-color':
      closeMenu();
      render();
      openDialog('color-dialog');
      break;
    case 'period-next':
      // A finished game stands in its last period: stepping out of it would
      // silently credit a period nobody played.
      if (clockIsClosed()) break;
      setPeriod(game, game.currentPeriod + 1);
      save();
      render();
      break;
    case 'period-prev':
      if (clockIsClosed()) break;
      setPeriod(game, Math.max(1, game.currentPeriod - 1));
      save();
      render();
      break;
    case 'toggle-clock':
      // Carried by the clock face: tap it to start, tap it again to stop.
      toggleClock();
      break;
    case 'edit-clock':
      // The same tap opens the face for typing and, once it is open, closes it
      // again — the blur this click causes on some platforms has already
      // committed the value by then, so there is nothing left to do.
      if (clockIsBeingEdited()) commitClockEdit();
      else beginClockEdit();
      break;
    case 'clock-nudge': {
      // The clock beside a scorer drifts by a second or two over a period, so
      // the usual correction is a nudge rather than a re-typed time. It works
      // on a running clock too: pausing to fix a second would cost another one.
      // A nudge next to an open edit would fight the value being typed, so the
      // typed value lands first.
      if (clockIsBeingEdited() && !commitClockEdit()) break;
      if (clockIsClosed()) break;
      const step = Number(target.dataset.clockStep) || 0;
      const next = Math.min(
        clockface.periodLength(game),
        Math.max(0, game.clock.seconds + step),
      );
      if (next === game.clock.seconds) break;
      setClock(game, next);
      save();
      render();
      break;
    }
    case 'reset-clock': {
      if (clockIsClosed()) break;
      // Back to the start of the period, stopped: easier than waiting for a
      // ten-minute countdown when correcting a mistake.
      setClockRunning(game, false);
      setClock(game, clockface.periodLength(game));
      save();
      render();
      showToast(`Clock reset to ${clockface.display(game.clock.seconds)}.`);
      break;
    }
    case 'export-csv':
      downloadCsv(game, target.dataset.kind);
      showToast(`Exported the ${target.dataset.kind.replace('-', ' ')}.`);
      break;
    case 'export-json':
      downloadJson(game);
      showToast('Exported the full game as JSON.');
      break;
    case 'confirm-danger':
      runDanger();
      break;
    case 'open-copy-game':
      openCopyGame();
      break;
    case 'confirm-copy-game':
      confirmCopyGame();
      break;
    case 'cancel-danger':
      closeDanger();
      break;
    case 'import-json':
      $('import-file').click();
      break;
    case 'new-game':
      startNewGame();
      break;
    case 'save-team':
      saveTeamToFile();
      break;
    case 'open-load-team':
      openLoadTeamFile();
      break;
    case 'confirm-load-team':
      confirmLoadTeam();
      break;
    case 'close-dialog':
      closeDialogs();
      closeImportDialogs();
      break;
    case 'open-paste-roster':
      openPasteRoster();
      break;
    case 'import-pasted-roster':
      importPastedRoster();
      break;
    case 'load-sample':
      loadSample();
      break;
    case 'dismiss-banner':
      $('storage-banner').hidden = true;
      break;
    default:
      break;
  }
});

// The clock face commits its own edit on blur; a rejected value keeps it open.
document.addEventListener(
  'blur',
  (event) => {
    if (event.target.id === 'clock-display') commitClockEdit();
  },
  true,
);

// The Edit button must not take focus on the way in. Focus leaving the face
// commits the edit, so a tap on Edit would otherwise close the field and the
// click that followed would open it again — and that only happens on the
// platforms that focus buttons on click, which is the worst kind of bug to
// chase. Keeping focus put lets the click decide.
document.addEventListener('mousedown', (event) => {
  if (event.target.closest?.('[data-action="edit-clock"]')) event.preventDefault();
});

// Enter commits a cell edit instead of adding a newline.
document.addEventListener('keydown', (event) => {
  // Escape closes whichever dialog is open, discarding what it holds.
  const importing = !$('load-team-dialog').hidden || !$('paste-roster-dialog').hidden;
  const viewing = [
    'settings-dialog',
    'about-dialog',
    'color-dialog',
    'roster-dialog',
    'copy-game-dialog',
    'export-dialog',
  ].some((id) => !$(id).hidden);

  if (event.key === 'Escape' && (importing || viewing || !$('more-menu').hidden) && !clockIsBeingEdited()) {
    closeDialogs();
    closeImportDialogs();
    closeMenu();
    return;
  }

  // Escape also abandons a substitution that is half entered, which is the
  // same promise it makes about a clock edit: nothing is recorded until the
  // second tap lands.
  if (event.key === 'Escape' && subStep) {
    subStep = null;
    render();
    return;
  }

  // Escape also gives the workspace its second column back, so a scorer who
  // expanded a panel can leave it the same way they leave a dialog.
  if (event.key === 'Escape' && expandedPanel && !clockIsBeingEdited()) {
    expandedPanel = null;
    render();
    return;
  }

  if (event.target.id === 'clock-display' && clockIsBeingEdited()) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (commitClockEdit()) event.target.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Abandon the edit, restoring the value the clock actually holds.
      setClockFaceMode(false);
      event.target.textContent = clockface.display(game.clock.seconds);
      event.target.blur();
      return;
    }
  }

  // The face is a run control wearing a clock's clothes, so give it the keyboard
  // a button implies: Enter or Space starts and stops, the way it does elsewhere.
  if (
    event.target.id === 'clock-display' &&
    !clockIsBeingEdited() &&
    (event.key === 'Enter' || event.key === ' ')
  ) {
    event.preventDefault();
    toggleClock();
    return;
  }

  // Enter takes the team total as typed. `change` would only fire on the way
  // out, and a scorer who has just typed a number expects it to land.
  if (event.target.id === 'teamtotal-input' && event.key === 'Enter') {
    event.preventDefault();
    commitTeamTotal(event.target.value);
    event.target.blur();
    return;
  }

  // Undo the last entry: the most important shortcut in the app.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (!typing) {
      event.preventDefault();
      performUndo();
    }
  }
});

document.addEventListener('change', (event) => {
  const { id } = event.target;

  if (event.target.dataset?.action === 'reassign-event') {
    reassignEvent(event.target.dataset.eventId, event.target.value);
    return;
  }

  if (event.target.dataset?.action === 'edit-event-time') {
    const entry = game.events.find((e) => e.id === event.target.dataset.eventId);
    if (!entry) return;

    // Typed the way the clock is: 7:30, 0730, or a bare count of seconds.
    const parsed = clockface.parseInput(event.target.value);
    if (parsed.error) {
      showToast(parsed.error);
      // Put the row back to what the record says rather than leaving the typo
      // sitting in the log looking like a time.
      render();
      return;
    }

    const length = clockface.periodLength(game, entry.period);
    const outcome = updateEvent(game, entry.id, {
      clockSeconds: Math.max(0, Math.min(length, length - parsed.seconds)),
    });
    if (outcome.error) {
      showToast(outcome.error);
      render();
      return;
    }

    save();
    render();
    flashLogRow(entry.id);
    return;
  }

  if (event.target.dataset?.action === 'edit-event-period') {
    // A missed play is usually logged in the period it is noticed in, so the
    // period is half of putting it back: the same row fixes both.
    const outcome = updateEvent(game, event.target.dataset.eventId, {
      period: Number(event.target.value),
    });
    if (outcome.error) {
      showToast(outcome.error);
      render();
      return;
    }

    save();
    render();
    flashLogRow(event.target.dataset.eventId);
    return;
  }

  if (id === 'team-name-input') {
    updateTeam(game, teamIdFor(detailTeamSlot), { name: event.target.value.trim() || 'Team' });
    save();
    render();
    return;
  }

  if (id === 'team-abbrev-input') {
    updateTeam(game, teamIdFor(detailTeamSlot), {
      abbreviation: event.target.value.trim().toUpperCase().slice(0, 4),
    });
    save();
    render();
    return;
  }

  if (id === 'teamtotal-input') {
    commitTeamTotal(event.target.value);
    return;
  }

  // The strip under the board is the read-out of these three, so a change has to
  // reach the page and not only the model: a scorer who sets the venue and sees
  // the old one still on the strip has no way to tell it was kept.
  if (id === 'game-date') {
    game.date = event.target.value;
    save();
    render();
    return;
  }

  if (id === 'game-time') {
    game.time = event.target.value;
    save();
    render();
    return;
  }

  if (id === 'game-venue') {
    game.venue = event.target.value;
    save();
    render();
    return;
  }

  if (id === 'game-periods') {
    setPeriodsPerGame(game, Number(event.target.value));
    save();
    render();
    return;
  }

  if (id === 'game-period-length') {
    game.periodSeconds = Number(event.target.value);
    // Apply the new length to the clock only when it is not running, so a
    // setting change cannot disturb a live countdown.
    if (!game.clock.running && game.clock.seconds > 0) {
      setClock(game, clockface.periodLength(game));
    }
    save();
    render();
  }
});

document.addEventListener('input', (event) => {
  // Let the date, time and venue fields update the model as they are typed, so
  // an export mid-edit still carries the current values.
  if (event.target.id === 'game-date') game.date = event.target.value;
  if (event.target.id === 'game-time') game.time = event.target.value;
  if (event.target.id === 'game-venue') game.venue = event.target.value;
});

$('add-player-form').addEventListener('submit', addPlayerFromForm);

$('import-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) importFromFile(file);
  event.target.value = '';
});

// One picker for both formats: `loadRosterFromFile` decides by extension.
$('team-file-input').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) loadRosterFromFile(file);
  // Cleared so picking the same file twice still fires a change event.
  event.target.value = '';
});

// A last save on the way out covers a clock that was mid-tick.
window.addEventListener('beforeunload', () => {
  saveState(game);
});

// ---------------------------------------------------------------------------
// First paint
// ---------------------------------------------------------------------------

function reportStorageAvailability() {
  // The only thing worth interrupting the scorer for is storage being unusable,
  // because then nothing is being kept at all. That the data is local-only is
  // already said by the export controls, so it is not repeated as a banner.
  const store = saveState(game);

  if (!store.ok) {
    $('storage-banner').hidden = false;
    $('storage-banner').querySelector('p').innerHTML =
      '<strong>This browser is blocking local storage.</strong> Nothing will be ' +
      'saved, so export the game before you close this tab.';
  }
}

reportStorageAvailability();
// render() starts the ticking loop when the game comes back mid-countdown.
render();
