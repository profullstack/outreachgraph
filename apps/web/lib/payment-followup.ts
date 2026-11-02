/**
 * The email a person sends to a customer who is behind on paying them.
 *
 * Mirrors coinpayportal `src/lib/payments/behind-email.ts` so the wording is
 * the same wherever the customer is chased from. A card the bank flagged
 * (stolen, lost, fraud) gets only "it was declined": naming the reason to the
 * person holding the card is what Stripe tells merchants not to do.
 *
 * Never sent by OutreachGraph. These are existing customers, not prospects, so
 * the draft goes to the person's own mail client and nothing touches the
 * outreach queue, its policy or its unsubscribe footer.
 */
import type { BehindAction, BehindCustomerView } from './api';

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export const owedText = (c: Pick<BehindCustomerView, 'owed'>): string =>
  c.owed.map((o) => formatMoney(o.amount, o.currency)).join(' + ');

export interface FollowUp {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly mailto: string;
}

export function draftFollowUp(c: BehindCustomerView): FollowUp | undefined {
  if (!c.email) return undefined;
  const from = c.business_name || 'us';
  const amount = owedText(c);
  const invoices = c.items
    .filter((i) => i.kind === 'invoice')
    .map((i) => i.title.replace(/^Invoice /, ''))
    .join(', ');
  const ask: Record<BehindAction, string> = {
    unreachable: `I'm resending invoice ${invoices} because the first email didn't reach you. The amount due is ${amount}.`,
    chase: `Invoice ${invoices} for ${amount} is now well past due. Can we talk about getting it settled this week?`,
    remind: `A quick reminder that invoice ${invoices} for ${amount} is overdue. The payment link is in the original email.`,
    retry: `Your payment of ${amount} didn't go through. It looks temporary on the bank's side. Could you try again in the next few days?`,
    new_card: `Your payment of ${amount} didn't go through because the card details are no longer valid. Could you pay with another card?`,
    unfinished: `It looks like your payment of ${amount} wasn't finished. Do you still want to go ahead?`,
    call_bank: `Your payment of ${amount} was declined by your bank without a reason. Could you check with them, or pay another way?`,
    do_not_chase: `Your payment of ${amount} was declined. If you'd still like to go ahead, could you pay another way?`,
  };
  const subject = invoices ? `Invoice ${invoices} from ${from}` : `Your payment to ${from}`;
  const first = c.name.split(/\s+/)[0] ?? c.name;
  const body = `Hi ${first},\n\n${ask[c.action]}\n\nThanks,\n${from}`;
  return {
    to: c.email,
    subject,
    body,
    mailto: `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  };
}
