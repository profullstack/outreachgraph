import Link from 'next/link';

export const metadata = { title: 'More · OutreachGraph' };

const SECTIONS = [
  { label: 'Campaigns', hint: 'Wizard not built yet' },
  { label: 'Conversations', hint: 'Interaction tracking only' },
  { label: 'Integrations', hint: 'Provider adapters pending' },
  { label: 'Usage', hint: 'Metering recorded, not enforced' },
  { label: 'Settings', hint: 'Thresholds live on the workspace' },
] as const;

/** Desktop expands the bottom nav into the full §25 navigation. */
export default function MorePage() {
  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">More</h1>
      </header>

      <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
        {SECTIONS.map((section) => (
          <li key={section.label} className="bg-surface-raised p-4">
            <div className="font-medium">{section.label}</div>
            <div className="text-ink-muted text-xs">{section.hint}</div>
          </li>
        ))}
      </ul>

      <p className="text-ink-muted mt-6 text-center text-xs">
        <Link href="/" className="underline">
          Back to Today
        </Link>
      </p>
    </div>
  );
}
