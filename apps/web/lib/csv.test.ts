import { describe, expect, test } from 'bun:test';
import { applyMapping, parseCsv } from './csv';

describe('parseCsv', () => {
  test('reads plain rows', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('keeps commas inside quoted fields', () => {
    // The reason this is not `split(',')`.
    expect(parseCsv('name,company\n"Mackenzie, Dave",Corp')).toEqual([
      ['name', 'company'],
      ['Mackenzie, Dave', 'Corp'],
    ]);
  });

  test('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a\n"one\ntwo"')).toEqual([['a'], ['one\ntwo']]);
  });

  test('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  test('handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('a trailing newline is not a row', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
  });

  test('strips the byte-order mark Excel leaves behind', () => {
    // Otherwise the first header is "﻿Email" and never matches.
    expect(parseCsv('﻿Email,Name\na@b.com,Dave')[0]).toEqual(['Email', 'Name']);
  });

  test('keeps empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });
});

describe('applyMapping', () => {
  test('picks the mapped columns and drops the rest', () => {
    const rows = [['7', 'Dave', 'dave@corp.com', 'ignored']];

    expect(applyMapping(rows, { name: 1, email: 2 })).toEqual([
      { name: 'Dave', email: 'dave@corp.com' },
    ]);
  });

  test('omits blank cells rather than sending empty strings', () => {
    expect(applyMapping([['', 'dave@corp.com']], { name: 0, email: 1 })).toEqual([
      { email: 'dave@corp.com' },
    ]);
  });
});
