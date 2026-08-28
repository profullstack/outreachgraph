import { LoginForm } from '../../../components/login-form';
import { BrandLockup } from '../../../components/brand';

export const metadata = { title: 'Sign in · OutreachGraph' };

/**
 * Sign in.
 *
 * The marketing layout is full-bleed — bands paint edge to edge and each
 * section owns its measure — so this page has to set its own. Without that it
 * inherited the whole viewport: on a desktop monitor the heading and the email
 * field ran the full width of the screen, flush to both edges, with no gutter
 * on a phone either.
 *
 * The card border only appears from `sm` up. At phone width a box drawn a few
 * pixels inside the screen edge reads as a rendering artefact rather than as a
 * card, so the form simply sits on the page there.
 */
/**
 * Only a path on this origin is accepted as a destination.
 *
 * `//evil.example` and `https://evil.example` are both valid values of a
 * `next` query parameter and both leave this site, so the check is "starts
 * with one slash and not two" rather than anything cleverer.
 */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/today';
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="flex min-h-[80dvh] items-center justify-center px-5 py-12">
      <div className="border-border w-full max-w-sm sm:rounded-2xl sm:border sm:p-8">
        <header className="mb-6">
          {/* The lockup is the heading here, so it carries the h1 rather than sitting above one. */}
          <h1>
            <BrandLockup size="lg" />
          </h1>
          <p className="text-ink-muted mt-2 text-sm">
            Turn public intent signals into warm conversations.
          </p>
        </header>

        <LoginForm next={safeNext(next)} />
      </div>
    </div>
  );
}
