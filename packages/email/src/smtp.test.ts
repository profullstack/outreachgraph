import { describe, expect, test } from 'bun:test';
import { MailerError } from './mailer';
import { SmtpMailer, SMTP_PRESETS, withPostalAddress } from './smtp';

const CREDENTIALS = {
  host: 'smtp.forwardemail.net',
  port: 465,
  secure: true,
  username: 'knox@profullstack.com',
  password: 'app-password',
  fromEmail: 'knox@profullstack.com',
  fromName: 'Knox',
} as const;

/** A nodemailer stand-in that records instead of connecting. */
function fakeNodemailer(verify?: () => Promise<unknown>) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    createTransport: () => ({
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return { messageId: '<abc@profullstack.com>' };
      },
      verify: verify ?? (async () => true),
      close: () => {},
    }),
  };
}

async function refusal(promise: Promise<unknown>): Promise<MailerError> {
  const thrown = await promise.then(() => undefined).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(MailerError);
  return thrown as MailerError;
}

describe('SmtpMailer', () => {
  test('refuses a mailbox that is not one of the outreach mailboxes, before any network I/O', async () => {
    const fake = fakeNodemailer();
    const mailer = new SmtpMailer(
      { ...CREDENTIALS, username: 'user@company.com', fromEmail: 'user@company.com' },
      { createTransport: fake.createTransport, queue: null },
    );
    const error = await refusal(mailer.verify());
    expect(error.code).toBe('SENDER_UNAUTHORIZED');
    expect((await refusal(mailer.send({ to: 'a@b.com', subject: 's', text: 't' }))).code).toBe(
      'SENDER_UNAUTHORIZED',
    );
    expect(fake.sent).toHaveLength(0);
  });

  test('refuses a From that is not the authenticated mailbox', async () => {
    const mailer = new SmtpMailer(
      { ...CREDENTIALS, fromEmail: 'cha0spunk@profullstack.com' },
      { createTransport: fakeNodemailer().createTransport, queue: null },
    );
    expect((await refusal(mailer.verify())).code).toBe('SENDER_UNAUTHORIZED');
  });

  test('never sends directly: no queue means every send is refused (fail closed)', async () => {
    const fake = fakeNodemailer();
    const mailer = new SmtpMailer(CREDENTIALS, {
      createTransport: fake.createTransport,
      queue: null,
    });
    const error = await refusal(
      mailer.send({
        to: 'jane@acme.com',
        subject: 'Hi',
        text: 'Hello',
        idempotencyKey: 'outreach:ws:p:r',
        tenantId: 'ws',
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID');
    expect(fake.sent).toHaveLength(0);
  });

  test('verify surfaces a login failure with the server text', async () => {
    const mailer = new SmtpMailer(CREDENTIALS, {
      queue: null,
      createTransport: fakeNodemailer(async () => {
        throw Object.assign(new Error('535 Username and Password not accepted'), {
          responseCode: 535,
          code: 'EAUTH',
        });
      }).createTransport,
    });
    const error = await refusal(mailer.verify());
    expect(error.status).toBe(535);
    expect(error.message).toContain('Username and Password not accepted');
  });

  test('verify passes for a good credential', async () => {
    const mailer = new SmtpMailer(CREDENTIALS, {
      queue: null,
      createTransport: fakeNodemailer().createTransport,
    });
    await expect(mailer.verify()).resolves.toBeUndefined();
  });
});

describe('withPostalAddress', () => {
  const ADDRESS = 'Profullstack, Inc., 123 Main St, San Jose, CA 95113';

  test('appends the address to text and html when a template left it out', () => {
    const out = withPostalAddress(
      { text: 'Hi', html: '<html><body><p>Hi</p></body></html>' },
      ADDRESS,
    );
    expect(out.text.endsWith(ADDRESS)).toBe(true);
    expect(out.html).toContain('123 Main St');
    expect(out.html!.indexOf('123 Main St')).toBeLessThan(out.html!.indexOf('</body>'));
  });

  test('leaves bodies that already carry it alone', () => {
    const text = `Hi\n\n${ADDRESS}`;
    expect(withPostalAddress({ text }, ADDRESS)).toEqual({ text });
  });
});

describe('SMTP_PRESETS', () => {
  test('every preset but the custom one names a host', () => {
    for (const preset of SMTP_PRESETS) {
      if (preset.id === 'custom') continue;
      expect(preset.host).toMatch(/\./);
      expect(preset.port).toBeGreaterThan(0);
    }
  });

  test('the ports and TLS modes agree with each other', () => {
    // 465 is implicit TLS; 587 begins in the clear and upgrades. Getting this
    // pair wrong is a connection that hangs rather than an error that explains
    // itself.
    for (const preset of SMTP_PRESETS) {
      if (preset.port === 465) expect(preset.secure).toBe(true);
      if (preset.port === 587) expect(preset.secure).toBe(false);
    }
  });

  test('tells the user what Gmail and Microsoft actually require', () => {
    // Both refuse a plain account password. Saying so at the point of
    // connection is the difference between a working mailbox and a support
    // ticket.
    expect(SMTP_PRESETS.find((p) => p.id === 'gmail')?.note).toContain('app password');
    expect(SMTP_PRESETS.find((p) => p.id === 'microsoft')?.note).toContain('SMTP AUTH');
  });
});
