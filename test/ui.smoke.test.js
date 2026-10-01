/**
 * Headless smoke test.
 *
 * The derivation engine is covered by unit tests, but nothing there proves the
 * UI wires up. This drives `app.js` against a minimal hand-rolled DOM so a typo
 * in an element id, a crash inside a render function, or a broken entry flow
 * fails loudly instead of only showing up in a browser.
 *
 * It is deliberately not a DOM emulator: only the handful of APIs the app
 * touches are implemented.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..', 'app');

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------

/**
 * Recorded downloads, shared between the anchor stub and the Blob stub, and
 * reset for each app instance.
 */
let pendingBlob = null;
let downloads = [];
let timers = [];

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(name) {
    this.set.add(name);
  }
  remove(name) {
    this.set.delete(name);
  }
  contains(name) {
    return this.set.has(name);
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = {};
    this.attributes = {};
    this.classList = new ClassList();
    this.children = [];
    this.listeners = new Map();
    this._innerHTML = '';
    this._textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    // Checkboxes: the app reads `checked` to learn the direction of a toggle,
    // and sets `indeterminate` for a partly selected roster.
    this.checked = false;
    this.indeterminate = false;
    this.files = [];
    this.style = {};
    this.href = '';
    this.download = '';
  }

  set innerHTML(html) {
    this._innerHTML = String(html);
  }
  get innerHTML() {
    return this._innerHTML;
  }

  set textContent(text) {
    this._textContent = String(text);
    if (text === '') this._innerHTML = '';
  }
  /**
   * Reading textContent must reflect whatever markup was last assigned, the way
   * a real DOM node does — otherwise a test asserting on rendered output reads
   * an empty string and the failure looks like a bug in the app.
   */
  get textContent() {
    if (!this._innerHTML) return this._textContent;
    return this._innerHTML
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }

  querySelector(selector) {
    // The storage banner is the one place the app uses querySelector, and only
    // when storage is unusable, which it is not under the test stub.
    if (selector === 'p') return this;
    return null;
  }
  closest() {
    return null;
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener() {}
  click() {
    // A real anchor click starts a download; record it so exports can be
    // asserted on without a browser.
    if (this.download) {
      downloads.push({
        filename: this.download,
        href: this.href,
        ...(pendingBlob || {}),
      });
      pendingBlob = null;
    }
  }
  focus() {}
  blur() {}
  select() {}

  /** Text of the rendered markup, so assertions can look for real values. */
  get rendered() {
    return this._innerHTML;
  }
}

/**
 * Build the id -> element map from the real HTML file, so this test breaks if a
 * lookup in app.js stops matching the document.
 */
function buildDocument() {
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const elements = new Map();

  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    const id = match[1];
    const tag = html.slice(0, match.index).match(/<([a-zA-Z]+)[^>]*$/)?.[1] ?? 'div';
    const element = new Element(tag, id);

    // Carry the `hidden` attribute across, and default it per element type.
    // A fresh stub element otherwise has `hidden === false`, which makes every
    // dialog look permanently open — exactly the kind of thing that hides a
    // real bug. Dialogs in the document start hidden, so the stub must too.
    const openTagStart = html.lastIndexOf('<', match.index);
    const openTag = html.slice(openTagStart, html.indexOf('>', match.index) + 1);

    if (/\shidden(\s|>|=)/.test(openTag)) {
      element.hidden = true;
    } else if (/class="[^"]*\bdialog\b/.test(openTag)) {
      element.hidden = true;
    }

    // Carry the attributes the app reads, so getAttribute reflects the document
    // rather than returning null for everything.
    for (const attr of openTag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      element.setAttribute(attr[1], attr[2]);
    }
    element._textContent = html
      .slice(html.indexOf('>', match.index) + 1, html.indexOf('</', match.index))
      .trim();

    elements.set(id, element);
  }

  return elements;
}

function installFakeDom() {
  pendingBlob = null;
  downloads = [];
  timers = [];
  const elements = buildDocument();
  const listeners = new Map();

  const document = {
    body: new Element('body'),
    activeElement: null,
    // Only ids that exist in the document resolve, so a lookup for a missing
    // element surfaces as a real failure instead of silently working.
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => new Element(tag),
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener: () => {},
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const toasts = [];

  globalThis.document = document;
  globalThis.localStorage = localStorage;
  // Deliberately no window.confirm: the app asks through its own dialog now, so
  // leaving a stub here would let a reintroduced native prompt pass unnoticed.
  globalThis.window = {
    addEventListener: () => {},
  };
  globalThis.CSS = { escape: (value) => String(value) };
  // Timers are queued, not run. The app uses setTimeout both for the 1-second
  // clock and for deferred renders, and running them inline would recurse the
  // full length of a ten-minute clock. Tests advance time explicitly instead.
  timers = [];
  let nextTimerId = 1;
  globalThis.setTimeout = (fn) => {
    const id = nextTimerId++;
    timers.push({ id, fn });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers = timers.filter((timer) => timer.id !== id);
  };
  globalThis.URL = {
    createObjectURL: (blob) => {
      // The most recent pending download is the one the anchor will reference.
      pendingBlob = { text: blob.parts.join(''), type: blob.type };
      return 'blob:x';
    },
    revokeObjectURL: () => {},
  };
  globalThis.Blob = class {
    constructor(parts, options = {}) {
      this.parts = parts;
      this.type = options.type || '';
    }
  };

  return { elements, listeners, storage, toasts, document, downloads };
}

/** Let queued microtasks and deferred renders run. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run whatever timers are pending, one pass, the way a real event loop would.
 * Each pass may queue more (the clock reschedules itself), so this is
 * deliberately one pass rather than a drain.
 */
function runTimers() {
  const due = timers;
  timers = [];
  for (const timer of due) timer.fn();
}

/** The game state as the app persisted it. */
function storedGame() {
  const raw = localStorage.getItem('game-stats-logger/state/v1');
  return raw ? JSON.parse(raw).game : null;
}

/**
 * Fire an event.
 *
 * Element-level listeners (the add-player form, the file input) and the
 * document-level delegated listeners are both dispatched, so a test exercises
 * the same path a real click or submit would.
 */
function emit(listeners, type, target, extra = {}) {
  const event = {
    target,
    preventDefault: () => {},
    ...extra,
  };
  if (target instanceof Element) {
    for (const handler of target.listeners.get(type) ?? []) handler(event);
  }
  for (const handler of listeners.get(type) ?? []) handler(event);
}

/** A clickable element carrying the given data attributes. */
function actionable(dataset) {
  const el = new Element('button');
  Object.assign(el.dataset, dataset);
  el.closest = (selector) => (selector === '[data-action]' ? el : null);
  return el;
}

/**
 * Click through the confirmation the app shows before a destructive act.
 *
 * Asserts the dialog was actually waiting. If an action ever stops asking, the
 * test should fail here rather than quietly performing the step for it.
 */
function confirmDanger(dom) {
  assert.equal(
    document.getElementById('confirm-dialog').hidden,
    false,
    'a confirmation should be waiting before this action',
  );
  emit(dom.listeners, 'click', actionable({ action: 'confirm-danger' }));
}

// ---------------------------------------------------------------------------
// The app is a module with top-level side effects, so it is loaded fresh per
// test group via a cache-busting query string.
// ---------------------------------------------------------------------------

let appLoadCount = 0;

/**
 * Import app.js under a fresh module identity.
 *
 * The module has top-level side effects — it resolves elements and registers
 * listeners once — so a cached module would keep writing into the *first* test's
 * document while a later test asserted on its own. A unique query string forces
 * a re-evaluation per test.
 */
async function loadApp() {
  appLoadCount += 1;
  await import(`../app/js/app.js?smoke=${appLoadCount}`);
}

/** A new, isolated document, with the app booted against it. */
async function startApp() {
  const dom = installFakeDom();
  await loadApp();
  return dom;
}

// ---------------------------------------------------------------------------

test('the app boots and renders without throwing', async () => {
  await startApp();

  // The seed game must reach the screen, not just the model.
  assert.match(document.getElementById('score-home').textContent, /^\d+$/);
  assert.match(document.getElementById('score-away').textContent, /^\d+$/);
  assert.equal(document.getElementById('period-display').textContent, 'Q3');
  assert.equal(document.getElementById('clock-display').textContent, '06:52');

  // Home and away names come from the sample teams.
  assert.equal(document.getElementById('score-home-name').textContent, 'Northside');
  assert.equal(document.getElementById('score-away-name').textContent, 'Riverside');

  // No advisory strip across the top: it took a line of the scoring area to say
  // something the export controls already imply. Storage works under the stub,
  // so the failure-only warning must stay hidden.
  assert.equal(document.getElementById('storage-banner').hidden, true, 'no banner over the board');
});

test('the hidden attribute really hides, whatever the component sets', async () => {
  // A component's own `display: flex` outranks the browser's built-in
  // `[hidden] { display: none }`, so `.hidden = true` silently did nothing —
  // which is how both the storage banner and the toast ended up stuck on
  // screen. The global guard is what makes the attribute mean what it says.
  const css = readFileSync(resolve(appDir, 'styles.css'), 'utf8');
  assert.match(
    css,
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    'the hidden attribute must win over a component display',
  );

  // The two components that set `display` themselves are the ones that need it.
  const blockFor = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at !== -1, `expected a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(blockFor('.toast'), /display:\s*flex/);
  assert.match(blockFor('.banner'), /display:\s*flex/);

  const dom = await startApp();
  assert.equal(document.getElementById('storage-banner').hidden, true);

  // Dismissing reports success rather than throwing.
  emit(dom.listeners, 'click', actionable({ action: 'dismiss-banner' }));
  assert.equal(document.getElementById('storage-banner').hidden, true);
});

test('the roster bar sits directly above the entry rows', async () => {
  // Setting up the two teams is the first thing a scorer does, so the bar
  // belongs next to the entry rows rather than below the box score — and just
  // above the workspace, so the page's scroll carries it away with the rest of
  // the setup instead of pinning it to the panels.
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const rosterAt = html.indexOf('class="rosterbar"');
  const workspaceAt = html.indexOf('<main');
  const entryAt = html.indexOf('panel--entry');
  assert.ok(rosterAt !== -1, 'the roster bar should exist');
  assert.ok(entryAt !== -1, 'live entry should be inside the workspace');
  assert.ok(
    rosterAt < workspaceAt,
    'the roster bar belongs above the workspace, so scrolling can take it away',
  );
  assert.ok(rosterAt < entryAt, 'the roster bar should come before live entry');

  // And the team controls still work from their new home.
  const dom = await startApp();
  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'away' }));
  assert.equal(document.getElementById('team-tab-away').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('team-name-input').value, 'Riverside');
});

test('every element id referenced by the app exists in the HTML document', async () => {
  // Read the ids straight from the markup and check the app's lookups against
  // them, so a renamed or removed id fails here rather than at runtime.
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const appSource = readFileSync(resolve(appDir, 'js', 'app.js'), 'utf8');

  const lookedUp = new Set([...appSource.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  // Template lookups like $(`team-tab-${slot}`) are expanded against the domain
  // of their own variable, so the expansion has to match the variable used.
  const domains = {
    slot: ['home', 'away'],
    panel: ['entry', 'log', 'box'],
  };
  for (const m of appSource.matchAll(/\$\(`([^`]+)`\)/g)) {
    const variable = m[1].match(/\$\{(\w+)\}/)?.[1];
    for (const value of domains[variable] ?? []) {
      lookedUp.add(m[1].replace(/\$\{[^}]+\}/g, value));
    }
  }

  const missing = [...lookedUp].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], 'these ids are looked up but not in index.html');

  await startApp();

  // And every id in the document resolves after boot.
  for (const id of htmlIds) {
    assert.ok(document.getElementById(id), `#${id} should resolve`);
  }
});

