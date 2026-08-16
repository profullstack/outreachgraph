import { redirect } from 'next/navigation';
import { SettingsForm } from '../../../components/settings-form';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchSettings,
  type SettingsView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Settings · OutreachGraph' };

/**
 * Notification and autopilot settings.
 *
 * Its own page rather than a section of More, because once the product runs
 * unattended these are the controls that decide what it does while nobody is
 * looking — and "how much may it send today" is not a preference to hide
 * behind a disclosure triangle.
 */
export default async function SettingsPage() {
  let settings: SettingsView | undefined;
  let offline = false;

  try {
    settings = await fetchSettings();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-ink-muted text-sm">What we send you, and what we send for you.</p>
      </header>

      {offline || !settings ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <SettingsForm initial={settings} />
      )}
    </div>
  );
}
