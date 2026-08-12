import type { Message } from './mailer';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The verification email.
 *
 * Plain text carries the full link rather than hiding it behind an anchor,
 * because a verification mail that looks like a phishing test is one people
 * refuse to click — and because text-only clients must be able to finish
 * signup too.
 */
export function verificationEmail(to: string, link: string): Message {
  const text = [
    'Confirm your email to finish setting up OutreachGraph.',
    '',
    link,
    '',
    'The link expires in 24 hours. If you did not create this account you can',
    'ignore this message — nothing was sent on your behalf and no outreach can',
    'happen until an address is confirmed.',
  ].join('\n');

  const safe = escapeHtml(link);

  const html = [
    '<p>Confirm your email to finish setting up OutreachGraph.</p>',
    `<p><a href="${safe}">${safe}</a></p>`,
    '<p>The link expires in 24 hours. If you did not create this account you can ',
    'ignore this message — nothing was sent on your behalf and no outreach can ',
    'happen until an address is confirmed.</p>',
  ].join('');

  return { to, subject: 'Confirm your email · OutreachGraph', text, html };
}