test('the sample game renders a populated box score and scoresheet', async () => {
  await startApp();

  const box = document.getElementById('box-table').innerHTML;
  assert.match(box, /J\. Reed/);
  assert.match(box, /M\. Diaz/);
  assert.match(box, /Team totals/);

  const sheet = document.getElementById('sheet-table').innerHTML;
  assert.match(sheet, /Northside/);
  assert.match(sheet, /Riverside/);
  // Four quarters plus a total column.
  assert.match(sheet, />Q1</);
  assert.match(sheet, />Q4</);
});

test('the play-by-play lists the seeded entries newest first', async () => {
  await startApp();

  const log = document.getElementById('log-list').innerHTML;
  const firstPeriod = log.indexOf('Q3');
  const laterPeriod = log.indexOf('Q1');
  assert.ok(firstPeriod >= 0, 'Q3 entries should be present');
  assert.ok(
    firstPeriod < laterPeriod,
    'the newest period should appear before the earliest one',
  );
});

test('the play-by-play counts up from 00:00, not down from the period length', async () => {
  await startApp();

  const log = document.getElementById('log-list').innerHTML;
  const times = [...log.matchAll(/class="log__time">([^<]*)</g)].map((match) => match[1]);
  assert.ok(times.length > 0, 'every entry should render a time');

  for (const time of times) {
    assert.match(time, /^\d{2}:\d{2}$/, `"${time}" should be MM:SS`);
  }

  // The list is newest first, so the last row is the opening play at 0:30 and
  // the first row is the final play of the third period at 9:42. A countdown
  // would report those two values the other way round.
  assert.equal(times[0], '09:42', 'the newest entry reads late in its period');
  assert.equal(times[times.length - 1], '00:30', 'the oldest entry reads early');
});

test('a logged stat updates the scoreboard, roster and box score together', async () => {
  const dom = await startApp();

  const before = Number(document.getElementById('score-home').textContent);

  // Find a real player id from the rendered card markup.
  const cards = document.getElementById('player-cards').innerHTML;
  const playerId = cards.match(/data-player-id="([^"]+)"/)?.[1];
  assert.ok(playerId, 'a player card should be rendered');

  emit(
    dom.listeners,
    'click',
    actionable({ action: 'log-stat', playerId, stat: '3PT', result: 'made' }),
  );

  const after = Number(document.getElementById('score-home').textContent);
  assert.equal(after, before + 3, 'a made three should add exactly three points');

  // The same total must appear in the scoresheet and the box score.
  const sheet = document.getElementById('sheet-table').innerHTML;
  const box = document.getElementById('box-table').innerHTML;
  assert.ok(sheet.includes(String(after)), 'scoresheet should carry the total');
  assert.ok(box.includes(String(after)), 'box score should carry the total');
});

test('undo restores the previous score', async () => {
  const dom = await startApp();

  const before = Number(document.getElementById('score-home').textContent);
  const playerId = document.getElementById('player-cards').innerHTML.match(
    /data-player-id="([^"]+)"/,
  )[1];

  emit(dom.listeners, 'click', actionable({ action: 'log-stat', playerId, stat: '2PT', result: 'made' }));
  assert.equal(Number(document.getElementById('score-home').textContent), before + 2);

  emit(dom.listeners, 'click', actionable({ action: 'undo' }));
  assert.equal(Number(document.getElementById('score-home').textContent), before);
});

test('switching teams re-renders without throwing', async () => {
  const dom = await startApp();

  for (const slot of ['away', 'home']) {
    emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: slot }));
    assert.equal(
      document.getElementById('team-tab-' + slot).getAttribute('aria-selected'),
      'true',
    );
  }
});

test('period controls move the current period and relabel the board', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'period-next' }));
  assert.equal(document.getElementById('period-display').textContent, 'Q4');

  emit(dom.listeners, 'click', actionable({ action: 'period-prev' }));
  assert.equal(document.getElementById('period-display').textContent, 'Q3');
});

// ---------------------------------------------------------------------------
// Team files
// ---------------------------------------------------------------------------

