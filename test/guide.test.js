/**
 * The beginner guide.
 *
 * It is shipped inside the app rather than linked out to the repository, so the
 * two things worth holding to are that the app offers it and that every picture
 * it shows is actually there — a guide with four broken images is worse than no
 * guide, and nothing else in the suite would notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..', 'app');

test('the guide ships with the app, pictures and all', () => {
  const page = readFileSync(resolve(appDir, 'guide', 'index.html'), 'utf8');

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

test('the app offers the guide from Help', () => {
  const html = readFileSync(resolve(appDir, 'index.html'), 'utf8');
  assert.match(html, /href="guide\/"/, "Help should link to /guide/");
});
