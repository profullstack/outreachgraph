/**
 * Transactional email.
 *
 * Three kinds of mail now leave the product, and they are kept distinct on
 * purpose:
 *
 *   - **Account mail** — verification and password-adjacent notices.
 *   - **Notifications** — lead alerts and the daily digest, sent to the
 *     customer about their own workspace.
 *   - **Outreach** — the drafted message, sent to a prospect on the customer's
 *     behalf when a campaign is on autopilot.
 *
 * The third used to be impossible: outreach ended at an approval card and a
 * human copied it elsewhere. It goes through this boundary now, but it is the
 * only one that carries a `replyTo` pointing at the customer, and the only one
 * the policy engine gates — so "we sent this on your behalf" and "we sent you
 * a receipt" stay distinguishable in a provider's logs and in the audit trail.
 */

export {
  ConsoleMailer,
  MailerError,
  ResendMailer,
  type Mailer,
  type Message,
  type SendResult,
} from './mailer';
export { verificationEmail } from './templates';
export {
  dailyDigestEmail,
  leadAlertEmail,
  type DailyDigest,
  type DigestLead,
  type LeadAlert,
} from './notifications';