test('saving a team triggers a JSON file download named after the team', async () => {
  const dom = await startApp();

  const name = document.getElementById('score-home-name').textContent;
  // Count rows, not id attributes: each row emits its player id three times
  // (row, checkbox, and every stat button). An unselected row is marked with
  // the bare class, which is what this matches.
  const rosterSize = (document.getElementById('player-cards').innerHTML.match(
    /<tr class="player-card"/g,
  ) || []).length;
  assert.ok(rosterSize > 0, 'the seeded game should have a home roster');

  emit(dom.listeners, 'click', actionable({ action: 'save-team' }));

  assert.ok(dom.downloads.length, 'a download should have been triggered');
  const file = dom.downloads.at(-1);
  assert.equal(file.filename, `${name.replace(/[^a-zA-Z0-9]+/g, '-')}_team.json`);

  const payload = JSON.parse(file.text);
  assert.equal(payload.format, 'game-stats-logger/team');
  assert.equal(payload.team.name, name);
  assert.equal(payload.team.players.length, rosterSize);
});

test('a picked team file asks for confirmation before replacing the roster', async () => {
  const dom = await startApp();

  // Build a team file for a different team.
  const teamFile = JSON.stringify({
    format: 'game-stats-logger/team',
    version: 1,
    team: {
      name: 'Riverside',
      abbreviation: 'RIV',
      players: [
        { number: '12', name: 'M. Diaz' },
        { number: '34', name: 'P. Alvarez' },
      ],
    },
  });

  emit(dom.listeners, 'click', actionable({ action: 'open-load-team' }));
  // The picker is a hidden input; drive its change event directly.
  const input = document.getElementById('team-file-input');
  input.files = [{ name: 'Riverside_team.json', text: () => teamFile }];
  emit(dom.listeners, 'change', input);
  await settle();

  const dialog = document.getElementById('load-team-dialog');
  assert.equal(dialog.hidden, false, 'the confirm dialog should open');
  // The summary states the exact damage: how many players go, how many arrive,
  // and that the entries they logged are kept.
  const summary = document.getElementById('load-team-target').textContent;
  assert.match(summary, /Riverside_team\.json/);
  assert.match(summary, /Replace the 5 players on Northside with 2/);
  assert.match(summary, /recorded entr/);
  assert.equal(document.getElementById('load-team-mode').hidden, true, 'a file replaces, so no mode choice');

  // Nothing applied until confirmed.
  const beforeConfirm = document.getElementById('player-cards').innerHTML;
  assert.match(beforeConfirm, /Northside|J\. Reed|Question/, 'roster should be untouched yet');

  emit(dom.listeners, 'click', actionable({ action: 'confirm-load-team' }));
  await settle();

  assert.equal(dialog.hidden, true);
  assert.equal(document.getElementById('score-home-name').textContent, 'Riverside');
  assert.match(document.getElementById('player-cards').innerHTML, /M\. Diaz/);
  // The toast names the file it came from, which is the only record of it.
  assert.match(document.getElementById('toast').textContent, /Riverside_team\.json/);
});

test('cancelling a picked team file leaves the roster alone', async () => {
  const dom = await startApp();

  const before = document.getElementById('player-cards').innerHTML;
  const nameBefore = document.getElementById('score-home-name').textContent;

  const teamFile = JSON.stringify({
    team: { name: 'Riverside', players: [{ number: '12', name: 'M. Diaz' }] },
  });
  const input = document.getElementById('team-file-input');
  input.files = [{ name: 'r.json', text: () => teamFile }];
  emit(dom.listeners, 'change', input);
  await settle();

  emit(dom.listeners, 'click', actionable({ action: 'close-dialog' }));
  await settle();

  assert.equal(document.getElementById('load-team-dialog').hidden, true);
  assert.equal(document.getElementById('player-cards').innerHTML, before);
  assert.equal(document.getElementById('score-home-name').textContent, nameBefore);
});

test('a file that is not a team is reported and changes nothing', async () => {
  const dom = await startApp();

  const before = document.getElementById('player-cards').innerHTML;
  const input = document.getElementById('team-file-input');
  input.files = [{ name: 'game.json', text: () => '{"schemaVersion":1,"game":{}}' }];
  emit(dom.listeners, 'change', input);
  await settle();

  assert.equal(document.getElementById('load-team-dialog').hidden, true, 'no confirm dialog');
  assert.match(document.getElementById('toast').textContent, /full game backup/);
  assert.equal(document.getElementById('player-cards').innerHTML, before);
});

test('corrupt JSON is reported rather than thrown', async () => {
  const dom = await startApp();

  const input = document.getElementById('team-file-input');
  input.files = [{ name: 'broken.json', text: () => '{{{not json' }];
  emit(dom.listeners, 'change', input);
  await settle();

  assert.match(document.getElementById('toast').textContent, /not valid JSON/);
  assert.equal(document.getElementById('load-team-dialog').hidden, true);
});

test('pasting a roster asks to replace or add, then imports on confirm', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'open-paste-roster' }));
  const paste = document.getElementById('paste-roster-dialog');
  assert.equal(paste.hidden, false, 'the paste box should open');

  document.getElementById('roster-paste-text').value = '陳大文,55\n李小明,4';
  emit(dom.listeners, 'click', actionable({ action: 'import-pasted-roster' }));
  await settle();

  const dialog = document.getElementById('load-team-dialog');
  assert.equal(dialog.hidden, false, 'the same confirmation the file path uses');
  // The paste box must close, because both dialogs share one stacking level and
  // the paste box sits later in the document: leaving it open put the
  // confirmation behind it, so a real click on "Read these players" looked like
  // it had done nothing at all.
  assert.equal(paste.hidden, true, 'the paste box must not cover the confirmation');
  // A paste supplies players, not an identity, and it offers both choices.
  assert.equal(document.getElementById('load-team-mode').hidden, false);
  assert.match(document.getElementById('load-team-target').textContent, /the pasted roster/);
  assert.match(document.getElementById('load-team-target').textContent, /Replace the 5 players/);
  assert.equal(document.getElementById('load-team-target').textContent.includes('陳大文'), false);

  // Nothing changes until the confirmation is accepted.
  assert.match(document.getElementById('player-cards').innerHTML, /J\. Reed/);

  emit(dom.listeners, 'click', actionable({ action: 'confirm-load-team' }));
  await settle();

  assert.equal(dialog.hidden, true);
  assert.match(document.getElementById('player-cards').innerHTML, /陳大文/);
  assert.match(document.getElementById('player-cards').innerHTML, /李小明/);
  assert.equal(document.getElementById('player-cards').innerHTML.includes('J. Reed'), false);
  // The team keeps its own name: a paste only replaces players.
  assert.equal(document.getElementById('score-home-name').textContent, 'Northside');
  assert.match(document.getElementById('toast').textContent, /pasted roster/);
});

test('choosing Add keeps the players already on the team', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'open-paste-roster' }));
  document.getElementById('roster-paste-text').value = '陳大文,55';
  emit(dom.listeners, 'click', actionable({ action: 'import-pasted-roster' }));
  await settle();

  // The radio pair is real DOM, so a test drives it by setting .checked.
  document.getElementById('load-mode-add').checked = true;
  emit(dom.listeners, 'click', actionable({ action: 'confirm-load-team' }));
  await settle();

  const cards = document.getElementById('player-cards').innerHTML;
  // Assert on the jersey number, which renders in full: a long name is
  // ellipsised in the compact row.
  assert.match(cards, /player-card__number">4</, 'the existing roster survives');
  assert.match(cards, /陳大文/, 'and the pasted player joins it');
});

