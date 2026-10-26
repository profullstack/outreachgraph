'use client';

import { useEffect } from 'react';

/**
 * Remembers an /i/<code> invite for 30 days, so it still counts if the person
 * wanders off and signs up later from the home page. The API reads it at signup.
 */
export function InviteCookie({ code }: { code: string }) {
  useEffect(() => {
    if (!code) return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `og_invite=${encodeURIComponent(code)}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${secure}`;
  }, [code]);
  return null;
}
