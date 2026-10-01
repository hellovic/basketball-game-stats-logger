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
  createGame,
  deleteEvent,
  loadState,
  mergeRoster,
  playersOf,
  removePlayer,
  saveState,
  setClock,
  setClockRunning,
  setPeriod,
  setPeriodsPerGame,
  setTeamPeriodTotal,
  swapSides,
  teamPeriodTotal,
  undoLastEvent,
  updateEvent,
  updateTeam,
} from './store.js';
import { describeEvent, entryButtons, eventPoints, getStat } from './stats.js';
import { parseTeamFile, teamFileJson, teamFileName, teamFromGame } from './teamfile.js';
import { parseRosterText } from './rosterimport.js';
import {
  computeGame,
  consistencyWarnings,
  derivedPeriodPoints,
  listPeriods,
  playerLine,
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
 * How the panel chrome names itself in tooltips and labels.
 */
const PANEL_NAMES = { entry: 'live entry', log: 'play-by-play', box: 'box score' };

/**
 * How tall Live entry's stat keys are, smallest first.
 *
 * Only Live entry has one: it is the panel a scorer works down, and the whole
 * point is fitting the roster on screen without a scroll. The default sits at
 * the small end already, so the buttons are there to go further in either
 * direction rather than to undo an oversized out-of-the-box key.
 */
const KEY_SIZES = ['compact', 'normal', 'roomy'];
let keySize = 'normal';

/**
 * Players ticked for removal in the roster panel.
 *
 * Held here rather than read back off the checkboxes because every action
 * re-renders the whole panel: anything stored in the DOM would be lost when the
 * user logs a stat between ticking a player and removing them. Ids are pruned
 * against the viewed roster on every render, so a team switch, a new game or a
 * team loaded from file can never leave a stale id armed for deletion.
 */
let selectedPlayerIds = new Set();

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
  if (game.clock.running) return;

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

/** The accent colour a team should render in. */
function accentFor(teamId) {
  return teamId === game.homeTeamId ? 'var(--home-accent)' : 'var(--away-accent)';
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
      : `Game clock, tap to ${game.clock.running ? 'stop' : 'start'}`,
  );
}

function renderScoreboard(derived) {
  const home = teamFor('home');
  const away = teamFor('away');

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
}

function renderRoster() {
  const teamId = teamIdFor(detailTeamSlot);
  const roster = playersOf(game, teamId);

  // A selection only ever refers to the roster in front of the scorer. Anything
  // else (the other team, a roster that has since been replaced) is dropped
  // rather than left armed for deletion.
  pruneSelection(roster);
  renderRosterToolbar(roster);
}

/** Drop selected ids that are no longer on the roster being viewed. */
function pruneSelection(roster) {
  const onRoster = new Set(roster.map((player) => player.id));
  for (const id of [...selectedPlayerIds]) {
    if (!onRoster.has(id)) selectedPlayerIds.delete(id);
  }
}

function renderRosterToolbar(roster) {
  const toolbar = $('roster-toolbar');
  if (!toolbar) return;

  const selectedCount = roster.filter((player) => selectedPlayerIds.has(player.id)).length;
  const allSelected = roster.length > 0 && selectedCount === roster.length;

  // Nothing to select (or remove) until the roster has players.
  toolbar.hidden = roster.length === 0;

  // The controls live in the document rather than being rebuilt here, so a
  // re-render cannot replace a checkbox the user is mid-click or the button
  // they are pressing.
  const master = $('roster-select-all');
  if (master) {
    master.disabled = roster.length === 0;
    master.checked = allSelected;
    // A partly ticked roster is neither checked nor unchecked, and the box has
    // to say so or "select all" looks broken.
    master.indeterminate = selectedCount > 0 && !allSelected;
  }

  const count = $('roster-selection-count');
  if (count) count.textContent = selectedCount === 0 ? '' : `${selectedCount} selected`;

  const remove = $('roster-remove-selected');
  if (remove) {
    remove.disabled = selectedCount === 0;
    remove.textContent = selectedCount > 0 ? `Remove ${selectedCount}` : 'Remove';
  }
}

