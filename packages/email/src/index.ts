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
  mailerErrorCode,
  ResendMailer,
  type Mailer,
  type Message,
  type SendResult,
} from './mailer';
export {
  SmtpMailer,
  SMTP_PRESETS,
  withPostalAddress,
  type SmtpCredentials,
  type SmtpMailerOptions,
  type SmtpPreset,
} from './smtp';
export {
  configureOutreachEmailQueue,
  DEFAULT_RECIPIENT_DOMAIN_CAP,
  EMAIL_QUEUE_APPLICATION_ID,
  OUTREACH_MAILBOXES,
  OutreachEmailQueue,
  outreachEmailQueue,
  outreachTransport,
  queueFailure,
  startOutreachEmailQueue,
  type OutreachEmailQueueConfig,
  type QueueMailbox,
} from './queue';
export { listUnsubscribeHeaders } from '@profullstack/email-queue';
export {
  classifyAutomated,
  ImapReader,
  parseHeaders,
  type ImapCredentials,
  type IncomingMessage,
  type MailReader,
} from './imap';
export {
  ImapWarmupSweeper,
  WARMUP_FOLDER,
  type SweptWarmup,
  type WarmupSweeper,
} from './warmup-inbox';
export { failedRecipientFromSource, plainTextFromSource } from './mime';
export { invitationEmail, passwordResetEmail, verificationEmail } from './templates';
export {
  communityLeadDigestEmail,
  intentLabel,
  type CommunityLeadDigest,
  type CommunityLeadDigestItem,
} from './lead-digest';
export {
  dailyDigestEmail,
  leadAlertEmail,
  type DailyDigest,
  type DigestLead,
  type LeadAlert,
} from './notifications';
