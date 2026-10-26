import Link from 'next/link';
import { BrandLockup } from '../../../../components/brand';
import { InviteCookie } from '../../../../components/invite-cookie';
import { LoginForm } from '../../../../components/login-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'You are invited · OutreachGraph',
  description: 'Someone saved you an invite to OutreachGraph.',
};

/**
 * Where an invite link lands: /i/<code>.
 *
 * Opening it uses nothing up. The code is remembered in a cookie and sent with
 * the new account, which records it server side, so the verification mail can
 * be opened on any device and the bonus still lands. Kept outside the crawl
 * gateway (proxy.ts) so link previews never see a 402.
 */
export default async function InviteLanding({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = decodeURIComponent(raw)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 32);

  return (
    <div className="flex min-h-[80dvh] items-center justify-center px-5 py-12">
      <div className="border-border w-full max-w-sm sm:rounded-2xl sm:border sm:p-8">
        <header className="mb-6">
          <h1>
            <BrandLockup size="lg" />
          </h1>
        </header>
        <InviteCookie code={code} />
        <p className="text-sm">Someone saved you one of their three invites.</p>
        <p className="text-ink-muted mt-2 mb-5 text-sm">
          Create an account and confirm your email: you both get free prospect credits. The invite
          works once, for a new account.
        </p>
        <LoginForm next="/inbox" invite={code} initialMode="register" />
        <p className="text-ink-muted mt-6 text-xs">
          <Link href="/" className="underline">
            What is OutreachGraph?
          </Link>
        </p>
      </div>
    </div>
  );
}
