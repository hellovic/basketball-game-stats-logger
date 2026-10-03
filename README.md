# 籃球比賽數據記錄器 / Basketball Game Stats Logger

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
bar (**More → Save / load / export**), and in **More → Help & about**. If a change
does not appear to have taken effect, compare that against the `app-version` in
`app/index.html` — a mismatch means the browser is serving you a stale bundle.
A hard reload (`Cmd`/`Ctrl` + `Shift` + `R`) fixes it.

The app opens with a **sample game** so you can see a populated screen right
away. Use *Game settings → Start a blank game* when you are ready to log a real
one, and *Reload the sample game* to bring it back.

**Copy as a new game** sits beside those two, for the same night's second
fixture or the second game of a tournament. It keeps the settings — date, start
time, venue, period structure and length — and whichever of the two teams you
tick, each with its roster and its colour. Everything that happened is left
behind: the scores, the quarter totals, the play-by-play and the box score all
start empty and the clock goes back to the first period. The dialog also offers
to write the finished game's JSON backup on the way through, ticked by default,
because the copy replaces the game on this device.

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
(**More → Save / load / export**) backs up a game, and the **team file** buttons in
**More → Team and players** back up a roster. See below.

---

## Using it during a game

Set the two teams and their rosters up in **More → Team and players**, or press
and hold either team block on the scoreboard to open that team's roster
directly — the block is the handle for the team it names. Then work straight
down the page. Every part of the game is on the one screen — there is
nothing to switch between. The scoreboard stays pinned to the top, and the setup
strip below it (the date and venue, the quarter totals) scrolls away as you go,
so a scroll down leaves the entry rows filling the screen. Each panel scrolls
inside its own box, so a long play-by-play never makes the page itself longer.

Setting up is the one job that is not a tap on the entry row, and it is done once
a game: a scorer is picking a team, not adding to it, so it lives in the menu
with the rest of the setup rather than holding a row of the screen all game.

The **Away / Home** tabs at the top of the strip choose which team the entry
rows are scoring. The same pair of tabs sits on the box score, and the two are
handles on the same switch — tapping either one moves the whole screen to that
team. A scorer enters one team's events at a time.

**Each team can wear its own colour.** **Colour** in *Team and players* shows
what the selected team is wearing; tap it for the rainbow plus white and black, which
sets the score on the scoreboard, the dot on the quarter strip, the left edge of
that team's play-by-play rows, its heading in the box score, and the row of
every one of its players who is on the floor. Home starts blue and away starts
red, which is what a game looks like if nobody touches them.
The colour is saved on the **team**, not on the side, so **Swap sides** moves
each team's colour with it — and it travels in a saved team file, so a team you
reload arrives in its own colours.

Three of the nine cannot be printed as themselves and stay readable: a score has
to be legible from across a gym, so **white** is drawn in slate, **black** in
near-black and **yellow** in a gold, each on its own pale tint. The picker
still shows the colour by name and as it looks; a white team just reads the way a
white kit with dark numbers reads from the table.

1. **Quarter totals** — a thin strip under the scoreboard, so the per-quarter
   score is always in view without taking over the screen.
2. **Live entry** — one tap records one stat. Each player is a row: their number
   and name, then the scoring keys (`+2`, `+3` and `+1` to make a shot; `2`, `3`
   and `1` to miss one), then the counting keys. The running totals live in the
   box score below, so the entry row carries nothing but the keys. The thirteen
   keys share out the panel rather than each claiming its own width, so the
   matrix fits without scrolling sideways.

   **Sub** in that panel's heading records the lineup. Before the first
   substitution it asks for the five who start, one tap each; after that it is
   two taps — the player coming off, then the player coming on — with the strip
   above the table saying which tap it is waiting for and offering a way out.
   Whoever is on the floor carries their team's colour: a bar down the left of
   the row, the number in the same colour, and a wash across the row itself, so
   the five out there can be found without reading a name. A player sitting down
   keeps their name and loses their keys: every name stays at full strength, and
   the row is there to be read with nothing on it to hit by mistake.
3. **Undo** — the button on the scoreboard (it stays pinned, so it is always in
   reach), or `Ctrl`/`Cmd` + `Z`. The toast after each entry also offers a
   one-tap undo.