test('a single-column paste is reported in the dialog, not imported', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'open-paste-roster' }));
  document.getElementById('roster-paste-text').value = '陳大文\n李小明';

  emit(dom.listeners, 'click', actionable({ action: 'import-pasted-roster' }));
  await settle();

  const error = document.getElementById('paste-roster-error');
  assert.equal(error.hidden, false, 'the problem is shown next to the box');
  assert.match(error.textContent, /player and a number/i);
  assert.equal(
    document.getElementById('load-team-dialog').hidden,
    true,
    'no confirmation for input that could not be read',
  );
  assert.match(document.getElementById('player-cards').innerHTML, /J\. Reed/, 'roster untouched');
});

test('an empty paste is reported rather than importing nothing', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'open-paste-roster' }));
  document.getElementById('roster-paste-text').value = '   \n  ';

  emit(dom.listeners, 'click', actionable({ action: 'import-pasted-roster' }));
  await settle();

  assert.match(document.getElementById('paste-roster-error').textContent, /empty/i);
  assert.equal(document.getElementById('load-team-dialog').hidden, true);
});

test('Escape closes the paste box', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'open-paste-roster' }));
  assert.equal(document.getElementById('paste-roster-dialog').hidden, false);

  emit(dom.listeners, 'keydown', document.getElementById('clock-display'), { key: 'Escape' });
  assert.equal(document.getElementById('paste-roster-dialog').hidden, true);
});

test('a picked CSV file imports through the same confirmation', async () => {
  const dom = await startApp();

  const csv = 'Player,Group,Number\n陳大文,U14,55\n李小明,U17,4\n';
  const input = document.getElementById('team-file-input');
  input.files = [{ name: 'Sunrise-2026_roster.csv', text: () => csv }];
  emit(dom.listeners, 'change', input);
  await settle();

  assert.equal(document.getElementById('load-team-dialog').hidden, false, 'CSV opens the dialog');
  const summary = document.getElementById('load-team-target').textContent;
  assert.match(summary, /Sunrise-2026_roster\.csv/);
  assert.match(summary, /Read as a header row, comma-separated columns/);
  assert.match(summary, /ignored Group/);

  emit(dom.listeners, 'click', actionable({ action: 'confirm-load-team' }));
  await settle();

  assert.match(document.getElementById('player-cards').innerHTML, /陳大文/);
  assert.equal(document.getElementById('score-home-name').textContent, 'Northside');
});

test('a CSV with no header is read by finding the number column', async () => {
  const dom = await startApp();

  const input = document.getElementById('team-file-input');
  input.files = [{ name: 'roster.csv', text: () => '陳大文,U14,55\n李小明,U17,4' }];
  emit(dom.listeners, 'change', input);
  await settle();

  emit(dom.listeners, 'click', actionable({ action: 'confirm-load-team' }));
  await settle();

  const cards = document.getElementById('player-cards').innerHTML;
  assert.match(cards, /陳大文/);
  // The jersey numbers are the third column, not the group codes.
  assert.match(cards, /55/);
  assert.equal(cards.includes('U14'), false);
});

test('the save button is disabled until the team has a player', async () => {
  const dom = await startApp();

  // A blank game has empty rosters on both sides, so saving is unavailable.
  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  assert.equal(document.getElementById('save-team-button').disabled, true);

  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'away' }));
  assert.equal(document.getElementById('save-team-button').disabled, true);

  // Add one player to the away team, through the real form path.
  document.getElementById('new-number').value = '12';
  document.getElementById('new-name').value = 'M. Diaz';
  emit(dom.listeners, 'submit', document.getElementById('add-player-form'));

  assert.equal(document.getElementById('save-team-button').disabled, false);

  // The home team is still empty, so switching back disables it again.
  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'home' }));
  assert.equal(document.getElementById('save-team-button').disabled, true);
});

// ---------------------------------------------------------------------------
// Bulk roster removal
// ---------------------------------------------------------------------------

/** A checkbox carrying the given data attributes and checked state. */
function checkbox(dataset, checked) {
  const el = actionable(dataset);
  el.checked = checked;
  return el;
}

/** Player ids as rendered in the Live entry cards, in row order. */
function rosterIds() {
  return [
    ...document.getElementById('player-cards').innerHTML.matchAll(
      /data-action="player-row"\s+data-player-id="([^"]+)"/g,
    ),
  ].map((match) => match[1]);
}

test('the entry rows carry a checkbox per player and a disabled remove button', async () => {
  await startApp();

  const ids = rosterIds();
  assert.ok(ids.length > 0, 'the seeded game should render a roster');
  assert.equal(
    (document.getElementById('player-cards').innerHTML.match(/data-action="toggle-player"/g) || [])
      .length,
    ids.length,
    'every entry row should carry a checkbox',
  );

  const master = document.getElementById('roster-select-all');
  assert.ok(master, 'the toolbar should offer a select-all checkbox');
  assert.equal(master.checked, false);
  assert.equal(master.indeterminate, false);
  assert.equal(document.getElementById('roster-remove-selected').disabled, true);
});

test('ticking a player removes only that player and their entries', async () => {
  const dom = await startApp();

  const before = storedGame().events.length;
  const ids = rosterIds();
  const target = ids[0];

  emit(dom.listeners, 'click', checkbox({ action: 'toggle-player', playerId: target }, true));

  // The count appears, and the destructive button becomes available.
  assert.equal(
    document.getElementById('roster-selection-count').textContent,
    '1 selected',
  );
  assert.equal(document.getElementById('roster-remove-selected').disabled, false);
  // One of five ticked: neither fully checked nor unchecked.
  assert.equal(document.getElementById('roster-select-all').indeterminate, true);
  assert.equal(document.getElementById('roster-select-all').checked, false);

  emit(dom.listeners, 'click', actionable({ action: 'remove-selected-players' }));
  confirmDanger(dom);

  const after = storedGame();
  assert.equal(after.players.some((player) => player.id === target), false);
  assert.equal(after.events.some((event) => event.playerId === target), false);
  assert.ok(after.events.length < before, 'their entries should be gone too');
  // Every other player is untouched.
  assert.equal(rosterIds().includes(target), false);
  assert.equal(rosterIds().length, ids.length - 1);
});

test('select all ticks the whole roster and removes it in one confirmed action', async () => {
  const dom = await startApp();

  emit(
    dom.listeners,
    'click',
    checkbox({ action: 'toggle-all-players' }, true),
  );

  const ids = rosterIds();
  assert.equal(ids.length, 5, 'the sample home roster has five players');
  const master = document.getElementById('roster-select-all');
  assert.equal(master.checked, true);
  assert.equal(master.indeterminate, false);
  assert.equal(
    document.getElementById('roster-selection-count').textContent,
    '5 selected',
  );

  emit(dom.listeners, 'click', actionable({ action: 'remove-selected-players' }));
  confirmDanger(dom);

  const after = storedGame();
  const homeId = after.homeTeamId;
  assert.equal(after.players.filter((player) => player.teamId === homeId).length, 0);
  assert.equal(
    after.events.filter((event) => event.teamId === homeId).length,
    0,
    'the removed players\' entries should leave the scoreboard too',
  );
});

test('unticking a player takes them back out of the selection', async () => {
  const dom = await startApp();
  const target = rosterIds()[0];

  emit(dom.listeners, 'click', checkbox({ action: 'toggle-player', playerId: target }, true));
  assert.equal(document.getElementById('roster-selection-count').textContent, '1 selected');

  emit(dom.listeners, 'click', checkbox({ action: 'toggle-player', playerId: target }, false));

  assert.equal(document.getElementById('roster-selection-count').textContent, '');
  assert.equal(document.getElementById('roster-remove-selected').disabled, true);
});

test('a selection does not survive switching to the other roster', async () => {
  const dom = await startApp();
  const homePlayer = rosterIds()[0];

  emit(dom.listeners, 'click', checkbox({ action: 'toggle-player', playerId: homePlayer }, true));
  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'away' }));

  // The away roster must not inherit a selection aimed at the home team.
  assert.equal(document.getElementById('roster-remove-selected').disabled, true);
  assert.equal(document.getElementById('roster-selection-count').textContent, '');

  // Switching back does not resurrect it either.
  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'home' }));
  assert.equal(document.getElementById('roster-selection-count').textContent, '');
});

