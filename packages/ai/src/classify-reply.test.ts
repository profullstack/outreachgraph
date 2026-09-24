/**
 * The model's label, read strictly.
 *
 * A model's output is not trusted to be well-formed, and a label it invents
 * must not become a label anything acts on. Everything unreadable is `other`
 * at zero, which triggers nothing downstream.
 */

import { describe, expect, test } from 'bun:test';
import { classifyReplyWithModel, parseClassification } from './classify-reply';
import { StubModel } from './model';

describe('parseClassification', () => {
  test('reads a well-formed answer', () => {
    const result = parseClassification(
      '{"label":"interested","confidence":0.92,"reason":"they wrote \\"send details\\""}',
    );
    expect(result).toEqual({
      label: 'interested',
      confidence: 0.92,
      source: 'model',
      reason: 'they wrote "send details"',
    });
  });

  test('tolerates a code fence around the JSON', () => {
    expect(parseClassification('```json\n{"label":"question","confidence":0.7}\n```').label).toBe(
      'question',
    );
  });

  test('an invented label is other at zero', () => {
    const result = parseClassification('{"label":"very_interested","confidence":0.99}');
    expect(result.label).toBe('other');
    expect(result.confidence).toBe(0);
  });

  test('prose is other at zero', () => {
    expect(parseClassification('They seem keen!').confidence).toBe(0);
  });

  test('confidence is clamped and a missing one is zero', () => {
    expect(parseClassification('{"label":"question","confidence":7}').confidence).toBe(1);
    expect(parseClassification('{"label":"question"}').confidence).toBe(0);
  });
});

describe('classifyReplyWithModel', () => {
  test('sends only their new words, not our quoted message', async () => {
    const model = new StubModel('{"label":"interested","confidence":0.9,"reason":"yes"}');
    await classifyReplyWithModel(model, {
      body: "Yes, send pricing.\n\nOn Mon, Ada wrote:\n> Don't want these? Unsubscribe: x",
    });
    expect(model.calls[0]?.user).toContain('Yes, send pricing.');
    expect(model.calls[0]?.user).not.toContain('Unsubscribe');
  });

  test('an empty reply is not sent to the model', async () => {
    const model = new StubModel('{"label":"interested","confidence":0.9}');
    const result = await classifyReplyWithModel(model, { body: '   ' });
    expect(result.label).toBe('other');
    expect(model.calls).toHaveLength(0);
  });
});
