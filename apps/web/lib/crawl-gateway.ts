import { createGateway } from '@profullstack/x402-gateway';
import { x402Proxy } from '@profullstack/x402-gateway/next';

/**
 * Sells crawl access to AI training crawlers (GPTBot, ClaudeBot, CCBot,
 * meta-externalagent, Bytespider, Applebot-Extended, ...) by the day over
 * x402, settled by CoinPay in USDC. People, Googlebot and the retrieval
 * crawlers behind AI search pass through untouched.
 *
 * Runs inside the middleware, so nothing here may import Node-only modules.
 * The env is read through a non-literal key on purpose: Next inlines
 * `process.env.NAME` at build time, and these are runtime secrets. Without
 * COINPAY_X402_KEY and CRAWL_PAY_TO the gateway still answers training
 * crawlers with 402, just with an empty offer.
 */
const env = (name: string) => process.env[name];

/**
 * Names this site on the gateway's CoinPay calls (x402 verify/settle, checkout
 * sessions). Every app shares one host, so the runtime default UA made them one
 * caller in CoinPay's logs and throttle. 0.13 has no `userAgent` option; it
 * takes a `fetch`.
 */
const COINPAY_UA = env('COINPAY_USER_AGENT') || 'outreachgraph.com (+https://outreachgraph.com)';
const fetchWithUserAgent = ((input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('user-agent', COINPAY_UA);
  return fetch(input, { ...init, headers });
}) as typeof fetch;

export const gateway = createGateway({
  siteUrl: env('SITE_URL') || env('NEXT_PUBLIC_SITE_URL') || 'https://outreachgraph.com',
  siteName: 'OutreachGraph',
  coinpay: { apiKey: env('COINPAY_X402_KEY') },
  payTo: env('CRAWL_PAY_TO'),
  contact: 'mailto:support@outreachgraph.com',
  fetch: fetchWithUserAgent,
});

/** Resolves to a Response for a refused crawler, or undefined to carry on. */
export const gate = x402Proxy(gateway);
