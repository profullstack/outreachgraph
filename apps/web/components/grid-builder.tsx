'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ProspectRow } from '../lib/types';

/**
 * Asking the same questions of many prospects at once.
 *
 * The cell count is shown before the button is pressed, and that is the whole
 * design. A grid is the one action in this product where a single click can
 * spend a lot of model budget, so "questions × people = this many answers" has
 * to be visible at the moment of deciding rather than discoverable afterwards
 * on an invoice.
 *
 * Questions are free text rather than a menu. The useful ones are specific to
 * what somebody sells — "which payments provider are they on" is a different
 * question from "what stack do they run" — and a menu would only ever contain
 * the questions we thought of.
 */
export function GridBuilder({ prospects }: { prospects: ProspectRow[] }) {
  const router = useRouter();

  const [name, setName] = useState('');
  const [questions, setQuestions] = useState<string[]>(['']);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const realQuestions = questions.map((q) => q.trim()).filter(Boolean);
  const cells = realQuestions.length * selected.size;

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch('/api/v1/grids', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name,
          questions: realQuestions,
          personIds: [...selected],
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        gridId?: string;
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(payload.error?.message ?? `that failed (${response.status})`);
        return;
      }

      if (payload.gridId) router.push(`/research/${payload.gridId}`);
      else router.refresh();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <h2 className="text-sm font-semibold">Ask across a list</h2>

      <label htmlFor="grid-name" className="text-ink-muted mt-3 block text-xs">
        What is this for
      </label>
      <input
        id="grid-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Competitor scan, August"
        className="border-border bg-surface mt-1 w-full rounded-xl border px-3 py-2.5"
      />

      <div className="mt-4">
        <span className="text-ink-muted text-xs">Questions</span>

        <div className="mt-1 flex flex-col gap-2">
          {questions.map((question, index) => (
            <div key={index} className="flex gap-2">
              <input
                value={question}
                aria-label={`Question ${index + 1}`}
                onChange={(e) =>
                  setQuestions((c) => c.map((q, i) => (i === index ? e.target.value : q)))
                }
                placeholder="Which payments provider are they on?"
                className="border-border bg-surface min-h-[44px] flex-1 rounded-xl border px-3"
              />
              {questions.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setQuestions((c) => c.filter((_, i) => i !== index))}
                  aria-label={`Remove question ${index + 1}`}
                  className="border-border text-ink-muted min-h-[44px] rounded-xl border px-3"
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setQuestions((c) => [...c, ''])}
          className="border-border mt-2 min-h-[40px] rounded-xl border px-3 text-sm"
        >
          Another question
        </button>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between">
          <span className="text-ink-muted text-xs">
            Who to ask about ({selected.size} selected)
          </span>
          <button
            type="button"
            onClick={() =>
              setSelected((c) =>
                c.size === prospects.length ? new Set() : new Set(prospects.map((p) => p.id)),
              )
            }
            className="text-ink-muted text-xs underline"
          >
            {selected.size === prospects.length ? 'Clear' : 'Select all'}
          </button>
        </div>

        {prospects.length === 0 ? (
          <p className="text-ink-muted border-border mt-2 rounded-xl border border-dashed p-4 text-center text-xs">
            No prospects yet.
          </p>
        ) : (
          <ul className="border-border mt-2 max-h-64 overflow-y-auto rounded-xl border">
            {prospects.map((prospect) => (
              <li key={prospect.id} className="border-border border-b last:border-b-0">
                <label className="flex items-center gap-3 p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(prospect.id)}
                    onChange={() => toggle(prospect.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{prospect.display_name}</span>
                    <span className="text-ink-muted block truncate text-xs">
                      {prospect.current_company ?? 'no company'} · {prospect.signal_count} signals
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}

      <button
        type="button"
        onClick={create}
        disabled={busy || cells === 0 || !name.trim()}
        className="bg-accent mt-4 min-h-[44px] w-full rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Creating…' : cells === 0 ? 'Pick questions and people' : `Create ${cells} answers`}
      </button>

      <p className="text-ink-muted mt-3 text-xs">
        One model call per answer. Every answer comes from what we have already collected about that
        person — where there is no evidence the cell stays empty rather than being guessed.
      </p>
    </section>
  );
}
