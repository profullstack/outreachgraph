/**
 * A CSV reader, in the browser.
 *
 * Written rather than installed because the alternative is shipping a parsing
 * library to every page of a PWA to read one file on one screen, and because
 * the hard part of CSV is small and well-specified: quoted fields may contain
 * commas, newlines and doubled quotes, and everything else is splitting.
 *
 * Parsing happens client-side deliberately. The file is already on the user's
 * machine; uploading several megabytes so a server can split it on commas
 * spends bandwidth and a request timeout to learn nothing the browser did not
 * already know. What the browser must not do is *decide* anything — every row
 * it produces is still cleaned server-side, because a client can be told to
 * lie about which addresses are real.
 */

/**
 * Splits CSV text into rows of fields.
 *
 * Handles the three things that break naive splitting: `"a,b"` (a comma inside
 * a field), `"line one\nline two"` (a newline inside a field), and `"say ""hi"""`
 * (an escaped quote). CRLF is normalised, and a trailing newline does not
 * produce a phantom empty row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  // A byte-order mark survives Excel exports and would otherwise become part
  // of the first header, so `﻿Email` never matches `email`.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = (): void => {
    row.push(field);
    field = '';
  };

  const endRow = (): void => {
    endField();
    // A blank trailing line is not a record.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      endField();
      index += 1;
      continue;
    }

    if (char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // Whatever is left after the last newline is a row, unless the file ended
  // cleanly on one.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/** A row keyed by the fields the importer understands. */
export interface MappedRow {
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  location?: string;
}

/** Applies a header mapping to the data rows. */
export function applyMapping(
  rows: readonly string[][],
  mapping: Readonly<Record<string, number>>,
): MappedRow[] {
  return rows.map((cells) => {
    const mapped: MappedRow = {};

    for (const [field, index] of Object.entries(mapping)) {
      const value = cells[index];
      if (value !== undefined && value.trim() !== '') {
        mapped[field as keyof MappedRow] = value;
      }
    }

    return mapped;
  });
}