test('removing every player on the viewed team zeroes that side only', async () => {
  const dom = await startApp();

  const awayBefore = document.getElementById('score-away').textContent;

  // "Select all" selects the roster being viewed, which is home on load.
  emit(dom.listeners, 'click', checkbox({ action: 'toggle-all-players' }, true));
  emit(dom.listeners, 'click', actionable({ action: 'remove-selected-players' }));
  confirmDanger(dom);

  // Home is gone: its players and their entries are both deleted.
  assert.equal(document.getElementById('score-home').textContent, '0');
  // The other team was never selected, so its players and score survive.
  assert.equal(document.getElementById('score-away').textContent, awayBefore);
  assert.equal(
    storedGame().players.filter((player) => player.teamId !== storedGame().homeTeamId).length > 0,
    true,
    'the away roster should be untouched',
  );
  // The box score still renders; the removed side contributes no players.
  assert.match(document.getElementById('box-table').innerHTML, /Riverside/);
  assert.doesNotMatch(document.getElementById('box-table').innerHTML, /J\. Reed/);
  // With nobody left to show, the toolbar has nothing to act on.
  assert.equal(document.getElementById('roster-toolbar').hidden, true);
});

test('a destructive action asks first, naming what it would discard', async () => {
  const dom = await startApp();
  const before = storedGame();
  assert.ok(before.events.length > 0, 'the sample game has recorded work to lose');

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));

  const dialog = document.getElementById('confirm-dialog');
  assert.equal(dialog.hidden, false, 'the question comes before anything is discarded');
  assert.equal(document.getElementById('confirm-title').textContent, 'Start a blank game?');
  assert.equal(document.getElementById('confirm-go').textContent, 'Start a blank game');
  // The warning carries the count, so the answer is given against a number.
  assert.match(
    document.getElementById('confirm-text').textContent,
    new RegExp(`${before.events.length} recorded entries will be discarded`),
  );
  assert.deepEqual(storedGame(), before, 'nothing changes while the question is open');

  // Cancel leaves the game exactly as it was.
  emit(dom.listeners, 'click', actionable({ action: 'cancel-danger' }));
  assert.equal(dialog.hidden, true);
  assert.deepEqual(storedGame(), before);

  // Asking again, then confirming, is what actually discards it.
  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  emit(dom.listeners, 'click', actionable({ action: 'confirm-danger' }));
  assert.equal(dialog.hidden, true);
  assert.deepEqual(storedGame().events, [], 'confirming is what starts the blank game');
});

test('cancelling the bulk confirmation changes nothing', async () => {
  const dom = await startApp();
  const before = storedGame();

  emit(dom.listeners, 'click', checkbox({ action: 'toggle-all-players' }, true));
  emit(dom.listeners, 'click', actionable({ action: 'remove-selected-players' }));

  // The question is up, and asking it has not changed anything yet.
  assert.equal(document.getElementById('confirm-dialog').hidden, false);
  assert.deepEqual(storedGame().players, before.players);

  emit(dom.listeners, 'click', actionable({ action: 'cancel-danger' }));

  assert.equal(document.getElementById('confirm-dialog').hidden, true);
  assert.deepEqual(storedGame().players, before.players);
  assert.equal(storedGame().events.length, before.events.length);
  // The selection is kept, so the scorer can retry.
  assert.equal(document.getElementById('roster-selection-count').textContent, '5 selected');
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

test('a new game can start its clock — it does not stop at 00:00', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);

  // A blank game's clock holds nothing.
  assert.equal(document.getElementById('clock-display').textContent, '00:00');
  // The button says what it will actually do.
  assert.equal(document.getElementById('clock-toggle').textContent, 'Start');

  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));

  // This is the regression: starting used to leave it at 00:00, and the first
  // tick then stopped it.
  assert.equal(document.getElementById('clock-display').textContent, '10:00');
  assert.equal(storedGame().clock.seconds, 600);
  assert.equal(storedGame().clock.running, true);
  assert.equal(document.getElementById('clock-toggle').textContent, 'Pause');

  // One tick of a real clock leaves it running.
  runTimers();
  assert.equal(document.getElementById('clock-display').textContent, '09:59');
  assert.equal(storedGame().clock.running, true);
});

test('the clock runs down and moves the game to the next period', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  // A short period keeps the test readable.
  document.getElementById('game-period-length').value = '360';
  emit(dom.listeners, 'change', document.getElementById('game-period-length'));

  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  assert.equal(document.getElementById('clock-display').textContent, '06:00');

  // Run the countdown out.
  for (let i = 0; i < 360; i += 1) runTimers();

  assert.equal(document.getElementById('clock-display').textContent, '06:00', 'refilled for the next period');
  assert.equal(storedGame().clock.running, false, 'a period end stops the clock');
  assert.equal(document.getElementById('period-display').textContent, 'Q2');
  assert.equal(storedGame().currentPeriod, 2);
  assert.match(document.getElementById('toast').textContent, /End of Q1/);
});

test('the toast can be dismissed instead of waiting it out', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'log-stat', playerId: rosterIds()[0], stat: '2PT', result: 'made' }));
  const toast = document.getElementById('toast');
  assert.equal(toast.hidden, false, 'the toast is showing');
  assert.match(toast.innerHTML, /data-action="dismiss-toast"/, 'it offers a close button');

  emit(dom.listeners, 'click', actionable({ action: 'dismiss-toast' }));

  assert.equal(toast.hidden, true, 'the close button hides it');
  // And it stays hidden: the auto-dismiss timer must not resurrect it.
  runTimers();
  assert.equal(toast.hidden, true);

  // A later entry still gets its own toast.
  emit(dom.listeners, 'click', actionable({ action: 'log-stat', playerId: rosterIds()[0], stat: '2PT', result: 'made' }));
  assert.equal(toast.hidden, false);
});

test('the clock pauses and resumes without losing time', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  runTimers();
  runTimers();
  assert.equal(document.getElementById('clock-display').textContent, '09:58');

  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  assert.equal(storedGame().clock.running, false);
  assert.equal(document.getElementById('clock-toggle').textContent, 'Resume');

  // While paused, a pending tick must not change anything.
  runTimers();
  assert.equal(document.getElementById('clock-display').textContent, '09:58');

  // Resuming continues from where it stopped rather than restarting the period.
  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  runTimers();
  assert.equal(document.getElementById('clock-display').textContent, '09:57');
});

test('reset puts the clock back to the start of the period and stops it', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  runTimers();
  runTimers();
  assert.equal(document.getElementById('clock-display').textContent, '09:58');

  emit(dom.listeners, 'click', actionable({ action: 'reset-clock' }));
  assert.equal(document.getElementById('clock-display').textContent, '10:00');
  assert.equal(storedGame().clock.running, false);
});

test('logging a stat starts the clock, refilling it if it is at zero', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  // Give the away team a player so there is a card to tap.
  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'away' }));
  document.getElementById('new-number').value = '12';
  document.getElementById('new-name').value = 'M. Diaz';
  emit(dom.listeners, 'submit', document.getElementById('add-player-form'));

  const playerId = document.getElementById('player-cards').innerHTML.match(/data-player-id="([^"]+)"/)[1];
  emit(dom.listeners, 'click', actionable({ action: 'log-stat', playerId, stat: '2PT', result: 'made' }));

  assert.equal(storedGame().clock.running, true);
  assert.equal(storedGame().clock.seconds, 600, 'the clock should not be left at zero');
  assert.equal(document.getElementById('clock-display').textContent, '10:00');
});

test('switching to halves moves the period length to twenty minutes', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  assert.equal(document.getElementById('clock-toggle').textContent, 'Start');

  const periods = document.getElementById('game-periods');
  periods.value = '2';
  emit(dom.listeners, 'change', periods);

  assert.equal(storedGame().periodSeconds, 1200);
  assert.equal(document.getElementById('clock-toggle').textContent, 'Start');
  assert.equal(document.getElementById('period-display').textContent, 'H1');

  // A specific length already chosen by the scorer is respected, not overwritten.
  const length = document.getElementById('game-period-length');
  length.value = '480';
  emit(dom.listeners, 'change', length);
  periods.value = '4';
  emit(dom.listeners, 'change', periods);
  assert.equal(storedGame().periodSeconds, 480);
});

