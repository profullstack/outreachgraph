/**
 * Just enough MIME to read what somebody wrote.
 *
 * The reader used to fetch the envelope and a handful of headers, which was
 * enough to notice *that* someone replied and nothing about *what* they said.
 * A label ("interested", "take me off your list") and a drafted answer both
 * need the words, so the reader now fetches the raw message and this turns it
 * into the plain text a person typed.
 *
 * Deliberately small rather than a full parser: the only question asked of a
 * message is "what is its readable text", and a dependency that answers every
 * other question MIME can pose is weight this path does not need. It prefers
 * `text/plain`, falls back to de-tagged `text/html`, decodes the two transfer
 * encodings mail actually uses, and gives up quietly — an unreadable body is a
 * reply with no text, not a failed poll.
 */

interface Part {
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Longest text kept per message. A reply is sentences; a forwarded thread is not our business. */
const MAX_TEXT = 20_000;

export function plainTextFromSource(source: string): string {
  const root = splitPart(source);
  const text = findText(root, 0);
  return text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT);
}

/**
 * The address a delivery failure is about.
 *
 * A bounce comes from `mailer-daemon@`, which matches nobody we wrote to, so
 * the only way to put it on the right thread is the recipient the report
 * names. `Final-Recipient` is the RFC 3464 field; `X-Failed-Recipients` is
 * what Exim and Gmail add.
 */
export function failedRecipientFromSource(source: string): string | undefined {
  const match =
    source.match(/^final-recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/im) ??
    source.match(/^original-recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/im) ??
    source.match(/^x-failed-recipients:\s*<?([^\s>,]+@[^\s>,]+)>?/im);
  return match?.[1]?.trim().toLowerCase();
}

function splitPart(raw: string): Part {
  const normalised = raw.replace(/\r\n/g, '\n');
  const index = normalised.indexOf('\n\n');
  const head = index === -1 ? normalised : normalised.slice(0, index);
  const body = index === -1 ? '' : normalised.slice(index + 2);

  const headers: Record<string, string> = {};
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  return { headers, body };
}

function findText(part: Part, depth: number): string {
  // A pathological nesting is someone else's bug; ten levels is plenty.
  if (depth > 10) return '';

  const contentType = (part.headers['content-type'] ?? 'text/plain').toLowerCase();

  if (contentType.startsWith('multipart/')) {
    const boundary = param(part.headers['content-type'] ?? '', 'boundary');
    if (!boundary) return '';

    const children = part.body
      .split(`--${boundary}`)
      .slice(1)
      .filter((chunk) => !chunk.startsWith('--'))
      .map((chunk) => splitPart(chunk.replace(/^\n/, '')));

    // Plain text anywhere beats HTML anywhere: `multipart/alternative` puts
    // the plain part first, but a `multipart/mixed` wrapper may not.
    for (const child of children) {
      const type = (child.headers['content-type'] ?? 'text/plain').toLowerCase();
      if (type.startsWith('text/plain') || type.startsWith('multipart/')) {
        const text = findText(child, depth + 1);
        if (text.trim()) return text;
      }
    }
    for (const child of children) {
      const text = findText(child, depth + 1);
      if (text.trim()) return text;
    }
    return '';
  }

  if (contentType.startsWith('text/plain') || contentType.startsWith('message/delivery-status')) {
    return decode(part);
  }
  if (contentType.startsWith('text/html')) {
    return htmlToText(decode(part));
  }

  return '';
}

function decode(part: Part): string {
  const encoding = (part.headers['content-transfer-encoding'] ?? '').toLowerCase();
  const charset = param(part.headers['content-type'] ?? '', 'charset') ?? 'utf-8';

  let bytes: Uint8Array;
  if (encoding === 'base64') {
    try {
      bytes = Uint8Array.from(Buffer.from(part.body.replace(/\s+/g, ''), 'base64'));
    } catch {
      return '';
    }
  } else if (encoding === 'quoted-printable') {
    bytes = quotedPrintable(part.body);
  } else {
    return part.body;
  }

  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function quotedPrintable(input: string): Uint8Array {
  const unfolded = input.replace(/=\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < unfolded.length; i += 1) {
    const ch = unfolded[i]!;
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const byte of new TextEncoder().encode(ch)) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

function htmlToText(html: string): string {
  return (
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      // Quoted history, the HTML way. Everything we need is above it.
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
  );
}

function param(header: string, name: string): string | undefined {
  const match = header.match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i'));
  return match?.[1]?.trim();
}
