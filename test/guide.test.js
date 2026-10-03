/**
 * The beginner guide.
 *
 * It is shipped inside the app rather than linked out to the repository, and it
 * is written twice — English and Traditional Chinese — in one page. Two things
 * are therefore worth holding: that the two languages stay the same guide, and
 * that every picture either of them shows is actually there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..', 'app');
const guidePath = resolve(appDir, 'guide', 'index.html');

const countOf = (text, pattern) => (text.match(pattern) || []).length;

test('the guide ships with the app, pictures and all', () => {
  const page = readFileSync(guidePath, 'utf8');

  const images = [...page.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(images.length >= 3, 'the guide is illustrated, not a wall of text');

  for (const src of images) {
    assert.ok(existsSync(resolve(appDir, 'guide', src)), `${src} should be there`);
  }

  // The pictures are the app: they carry its labels, so a renamed button is a
  // reason to redraw rather than to leave a diagram of an older app on the page.
  const screen = readFileSync(resolve(appDir, 'guide', 'screen.svg'), 'utf8');
  for (const label of ['Live entry', 'Play-by-play', 'Box score', 'REB', 'Team']) {
    assert.ok(screen.includes(label), `the screen diagram should show ${label}`);
  }
});

test('the guide is the same guide in both languages', () => {
  const page = readFileSync(guidePath, 'utf8');

  const sections = countOf(page, /<section>/g);
  assert.ok(sections >= 8, 'the guide keeps its sections');

  // One heading per language for the page itself, and one per section — plus the
  // footer, which is a line of its own in each.
  assert.equal(countOf(page, /class="lang lang--en"/g), sections + 2, 'English blocks');
  assert.equal(
    countOf(page, /class="lang lang--zh"[^>]*>/g),
    sections + 2,
    'a Chinese twin for every block',
  );
  assert.equal(countOf(page, /<h1>/g), 2, 'one title in each language');
  assert.equal(countOf(page, /<h2>/g), sections * 2, 'and one heading per section, twice');
  assert.equal(countOf(page, /<figure>/g), sections * 2 - 8, 'the same pictures, twice');

  // The translation is really there, not a stub: a few of the words a reader
  // will be looking for, taken from the app's own vocabulary.
  for (const phrase of ['賽前兩分鐘', '上陣時間', '換人', '記分牌', '個人數據表']) {
    assert.ok(page.includes(phrase), `the Chinese guide should mention ${phrase}`);
  }

  // And every Chinese block declares its language, so a screen reader switches
  // voice for it rather than reading it as mangled English.
  assert.equal(countOf(page, /class="lang lang--zh" lang="zh-Hant"/g), sections + 2);
});

test('the guide offers both languages, and remembers the choice', () => {
  const page = readFileSync(guidePath, 'utf8');

  const switcher = /<div class="lang-switch"[^>]*>([\s\S]*?)<\/div>/.exec(page)?.[1] ?? '';
  assert.match(switcher, /data-lang="en"/, 'an English button');
  assert.match(switcher, /data-lang="zh-Hant"/, 'and a Chinese one');
  assert.match(switcher, /aria-pressed="true"/, 'the one in play says so');

  // The switch is the one piece of script on the page, and it is the only place
  // the choice is kept.
  assert.match(page, /game-stats-logger\/guide-lang/, 'the choice is remembered');
  assert.match(page, /documentElement\.dataset\.lang/, 'and applied to the page');
});

test('the app offers the guide from the menu and from Help', () => {
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');

  const menu = html.slice(html.indexOf('id="more-menu"'), html.indexOf('</div>', html.indexOf('id="more-menu"')));
  assert.match(menu, /<a[^>]+href="guide\/"/, 'the menu carries the shortcut');
  assert.match(menu, /Beginner&#39;s guide|Beginner's guide/, 'named as a guide');
  assert.ok(
    menu.indexOf('Beginner') < menu.indexOf('Game settings'),
    'and it leads the menu, where a first-timer will find it',
  );

  // Help still points at it, for anyone who looks there instead.
  assert.match(html, /href="guide\/"/);
});
