/**
 * Links to the checkout page, and the part of its own query it passes on.
 *
 * The link is only a hint: it preselects a pack. Who pays and what a pack
 * costs are decided by the API from the session and the pack table.
 */

export const CHECKOUT_PATH = '/checkout';

/** What the page reads from its link. `error` is a code set by a failed post. */
const PASSED_ON = ['option', 'plan', 'source', 'error'] as const;

type Query = Record<string, string | string[] | undefined>;

/** A buy button's destination: the checkout page with that pack selected. */
export function checkoutHref(packId: string, source: string): string {
  const qs = new URLSearchParams({ option: packId, source });
  return `${CHECKOUT_PATH}?${qs.toString()}`;
}

/** The page's query, narrowed to the keys it uses, as `?a=b` or ''. */
export function checkoutSearch(query: Query): string {
  const qs = new URLSearchParams();
  for (const key of PASSED_ON) {
    const value = query[key];
    const one = Array.isArray(value) ? value[0] : value;
    if (one) qs.set(key, one.slice(0, 64));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/** Where a signed-out visitor goes: sign in, then back here with the selection. */
export function checkoutSignInHref(query: Query): string {
  const { error: _dropped, ...rest } = query;
  return `/login?next=${encodeURIComponent(`${CHECKOUT_PATH}${checkoutSearch(rest)}`)}`;
}
