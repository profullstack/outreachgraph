/**
 * A face, or the initials standing in for one.
 *
 * The picture is a URL the person published — Gravatar, their LinkedIn
 * profile, their company's team page — and it is hot-linked rather than
 * copied, so it can vanish. When it does, or when there never was one, the
 * initials take the same space, so a list of people does not jump around
 * depending on who has a photograph.
 */

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-lg',
} as const;

export function Avatar({
  name,
  src,
  size = 'md',
  className = '',
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const box = `${SIZES[size]} shrink-0 rounded-full ${className}`;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote hosts are not known ahead of time
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`${box} bg-surface object-cover`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`${box} bg-surface text-ink-muted border-border flex items-center justify-center border font-semibold`}
    >
      {initials(name)}
    </span>
  );
}

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => /[\p{L}\p{N}]/u.test(part));
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase() || '?';
}
