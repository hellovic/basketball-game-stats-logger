#!/usr/bin/env node
/**
 * Development static server.
 *
 * `python3 -m http.server` sends no `Cache-Control` at all, and answers every
 * request for `index.html` with 200. Browsers are then free to reuse a cached
 * copy of a JavaScript module — so you refresh, get the updated markup, and keep
 * running the *old* code. That produces a genuinely confusing symptom: a new
 * button that does nothing, because the handler for it does not exist yet in
 * the module the browser is still holding.
 *
 * This server sends `no-store` for everything, which removes that entire class
 * of problem.
 *
 * It binds to every interface by default, so a phone or tablet on the same
 * Wi-Fi can score a game at `http://<your-lan-ip>:<port>/`. Each device keeps
 * its own game in its own browser storage — this shares the *app*, not the
 * data. Pass `--local` to bind to loopback only and keep it off the network.
 *
 * Usage:
 *   node scripts/dev-server.mjs [port]         serve on the LAN (default 8080)
 *   node scripts/dev-server.mjs --local        this machine only
 *   node scripts/dev-server.mjs 3000 --local   both, in any order
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../app', import.meta.url)));

const args = process.argv.slice(2);
const localOnly = args.includes('--local');
const positional = args.filter((arg) => !arg.startsWith('--'));
const PORT = Number(positional[0] || process.env.PORT || 8080);
const HOST = localOnly ? '127.0.0.1' : '0.0.0.0';

/**
 * Every non-internal IPv4 address, so the printed link is the one other devices
 * can actually use. These are the addresses a phone on the same Wi-Fi can reach.
 */
function lanAddresses() {
  const found = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address);
    }
  }
  return found;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    // The point of this server. `no-store` means the browser never reuses a
    // cached copy, so an edit is visible on a plain refresh.
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve inside ROOT and confirm we stayed there, so `..` cannot escape.
    const target = resolve(join(ROOT, normalize(pathname)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      send(res, 403, 'Forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      send(res, 404, `Not found: ${pathname}`);
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Last-Modified': info.mtime.toUTCString(),
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  } catch (error) {
    send(res, 500, `Server error: ${error.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT} with no-store caching (always fresh).\n`);
  console.log(`  This computer   http://localhost:${PORT}/`);

  if (localOnly) {
    console.log('\nBound to this machine only (--local), so other devices cannot reach it.');
    return;
  }

  const addresses = lanAddresses();
  if (addresses.length === 0) {
    console.log('\nNo LAN address found — this machine may not be on a network.');
    return;
  }

  console.log('  Other devices on the same Wi-Fi:');
  for (const address of addresses) {
    console.log(`                  http://${address}:${PORT}/`);
  }

  console.log(
    '\n  Each device keeps its own game in its own browser storage.\n' +
      '  Sharing this link shares the app, not the data — use a JSON export\n' +
      '  or a team file to move a game between devices.',
  );
});
