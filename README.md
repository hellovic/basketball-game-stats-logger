# Basketball Game Stats Logger

A responsive web app for manually logging basketball game stats courtside.
Tap a stat, and the quarter score, running total, quarter strip and player box
score all stay in agreement — because they are all calculated from the same
list of entries.

No accounts, no server, no build step, no dependencies.

---

## Running it

```bash
# Recommended — serves on your Wi-Fi at http://<your-ip>:8080
npm run serve

# This machine only, kept off the network
npm run serve -- --local

# Or open the file directly
open app/index.html
```

The server prints the exact addresses to use:

```
  This computer   http://localhost:8080/
  Other devices on the same Wi-Fi:
                  http://192.168.1.42:8080/
```

Open either one in a browser.

**Use `npm run serve` rather than `python3 -m http.server`,** and not just for
convenience. Python's server sends no `Cache-Control` header, and answers every
request for `index.html` with `200`, so browsers are free to keep reusing a
cached copy of a JavaScript module. The symptom is nasty and misleading: you
refresh, see updated markup, and keep running the *old* code — so a new button
appears and does nothing, because its handler does not exist in the module the
browser is still holding. `scripts/dev-server.mjs` sends `no-store` for
everything, which removes that whole class of problem.

The app shows its **version** in two places: at the right-hand end of the file
bar (**More → Import / export**), and in **More → Help & about**. If a change
does not appear to have taken effect, compare that against the `app-version` in
`app/index.html` — a mismatch means the browser is serving you a stale bundle.
A hard reload (`Cmd`/`Ctrl` + `Shift` + `R`) fixes it.

The app opens with a **sample game** so you can see a populated screen right
away. Use *Game settings → Start a blank game* when you are ready to log a real
one, and *Reload the sample game* to bring it back.

The strip under the scoreboard **reports** the game rather than editing it: the
date, start time, venue and period structure are shown as read-only pills, and
tapping any one of them opens **Game settings**, where they are actually
changed. The date names every file you export; the time and venue are part of
the saved game and travel with a backup. The start time is left blank rather
than filled in with the current time, so a game is never stamped with a guess.

The four actions that throw work away — starting a blank game, reloading the
sample, removing players, and restoring a backup — all ask before they act. The
question names what would be lost (*"36 recorded entries will be discarded"*)
and changes nothing until you confirm, so there is always a chance to export
first.

> Opening `index.html` directly works in current browsers, but it is the least
> reliable option: the app uses ES modules, which some browsers refuse to load
> from `file://`.

Tests need Node 18+ and nothing else:

```bash
npm test        # or: node --test "test/**/*.test.js"
```

---

## Where the data is saved

**In this browser, on this device — nowhere else.** The game is written to
`localStorage` on every entry, so a refresh, a crash, or a closed laptop lid
loses nothing.

The consequences are worth being explicit about:

- **Nothing syncs.** Your phone and your laptop keep separate games.
- Clearing your browser's site data or cookies **erases the game**.
- Private/incognito windows discard it when the window closes.
- It is tied to the exact address. `localhost:8080` and
  `<you>.github.io/basketball-game-stats-logger` are different storage
  buckets and do
  not see each other's games.

That is why both exports matter: the **Export** group in the file bar
(**More → Import / export**) backs up a game, and a **team file** backs up a
roster. See below.

---

## Using it during a game

Set up two teams and their rosters in the **roster bar**, which sits just above
the entry rows, then work straight down the page. Every part of the game is on
the one screen — there is nothing to switch between. The scoreboard stays pinned
to the top, and the setup strip below it (the date and venue, the quarter totals
and the roster bar) scrolls away as you go, so a scroll down leaves the entry
rows filling the screen. Each panel scrolls inside its own box, so a long
play-by-play never makes the page itself longer.

The **Away / Home** tabs at the top of the strip choose which team the entry
rows are scoring. The same pair of tabs sits on the box score, and the two are
handles on the same switch — tapping either one moves the whole screen to that
team. A scorer enters one team's events at a time.

1. **Quarter totals** — a thin strip under the scoreboard, so the per-quarter
   score is always in view without taking over the screen.
2. **Live entry** — one tap records one stat. Each player is a row: their number
   and name, then the scoring keys (`+2`, `+3` and `+1` to make a shot; `2`, `3`
   and `1` to miss one), then the counting keys. The running totals live in the
   box score below, so the entry row carries nothing but the keys. The thirteen
   keys share out the panel rather than each claiming its own width, so the
   matrix fits without scrolling sideways.
3. **Undo** — the button on the scoreboard (it stays pinned, so it is always in
   reach), or `Ctrl`/`Cmd` + `Z`. The toast after each entry also offers a
   one-tap undo.