/**
 * Remove every ticked player, along with the entries they logged.
 *
 * Deleting the entries is what keeps the app's promise intact: a removed
 * player's points leave the scoreboard and the box score at the same moment, so
 * the two cannot drift apart. The alternative — keeping an entry whose player is
 * gone — leaves points that no player line accounts for, which the app reports
 * as a problem under the scoresheet.
 */
function removeSelectedPlayers() {
  const roster = playersOf(game, teamIdFor(detailTeamSlot));
  const players = roster.filter((player) => selectedPlayerIds.has(player.id));
  if (players.length === 0) return;

  const ids = new Set(players.map((player) => player.id));
  const entries = game.events.filter((event) => ids.has(event.playerId)).length;

  const who =
    players.length === 1
      ? players[0].name
      : `${players.length} players`;
  const them = players.length === 1 ? 'this player' : 'them';
  const detail =
    entries > 0
      ? `${entries} recorded ${entries === 1 ? 'entry' : 'entries'} will be deleted ` +
        `with ${them}, and the score and box score will drop.`
      : 'Their place in the roster is all that goes.';

  askBefore({
    title: `Remove ${who}?`,
    // Removing a player is not an event, so the ordinary undo (which pops the
    // last entry) cannot reverse this. The confirmation is the safety net.
    text: `${detail} Removing a player cannot be undone.`,
    confirmLabel: `Remove ${players.length === 1 ? 'player' : `${players.length} players`}`,
    run: () => {
      for (const player of players) removePlayer(game, player.id);
      game.events = game.events.filter((event) => !ids.has(event.playerId));

      selectedPlayerIds.clear();
      save();
      render();

      showToast(
        entries > 0
          ? `${who} removed with ${entries} ${entries === 1 ? 'entry' : 'entries'}.`
          : `${who} removed.`,
      );
    },
  });
}


/**
 * The live entry table: one row per player on the team being scored.
 *
 * The row is a table row rather than a card because the keys, the running
 * totals and the column headings all have to line up down the page — a scorer
 * finds "the third player's rebounds" by reading one column, not by re-finding
 * a card. The 17 columns are: check, player, 4 scoring keys, 7 other keys and
 * the 4 live values the keys are already reflected in.
 */
