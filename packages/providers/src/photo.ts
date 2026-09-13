/** Only ordinary remote image URLs; never inline content or embedded credentials. */
export function publicPhotoUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('#')) return undefined;
  try {
    const url = new URL(value.trim(), base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !host.includes('.') ||
      /\.(localhost|local|internal)$/.test(host) ||
      /^(0|10|127)\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^\[/.test(host)
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
