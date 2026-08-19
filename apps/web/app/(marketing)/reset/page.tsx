import { ResetPasswordForm } from '../../../components/reset-password-form';
import { BrandLockup } from '../../../components/brand';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Choose a new password · OutreachGraph' };

/**
 * The landing page for the emailed reset link.
 *
 * The token arrives in the query string and is handed to the client, which
 * posts it only when the form is submitted — so a mail client that prefetches
 * the link renders this page rather than consuming a single-use token.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="flex min-h-[80dvh] items-center justify-center px-5 py-12">
      <div className="border-border w-full max-w-sm sm:rounded-2xl sm:border sm:p-8">
        <header className="mb-6">
          <BrandLockup size="lg" />
          <h1 className="mt-4 text-xl font-semibold">Choose a new password</h1>
        </header>

        <ResetPasswordForm token={token ?? ''} />
      </div>
    </div>
  );
}
