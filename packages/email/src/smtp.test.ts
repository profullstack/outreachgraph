import { describe, expect, test } from 'bun:test';
import type { Transporter } from 'nodemailer';
import { MailerError } from './mailer';
import { formatFrom, SmtpMailer, SMTP_PRESETS } from './smtp';

const CREDENTIALS = {
  host: 'smtp.company.com',
  port: 465,
  secure: true,
  username: 'user@company.com',
  password: 'app-password',
  fromEmail: 'user@company.com',
  fromName: 'Jane Smith',
} as const;

/** A transport that records instead of connecting. */
function fakeTransport(behaviour: {
  sendMail?: (options: Record<string, unknown>) => Promise<unknown>;
  verify?: () => Promise<boolean>;
}): { transport: Transporter; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];

  const transport = {
    sendMail: async (options: Record<string, unknown>) => {
      sent.push(options);
      return behaviour.sendMail ? behaviour.sendMail(options) : { messageId: '<abc@company.com>' };
    },
    verify: behaviour.verify ?? (async () => true),
    close: () => {},
  } as unknown as Transporter;

  return { transport, sent };
}

describe('formatFrom', () => {
  test('uses the bare address when there is no display name', () => {
    expect(formatFrom('user@company.com')).toBe('user@company.com');
    expect(formatFrom('user@company.com', '   ')).toBe('user@company.com');
  });

  test('quotes the display name', () => {
    expect(formatFrom('user@company.com', 'Jane Smith')).toBe('"Jane Smith" <user@company.com>');
  });

  test('strips characters that would end the header early', () => {
    // A display name is customer input. Left alone, a quote or a newline in it
    // terminates the field and lets the rest be read as more headers — a
    // header injection with a friendly face.
    //
    // `<` and `>` inside a quoted string are ordinary characters, so the fix
    // is to make sure the string cannot be closed early: strip the quotes and
    // the address that is actually used stays ours.
    const from = formatFrom('user@company.com', 'Jane" <evil@attacker.com>, "X');
    expect(from).toBe('"Jane <evil@attacker.com>, X" <user@company.com>');
    expect(from.endsWith('<user@company.com>')).toBe(true);
    // Exactly the two quotes this function added, and no more.
    expect(from.split('"')).toHaveLength(3);

    expect(formatFrom('user@company.com', 'Jane\r\nBcc: evil@attacker.com')).toBe(
      '"JaneBcc: evil@attacker.com" <user@company.com>',
    );
  });
});

describe('SmtpMailer', () => {
  test('sends from the configured mailbox, with the reply-to it was given', async () => {
    const { transport, sent } = fakeTransport({});
    const mailer = new SmtpMailer(CREDENTIALS, transport);

    const result = await mailer.send({
      to: 'jane@acme.com',
      subject: 'Quick question',
      text: 'Hello',
      replyTo: 'inbox@company.com',
    });

    expect(sent[0]?.from).toBe('"Jane Smith" <user@company.com>');
    expect(sent[0]?.to).toBe('jane@acme.com');
    expect(sent[0]?.replyTo).toBe('inbox@company.com');
    expect(result.id).toBe('<abc@company.com>');
  });

  test('omits reply-to entirely when there is none', async () => {
    const { transport, sent } = fakeTransport({});
    await new SmtpMailer(CREDENTIALS, transport).send({
      to: 'jane@acme.com',
      subject: 'Hi',
      text: 'Hello',
    });

    expect(sent[0]).not.toHaveProperty('replyTo');
  });

  test("keeps the server's rejection text, which is the actionable part", async () => {
    const failure = Object.assign(new Error('535 Username and Password not accepted'), {
      responseCode: 535,
    });

    const { transport } = fakeTransport({
      sendMail: async () => {
        throw failure;
      },
    });

    const thrown = await new SmtpMailer(CREDENTIALS, transport)
      .send({ to: 'jane@acme.com', subject: 'Hi', text: 'Hello' })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(MailerError);
    const error = thrown as MailerError;
    expect(error.status).toBe(535);
    expect(error.message).toContain('535 Username and Password not accepted');
  });

  test('verify surfaces a login failure rather than reporting success', async () => {
    const { transport } = fakeTransport({
      verify: async () => {
        throw new Error('535 Authentication failed');
      },
    });

    await expect(new SmtpMailer(CREDENTIALS, transport).verify()).rejects.toThrow(MailerError);
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
