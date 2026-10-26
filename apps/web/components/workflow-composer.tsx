'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { WorkflowPlanStepView, WorkflowTemplateView } from '../lib/api';
import { WorkflowPlan } from './workflow-plan';

interface Preview {
  plan: WorkflowPlanStepView[];
  notes: string[];
  errors: string[];
  warnings: string[];
  interpretedBy: 'model' | 'rules';
}

/**
 * Describe a workflow in English, see the plan it becomes, save it as a draft.
 *
 * Preview reads the text into a plan and saves nothing; Save creates a draft.
 * Nothing runs until the draft is published from its own page — creating and
 * switching on are deliberately two separate acts.
 */
export function WorkflowComposer({ templates }: { templates: readonly WorkflowTemplateView[] }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pickTemplate(template: WorkflowTemplateView) {
    setPrompt(template.prompt);
    setName(template.name);
    setTemplateId(template.id);
    setPreview({
      plan: [...template.plan],
      notes: [],
      errors: [],
      warnings: [],
      interpretedBy: 'rules',
    });
    setError(null);
  }

  async function call(path: string, body: unknown) {
    const response = await fetch(`/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (json.error as { message?: string } | undefined)?.message;
      throw new Error(message ?? `request failed (${response.status})`);
    }
    return json;
  }

  async function runPreview() {
    setBusy('preview');
    setError(null);
    try {
      setPreview((await call('/workflows/interpret', { prompt })) as unknown as Preview);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const template = templates.find((t) => t.id === templateId);
      const body =
        template && template.prompt === prompt
          ? { templateId: template.id, ...(name.trim() ? { name: name.trim() } : {}) }
          : { prompt, ...(name.trim() ? { name: name.trim() } : {}) };
      const result = (await call('/workflows', body)) as { workflow: { id: string } };
      router.push(`/workflows/${result.workflow.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  const blocked = (preview?.errors.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-5">
      {templates.length > 0 ? (
        <section aria-labelledby="templates-heading">
          <h2 id="templates-heading" className="mb-2 text-sm font-semibold">
            Start from a template
          </h2>
          <div className="flex flex-col gap-2">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => pickTemplate(template)}
                aria-pressed={templateId === template.id}
                className={`rounded-2xl border p-3 text-left ${
                  templateId === template.id
                    ? 'border-accent bg-accent/5'
                    : 'border-border bg-surface-raised'
                }`}
              >
                <span className="block text-sm font-medium">{template.name}</span>
                <span className="text-ink-muted mt-1 block text-xs leading-relaxed">
                  {template.summary}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <label htmlFor="workflow-prompt" className="text-sm font-semibold">
          Describe the workflow
        </label>
        <textarea
          id="workflow-prompt"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setTemplateId((current) =>
              current && templates.find((t) => t.id === current)?.prompt === e.target.value
                ? current
                : null,
            );
          }}
          rows={7}
          maxLength={4000}
          placeholder="Find US startups hiring contract engineers. Email the CTO or VP of Engineering at companies with 10 to 500 employees. Not agencies. Up to 50 emails a day with my approval, every weekday at 8am Pacific."
          className="border-border bg-surface rounded-2xl border p-3 text-sm leading-relaxed"
        />
        <label htmlFor="workflow-name" className="text-ink-muted text-xs">
          Name (optional)
        </label>
        <input
          id="workflow-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="border-border bg-surface min-h-[44px] rounded-xl border px-3 text-sm"
        />
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={runPreview}
            disabled={busy !== null || prompt.trim().length < 3}
            className="border-border min-h-[44px] rounded-xl border px-4 text-sm font-medium disabled:opacity-50"
          >
            {busy === 'preview' ? 'Reading…' : 'Preview plan'}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy !== null || prompt.trim().length < 3 || blocked}
            className="bg-accent min-h-[44px] rounded-xl px-4 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === 'save' ? 'Saving…' : 'Save as draft'}
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-rose-600">
            {error}
          </p>
        ) : null}
      </section>

      {preview ? (
        <section aria-labelledby="plan-heading" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 id="plan-heading" className="text-sm font-semibold">
              Plan
            </h2>
            <span className="text-ink-muted text-xs">
              read by {preview.interpretedBy === 'model' ? 'the model, checked by rules' : 'rules'}
            </span>
          </div>
          {preview.errors.map((e) => (
            <p key={e} role="alert" className="text-sm text-rose-600">
              {e}
            </p>
          ))}
          {[...preview.notes, ...preview.warnings].map((note) => (
            <p key={note} className="text-xs text-amber-600">
              {note}
            </p>
          ))}
          <WorkflowPlan plan={preview.plan} />
          <p className="text-ink-muted text-xs">
            Saving makes a draft. Dry-run it, adjust any step, then publish to switch it on.
          </p>
        </section>
      ) : null}
    </div>
  );
}