4. **Play-by-play** — every entry, newest first, each row stamped with how far
   into its period the play happened, counting up from 00:00 to the period
   length. Delete a wrong entry, or use the dropdown on a row to move it to a
   different player on the same team.
5. **Box score** — both teams, per-player totals with a team totals row. The
   heading of the team you are entering is highlighted, so it is obvious where
   the next tap will land.
6. **Team total** — under the entry table: the points the selected team has
   scored *in the period on the board*, typed rather than tapped. See below.

Live entry's heading carries three controls; the play-by-play and the box score
carry one each:

| Control | Where | What it does |
| --- | --- | --- |
| `−` / `+` | Live entry | Smaller or larger stat keys, so more or fewer of the roster fit on screen |
| the four-corner icon | every panel | Stretch that section across the whole width, hiding the other two |

The keys start small — fitting the roster on screen is worth more at the table
than a tall key — at 32px, and the two buttons step up to 40px or down to 26px.
The row height follows the key, so a smaller key really does mean more players
in view. The four-corner control is how you see every column of the entry row or
the box score on a screen too narrow to show them side by side; `Esc` also
returns to two columns.

The **More** menu holds what does not fit in the top bar: game settings, the
player roster, import/export and team files, the game summary, and help. The
file bar it toggles is hidden until you ask for it, which is what keeps the two
columns tall enough to read at a glance on an iPad.

### Scoring from a phone or tablet

The server listens on every network interface, so any device on the same Wi-Fi
can open the address it prints. Nothing to install on the other device — it is
just a web page.

Three things to know before you rely on it:

- **Each device keeps its own game.** Storage is per browser, per address. A
  game logged on your phone is not visible on your laptop, and nothing is
  uploaded anywhere. This shares the app, not the data.
- **The address is part of the data's identity.** `http://192.168.1.42:8080` and
  `http://localhost:8080` are different storage buckets, even on the same
  machine, so a game started at one address will not appear at the other. Pick
  one address and stay with it for a game.
- **Your router may hand out a different address later.** If the link stops
  working, check the address the server prints on its next start.

To move a game from one device to another, export the JSON backup on the first
and use **Restore JSON…** on the second. Rosters move with a team file.

On macOS the first incoming connection may raise a firewall prompt — allow it,
or the other devices will time out. Use `--local` when you want to be certain
nothing is exposed to the network at all.

### Team files and rosters

Rosters do not change much week to week, so a team can be saved and loaded back
next game. Writing JSON by hand is the hard way; **Paste roster…** is the easy
one.

**Paste roster…** takes the two columns you already have open in a spreadsheet,
a notes app or a message — one player per line:

```
Player  Number
陳大文   55
李小明   4
```

- The separator can be a tab, a comma or runs of spaces, so pasting straight out
  of Excel, Numbers, Google Sheets or a document all work.
- The header row is optional, its wording does not have to match the example, and
  its columns may be in either order. With no header, the numeric column is found
  by looking at the data, so `陳大文,U14,55` reads the number as 55, not U14.
- Extra columns are ignored (and named back to you), blank lines and `#` comments
  are skipped, and a leading `#` on a number is stripped.
- A team name is never taken from a paste: the paste replaces or adds *players*,
  and your team keeps its name and abbreviation.
- Shared jersey numbers, unnumbered players and nameless rows are reported as
  warnings rather than blocking the import.

Then choose **Replace it** or **Add to it**. **Replace** keeps the entries those
players already logged in the score and the play-by-play, and drops the players
themselves — for deleting players *and* their entries, use the checkboxes in the
roster instead.

- **Load team…** reads a saved team or a `.csv` back,
  deciding by the file extension. A CSV is parsed exactly like a paste.
- **Save team** writes the current team's name, abbreviation and roster
  to a small JSON file, named after the team, and downloads it.

Whichever way a roster arrives, the app shows what it understood and what will
change, and nothing happens until you confirm — replacing a roster is too
destructive to trigger from a file picker or a paste alone.

The other team and the game log are never touched, so an import is safe
mid-game. Player stats already recorded stay attached to the right players:
importing reuses an existing player's identity when the names match.

Because it is a file, a team can be mailed to another coach, carried to the
scorer's other laptop, and kept as a backup — none of which a browser-local
store can do. Keep your teams somewhere sensible; there is no cloud copy.

Picking the wrong file is handled rather than ignored: a full game backup is
detected and you are pointed at **Restore JSON…** instead, JSON pasted into
the text box says so rather than being parsed into nonsense, and a corrupt file
reports the problem without changing anything.

The file looks like this, and is safe to hand-edit:

```json
{
  "format": "game-stats-logger/team",
  "version": 1,
  "appVersion": "0.2.0",
  "exportedAt": 1790679059251,
  "team": {
    "name": "Northside",
    "abbreviation": "NOR",
    "players": [
      { "number": "4", "name": "J. Reed", "active": true },
      { "number": "7", "name": "A. Cole", "active": true }
    ]
  }
}
```