function renderEntry(derived) {
  const container = $('player-cards');

  // Entry works for one team at a time: a scorer is entering one team's events.
  const teamId = teamIdFor(detailTeamSlot);
  const roster = playersOf(game, teamId).filter((player) => player.active !== false);

  if (roster.length === 0) {
    container.innerHTML =
      '<tr class="entry__empty"><td colspan="15">No players yet — add one in the roster bar above.</td></tr>';
    return;
  }

  const accent = accentFor(teamId);

  // Every button the app can record, in catalog order. Team events are not
  // here: they belong to no player, so they get their own strip under the
  // table. The three groups below line up with the three column groups.
  const buttons = entryButtons();
  const makes = buttons.filter((b) => b.kind === 'made');
  const misses = buttons.filter((b) => b.kind === 'miss');
  const counts = buttons.filter((b) => b.kind === 'count');

  container.innerHTML = roster
    .map((player) => {
      const line = derived.playerLines[player.id] || playerLine(game, player.id);
      const selected = selectedPlayerIds.has(player.id);
      const name = escapeHtml(player.name);

      /**
       * One cell per key, so every button shares a table column with the
       * heading above it. A single spanning cell laid out by flexbox drifts:
       * the buttons size themselves and the headings stay where the table put
       * them, which is what put "+1" over the wrong button.
       */
      const keys = (list, group) =>
        list
          .map(
            (b) => `
          <td class="player-card__key player-card__keys--${group}">
            <button type="button"
                    class="stat-btn stat-btn--${b.kind}"
                    data-action="log-stat"
                    data-player-id="${escapeHtml(player.id)}"
                    data-stat="${b.key}"
                    data-result="${b.result ?? ''}"
                    title="${escapeHtml(b.title)}"
                    aria-label="${escapeHtml(`${b.title} for ${player.name}`)}">${escapeHtml(b.label)}</button>
          </td>`,
          )
          .join('');

      return `
        <tr class="player-card${selected ? ' player-card--selected' : ''}"
            style="--accent: ${accent}" data-action="player-row"
            data-player-id="${escapeHtml(player.id)}">
          <td class="player-card__check">
            <label class="roster__check-hit">
              <input type="checkbox" class="roster__check" data-action="toggle-player"
                     data-player-id="${escapeHtml(player.id)}"
                     aria-label="Select ${name}"${selected ? ' checked' : ''}>
            </label>
          </td>
          <td class="player-card__who">
            <span class="player-card__number">${escapeHtml(player.number) || '—'}</span>
            <span class="player-card__name" title="${name}">${name}</span>
          </td>
          ${keys(makes, 'scoring')}${keys(misses, 'scoring')}${keys(counts, 'other')}
        </tr>`;
    })
    .join('');
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

  // Newest first: the most recent entry is the one most likely to be wrong.
  const ordered = [...game.events].reverse();

  list.innerHTML = ordered
    .map((event) => {
      const player = game.players.find((p) => p.id === event.playerId);
    const points = eventPoints(event);
      const who = player
        ? `${player.number ? `#${player.number} ` : ''}${player.name}`
        : 'TEAM';

      return `
        <li class="log__row${player ? '' : ' log__row--team'}" style="--accent: ${accentFor(event.teamId)}">
          <span class="log__time">${escapeHtml(eventClock(clockface.elapsedInPeriod(game, event)))}</span>
          <span class="log__period">${escapeHtml(periodLabel(event.period, game.periodsPerGame))}</span>
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

function renderBox(derived) {
  const table = $('box-table');
  const columns = [
    ['PTS', (l) => l.points],
    ['FG', (l) => madeAttempted(l.fgMade, l.fgAtt)],
    ['3P', (l) => madeAttempted(l['3PT'].made, l['3PT'].made + l['3PT'].missed)],
    ['FT', (l) => madeAttempted(l.ftMade, l.ftAtt)],
    ['REB', (l) => l.reb],
    ['OREB', (l) => l.rebOff],
    ['DREB', (l) => l.rebDef],
    ['AST', (l) => l.ast],
    ['STL', (l) => l.stl],
    ['BLK', (l) => l.blk],
    ['TO', (l) => l.to],
    ['PF', (l) => l.pf],
  ];

  // Everything up to here is a tally of recorded events; what follows is read
  // off those tallies.
  const countingColumns = columns.length;

  // The rates read the same line the columns beside them do, and they only fit
  // once the panel has the whole width. That is what the Full width button on
  // this panel is for, so they are added there and nowhere else: the compact box
  // a scorer watches during play stays the twelve counting columns it was.
  if (expandedPanel === 'box') {
    columns.push(
      ['FG%', (l) => pct(l.fgPct)],
      ['3P%', (l) => pct(l.fg3Pct)],
      ['FT%', (l) => pct(l.ftPct)],
      ['eFG%', (l) => pct(l.efgPct)],
      ['TS%', (l) => pct(l.tsPct)],
      ['EFF', (l) => l.eff],
    );
  }

  // Everything after the counting columns is derived rather than recorded, so it
  // is ruled off to keep the eye from reading a rate as a tally.
  const cellClass = (index) => (index >= countingColumns ? ' class="is-advanced"' : '');

  const head = `<thead><tr><th>Player</th>${columns
    .map(([label], index) => `<th${cellClass(index)}>${label}</th>`)
    .join('')}</tr></thead>`;

  const currentTeamId = teamIdFor(detailTeamSlot);
  const currentCount = playersOf(game, currentTeamId).length;
  $('box-team-name').textContent = `${safeText(game.teams[currentTeamId]?.name) || 'Team'} · ${currentCount} player${
    currentCount === 1 ? '' : 's'
  }`;

  const body = [game.awayTeamId, game.homeTeamId]
    .filter(Boolean)
    .map((teamId) => {
      const team = game.teams[teamId];
      const roster = playersOf(game, teamId);
      const teamLineValues = derived.teamTotals[teamId] || teamLine(game, teamId);

      // Both teams stay in one table so the two totals can be read against each
      // other; the heading of the team being entered is marked so it is obvious
      // where the next tap will land.
      const heading = `<tr class="team-heading${
        teamId === currentTeamId ? ' is-current' : ''
      }"><td colspan="${columns.length + 1}">${escapeHtml(team?.name || 'Team')}</td></tr>`;

      const playerRows = roster
        .map((player) => {
          const line = derived.playerLines[player.id];
          if (!line) return '';
          return `<tr>
            <td class="js-name">${escapeHtml(player.number) ? `#${escapeHtml(player.number)} ` : ''}${escapeHtml(player.name)}</td>
            ${columns.map(([, get], index) => `<td${cellClass(index)}>${escapeHtml(get(line))}</td>`).join('')}
          </tr>`;
        })
        .join('');

      const totals = `<tr class="row--team">
        <td>Team totals</td>
        ${columns.map(([, get], index) => `<td${cellClass(index)}>${escapeHtml(get(teamLineValues))}</td>`).join('')}
      </tr>`;

      return heading + playerRows + totals;
    })
    .join('');

  table.innerHTML = `${head}<tbody>${body}</tbody>`;
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

/** Flash a player card so a tap is visibly acknowledged. */
function flashCard(playerId) {
  const card = document.querySelector(`.player-card[data-player-id="${CSS.escape(playerId)}"]`);
  if (!card) return;
  card.classList.add('is-hit');
  setTimeout(() => card.classList.remove('is-hit'), 220);
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
  showToast(`Moved ${describeEvent(previous.stat, previous.result)} to ${target?.name ?? 'another player'}.`);
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
      title: 'Restore this backup?',
      text: `The game on screen will be replaced by ${file.name}. ${atStake()}`,
      confirmLabel: 'Restore it',
      run: () => {
        game = imported;
        detailTeamSlot = 'home';
        save();
        render();
        showToast(`Restored the game from ${file.name}.`);
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
  if (clockIsBeingEdited()) return;

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
  for (const id of ['settings-dialog', 'summary-dialog', 'about-dialog']) {
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
 * Say whether the import/export bar is showing.
 *
 * The menu item toggles the bar rather than opening something, so it carries
 * its own state: a menu entry that looks like the others but leaves a mark
 * elsewhere on the screen is otherwise impossible to read.
 */
function renderMenuState() {
  const bar = $('actionbar');
  $('menu-files-state').textContent = bar.hidden ? 'Hidden' : 'Shown';
}

// ---------------------------------------------------------------------------
// The game summary
// ---------------------------------------------------------------------------

/**
 * The third reading of the same entries: the quarter grid and the leading
 * scorers, for the moment at the end of a game when someone asks how it went.
 *
 * It is computed on open rather than kept up to date, because it is only ever
 * looked at — nothing here can be tapped.
 */
function renderSummary() {
  const derived = computeGame(game);
  const periods = listPeriods(game);

  const gridHead = `<thead><tr><th>Team</th>${periods
    .map((p) => `<th>${escapeHtml(periodLabel(p, game.periodsPerGame))}</th>`)
    .join('')}<th>Total</th></tr></thead>`;

  const gridBody = `<tbody>${derived.grid.rows
    .map((row) => {
      const team = game.teams[row.teamId];
      const cells = row.cells.map((cell) => `<td>${escapedNumber(cell.value)}</td>`).join('');

      return `<tr>
        <td class="js-name" style="--accent: ${accentFor(row.teamId)}">
          <span class="sheet__team-dot" aria-hidden="true"></span>${escapeHtml(team?.name || 'Team')}
        </td>
        ${cells}
        <td class="row--team-total">${escapedNumber(row.total)}</td>
      </tr>`;
    })
    .join('')}</tbody>`;

  const scorers = [game.awayTeamId, game.homeTeamId]
    .filter(Boolean)
    .map((teamId) => {
      const team = game.teams[teamId];
      const ranked = playersOf(game, teamId)
        .map((player) => ({ player, line: derived.playerLines[player.id] }))
        .filter((entry) => entry.line && entry.line.points > 0)
        .sort((a, b) => b.line.points - a.line.points || a.player.name.localeCompare(b.player.name))
        .slice(0, 3);

      const items = ranked.length
        ? ranked
            .map(
              (entry) => `<li>
                <span class="summary__num">${
                  escapeHtml(entry.player.number) ? `#${escapeHtml(entry.player.number)}` : '—'
                }</span>
                <span class="summary__name">${escapeHtml(entry.player.name)}</span>
                <span class="summary__pts">${entry.line.points}</span>
              </li>`,
            )
            .join('')
        : '<li class="summary__none">No points recorded.</li>';

      return `<div class="summary__team">
        <h3 class="summary__heading" style="--accent: ${accentFor(teamId)}">${escapeHtml(
          team?.name || 'Team',
        )}</h3>
        <ol class="summary__list">${items}</ol>
      </div>`;
    })
    .join('');

  const line = (teamId) =>
    `<span class="summary__side" style="--accent: ${accentFor(teamId)}">
      <span class="summary__side-name">${escapeHtml(game.teams[teamId]?.name || 'Team')}</span>
      <span class="summary__side-score">${derived.scores[teamId] ?? 0}</span>
    </span>`;

  $('summary-body').innerHTML = `
    <div class="summary__score">${line(game.awayTeamId)}${line(game.homeTeamId)}</div>
    <div class="table-scroll"><table class="summary__grid">${gridHead}${gridBody}</table></div>
    <div class="summary__teams">${scorers}</div>`;
}

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
      logStat(target.dataset.playerId, target.dataset.stat, target.dataset.result);
      break;
    case 'toggle-expand': {
      const panel = target.dataset.panel;
      expandedPanel = expandedPanel === panel ? null : panel;
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
    case 'focus-roster': {
      // "Manage players" has no dialog of its own: the roster bar is already
      // on screen, so the useful thing is to put the cursor in it.
      closeMenu();
      const field = $('team-name-input');
      field.focus();
      field.select();
      break;
    }
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
    case 'toggle-actionbar': {
      const bar = $('actionbar');
      bar.hidden = !bar.hidden;
      renderMenuState();
      break;
    }
    case 'open-summary':
      closeMenu();
      renderSummary();
      openDialog('summary-dialog');
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
    case 'toggle-player': {
      // The checkbox has already flipped itself, so the DOM is the source of
      // truth for the direction of this toggle.
      const playerId = target.dataset.playerId;
      if (target.checked) selectedPlayerIds.add(playerId);
      else selectedPlayerIds.delete(playerId);
      render();
      break;
    }
    case 'toggle-all-players': {
      const roster = playersOf(game, teamIdFor(detailTeamSlot));
      if (target.checked) for (const player of roster) selectedPlayerIds.add(player.id);
      else selectedPlayerIds.clear();
      render();
      break;
    }
    case 'remove-selected-players':
      removeSelectedPlayers();
      break;
    case 'select-team':
      detailTeamSlot = target.dataset.teamSlot;
      render();
      break;
    case 'period-next':
      setPeriod(game, game.currentPeriod + 1);
      save();
      render();
      break;
    case 'period-prev':
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
  const viewing = ['settings-dialog', 'summary-dialog', 'about-dialog'].some(
    (id) => !$(id).hidden,
  );

  if (event.key === 'Escape' && (importing || viewing || !$('more-menu').hidden) && !clockIsBeingEdited()) {
    closeDialogs();
    closeImportDialogs();
    closeMenu();
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

  if (id === 'game-date') {
    game.date = event.target.value;
    save();
    return;
  }

  if (id === 'game-time') {
    game.time = event.target.value;
    save();
    return;
  }

  if (id === 'game-venue') {
    game.venue = event.target.value;
    save();
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
