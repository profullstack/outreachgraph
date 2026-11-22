import { describe, expect, test } from 'bun:test';
import { checkoutHref, checkoutSearch, checkoutSignInHref } from './checkout-link';

describe('checkout links', () => {
  test('a buy button opens the checkout page with its pack selected', () => {
    expect(checkoutHref('pack_500', 'billing')).toBe('/checkout?option=pack_500&source=billing');
  });

  test('the page passes on only the keys it reads', () => {
    expect(
      checkoutSearch({
        option: 'pack_100',
        source: 'billing',
        error: 'owner_or_admin',
        email: 'someone@example.com',
        amount: '1',
        quantity: '9',
      }),
    ).toBe('?option=pack_100&source=billing&error=owner_or_admin');
    expect(checkoutSearch({})).toBe('');
    expect(checkoutSearch({ option: ['pack_500', 'pack_100'] })).toBe('?option=pack_500');
  });

  test('a signed-out visitor comes back to the same selection, on this site', () => {
    const href = checkoutSignInHref({ option: 'pack_2000', source: 'billing', error: 'x' });
    expect(href).toBe(
      `/login?next=${encodeURIComponent('/checkout?option=pack_2000&source=billing')}`,
    );
    expect(checkoutSignInHref({})).toBe('/login?next=%2Fcheckout');
  });
});