### The game clock

The clock is a manual convenience, not a scoreboard feed. It counts down, and
two behaviours are worth knowing:

- **Starting a clock at 00:00 fills it to a full period** and says so. A clock
  reading 00:00 is between periods, so starting one means starting a period.
  Starting from a partly elapsed clock (after a pause) resumes it untouched.
- **Reaching 00:00 ends the period and moves the game on** — the quarter
  advances and the clock refills for the next one. The scorer is usually still
  recording when a period ends, so the app does not wait to be told. Overtime
  gets a 5-minute period.

**You can type a time straight into the clock.** Click the clock face (it is
dotted-underlined to show it is typeable) or use **Edit**, then type what
you need and press Enter or click away:

| You type | You get |
| --- | --- |
| `7:30` | 7 minutes 30 seconds |
| `07:30` | the same |
| `:45` | 45 seconds |
| `450` | 450 seconds — a raw count, same as `7:30` |
| `0` | clock cleared; starting refills the period |

Anything after the colon is seconds, so `3:1` is three minutes **one** second —
write `3:10` for three minutes ten.

Setting a time always leaves the clock **stopped**, so you decide separately
whether to count down. Editing a running clock pauses it first. A value that
cannot be read is reported and the field stays open so you can fix it; `Escape`
abandons the edit and restores the real time.

Buttons sit beside the clock: **start/pause** (which reads `Start`, `Resume` or
`Pause` according to what it will do), **Edit** to type a time, **Reset** to put
the clock back to the start of the current period, and **− / +** to move the
period by hand.

The clock bar is deliberately thin, and it is sticky — so every pixel it takes is
permanently lost from the scoring area below. That is why the labels are one word
and the controls are compact. Phone-width layouts restore full-size tap targets.

Set the **period length** under *Game settings*: 6, 8, 10, 12 or 20 minutes.
Switching between quarters and halves moves the length with it (10 → 20 minutes),
unless you have already chosen a specific length, in which case your choice
stands.

### What gets tracked

| Column | Meaning |
| --- | --- |
| `PTS` | Points, from made shots |
| `FG` / `FG%` | Field goals made–attempted (2PT and 3PT combined) |
| `3P` | Three-pointers made–attempted |
| `FT` / `FT%` | Free throws made–attempted |
| `REB` / `OREB` / `DREB` | Rebounds, total and split |
| `AST` `STL` `BLK` `TO` `PF` | Assists, steals, blocks, turnovers, personal fouls |

**Misses are recorded, not skipped.** Tapping `2`, `3` or `1` is what makes the
percentage columns real. A game logged with only made shots shows `100%` rather
than nothing.

Every one of these is recorded and exported. The **entry rows** are the keys
alone; the **box score** shows the per-player totals except the percentages,
which would not fit thirteen columns into a quarter of an iPad screen — `FG%`
and `FT%` appear in **More → View game summary** and in the CSV exports, where
the made–attempted figures beside them say the same thing.

### How the score is calculated

**Every point is an entry**, and the scoreboard, the quarter strip, the box score
and the exports are all the same list of entries read different ways, so they
cannot disagree. Deleting or correcting an entry moves every one of them at once.

Almost every entry names the player who scored it. The exception is the **team
total** box under the entry table, which records points for a whole team in one
period:

- It applies to **the team the Away / Home tabs have selected**, and to the
  period on the clock, so the same box serves either side.
- Type the number **shown on the scoreboard**, not the number of points since
  your last entry. Typing it again replaces it; retyping is the correction.
- One entry per team per period, so a blank box and a zero both take it back out.
- The points reach the quarter totals, the running score and the box score's team
  totals row. No player line shows them, because none of them belong to a player.

This is how you keep a game where you only follow one team. Score your own side
player by player, and give the other side its quarter score here — the play-by-play
reads `TEAM · Team total · +18`.

What it gives up is the equality between a team's total and the sum of its player
lines, for that team. Everything else still holds, and the two ways of scoring are
meant to be used one per team: a period with **both** a typed total and player
entries is counted twice, so the app says so afterwards under the scoresheet.
Nothing is blocked while you are logging — a scorer mid-game has no time to
untangle it — but it is named so it can be found before the final buzzer.

---

## Exporting

Four exports, all generated in your browser:

| Export | What it is |
| --- | --- |
| **Box score CSV** | One row per player plus a team totals row. Opens directly in Excel, Numbers or Google Sheets. |
| **Play-by-play CSV** | The full entry log, oldest first, each row stamped with elapsed game time. The audit trail — enough to reconstruct a game by hand. |
| **Game summary CSV** | The quarter grid plus the leading scorers. Good for sharing a result. |
| **Full backup JSON** | The complete game. Re-importable, so this is what to use to move a game to another device or browser. |

