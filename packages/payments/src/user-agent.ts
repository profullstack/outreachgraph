/**
 * The User-Agent outreachgraph.com sends on its server-side CoinPay calls.
 * Every Profullstack app shares one host, so the runtime default (`Bun/1.4.4`)
 * made them one caller in CoinPay's logs and throttle. `COINPAY_USER_AGENT`
 * replaces it whole.
 */
const env = (name: string): string => {
  const value = typeof process === 'undefined' ? undefined : process.env[name];
  return typeof value === 'string' ? value.trim() : '';
};

const version = env('npm_package_version');

export const COINPAY_UA =
  env('COINPAY_USER_AGENT') ||
  `outreachgraph.com${version ? `/${version}` : ''} (+https://outreachgraph.com)`;