test('the clock face reflects the sample game on load', async () => {
  await startApp();
  // The sample is positioned mid-Q3 with 6:52 left.
  assert.equal(document.getElementById('clock-display').textContent, '06:52');
  assert.equal(document.getElementById('clock-toggle').textContent, 'Resume');
});

// ---------------------------------------------------------------------------
// Editing the clock time
// ---------------------------------------------------------------------------

test('a clock time can be typed in and then counted down', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  assert.equal(document.getElementById('clock-display').getAttribute('contenteditable'), 'false');

  // "Edit time" opens the face for typing.
  emit(dom.listeners, 'click', actionable({ action: 'edit-clock' }));
  const face = document.getElementById('clock-display');
  assert.equal(face.getAttribute('contenteditable'), 'true');

  face.textContent = '7:30';
  emit(dom.listeners, 'blur', face);

  assert.equal(face.getAttribute('contenteditable'), 'false');
  assert.equal(face.textContent, '07:30', 'the typed value is normalised');
  assert.equal(storedGame().clock.seconds, 450);
  assert.equal(storedGame().clock.running, false, 'setting a time leaves it stopped');
  // Starting it counts down from the typed value, not from the period start.
  assert.equal(document.getElementById('clock-toggle').textContent, 'Resume');

  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  runTimers();
  assert.equal(document.getElementById('clock-display').textContent, '07:29');
  assert.equal(storedGame().clock.running, true);
});

test('a bare number of seconds is accepted', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'edit-clock' }));

  const face = document.getElementById('clock-display');
  face.textContent = '90';
  emit(dom.listeners, 'blur', face);

  assert.equal(face.textContent, '01:30');
  assert.equal(storedGame().clock.seconds, 90);
});

test('editing a running clock pauses it first', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  assert.equal(storedGame().clock.running, true);

  emit(dom.listeners, 'click', actionable({ action: 'edit-clock' }));
  assert.equal(storedGame().clock.running, false, 'a running clock must pause to be edited');

  const face = document.getElementById('clock-display');
  face.textContent = '2:00';
  emit(dom.listeners, 'blur', face);
  assert.equal(storedGame().clock.seconds, 120);
});

test('a typed value cannot be overwritten by a re-render while editing', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'edit-clock' }));

  // A re-render from elsewhere in the app must not clobber the typed text.
  const face = document.getElementById('clock-display');
  face.textContent = '3:1';
  emit(dom.listeners, 'click', actionable({ action: 'period-next' }));
  assert.equal(face.textContent, '3:1', 'the typed text survives a re-render');

  emit(dom.listeners, 'blur', face);
  // "3:1" is read as 3 minutes 1 second, the same way it is read anywhere else.
  assert.equal(face.textContent, '03:01');
});

test('a bad clock value is reported and the field stays open to fix', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  const before = storedGame().clock.seconds;

  emit(dom.listeners, 'click', actionable({ action: 'edit-clock' }));
  const face = document.getElementById('clock-display');
  face.textContent = 'nonsense';
  emit(dom.listeners, 'blur', face);

  assert.match(document.getElementById('toast').textContent, /7:30/);
  assert.equal(storedGame().clock.seconds, before, 'the time is unchanged');
  assert.equal(face.getAttribute('contenteditable'), 'true', 'still editable to correct it');
  assert.equal(face.textContent, '10:00', 'the real value is shown back');
});

test('Escape abandons a clock edit', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  const before = storedGame().clock.seconds;

  emit(dom.listeners, 'click', actionable({ action: 'edit-clock' }));
  const face = document.getElementById('clock-display');
  face.textContent = '1:00';
  emit(dom.listeners, 'keydown', face, { key: 'Escape' });

  assert.equal(storedGame().clock.seconds, before, 'nothing was applied');
  assert.equal(face.textContent, '10:00');
  assert.equal(face.getAttribute('contenteditable'), 'false');
});

test('typing 0 clears the clock so starting refills the period', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  runTimers();
  assert.equal(document.getElementById('clock-display').textContent, '09:59');

  emit(dom.listeners, 'click', actionable({ action: 'edit-clock' }));
  const face = document.getElementById('clock-display');
  face.textContent = '0';
  emit(dom.listeners, 'blur', face);

  assert.equal(face.textContent, '00:00');
  assert.equal(storedGame().clock.seconds, 0);

  emit(dom.listeners, 'click', actionable({ action: 'toggle-clock' }));
  assert.equal(document.getElementById('clock-display').textContent, '10:00');
});

test('clicking the clock face starts editing', async () => {
  const dom = await startApp();

  emit(dom.listeners, 'click', actionable({ action: 'new-game' }));
  confirmDanger(dom);
  const face = document.getElementById('clock-display');

  emit(dom.listeners, 'click', face);

  assert.equal(face.getAttribute('contenteditable'), 'true');
});

test('all three views are on screen at once, with no tab switcher', async () => {
  await startApp();

  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');

  // One panel per view, and none of them may be hidden or switched.
  for (const label of ['Live entry', 'Play-by-play', 'Box score']) {
    assert.match(html, new RegExp(`<section class="panel[^"]*" aria-label="${label}"`));
  }

  // The tabs used to hide two of the three, and nothing may hide them now.
  for (const childId of ['player-cards', 'log-list', 'box-table']) {
    assert.equal(document.getElementById(childId).hidden, false, `#${childId} should be visible`);
  }
  assert.doesNotMatch(html, /hidden[^>]*id="(player-cards|log-list|box-table)"/);

  // The switcher itself is gone, so there is no way back to one-view-at-a-time.
  assert.doesNotMatch(html, /view-tab-/, 'the view tabs should be removed');
  assert.doesNotMatch(html, /select-view/, 'the view switcher action should be removed');
});

