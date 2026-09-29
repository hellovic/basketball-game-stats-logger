/**
 * Reading a roster out of pasted text or a `.csv`.
 *
 * This is the fast path for setting up a team: the scorer copies two columns
 * out of Excel, Numbers or Docs and pastes them in. That text arrives
 * tab-separated, comma-separated or space-aligned depending on where it came
 * from, so the parser detects the delimiter instead of demanding one.
 *
 * The format is deliberately forgiving in the same way `teamfile.js` is: a
 * header row is optional, unknown columns are ignored, and problems a human can
 * see and fix (a shared jersey number, a missing number) become warnings rather
 * than a refusal to import. Only input that cannot be understood at all is an
 * error.
 *
 * No DOM access, so this is unit tested directly.
 */

/** Names that mean "this column holds the player's name". */
const NAME_HEADERS = new Set([
  'player',
  'players',
  'name',
  'player name',
  'full name',
  '姓名',
  '球員',
  '球员',
  '名字',
  '球員姓名',
]);

/** Names that mean "this column holds the jersey number". */
const NUMBER_HEADERS = new Set([
  'number',
  'no',
  'no.',
  'nº',
  'num',
  '#',
  'jersey',
  'jersey number',
  '號碼',
  '号码',
  '背號',
  '球衣號碼',
]);

