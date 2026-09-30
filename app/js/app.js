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
  undoLastEvent,
  updateEvent,
  updateTeam,
} from './store.js';
import { COUNTING, REBOUND, SHOOTING, describeEvent, entryButtons, getStat } from './stats.js';
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
import { eventClock, madeAttempted, pct, periodLabel, safeText } from './format.js';
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
 * Players ticked for removal in the roster panel.
 *
 * Held here rather than read back off the checkboxes because every action
 * re-renders the whole panel: anything stored in the DOM would be lost when the
 * user logs a stat between ticking a player and removing them. Ids are pruned
 * against the viewed roster on every render, so a team switch, a new game or a
 * team loaded from file can never leave a stale id armed for deletion.
 */
let selectedPlayerIds = new Set();

const $ = (id) => document.getElementById(id);

function save() {
  const result = saveState(game);
  if (!result.ok) showToast('Could not save — the game is only in memory.');
  return result;
}

/**
 * Start the clock, refilling it from the period length if it is sitting at
 * 00:00. A clock at zero is between periods, so starting it starts a period.
 */
function startClock() {
  if (game.clock.running) return;

  const { seconds, fromZero } = clockface.startValue(game);
  setClock(game, seconds);
  setClockRunning(game, true);

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
  renderLog(derived);
  renderBox(derived);
  renderSheet(derived);
  renderFooter();
  renderTeamLibrary();

  $('undo-button').disabled = game.events.length === 0;

  // One word: the scoreboard is a thin status bar, and the time is already on
  // the clock face beside the button. The starting value is still announced in
  // the toast when the clock is refilled.
  $('clock-toggle').textContent = game.clock.running
    ? 'Pause'
    : game.clock.seconds === 0
      ? 'Start'
      : 'Resume';

  renderWarnings();
}

