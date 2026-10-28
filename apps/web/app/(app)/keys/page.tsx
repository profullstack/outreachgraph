import { KeysPanel } from '../../../components/keys-panel';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Keys · OutreachGraph' };

/** The workspace key passphrase: unlock so autopilot can use your mailboxes and accounts. */
export default function KeysPage() {
  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Keys</h1>
        <p className="text-ink-muted text-sm">
          Your mailbox passwords and account tokens open only while you are unlocked. Locked (after
          a restart, when the unlock time runs out, or when you press Lock), autopilot waits and
          nothing is lost.
        </p>
      </header>
      <KeysPanel />
    </div>
  );
}
