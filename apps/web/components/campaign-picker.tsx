'use client';

import { useRouter } from 'next/navigation';

/**
 * One dropdown for "which campaign", however many there are.
 *
 * It replaces a row of chips that showed the first eight and silently dropped
 * the rest — a workspace selling fifty products could not pick forty-two of
 * them. A native select is searchable by typing on every platform and costs
 * one line of layout at any length.
 */
export function CampaignPicker({
  campaigns,
  selected,
  basePath,
  param = 'campaign',
  allLabel = 'All campaigns',
}: {
  campaigns: readonly { id: string; name: string; autopilot?: boolean }[];
  selected?: string | undefined;
  basePath: string;
  param?: string;
  allLabel?: string;
}) {
  const router = useRouter();
  const sorted = [...campaigns].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <label className="mb-4 block">
      <span className="sr-only">Show one campaign</span>
      <select
        value={selected ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          const join = basePath.includes('?') ? '&' : '?';
          router.push(value ? `${basePath}${join}${param}=${encodeURIComponent(value)}` : basePath);
        }}
        className="border-border bg-surface w-full rounded-xl border px-3 py-2.5 text-sm"
      >
        <option value="">
          {allLabel} ({campaigns.length})
        </option>
        {sorted.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
            {row.autopilot ? ' · autopilot' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
