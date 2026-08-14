'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * Setup: paste your own site, get a profile back, correct it, save it.
 *
 * Deliberately a review step rather than a save. What comes back is a model's
 * reading of a marketing page — a good starting point and not a fact about
 * somebody's business — so it is shown as editable fields and nothing is
 * written until the person presses save. The alternative, silently adopting
 * whatever the model said, means every draft afterwards is grounded in a guess
 * nobody checked.
 */

interface Draft {
  offering: {
    name: string;
    category: string;
    description: string;
    valuePropositions: string[];
    likelyPains: string[];
    competitors: string[];
  };
  icp: {
    titles: string[];
    seniorities: string[];
    industries: string[];
    technologies: string[];
    keywords: string[];
    exclusions: string[];
  };
  voice: { style: string; instructions: string; maxWords: number };
  whereToFind: string[];
}

/**
 * Turns the API's per-field complaints into something worth reading.
 *
 * A rejected save that says only "that profile is incomplete" leaves someone
 * hunting through nine fields for the one the server disliked, so the paths
 * come along: `offering.valuePropositions.3` means the fourth line of that box.
 */
function fieldSummary(details: unknown): string {
  if (!details || typeof details !== 'object') return '';
  return Object.keys(details as Record<string, unknown>).join(', ');
}

const lines = (values: string[]) => values.join('\n');
const parseLines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

export function ProfileSetup({ initialUrl }: { initialUrl?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Separate from the read error: the save button sits at the bottom of a long
  // form, and an explanation rendered up by the URL box is off-screen.
  const [saveError, setSaveError] = useState<string | undefined>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [saved, setSaved] = useState(false);

  async function read(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;

    setBusy(true);
    setError(undefined);
    setSaveError(undefined);
    setSaved(false);

    try {
      const response = await fetch('/api/v1/onboarding/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ url }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload?.error?.message ?? `that failed (${response.status})`);
        return;
      }

      setDraft(payload.draft as Draft);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(undefined);

    try {
      const response = await fetch('/api/v1/onboarding/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          url,
          offering: draft.offering,
          icp: draft.icp,
          voice: draft.voice,
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload?.error?.message ?? `that failed (${response.status})`;
        const fields = fieldSummary(payload?.error?.details);
        setSaveError(fields ? `${message}: ${fields}` : message);
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setSaveError('could not reach the server');
    } finally {
      setSaving(false);
    }
  }

  function edit(patch: Partial<Draft>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={read} className="border-border bg-surface-raised rounded-2xl border p-4">
        <label htmlFor="site" className="text-sm font-medium">
          Your website
        </label>
        <p className="text-ink-muted mt-1 text-xs">
          We read your homepage and draft a profile: what you sell, who buys it, and how you write.
          You get to correct all of it before anything is saved.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            id="site"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="yourcompany.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-3"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="bg-accent shrink-0 rounded-xl px-4 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Reading…' : 'Read my site'}
          </button>
        </div>

        {error ? (
          <p role="alert" className="text-hot mt-3 text-sm">
            {error}
          </p>
        ) : null}
      </form>

      {draft ? (
        <div className="border-border bg-surface-raised flex flex-col gap-5 rounded-2xl border p-4">
          <Field
            label="What you sell"
            hint="Every message is grounded in this. Vague text here makes vague outreach."
            value={draft.offering.name}
            onChange={(name) => edit({ offering: { ...draft.offering, name } })}
          />

          <TextArea
            label="Description"
            value={draft.offering.description}
            rows={3}
            onChange={(description) => edit({ offering: { ...draft.offering, description } })}
          />

          <ListField
            label="Why they should care"
            hint="The claims a message can make. Shown here because it is saved with the rest."
            values={draft.offering.valuePropositions}
            onChange={(valuePropositions) =>
              edit({ offering: { ...draft.offering, valuePropositions } })
            }
          />

          <ListField
            label="Problems your buyer has"
            hint="In their words, not yours."
            values={draft.offering.likelyPains}
            onChange={(likelyPains) => edit({ offering: { ...draft.offering, likelyPains } })}
          />

          <ListField
            label="Job titles to target"
            values={draft.icp.titles}
            onChange={(titles) => edit({ icp: { ...draft.icp, titles } })}
          />

          <ListField
            label="Industries"
            values={draft.icp.industries}
            onChange={(industries) => edit({ icp: { ...draft.icp, industries } })}
          />

          <ListField
            label="Keywords that signal a fit"
            hint="What these people say when they have the problem you solve."
            values={draft.icp.keywords}
            onChange={(keywords) => edit({ icp: { ...draft.icp, keywords } })}
          />

          <ListField
            label="Never target"
            values={draft.icp.exclusions}
            onChange={(exclusions) => edit({ icp: { ...draft.icp, exclusions } })}
          />

          <Field
            label="How you write"
            value={draft.voice.style}
            onChange={(style) => edit({ voice: { ...draft.voice, style } })}
          />

          {draft.whereToFind.length > 0 ? (
            <div>
              <span className="text-sm font-medium">Where these people are</span>
              <p className="text-ink-muted mt-1 text-xs">
                Suggestions to act on yourself — we do not search these yet.
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {draft.whereToFind.map((entry) => (
                  <li key={entry} className="text-ink-muted text-[13px] leading-relaxed">
                    {entry}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !draft.offering.name.trim()}
              className="bg-accent shrink-0 rounded-xl px-4 text-sm font-medium text-white disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save profile'}
            </button>
            {saved ? <span className="text-good text-sm">Saved.</span> : null}
            {saveError ? (
              <span role="alert" className="text-hot text-sm">
                {saveError}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {hint ? <span className="text-ink-muted text-xs">{hint}</span> : null}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-border bg-surface mt-1 rounded-xl border px-3 py-3"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  rows,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="border-border bg-surface mt-1 rounded-xl border px-3 py-3 text-[15px]"
      />
    </label>
  );
}

/** One per line. A textarea beats tag chips for correcting a list of twelve. */
function ListField({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-ink-muted text-xs">{hint ? `${hint} ` : ''}One per line.</span>
      <textarea
        value={lines(values)}
        rows={Math.min(Math.max(values.length + 1, 2), 8)}
        onChange={(e) => onChange(parseLines(e.target.value))}
        className="border-border bg-surface mt-1 rounded-xl border px-3 py-3 font-mono text-[13px]"
      />
    </label>
  );
}
