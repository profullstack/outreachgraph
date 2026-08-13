import { VerifyForm } from '../../../components/verify-form';
import { BrandLockup } from '../../../components/brand';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Confirm your email · OutreachGraph' };

/**
 * The landing page for the emailed verification link.
 *
 * The token arrives in the query string and is posted from the browser rather
 * than consumed here, so a mail client or scanner that prefetches the link
 * cannot silently burn a single-use token before the person ever clicks it.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 pt-12">
      <BrandLockup height="h-7" />
      <h1 className="text-xl font-semibold">Confirm your email</h1>
      <VerifyForm token={token ?? ''} />
    </div>
  );
}