/** Strip decoration from a header cell: `#`, `*`, dots and stray whitespace. */
function normalizeHeader(cell) {
  return String(cell ?? '')
    .replace(/^\s*#\s*/, '')
    .replace(/[*:.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Split one line, honouring RFC 4180 quoting when the delimiter is a comma.
 *
 * Quoting only applies to commas: a tab-separated paste from Excel never quotes
 * fields, and treating a `"` in a name as syntax there would mangle it.
 */
function splitLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (delimitedQuote(delimiter, char)) {
      // A doubled quote inside a quoted field is one literal quote.
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === delimiter) {
      cells.push(cell);
      cell = '';
      continue;
    }

    cell += char;
  }

  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** Only comma-separated data is allowed to use quotes. */
function delimitedQuote(delimiter, char) {
  return delimiter === ',' && char === '"';
}

/** Anything that reads as a jersey number rather than a name. */
const NUMBER_CELL = /^\d+[a-zA-Z]?$/;

/**
 * One row of `player` + `number` with a single space between them.
 *
 * A single space is a terrible delimiter in general — plenty of names contain
 * one — so it is only used when the line looks exactly like a name followed by
 * a jersey number. This matters because a copy out of a rendered table, a
 * terminal or a chat message often collapses a tab to one space, and refusing
 * that paste looks to the scorer like the importer is broken.
 */
/**
 * A single-space line whose last word reads as a jersey number.
 *
 * Any single space can be a delimiter once the line *ends* in a number: the
 * name is everything before it, which is how `J. Reed 4` and `D. Okafor 11`
 * keep their given names. The earlier tokens are rejoined by the caller.
 */
function looksLikeSpacedRow(line) {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return NUMBER_CELL.test(cleanNumber(tokens[tokens.length - 1]));
}

/** A single-space line whose two words really are the column headings. */
function looksLikeSpacedHeader(line) {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) return false;
  const named = NAME_HEADERS.has(normalizeHeader(tokens[0]));
  const numbered = NUMBER_HEADERS.has(normalizeHeader(tokens[1]));
  return named && numbered;
}

/**
 * Pick the separator this text seems to use: tab beats comma beats spaces.
 *
 * A single space is only accepted when a line looks exactly like a heading pair
 * or a name followed by a jersey number, because it is the one separator that
 * also occurs inside ordinary data.
 */
function detectDelimiter(lines) {
  const scored = [
    { delimiter: '\t', hits: lines.filter((line) => line.includes('\t')).length },
    { delimiter: ',', hits: lines.filter((line) => line.includes(',')).length },
  ];

  const best = scored.sort((a, b) => b.hits - a.hits)[0];
  if (best.hits > 0) {
    return { delimiter: best.delimiter, name: best.delimiter === '\t' ? 'tab' : 'comma' };
  }

  // Space-aligned columns: two or more spaces between fields.
  if (lines.some((line) => /\S {2,}\S/.test(line))) {
    return { delimiter: / {2,}/, name: 'spaces' };
  }

  if (lines.some((line) => looksLikeSpacedRow(line) || looksLikeSpacedHeader(line))) {
    return { delimiter: / +/, name: 'space' };
  }

  return { delimiter: '\t', name: 'tab' };
}

/** Rows that arrived as one cell but are really `player<space>number`. */
function splitUndividedRows(rows) {
  let changed = 0;
  const split = rows.map((row) => {
    if (row.length !== 1) return row;
    const tokens = row[0].split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return row;
    const tail = tokens[tokens.length - 1];
    if (!NUMBER_CELL.test(cleanNumber(tail))) return row;
    changed += 1;
    return [tokens.slice(0, -1).join(' '), tail];
  });
  // Only accept the reading if it explains most of the rows; one lucky match in
  // a single column of names is not enough to invent a number column.
  return changed >= Math.ceil(rows.length / 2) ? split : rows;
}

function splitRows(line, delimiter) {
  if (delimiter instanceof RegExp) return line.split(delimiter).map((cell) => cell.trim());
  return splitLine(line, delimiter);
}

/** A jersey number for display and sorting: `'7'` from `'#7'`, else `''`. */
function cleanNumber(value) {
  return String(value ?? '')
    .replace(/^\s*#\s*/, '')
    .replace(/[,\s]+$/g, '')
    .trim();
}

/** A value that reads as a jersey number rather than a name. */
function looksLikeNumber(cell) {
  const value = cleanNumber(cell);
  return value !== '' && /^\d+[a-zA-Z]?$/.test(value);
}

function cleanName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does the first row name its columns?
 *
 * A row of `Player / Number` obviously does. So does a first row with no
 * numeric cell, because real rosters always have at least one jersey number —
 * that catches `名稱 / 背號` and any spelling of the headers not listed above,
 * which matters because refusing to guess would turn a header into a player.
 *
 * A row with only one filled cell is never a header: `陳大文,` is a player whose
 * number is missing, and reading it as a heading would drop them from the team.
 */
function looksLikeHeader(row) {
  if (row.length < 2) return false;
  if (row.some((cell) => NAME_HEADERS.has(normalizeHeader(cell)))) return true;
  if (row.some((cell) => NUMBER_HEADERS.has(normalizeHeader(cell)))) return true;
  const filled = row.filter((cell) => String(cell ?? '').trim() !== '').length;
  if (filled < 2) return false;
  return !row.some(looksLikeNumber);
}

/** Does a column look like jersey numbers across the sample of rows it has? */
function columnLooksNumeric(rows, index) {
  const values = rows.map((row) => cleanNumber(row[index])).filter((value) => value !== '');
  if (values.length === 0) return false;
  return values.filter(looksLikeNumber).length * 2 > values.length;
}

/** All rows under a header with the same width, so ragged rows do not corrupt. */
function findPlayerColumn(headers, aliases) {
  return headers.findIndex((cell) => aliases.has(normalizeHeader(cell)));
}

/**
 * Read a pasted roster or the contents of a `.csv`.
 *
 * Returns `{ players, delimiter, hasHeader, ignoredColumns, warnings, error }`.
 * `error` is a message for the user; everything else is advisory so the import
 * can still proceed with what it understood.
 */
export function parseRosterText(text) {
  const empty = {
    players: [],
    delimiter: '',
    hasHeader: false,
    ignoredColumns: [],
    warnings: [],
  };

  if (typeof text !== 'string' || text.trim() === '') {
    return { ...empty, error: 'The roster is empty.' };
  }

  // A JSON team file pasted into the text box is a common mistake worth naming.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || /"players"\s*:/.test(trimmed)) {
    return {
      ...empty,
      error: 'That looks like JSON. Use "Load team from file… (JSON or CSV)" for a team file.',
    };
  }

  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('//'));

  if (lines.length === 0) {
    return { ...empty, error: 'The roster is empty.' };
  }

  const { delimiter, name: delimiterName } = detectDelimiter(lines);
  let rows = lines.map((line) => splitRows(line, delimiter));

  // `陳大文 55` arrives as one cell when a single space separates the two,
  // because a single space is not otherwise safe to split on.
  if (delimiter.source === ' +') {
    rows = splitUndividedRows(rows);
  }

  if (rows[0].length < 2) {
    return {
      ...empty,
      delimiter: delimiterName,
      error:
        'Each line needs a player and a number, separated by a tab, a comma or a ' +
        'space — for example "陳大文,55" or "陳大文 55".',
    };
  }

  const hasHeader = looksLikeHeader(rows[0]);
  const headers = hasHeader ? rows[0] : [];
  const body = hasHeader ? rows.slice(1) : rows;

  // Positional default is Player then Number, which is the order the scorer
  // reads off a scoresheet; a header can swap them.
  let nameAt = 0;
  let numberAt = 1;

  if (hasHeader) {
    const named = findPlayerColumn(headers, NAME_HEADERS);
    const numbered = findPlayerColumn(headers, NUMBER_HEADERS);
    // Only trust a header if it found the columns and they are not the same one.
    if (named !== -1) nameAt = named;
    if (numbered !== -1 && numbered !== named) numberAt = numbered;
    else if (numbered === -1 && named === 0) numberAt = 1;

    // A single space splits a name into several cells, so the heading can point
    // at a cell that is not the number after all (`J. Reed` under "Player
    // Number" makes cell 1 "Reed"). Where the data disagrees with the heading,
    // the data wins: find the column that really holds numbers.
    if (delimiter.source === ' +' && !columnLooksNumeric(body, numberAt)) {
      const width = Math.max(...body.map((row) => row.length));
      const numeric = Math.max(
        0,
        ...Array.from({ length: width }, (_, index) => (columnLooksNumeric(body, index) ? index + 1 : 0)),
      );
      if (numeric > 0 && numeric - 1 !== nameAt) numberAt = numeric - 1;
    }
  } else {
    // No header to go by, so find the numbers instead of assuming column two.
    // A paste of `陳大文,U14,55` must not read "U14" as the jersey number.
    const sample = rows.slice(0, 20);
    if (sample.length > 0) {
      const width = Math.max(...sample.map((row) => row.length));
      const numeric = Math.max(
        0,
        ...Array.from({ length: width }, (_, index) => (columnLooksNumeric(sample, index) ? index + 1 : 0)),
      );
      if (numeric > 0) numberAt = numeric - 1;
    }
  }

  const players = [];
  const warnings = [];
  // With a single space as the separator, `J. Reed 4` splits into three cells.
  // The name is every cell before the number column, so they are rejoined.
  const joinName = delimiter.source === ' +' && numberAt >= 1;

  for (const row of body) {
    const name = cleanName(
      joinName ? row.slice(0, numberAt).filter(Boolean).join(' ') : row[nameAt],
    );
    const number = cleanNumber(row[numberAt]);

    if (!name && !number) continue; // A stray blank line, already harmless.
    if (!name) {
      warnings.push(`Row "${number}" has no player name and was skipped.`);
      continue;
    }

    players.push({ number, name, active: true });
  }

  if (players.length === 0) {
    return {
      ...empty,
      delimiter: delimiterName,
      warnings,
      error: 'No players were found in that roster.',
    };
  }

  // Report the columns that were read past, so a `Group` column is visibly
  // acknowledged rather than silently dropped.
  const width = Math.max(...rows.map((row) => row.length));
  const ignoredColumns = [];
  if (hasHeader) {
    for (let i = 0; i < headers.length; i += 1) {
      if (i !== nameAt && i !== numberAt && headers[i]) ignoredColumns.push(headers[i]);
    }
  } else if (width > 2) {
    ignoredColumns.push(`column 3-${width}`);
  }

  const numbers = new Map();
  for (const player of players) {
    if (!player.number) continue;
    numbers.set(player.number, (numbers.get(player.number) || 0) + 1);
  }
  const shared = [...numbers.entries()].filter(([, count]) => count > 1).map(([value]) => value);
  if (shared.length > 0) {
    warnings.push(
      `Jersey number${shared.length === 1 ? '' : 's'} ${shared.join(', ')} ` +
        `${shared.length === 1 ? 'is' : 'are'} used by more than one player. That is allowed, ` +
        `but check for a typo.`,
    );
  }

  const unnumbered = players.filter((player) => !player.number).length;
  if (unnumbered > 0) {
    warnings.push(
      `${unnumbered} player${unnumbered === 1 ? ' has' : 's have'} no jersey number.`,
    );
  }

  return {
    players,
    delimiter: delimiterName,
    hasHeader,
    ignoredColumns,
    warnings,
    error: null,
  };
}
