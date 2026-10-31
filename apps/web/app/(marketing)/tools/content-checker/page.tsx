import Link from 'next/link';
import { ContentChecker } from '../../../../components/content-checker';

export const metadata = {
  title: 'Free AI-speak checker · OutreachGraph',
  description:
    'Check a draft for common AI filler phrases in your browser. Your text stays private.',
};

export default function ContentCheckerPage() {
  return (
    <div className="mx-auto min-h-screen w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <nav className="mb-10 flex items-center justify-between">
        <Link href="/" className="text-sm font-semibold">
          OutreachGraph
        </Link>
        <Link href="/login" className="border-border rounded-xl border px-4 py-2 text-sm">
          Sign in
        </Link>
      </nav>
      <header className="mb-6">
        <p className="text-ink-muted font-mono text-[11px] tracking-[0.14em] uppercase">
          Free tool · no sign-up
        </p>
        <h1 className="mt-2 text-3xl leading-tight font-semibold tracking-[-0.03em]">
          AI-speak checker
        </h1>
        <p className="text-ink-muted mt-3 max-w-xl text-base leading-relaxed">
          Spot familiar filler phrases and make your draft sound more like you. Paste any copy
          below.
        </p>
      </header>
      <ContentChecker />
      <p className="text-ink-muted mt-8 text-sm">
        Need a first draft?{' '}
        <Link className="text-accent underline" href="/login">
          Open the Content Studio
        </Link>{' '}
        to write social posts, newsletters, and articles in your product voice.
      </p>
    </div>
  );
}
