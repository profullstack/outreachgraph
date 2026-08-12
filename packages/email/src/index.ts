/**
 * Transactional email.
 *
 * Only account mail goes through here — verification and password-adjacent
 * notices. Outreach never does: that is the approval queue's job, and routing
 * it through the same sender would make "we sent this on your behalf" and "we
 * sent you a receipt" indistinguishable in a provider's logs.
 */

export { ConsoleMailer, ResendMailer, type Mailer, type Message } from './mailer';
export { verificationEmail } from './templates';