test('an entry row combines the box-score columns with the stat buttons', async () => {
  await startApp();

  const cards = document.getElementById('player-cards').innerHTML;
  assert.ok((cards.match(/data-action="log-stat"/g) || []).length > 0, 'the buttons render');

  // The stat keys are the legend for the whole table now: written once above
  // the players, rather than repeated as a label on every row.
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const keyRow = /<tr class="entry__keys">([\s\S]*?)<\/tr>/.exec(html)?.[1] || '';
  const labels = [...keyRow.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(
    labels,
    [
      '+2', '+3', '+1', 'Miss',
      'Reb', 'O-Reb', 'Ast', 'Stl', 'Blk', 'To', 'Pf',
    ],
    'the key row should carry the scoring keys and the other stats',
  );

  // The made-attempted pair already reads as a percentage, so the two derived
  // columns stay out of the table even though they remain in the exports.
  assert.ok(!labels.includes('FG%'), 'FG% should not be a column');
  assert.ok(!labels.includes('FT%'), 'FT% should not be a column');

  // One table row per player, and every row carries all thirteen keys, which
  // is what makes the columns line up.
  const rows = cards.split('<tr class="player-card').slice(1);
  assert.ok(rows.length > 0, 'the seeded game should have a home roster');
  for (const row of rows) {
    assert.equal(
      (row.match(/data-action="log-stat"/g) || []).length,
      13,
      'every key should be on every row',
    );
  }

  // The running Pts/FG/3P/FT columns are gone from the entry row: they made the
  // row wider than the keys needed, and the box score below carries the totals.
  assert.doesNotMatch(cards, /player-card__col/);

  // Three identical miss keys in a row cannot be told apart, so each is the
  // bare number of the shot it misses: "+2" goes in, "2" misses.
  const missLabels = [...cards.matchAll(/stat-btn--miss[^>]*>([^<]+)<\/button>/g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(
    [...new Set(missLabels)],
    ['2', '3', '1'],
    'the miss keys should read 2, 3 and 1',
  );
  assert.ok(!cards.includes('>MISS<'), 'the bare MISS label should be gone');

  assert.match(cards, /player-card__keys--scoring/);
  assert.match(cards, /player-card__keys--other/);
  assert.match(cards, /player-card__who/);
  assert.doesNotMatch(
    cards,
    /player-card__row--info/,
    'rows are table rows now, not stacked cards',
  );
});

test('quarter totals render in a strip below the scoreboard, not in a side panel', async () => {
  await startApp();

  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const stripAt = html.indexOf('class="quarters"');
  assert.ok(stripAt > 0, 'the quarter strip should exist');
  assert.ok(
    stripAt > html.indexOf('</header>'),
    'the strip should sit below the scoreboard it reports on',
  );
  // The right-hand scoresheet panel is gone; the table moved into the strip.
  assert.equal((html.match(/id="sheet-table"/g) || []).length, 1);
  assert.doesNotMatch(html, /panel--sheet/);

  const sheet = document.getElementById('sheet-table').innerHTML;
  assert.match(sheet, />Q1</);
  assert.match(sheet, />Q4</);

  // It is not sticky any more: it scrolls away with the page, which is what
  // keeps the pinned scoreboard from growing.
  const css = readFileSync(resolve(appDir, 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('.quarters {'));
  assert.doesNotMatch(block.slice(0, block.indexOf('}')), /sticky/);
});

test('the game settings bar sits between the scoreboard and the quarter totals', async () => {
  await startApp();

  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const detailsAt = html.indexOf('class="game-details"');
  assert.ok(detailsAt > html.indexOf('</header>'), 'the settings bar belongs under the scoreboard');
  assert.ok(
    detailsAt < html.indexOf('class="quarters"'),
    'the settings bar belongs above the quarter totals it decides the shape of',
  );

  // The controls must still be wired from their new place: they set the period
  // structure that the strip below and every panel both read.
  assert.equal(document.getElementById('game-date').value, '2026-01-17');
  assert.equal(document.getElementById('game-time').value, '14:30');
  assert.equal(document.getElementById('game-periods').value, '4');
  assert.ok(document.getElementById('game-period-length').innerHTML.length > 0);
});

test('the game time sits beside the date and saves as it is set', async () => {
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const dateAt = html.indexOf('id="game-date"');
  const timeAt = html.indexOf('id="game-time"');
  assert.ok(timeAt > dateAt, 'the time field follows the date');
  assert.ok(
    timeAt < html.indexOf('id="game-venue"'),
    'and the pair stays together, ahead of the venue',
  );

  const dom = await startApp();
  const field = document.getElementById('game-time');
  assert.equal(field.value, '14:30', 'the sample game carries a start time');

  field.value = '18:45';
  emit(dom.listeners, 'change', field);

  assert.equal(storedGame().time, '18:45');
});

test('undo lives on the sticky scoreboard', async () => {
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const scoreboard = html.slice(html.indexOf('id="scoreboard"'));
  const beforeClose = scoreboard.slice(0, scoreboard.indexOf('</header>'));
  assert.match(beforeClose, /id="undo-button"/, 'undo should sit inside the scoreboard bar');

  const dom = await startApp();
  const before = storedGame().events.length;
  emit(dom.listeners, 'click', actionable({ action: 'undo' }));
  assert.equal(storedGame().events.length, before - 1, 'the sticky undo still works');
});

test('an entry-row checkbox bulk-removes the player and their entries', async () => {
  const dom = await startApp();
  const ids = rosterIds();
  const target = ids[0];

  emit(dom.listeners, 'click', checkbox({ action: 'toggle-player', playerId: target }, true));
  assert.equal(document.getElementById('roster-selection-count').textContent, '1 selected');

  emit(dom.listeners, 'click', actionable({ action: 'remove-selected-players' }));
  confirmDanger(dom);

  const after = storedGame();
  assert.equal(after.players.some((player) => player.id === target), false);
  assert.equal(after.events.some((event) => event.playerId === target), false);
  assert.equal(rosterIds().length, ids.length - 1);
});

test('the team-event strip is gone, along with the stats behind it', async () => {
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /team-events/, 'the strip should be gone from the document');

  // The strip was the only way to record one, so the catalog must not keep
  // offering them: a stat that can be defined but never entered is a trap for
  // whoever reads `stats.js` next.
  const stats = readFileSync(resolve(appDir, 'js', 'stats.js'), 'utf8');
  assert.doesNotMatch(stats, /TIMEOUT|teamButtons/, 'no team event should survive in the catalog');

  const app = readFileSync(resolve(appDir, 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /log-team-event/, 'nothing should still record a team event');

  const css = readFileSync(resolve(appDir, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /\.team-events|\.team-btn/, 'their styling should be gone too');

  await startApp();
  assert.equal(
    document.getElementById('team-events'),
    null,
    'no strip should be built at runtime either',
  );
});

test('each panel can take the full width and give it back', async () => {
  const dom = await startApp();
  const workspace = document.getElementById('workspace');
  const entry = document.getElementById('expand-entry');
  const log = document.getElementById('expand-log');
  const box = document.getElementById('expand-box');

  // The ordinary layout is two columns and nothing is pressed.
  assert.equal(workspace.classList.contains('is-expanded'), false);
  assert.equal(entry.getAttribute('aria-pressed'), 'false');
  assert.equal(entry.getAttribute('aria-label'), 'Full width');

  emit(dom.listeners, 'click', actionable({ action: 'toggle-expand', panel: 'entry' }));
  assert.equal(workspace.classList.contains('is-expanded'), true);
  assert.equal(workspace.getAttribute('data-focus'), 'entry');
  assert.equal(entry.getAttribute('aria-pressed'), 'true');
  assert.match(entry.title, /back beside/, 'the lit button says how to undo itself');
  assert.equal(log.getAttribute('aria-pressed'), 'false', 'only one panel at a time');

  // Asking a different section for the width moves it rather than stacking.
  emit(dom.listeners, 'click', actionable({ action: 'toggle-expand', panel: 'box' }));
  assert.equal(workspace.getAttribute('data-focus'), 'box');
  assert.equal(entry.getAttribute('aria-pressed'), 'false');
  assert.equal(box.getAttribute('aria-pressed'), 'true');

  // Pressing the lit button again puts the two columns back.
  emit(dom.listeners, 'click', actionable({ action: 'toggle-expand', panel: 'box' }));
  assert.equal(workspace.classList.contains('is-expanded'), false);
  assert.equal(workspace.getAttribute('data-focus'), null);
  assert.match(box.title, /whole width/);

  // Escape is the keyboard way back out, the same as it is for a dialog.
  emit(dom.listeners, 'click', actionable({ action: 'toggle-expand', panel: 'log' }));
  assert.equal(workspace.getAttribute('data-focus'), 'log');
  emit(dom.listeners, 'keydown', document.body, { key: 'Escape' });
  assert.equal(workspace.classList.contains('is-expanded'), false);

  // The class is only as good as the rule that reads it.
  const css = readFileSync(resolve(appDir, 'styles.css'), 'utf8');
  assert.match(
    css,
    /\.workspace\.is-expanded\[data-focus='entry'\] \.ws__right[\s\S]*?display: none/,
    'expanding live entry must actually hide the other column',
  );
});

test('the key headings sit over the keys, column for column', async () => {
  await startApp();

  // A heading row and a body row have to describe the same columns, or the
  // table centres a label over the wrong button — which is exactly what one
  // wide spanning cell did to "+1" and the miss keys.
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const keyRow = /<tr class="entry__keys">([\s\S]*?)<\/tr>/.exec(html)?.[1] || '';
  const headingColumns = [...keyRow.matchAll(/<th[^>]*>/g)]
    .map((match) => Number(/colspan="(\d+)"/.exec(match[0])?.[1] || 1))
    .reduce((total, span) => total + span, 0);

  const cards = document.getElementById('player-cards').innerHTML;
  const firstRow = cards.slice(cards.indexOf('<tr class="player-card'));
  const rowBody = firstRow.slice(0, firstRow.indexOf('</tr>'));
  const keyCells = (rowBody.match(/class="player-card__key/g) || []).length;

  assert.equal(
    headingColumns,
    keyCells,
    'the heading row and a player row must span the same number of columns',
  );
  assert.equal(keyCells, 13, 'three makes, three misses and seven counting stats');

  // The heading is written once over the three misses rather than three times.
  assert.equal(
    (keyRow.match(/entry__key--scoring/g) || []).length,
    4,
    'the scoring headings are +2, +3, +1 and one Miss',
  );
});

test('the board is pinned and the page below it scrolls', async () => {
  const css = readFileSync(resolve(appDir, 'styles.css'), 'utf8');
  const blockFor = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at !== -1, `expected a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };

  // The page is the scroller now, so the body must not lock it, and the board
  // has to ride on top of that scroll rather than scroll away with it.
  const body = blockFor('body');
  assert.doesNotMatch(body, /overflow:\s*hidden/, 'the body must not lock the page');
  assert.match(body, /min-height:\s*100dvh/);

  const board = blockFor('.scoreboard');
  assert.match(board, /position:\s*sticky/);
  assert.match(board, /top:\s*0/);

  // The workspace is a definite screenful below the board — a minimum would let
  // the longest play-by-play stretch it and make the page scroll instead.
  const workspace = blockFor('.workspace');
  assert.match(workspace, /height:\s*calc\(100dvh - var\(--board-h\)\)/);
  assert.doesNotMatch(
    workspace,
    /min-height:\s*calc\(100dvh/,
    'a minimum would grow to fit the play-by-play',
  );
});

test('the key matrix fits its panel instead of scrolling sideways', async () => {
  const css = readFileSync(resolve(appDir, 'styles.css'), 'utf8');
  const blockFor = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at !== -1, `expected a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };

  // Fixed layout plus a floor is what keeps thirteen keys inside a tablet
  // column: left to itself each key sized to its own content and the matrix ran
  // off the side of the panel.
  const entry = blockFor('.entry');
  assert.match(entry, /width:\s*100%/);
  assert.match(entry, /table-layout:\s*fixed/);
  assert.match(entry, /min-width:\s*620px/, 'a floor, so a phone still scrolls');
  assert.match(blockFor('.stat-btn'), /width:\s*100%/, 'keys fill their column');

  // The colgroup has to describe every column the header spans, or fixed layout
  // spreads the keys over the wrong count.
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  assert.match(html, /<colgroup>/);
  assert.match(html, /entry__col--key" span="13"/);
});

test('the headings carry the width control, and live entry a key size', async () => {
  await startApp();

  // Three headings used to carry a row-size pair and a fold chevron. The fold
  // and the box score's pair went; Live entry keeps a size pair, because it is
  // the panel a scorer works down and fitting the roster on screen is the whole
  // point there.
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  const controlsIn = (panel) => {
    const at = html.indexOf(`id="panel-${panel}"`);
    assert.ok(at !== -1, `expected a ${panel} panel`);
    const chunk = html.slice(at, html.indexOf('</section>', at));
    // The trailing character keeps `panel-tool__glyph` out of the count.
    return (chunk.match(/class="panel-tool[ "]/g) || []).length;
  };

  assert.equal(controlsIn('entry'), 3, 'live entry: smaller, larger, full width');
  assert.equal(controlsIn('log'), 1, 'the play-by-play keeps just the width control');
  assert.equal(controlsIn('box'), 1, 'so does the box score');

  // Folding is gone, not merely unwired.
  const app = readFileSync(resolve(appDir, 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /case 'toggle-collapse'/, 'the fold action should be gone');
});

test('live entry resizes its keys, and starts on the small side', async () => {
  const dom = await startApp();
  const entry = document.getElementById('panel-entry');
  const smaller = document.getElementById('key-down-entry');
  const larger = document.getElementById('key-up-entry');

  assert.equal(entry.getAttribute('data-density'), 'normal');
  assert.equal(smaller.disabled, false);
  assert.equal(larger.disabled, false);

  // Down to the smallest, where the "smaller" end is spent.
  emit(dom.listeners, 'click', actionable({ action: 'key-smaller', panel: 'entry' }));
  assert.equal(entry.getAttribute('data-density'), 'compact');
  assert.equal(smaller.disabled, true, 'the smallest key is a real end');

  // And back up through the default to the largest.
  emit(dom.listeners, 'click', actionable({ action: 'key-larger', panel: 'entry' }));
  emit(dom.listeners, 'click', actionable({ action: 'key-larger', panel: 'entry' }));
  assert.equal(entry.getAttribute('data-density'), 'roomy');
  assert.equal(larger.disabled, true);

  // The default really is smaller than the roomiest step, and the row follows
  // the key rather than being pinned to its own height.
  const css = readFileSync(resolve(appDir, 'styles.css'), 'utf8');
  // `.panel--entry` is declared more than once, so find the rule that actually
  // sets the height rather than whichever comes first.
  const keyHeight = (selector) => {
    for (let from = 0; ; ) {
      const at = css.indexOf(`\n${selector} {`, from);
      assert.ok(at !== -1, `expected a ${selector} rule setting --key-h`);
      const found = /--key-h:\s*(\d+)px/.exec(css.slice(at, css.indexOf('}', at)));
      if (found) return Number(found[1]);
      from = at + 1;
    }
  };
  const fallback = keyHeight('.panel--entry');
  const roomy = keyHeight(".panel--entry[data-density='roomy']");
  assert.ok(
    fallback < roomy,
    `the default key (${fallback}px) should be smaller than the roomiest (${roomy}px)`,
  );
  const rowRule = css.slice(css.indexOf('\n.entry tbody td {'));
  assert.match(rowRule.slice(0, rowRule.indexOf('}')), /calc\(var\(--key-h/, 'the row follows the key');
});

test('the team total box scores the selected team for the current period', async () => {
  const dom = await startApp();
  const input = document.getElementById('teamtotal-input');
  const period = document.getElementById('teamtotal-period');

  // The seed game is in Q3 with the home team selected.
  assert.equal(period.textContent, 'Q3');
  assert.equal(input.value, '', 'nothing typed to begin with');

  input.value = '17';
  emit(dom.listeners, 'change', input);

  const game = storedGame();
  const typed = game.events.find((event) => event.stat === 'TEAM_TOTAL');
  assert.ok(typed, 'the total is recorded as an entry like any other');
  assert.equal(typed.teamId, game.homeTeamId, 'against the selected team');
  assert.equal(typed.period, 3, 'in the period on the board');
  assert.equal(typed.points, 17);
  assert.equal(typed.playerId, null, 'and belongs to nobody in particular');
  assert.equal(document.getElementById('score-home').textContent, '43', '26 + 17');

  // Each side keeps its own, and switching tabs shows the one that side has.
  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'away' }));
  assert.equal(input.value, '', 'the away team has none');

  input.value = '11';
  emit(dom.listeners, 'change', input);
  assert.equal(document.getElementById('score-away').textContent, '32', '21 + 11');

  emit(dom.listeners, 'click', actionable({ action: 'select-team', teamSlot: 'home' }));
  assert.equal(input.value, '17', 'and the home box still holds its own');

  // Typing the number again replaces it rather than adding to it, because the
  // scorer types what the board shows.
  input.value = '20';
  emit(dom.listeners, 'change', input);
  assert.equal(document.getElementById('score-home').textContent, '46');
  assert.equal(
    storedGame().events.filter((event) => event.stat === 'TEAM_TOTAL').length,
    2,
    'one entry per team, not one per keystroke',
  );

  // An empty box takes it back out.
  input.value = '';
  emit(dom.listeners, 'change', input);
  assert.equal(document.getElementById('score-home').textContent, '26');
});
