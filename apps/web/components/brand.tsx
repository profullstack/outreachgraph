/**
 * The brand lockup, in the two forms the assets actually support.
 *
 * `logo.png` sets "Outreach" in white and "Graph" in blue, so the full wordmark
 * reads on the dark theme and half of it vanishes on the light one. That is why
 * `BrandLockup` swaps: dark surfaces get the wordmark, light surfaces get the
 * mark from `favicon.png` beside live text — which is also what shows if the
 * image never arrives.
 *
 * Plain `<img>`, not `next/image`: the runtime optimiser needs `sharp`, which
 * this workspace does not install, and the standalone build in docker/Dockerfile
 * would 500 on the first request for an optimised asset.
 *
 * The intrinsic sizes below are the real pixel dimensions of the two files. They
 * are here so the browser reserves the right box before the image loads.
 */

const WORDMARK = { src: '/logo.png', width: 1007, height: 256 } as const;
const MARK = { src: '/favicon.png', width: 512, height: 512 } as const;

/** The graph mark alone — the one asset that reads on any background. */
export function BrandMark({ className = 'h-7 w-7' }: { className?: string }) {
  return <img {...MARK} alt="" aria-hidden className={className} />;
}

/** The full wordmark. Dark surfaces only, for the reason above. */
export function BrandWordmark({ className = 'h-7 w-auto' }: { className?: string }) {
  return <img {...WORDMARK} alt="OutreachGraph" className={className} />;
}

/**
 * Safe anywhere the surface follows the colour scheme.
 *
 * Only one branch is ever rendered, so assistive technology sees a single
 * "OutreachGraph" rather than two.
 */
export function BrandLockup({
  className = '',
  height = 'h-7',
  text = 'text-[17px]',
}: {
  className?: string;
  height?: string;
  text?: string;
}) {
  return (
    <span className={`inline-flex items-center ${className}`}>
      <BrandWordmark className={`hidden w-auto dark:block ${height}`} />

      <span className="inline-flex items-center gap-2 dark:hidden">
        <BrandMark className={`aspect-square w-auto ${height}`} />
        <span className={`font-bold tracking-tight ${text}`}>OutreachGraph</span>
      </span>
    </span>
  );
}