4. **Play-by-play** — every entry, newest first, each row stamped with how far
   into its period the play happened, counting up from 00:00 to the period
   length. Delete a wrong entry, or use the dropdown on a row to move it to a
   different player on the same team.
5. **Box score** — both teams, per-player totals with a team totals row. The
   heading of the team you are entering is highlighted, so it is obvious where
   the next tap will land. Its **Full width** button adds the shooting
   percentages and efficiency, and turns every heading into a sort key — tap one
   and that team's players reorder, biggest first, and a second tap on the same
   heading turns it round. The **Player** heading is the exception: it sorts by
   jersey number, counting up from the lowest, because that is how a roster is
   printed and how a coach finds a name. Each team sorts inside its own block,
   so the two are never mixed together. See below.

   Tapping a player's row marks it, and tapping it again lets it go: the row is
   tinted across every column, which is what keeps an eye on one line in the
   nineteen-column version. The mark follows a player rather than a position, so
   sorting by a heading moves it with them, and removing a player from the
   roster takes the mark away with them too.
6. **Team total** — under the entry table: the points the selected team has
   scored *in the period on the board*, typed rather than tapped. See below.

Live entry's heading carries three controls; the play-by-play and the box score
carry one each:

| Control | Where | What it does |
| --- | --- | --- |
| `−` / `+` | Live entry | Smaller or larger stat keys, so more or fewer of the roster fit on screen |
| the four-corner icon | every panel | Stretch that section across the whole width, hiding the other two |

The keys start small, at **26px**, because fitting the roster on screen is worth
more at the table than a tall key; the buttons step down to 20px and up through
32px to 40px. The row height follows the key, so a smaller key really does mean
more players in view — 17 rows at the default, 20 at the smallest. At 20px the
number and the name share a line rather than stacking, which is what lets the
row shrink with the keys. The four-corner control is how you see every column of
the entry row or the box score on a screen too narrow to show them side by side;
`Esc` also returns to two columns.

