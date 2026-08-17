import { redirect } from 'next/navigation';
import { ListeningForm } from '../../../components/listening-form';
import { PageGuide } from '../../../components/page-guide';
import { ProductSwitcher } from '../../../components/product-switcher';
import { ProfileSetup } from '../../../components/profile-setup';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchListening,
  fetchMe,
  fetchProfile,
  type ListeningView,
  type WorkspaceProfileView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Set up · OutreachGraph' };

/**
 * The setup step (PRD §7, §11).
 *
 * Everything downstream is grounded in what this page collects: the composer
 * writes from the offering, the scorer ranks against the ICP. Until it is
 * filled in, the workspace is pointed at a placeholder offering that reads
 * "Describe what you sell here" — which is what every draft would quote.
 *
 * It describes **one product at a time**, chosen by `?product=`. A workspace
 * that sells two things needs two profiles: the claims a draft may ground
 * itself in, the buyers it is scored against and the voice it is written in
 * are all different, and collapsing them into one profile produces messages
 * that are vague about both.
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const { product } = await searchParams;
  const adding = product === 'new';
  const requested = adding ? undefined : product;

  let me;
  let profile: WorkspaceProfileView | undefined;
  let offline = false;

  try {
    [me, profile] = await Promise.all([
      fetchMe(),
      // Adding still loads the default profile — only for its product list, so
      // the switcher renders while the new one is being written.
      fetchProfile(requested),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  const verified = me?.emailVerified ?? false;
  const products = profile?.products ?? [];

  // Listening is configured per product, so it hangs off this product's own
  // campaign. A product without one yet simply has nothing to configure.
  const campaignId = products.find((p) => p.offeringId === profile?.offeringId)?.campaignId;

  let listening: ListeningView | undefined;
  if (!adding && campaignId) {
    try {
      listening = await fetchListening(campaignId);
    } catch {
      // A missing listening panel must not take the profile form down with
      // it — the rest of this page is what a new workspace needs first.
      listening = undefined;
    }
  }

  return (
    <div className="pt-4">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">
          {adding ? 'Add a product' : 'Set up your profile'}
        </h1>
        <p className="text-ink-muted mt-1 text-sm">
          {adding
            ? 'Each product gets its own buyers, its own voice and its own campaign.'
            : profile?.configured
              ? `Editing “${profile.offering?.name}”. Reading a site again replaces this product’s profile.`
              : 'Outreach is only as good as what we know about you. This takes a minute.'}
        </p>
      </header>

      {/* Both suppressed items are this page: the unverified case has its own
          gate below, and "tell us what you sell" is the form itself. */}
      <PageGuide page="setup" suppress={['verify', 'profile']} />

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : !verified ? (
        // Reading a site costs a model call, and an unverified signup is an
        // unattributed one. The gate is enforced by the API; this explains it
        // rather than letting the button fail with a 403.
        <p className="border-border bg-surface-raised rounded-2xl border p-4 text-sm">
          Confirm your email address first — we check it before running anything that costs money.
          The link is in your inbox.
        </p>
      ) : (
        <>
          <ProductSwitcher
            products={products}
            adding={adding}
            {...(profile?.offeringId ? { activeOfferingId: profile.offeringId } : {})}
          />

          <ProfileSetup
            adding={adding}
            // A fresh product starts from an empty URL box rather than
            // inheriting the last one, which would re-read the same site.
            {...(!adding && profile?.url ? { initialUrl: profile.url } : {})}
            {...(!adding && profile?.offeringId ? { offeringId: profile.offeringId } : {})}
          />

          {listening && (
            <div className="mt-4">
              <ListeningForm initial={listening} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
