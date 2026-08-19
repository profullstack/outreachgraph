import { ContactImport } from '../../../components/contact-import';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Import contacts · OutreachGraph' };

/**
 * Bringing in a list you already own.
 *
 * Separate from `/prospects`, which adds people by finding them. This is the
 * other direction — people you already have a relationship with — and the two
 * deserve different screens because they have different risks. Finding someone
 * risks contacting the wrong person; importing risks contacting the right
 * person without a basis for it.
 */
export default function ImportPage() {
  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Import contacts</h1>
        <p className="text-ink-muted text-sm">
          People who already know you — users, signups, a mailing list you own.
        </p>
      </header>

      <ContactImport />
    </div>
  );
}