The **More** menu holds what does not fit in the top bar: game settings, the
team and its players (also one press and hold on that team's scoreboard block),
swapping the two sides, the game's own exports, the game summary, and help. The file bar it toggles is hidden until you ask for it,
which is what keeps the two columns tall enough to read at a glance on an iPad.
Game settings is behind that menu rather than on a button of its own: the date,
time, venue and period pills on the strip all open it, so the scoreboard keeps
its three buttons — Undo, Reset and More — and the width they save.

**Swap home and away** puts both teams on the other side, for the game set up the
wrong way round or noticed only once the scoreboard is up. Only the sides change:
a team's name, abbreviation, roster and every entry travel with it, because they
are attached to the team rather than to the side it is drawn on. That also makes
the swap its own undo — swap twice and you are where you started — and it means
the export file names change with it, since they are built from who is home.

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
and use **Load game…** on the second. Rosters move with a team file.

On macOS the first incoming connection may raise a firewall prompt — allow it,
or the other devices will time out. Use `--local` when you want to be certain
nothing is exposed to the network at all.

### Team files and rosters

Rosters do not change much week to week, so a team can be saved and loaded back
next game. The roster itself is edited in **More → Team and players**: type a
number and a name to add a player, and the ✕ beside a name takes that player off
the roster. Writing a team file by hand is the hard way; **Paste roster…** is the
easy one.

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
themselves. It is the ✕ on the roster list, not an import, that deletes a player
*and* the entries they logged.

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
detected and you are pointed at **Load game…** instead, JSON pasted into
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

**Tap the clock to start it, tap it again to stop it.** The face is the run
control, which means the biggest target in the card does the thing a scorer does
without looking. It also says which way it will go: the label reads "tap to
start" when the clock is idle and "tap to stop" while it is counting.

**Editing the time is the Edit button beside it.** Tap **Edit**, type what you
need and press Enter or click away:

| You type | You get |
| --- | --- |
| `7:30` | 7 minutes 30 seconds |
| `07:30` | the same |
| `0730` | the same — the colon is optional |
| `500` | 5 minutes, same as `0500` |
| `:45` | 45 seconds |
| `45` | 45 seconds — two digits or fewer stay a count of seconds |
| `0` | clock cleared; starting refills the period |

Anything after the colon is seconds, so `3:1` is three minutes **one** second —
write `3:10` for three minutes ten. Without a colon, three and four digits read
as MMSS, which is what a hand on a keypad means by `0500`: minutes first, then
seconds. A digit-only entry whose last two digits are over 59 (`075`) is
reported rather than guessed at.

Setting a time always leaves the clock **stopped**, so you decide separately
whether to count down. Editing a running clock pauses it first. A value that
cannot be read is reported and the field stays open so you can fix it; `Escape`
abandons the edit and restores the real time.

The clock's own controls are the face (**tap to start, tap to stop**), the
**Edit** button beside it for typing a time, and **Reset** in the top bar to put
the clock back to the start of the current period. The **− / +** arrows in the
period pill move the period by hand.

**Four nudge keys move the clock by seconds** — `−1` and `−5` on the left of the
face, `+1` and `+5` on the right, fine step on top. A manual clock beside a
scorer drifts, and finding it two seconds out is normal; a nudge is a lighter
correction than re-typing the time, and putting each pair on the side it moves
towards means the key is where the finger is already going. They work while the
clock is running, which is when the drift is noticed. They will not take it past
the end of its period or below `00:00`.

**A running clock looks running.** The face turns green — the digits, the box
around them and the dot beside them, which beats — so the one thing on the page
that is a state rather than a count reads as "go" from across the table. Stopped
is the plain white face, and open for typing is the Edit button's amber. The tell
used to be the dot alone, which was too small to catch while play was going on.

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
| `3P%` `eFG%` `TS%` | Three-point, effective field goal and true shooting percentages |
| `EFF` | FIBA efficiency |
| `MIN` / `+/-` | Minutes on the floor, and the points swing while out there |

**Misses are recorded, not skipped.** Tapping `2`, `3` or `1` is what makes the
percentage columns real. A game logged with only made shots shows `100%` rather
than nothing.

Every one of these is recorded and exported. The **entry rows** are the keys
alone; the **box score** shows the counting totals, and its **Full width**
button adds the six derived columns — `FG%`, `3P%`, `FT%`, `eFG%`, `TS%` and
`EFF` — which need the room that only the full width gives them. They are in
the box score CSV as well, so a downloaded sheet matches the screen.

Two of those read differently from a plain percentage and are worth knowing
before you quote them to a player. **`eFG%`** counts a three as half a make more
than a two, and **`TS%`** folds free throws in at 0.44 of a trip each; both are
therefore able to pass 100%, and a team that only shot threes will. **`EFF`** is
the FIBA scoresheet number — points, rebounds, assists, steals and blocks, less
missed shots and turnovers — so it is worth zero to a player who did nothing and
can go negative for one who only missed.

Sorting by a rate skips the players who have nothing to sort: someone with no
shot attempts has no percentage, so they sit at the bottom whichever way the
column is turned rather than leading it as a 0%.

**`MIN` and `+/-` come from the substitutions**, so they appear once a lineup has
been recorded and stay away until then rather than showing a table of zeros.
Minutes are game-clock time — a stint measured on the clock, split at the period
boundaries it crosses, and counting up live for whoever is on the floor while
the box score is open. Plus/minus needs no clock at all: it is the points for,
less the points against, while that player was out there, read off the entries
you already logged. A team's totals row leaves both blank, because a team has no
single answer to either.

Minutes need the clock to be run. A period whose readings never leave the start
of the period was not timed, so it contributes no minutes to anybody and the
game says so rather than guessing from the wall clock. Plus/minus is unaffected:
it is about who was on the floor when the ball went in, not how long they were
there.

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
| **Save game** | The complete game. Re-importable, so this is what to use to move a game to another device or browser. |

Files are named `2026-01-17_RIV-at-NOR_box-score.csv`, and CSV files carry a
UTF-8 byte-order mark so accented player names open correctly rather than as
mojibake.

**Load game…** loads a backup back in. A truncated or unrelated file is
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
                    strip, then live entry and the log — and the dialogs
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