Files are named `2026-01-17_RIV-at-NOR_box-score.csv`, and CSV files carry a
UTF-8 byte-order mark so accented player names open correctly rather than as
mojibake.

**Restore JSON…** loads a backup back in. A truncated or unrelated file is
rejected with a message instead of overwriting your live game.

These cover one *game*. A team file (above) is a separate, much smaller export
holding just a name and a roster, so the two formats do not interoperate — and
each importer tells you if you have picked the other one.

---

## Hosting on GitHub Pages

It works, and it is the intended deployment — the app is entirely static. Every
path inside `app/` is relative, so the same files run unchanged on localhost, on
your Wi-Fi, and under a project subpath on Pages.

The repository carries a workflow at `.github/workflows/pages.yml` that
publishes `app/` whenever `main` moves. It runs the test suite first, so a build
that fails its own tests never goes live.

```bash
git remote add origin git@github.com:<you>/basketball-game-stats-logger.git
git push -u origin main
```

Then, once, in the repository: **Settings → Pages → Build and deployment →
Source: GitHub Actions**. The app appears at
`https://<you>.github.io/basketball-game-stats-logger/` after the first run
finishes.

Choose **GitHub Actions**, not "Deploy from a branch". The workflow is what
uploads the site, and it uploads `app/` alone — pointing Pages at a branch would
publish the repository root instead, putting this file and the test suite on the
web next to the app.

Two things to know about a hosted copy:

- **Games live in that browser, on that device.** Hosting the app does not put
  your games online — nothing is ever uploaded. Opening the same URL on your
  phone gives you an empty app with its own separate storage.
- **Pasting the URL to someone else shares the app, not your data.** They get
  their own empty copy. To share a game, export the CSV or the JSON backup.

Since GitHub Pages serves static files only, there is no server to keep in sync
and no way for the app to leak a game — the tradeoff is that backup is on you.

---

## Project layout

```
app/
  index.html        the document: scoreboard, the read-out strip, the quarter
                    strip, the roster bar, then live entry and the log
  styles.css        design tokens and all responsive rules
  js/
    stats.js        the stat catalog — add a stat here to record it
    derive.js       pure derivation: period scores, box score, percentages
    store.js        state, entry/undo/delete, roster loading, persistence
    clock.js        period lengths, starting, ticking down
    teamfile.js     the team file format: capture, write and parse
    rosterimport.js reading a pasted roster or CSV, forgivingly
    format.js       clock, percentage and label formatting
    export.js       CSV and JSON generation
    sample.js       the seeded sample game
    app.js          rendering and event wiring (the only DOM-touching module)
  .nojekyll         tells Pages to serve the folder as-is
.github/
  workflows/
    pages.yml       publishes app/ on every push to main, after the tests pass
scripts/
  dev-server.mjs    no-cache server, on your LAN by default, so edits always
                    show on a refresh and other devices can open the app
test/
  derive.test.js    derivation and store behaviour
  export.test.js    CSV shape, quoting and JSON round-tripping
  clock.test.js     period lengths, refilling, ticking, period ends
  store.test.js     game settings: period structure, length, clock state
  teamfile.test.js  team file format, round trips and rejections
  rosterimport.test.js  pasted/CSV roster parsing, delimiters and headers
  sample.test.js    the seed game is well formed and its math reconciles
  ui.smoke.test.js  boots the UI against a minimal DOM stub
```

`stats.js`, `derive.js`, `store.js`, `clock.js`, `teamfile.js`,
`rosterimport.js`, `format.js` and `export.js` never touch the DOM, which is what
lets the tests exercise them directly.

### Adding a statistic

Append an entry to the `STATS` array in `app/js/stats.js` with its `key`, `kind`
(`shooting`, `rebound` or `counting`) and, for shots, its `points`. The entry
buttons, the box score plumbing and the derivation logic all follow from that
table. Adding a column to the display is a one-line change in the `columns`
list in `app.js` — `renderEntry` builds the columns shown on each player's entry
row, and `renderBox` builds the fuller box score table below it.

---

## Known limits

- One game at a time, and exactly two teams within it. There is no game history —
  archive with an export.
- Team files keep **names and rosters only**, not stats. There is no career or
  season totals across games, and no in-app list of saved teams — you manage the
  files yourself.
- One scorer, one device. No multi-user collaboration.
- The game clock is a manual convenience. It is not connected to a scoreboard,
  and it is a single game clock — not per-player floor time.
- There is one clock setting for the whole game, so a league with a different
  overtime length than 5 minutes cannot be expressed exactly.
- No shot-chart or location data.
