'use client';

import { useMemo, useState } from 'react';

const PATTERNS = [
  'at the end of the day',
  'in today’s fast-paced',
  "in today's fast-paced",
  'it is worth noting',
  "it's worth noting",
  'game-changer',
  'game changer',
  'cutting-edge',
  'robust solution',
  'seamlessly',
  'delve into',
  'delve deeper',
  'unlock the power',
  'leverage our',
  'harness the power',
  'navigate the complex',
  'in conclusion',
  'furthermore',
  'moreover',
  'multifaceted',
  'ever-evolving landscape',
  'a testament to',
  'not only … but also',
] as const;

function occurrences(text: string, phrase: string): number {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/…/g, '.{0,24}');
  return [...text.matchAll(new RegExp(escaped, 'gi'))].length;
}

export function ContentChecker() {
  const [text, setText] = useState('');
  const matches = useMemo(
    () =>
      PATTERNS.map((phrase) => ({ phrase, count: occurrences(text, phrase) })).filter(
        (item) => item.count > 0,
      ),
    [text],
  );
  const hitCount = matches.reduce((sum, match) => sum + match.count, 0);
  const score = text.trim()
    ? Math.max(0, 100 - hitCount * 9 - Math.max(0, matches.length - 2) * 3)
    : null;
  const reading =
    score === null
      ? ''
      : score >= 85
        ? 'Few common filler patterns'
        : score >= 60
          ? 'Some phrases to review'
          : 'Several phrases to rewrite';

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-ink-muted text-xs">Paste a draft</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={12}
          maxLength={20_000}
          placeholder="Paste a post, email, or article here…"
          className="border-border bg-surface mt-1 w-full rounded-2xl border px-4 py-3 text-sm leading-relaxed"
        />
      </label>

      <div className="border-border bg-surface-raised rounded-2xl border p-4" aria-live="polite">
        {score === null ? (
          <p className="text-ink-muted text-sm">Your check appears here as you type or paste.</p>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">{reading}</p>
              <p className="text-ink-muted mt-1 text-xs">
                Found {hitCount} common phrase {hitCount === 1 ? 'pattern' : 'patterns'}.
              </p>
            </div>
            <div
              className="text-accent font-mono text-2xl font-semibold"
              aria-label={`Writing score ${score} out of 100`}
            >
              {score}
              <span className="text-ink-muted text-xs">/100</span>
            </div>
          </div>
        )}
        {matches.length > 0 ? (
          <ul className="border-border mt-4 flex flex-wrap gap-2 border-t pt-3">
            {matches.map(({ phrase, count }) => (
              <li key={phrase} className="border-border rounded-full border px-3 py-1 text-xs">
                {phrase}
                {count > 1 ? ` · ${count}` : ''}
              </li>
            ))}
          </ul>
        ) : text.trim() ? (
          <p className="text-good mt-3 border-t pt-3 text-sm">No common filler patterns found.</p>
        ) : null}
      </div>
      <p className="text-ink-muted text-xs leading-relaxed">
        This is a lightweight writing check, not an AI detector. Your text stays in this browser and
        is never uploaded.
      </p>
    </div>
  );
}