function renderScoreboard(derived) {
  const home = teamFor('home');
  const away = teamFor('away');

  $('score-home-name').textContent = safeText(home?.name, 'Home');
  $('score-away-name').textContent = safeText(away?.name, 'Away');
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
 * The team tabs and the name/abbreviation fields, which live on the roster bar
 * now that the roster no longer owns a column of its own.
 */
function renderTeamFields() {
  for (const slot of ['home', 'away']) {
    $(`team-tab-${slot}`).setAttribute('aria-selected', String(detailTeamSlot === slot));
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
  const message =
    entries > 0
      ? `Remove ${who} and delete ${entries} recorded ${entries === 1 ? 'entry' : 'entries'}? ` +
        'The score and box score will drop them.'
      : `Remove ${who}?`;

  if (!window.confirm(message)) return;

  // Removing a player is not an event, so the ordinary undo (which pops the
  // last entry) cannot reverse this. The confirmation is the safety net.
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
}


function renderEntry(derived) {
  const container = $('player-cards');

  // Entry works for one team at a time: a scorer is entering one team's events.
  const teamId = teamIdFor(detailTeamSlot);
  const roster = playersOf(game, teamId).filter((player) => player.active !== false);

  if (roster.length === 0) {
    container.innerHTML =
      '<p class="view__empty">No players yet — add one in the roster bar below.</p>';
    return;
  }

  const accent = accentFor(teamId);

  // Every button the app can record, in catalog order, with the group headings
  // dropped: at one row per player the filled/outlined button styles already
  // separate makes from misses, and the headings cost more height than they
  // were worth. The full stat catalog stays available as tooltips.
  const buttons = entryButtons();

  // The entry row carries the box-score columns inline, so one glance shows the
  // player's line and the buttons that change it. Percentages are the two
  // columns left out: the made-attempted pair ("5-9") already reads as a
  // percentage, and both values stay in the CSV and JSON exports.
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

  const header = columns
    .map(([label]) => `<span class="player-card__col-label">${label}</span>`)
    .join('');

  container.innerHTML = roster
    .map((player) => {
      const line = derived.playerLines[player.id] || playerLine(game, player.id);
      const selected = selectedPlayerIds.has(player.id);
      const name = escapeHtml(player.name);

      const statButtons = buttons
        .map(
          (b) => `
            <button type="button"
                    class="stat-btn stat-btn--${b.kind}"
                    data-action="log-stat"
                    data-player-id="${escapeHtml(player.id)}"
                    data-stat="${b.key}"
                    data-result="${b.result ?? ''}"
                    title="${escapeHtml(b.title)}"
                    aria-label="${escapeHtml(`${b.title} for ${player.name}`)}">${escapeHtml(b.label)}</button>`,
        )
        .join('');

      const statValues = columns
        .map(([, get]) => `<span class="player-card__col">${escapeHtml(String(get(line)))}</span>`)
        .join('');

      return `
        <article class="player-card${selected ? ' player-card--selected' : ''}"
                 style="--accent: ${accent}" data-action="player-row"
                 data-player-id="${escapeHtml(player.id)}">
          <div class="player-card__row player-card__row--info">
            <label class="roster__check-hit">
              <input type="checkbox" class="roster__check" data-action="toggle-player"
                     data-player-id="${escapeHtml(player.id)}"
                     aria-label="Select ${name}"${selected ? ' checked' : ''}>
            </label>
            <span class="player-card__number">${escapeHtml(player.number) || '—'}</span>
            <span class="player-card__name" title="${name}">${name}</span>
            <div class="player-card__stats">${header}${statValues}</div>
          </div>
          <div class="player-card__row player-card__row--buttons">
            <span class="player-card__stat-line">${statButtons}</span>
          </div>
        </article>`;
    })
    .join('');
}

function renderLog(derived) {
  const list = $('log-list');

  if (game.events.length === 0) {
    list.innerHTML = '<li class="log__empty">No entries yet. Everything you log appears here.</li>';
    return;
  }

  // Newest first: the most recent entry is the one most likely to be wrong.
  const ordered = [...game.events].reverse();

  list.innerHTML = ordered
    .map((event) => {
      const team = game.teams[event.teamId];
      const player = game.players.find((p) => p.id === event.playerId);
      const points = event.result === 'made' ? (getStat(event.stat)?.points ?? 0) : 0;
      const who = `${player?.number ? `#${player.number} ` : ''}${player?.name ?? 'Unknown player'}`;

      return `
        <li class="log__row" style="--accent: ${accentFor(event.teamId)}">
          <span class="log__period">${escapeHtml(periodLabel(event.period, game.periodsPerGame))}</span>
          <span class="log__time">${escapeHtml(eventClock(clockface.elapsedInPeriod(game, event)))}</span>
          <span class="log__who">${escapeHtml(who)}</span>
          <span class="log__what">${escapeHtml(describeEvent(event.stat, event.result))}</span>
          <span class="log__points">${points > 0 ? `+${points}` : ''}</span>
          ${reassignSelect(event)}
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
    ['FG%', (l) => pct(l.fgPct)],
    ['3P', (l) => madeAttempted(l['3PT'].made, l['3PT'].made + l['3PT'].missed)],
    ['FT', (l) => madeAttempted(l.ftMade, l.ftAtt)],
    ['FT%', (l) => pct(l.ftPct)],
    ['REB', (l) => l.reb],
    ['OREB', (l) => l.rebOff],
    ['DREB', (l) => l.rebDef],
    ['AST', (l) => l.ast],
    ['STL', (l) => l.stl],
    ['BLK', (l) => l.blk],
    ['TO', (l) => l.to],
    ['PF', (l) => l.pf],
  ];

  const head = `<thead><tr><th>Player</th>${columns
    .map(([label]) => `<th>${label}</th>`)
    .join('')}</tr></thead>`;

  const body = [game.awayTeamId, game.homeTeamId]
    .filter(Boolean)
    .map((teamId) => {
      const team = game.teams[teamId];
      const roster = playersOf(game, teamId);
      const teamLineValues = derived.teamTotals[teamId] || teamLine(game, teamId);

      const heading = `<tr class="team-heading"><td colspan="${columns.length + 1}">${escapeHtml(
        team?.name || 'Team',
      )}</td></tr>`;

      const playerRows = roster
        .map((player) => {
          const line = derived.playerLines[player.id];
          if (!line) return '';
          return `<tr>
            <td class="js-name">${escapeHtml(player.number) ? `#${escapeHtml(player.number)} ` : ''}${escapeHtml(player.name)}</td>
            ${columns.map(([, get]) => `<td>${escapeHtml(get(line))}</td>`).join('')}
          </tr>`;
        })
        .join('');

      const totals = `<tr class="row--team">
        <td>Team totals</td>
        ${columns.map(([, get]) => `<td>${escapeHtml(get(teamLineValues))}</td>`).join('')}
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
  $('game-venue').value = safeText(game.venue);
  $('game-periods').value = String(game.periodsPerGame);

  $('game-period-length').innerHTML = clockface.PERIOD_LENGTHS.map(
    (length) =>
      `<option value="${length.seconds}"${
        length.seconds === game.periodSeconds ? ' selected' : ''
      }>${escapeHtml(length.label)}</option>`,
  ).join('');

  // Shown so a stale cached bundle is obvious at a glance when something looks
  // out of date. The build stamp is the discriminator: if you are expecting a
  // fix and this still reads the old stamp, the browser is running old code.
  const version = document.querySelector('meta[name="app-version"]')?.content;
  const build = document.querySelector('meta[name="app-build"]')?.content;
  $('app-version').textContent = version ? `v${version}${build ? ` · ${build}` : ''}` : '';
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


function startNewGame() {
  if (game.events.length > 0 && !window.confirm('Start a blank game? The current game will be discarded — export it first if you need it.')) {
    return;
  }
  game = createGame({ date: game.date, periodsPerGame: game.periodsPerGame });
  detailTeamSlot = 'home';
  save();
  render();
  showToast('New game ready. Load your saved teams to set the rosters.');
}

function loadSample() {
  if (!window.confirm('Replace the current game with the sample game?')) return;
  game = sampleGame();
  detailTeamSlot = 'home';
  save();
  render();
  showToast('Sample game loaded.');
}

async function importFromFile(file) {
  try {
    const text = await file.text();
    const { game: imported, error } = importGame(text);
    if (error) {
      showToast(error);
      return;
    }
    game = imported;
    detailTeamSlot = 'home';
    save();
    render();
    showToast(`Restored the game from ${file.name}.`);
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
    $('clock-toggle').textContent = 'Resume';
    showToast('Clock paused while you set the time.');
  }

  display.setAttribute('contenteditable', 'true');
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

  display.setAttribute('contenteditable', 'false');
  setClock(game, seconds);
  setClockRunning(game, false);
  save();
  render();
  // render() skips the clock face while it is being edited, so normalise it here.
  display.textContent = clockface.display(game.clock.seconds);
  showToast(
    seconds === 0
      ? `Clock cleared. It will fill to ${clockface.display(clockface.periodLength(game))} when started.`
      : `Clock set to ${clockface.display(seconds)}. Use ${'Start'} to count down.`,
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
 * Tick the clock only while it is running.
 *
 * A self-rescheduling timeout rather than a permanent interval, so an idle app
 * is not waking up once a second all game.
 */
function ensureClockTicking() {
  clearTimeout(clockTimer);
  if (!game.clock.running) return;

  clockTimer = setTimeout(() => {
    if (game.clock.running) {
      tickClock();
      // Persist about once a second while running rather than on every tick, so
      // a long game does not thrash localStorage.
      save();
    }
    ensureClockTicking();
  }, 1000);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  // Clicking the clock face itself begins editing.
  if (event.target.id === 'clock-display') {
    beginClockEdit();
    return;
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'log-stat':
      logStat(target.dataset.playerId, target.dataset.stat, target.dataset.result);
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
      if (game.clock.running) {
        setClockRunning(game, false);
        save();
      } else {
        startClock();
        save();
        ensureClockTicking();
      }
      render();
      break;
    case 'edit-clock':
      beginClockEdit();
      break;
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

// Enter commits a cell edit instead of adding a newline.
document.addEventListener('keydown', (event) => {
  // Escape closes the import confirmation, discarding the picked file.
  // Escape closes whichever import dialog is open, discarding what it holds.
  const importing = !$('load-team-dialog').hidden || !$('paste-roster-dialog').hidden;
  if (event.key === 'Escape' && importing && !clockIsBeingEdited()) {
    closeImportDialogs();
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
      event.target.setAttribute('contenteditable', 'false');
      event.target.textContent = clockface.display(game.clock.seconds);
      event.target.blur();
      return;
    }
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

  if (id === 'game-date') {
    game.date = event.target.value;
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
  // Let the date and venue fields update the model as they are typed, so an
  // export mid-edit still carries the current values.
  if (event.target.id === 'game-date') game.date = event.target.value;
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
ensureClockTicking();
render();
