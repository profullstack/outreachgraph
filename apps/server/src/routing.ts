/**
 * Which requests the API answers and which go to the Next child.
 *
 * The public mail paths live at the root rather than under `/api/`, because
 * they are printed into messages and a short link is part of reading as though
 * a person typed it: `/t/` is a tracked link, `/u/` an unsubscribe, `/o/` an
 * open pixel. The front server used to forward only `/api/` and `/health`, so
 * all three fell through to Next and answered 404 in production — every
 * tracked link was dead, and so was the opt-out line in every message sent.
 * Tests of the Hono app never noticed, because they call it directly.
 */

const API_PREFIXES = ['/api/', '/health'] as const;

/** Root-level paths the Hono app serves. Each must also be absent from `apps/web/app`. */
export const PUBLIC_MAIL_PREFIXES = ['/t/', '/u/', '/o/'] as const;

export function routesToApi(pathname: string): boolean {
  return (
    API_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    PUBLIC_MAIL_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}
