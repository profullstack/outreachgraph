'use client';

import { useState, type FormEvent } from 'react';
import { ProfileFields } from '@profullstack/profile/react';

type Values = Record<string, string | null>;

/**
 * The account holder's own details (@profullstack/profile): prefilled from
 * GET /api/v1/me/profile, saved with PATCH. Not a prospect record.
 */
export function ProfileForm({ initial }: { initial: Values }) {
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);

    try {
      const response = await fetch('/api/v1/me/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setErrors(payload?.errors ?? {});
        setError(
          payload?.errors
            ? 'a few of those fields need another look'
            : `that failed (${response.status})`,
        );
        return;
      }

      setErrors({});
      setValues(payload?.profile ?? payload);
      setSaved(true);
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {/* Keyed on the saved values so a save shows what the server normalized. */}
      <ProfileFields
        key={JSON.stringify(values)}
        defaultValues={values}
        errors={errors}
        idPrefix="account-"
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="bg-accent rounded-xl px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save details'}
        </button>
        {saved ? <span className="text-ink-muted text-sm">Saved.</span> : null}
      </div>

      {error ? (
        <p role="alert" className="text-hot text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}
