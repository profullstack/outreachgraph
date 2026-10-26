import { gate } from './lib/crawl-gateway';
import { NextResponse, type NextRequest } from 'next/server';

/** The @profullstack/referrals cookie name, which @profullstack/affiliates reads. */
const REF_COOKIE = 'referral_code';

export async function proxy(request: NextRequest) {
  // Invite links stay outside the crawl gateway: a link preview of /i/<code>
  // must never be a 402.
  const invite = request.nextUrl.pathname.startsWith('/i/');

  // Crawl gateway first: AI training crawlers get 402 Payment Required (or the
  // sales page at /crawl) unless they present a paid pass. People, Googlebot
  // and retrieval crawlers fall through to everything below.
  if (!invite) {
    const answer = await gate(request);
    if (answer) return answer;
  }

  const response = NextResponse.next();

  // ?ref=<code>: first touch wins, so an existing cookie is never replaced.
  // The API records it against the account at signup.
  const ref = request.nextUrl.searchParams.get('ref');
  if (ref && /^[A-Za-z0-9]{4,32}$/.test(ref) && !request.cookies.get(REF_COOKIE)) {
    response.cookies.set(REF_COOKIE, ref.toUpperCase(), {
      path: '/',
      maxAge: 30 * 86_400,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
    });
  }
  return response;
}

export const config = {
  // Everything but Next's own assets and static files. API routes stay
  // covered on purpose: a training crawler hitting the API gets 402 too.
  // /install.sh is the CLI's curl installer and must reach anyone, so it is out.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|install\\.sh$|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff|woff2|ttf|otf|mp3|mp4|webmanifest)$).*)',
  ],
};
