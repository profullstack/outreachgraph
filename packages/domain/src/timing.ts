/**
 * When a message goes out (Hunter's planner: send during business hours;
 * gone quiet, one bump at 7 days).
 *
 * The recipient's timezone is inferred, deterministically and cheaply, from
 * what we already hold: the person's location, then their company's, then the
 * country code of their mail domain. Nothing is looked up. Anything that does
 * not resolve falls back to US Eastern, where most of a B2B list sits and
 * where a 9-to-5 window still overlaps the working day of both coasts and
 * western Europe's afternoon.
 */

export const DEFAULT_TIMEZONE = 'America/New_York';
/** Local hours a cold message may leave, Monday to Friday: [start, end). */
export const BUSINESS_HOURS = { start: 8, end: 17 } as const;

/** Days of silence after our answer before the single follow-up. */
export const QUIET_BUMP_DAYS = 7;
/** Threads older than this are never bumped, so a deploy does not wake months-old ones. */
export const QUIET_BUMP_MAX_AGE_DAYS = 30;
/** Marks a reply card as the one bump. Stored as the card's guidance. */
export const QUIET_BUMP_GUIDANCE = 'follow_up_bump';

// Most specific first. Matched case-insensitively as whole words against a
// free-text location ("San Francisco Bay Area", "Berlin, Germany", "Remote - UK").
const PLACE_ZONES: ReadonlyArray<readonly [RegExp, string]> = [
  // United States: cities and states, by zone.
  [
    /\b(san francisco|bay area|los angeles|san diego|seattle|portland|san jose|oakland|palo alto|mountain view|sacramento|las vegas|california|washington state|oregon|nevada|pacific)\b/i,
    'America/Los_Angeles',
  ],
  [/\b(phoenix|arizona)\b/i, 'America/Phoenix'],
  [
    /\b(denver|boulder|salt lake|colorado|utah|idaho|montana|new mexico|wyoming|mountain time)\b/i,
    'America/Denver',
  ],
  [
    /\b(chicago|austin|dallas|houston|san antonio|minneapolis|st\.? louis|kansas city|milwaukee|nashville|new orleans|texas|illinois|minnesota|wisconsin|missouri|tennessee|iowa|oklahoma|alabama|louisiana|central time)\b/i,
    'America/Chicago',
  ],
  [
    /\b(new york|nyc|brooklyn|boston|washington|d\.?c\.?|philadelphia|atlanta|miami|toronto|montreal|ottawa|pittsburgh|baltimore|charlotte|raleigh|detroit|columbus|cleveland|orlando|tampa|new jersey|massachusetts|florida|georgia|virginia|ohio|michigan|pennsylvania|north carolina|ontario|quebec|eastern time)\b/i,
    'America/New_York',
  ],
  [/\b(vancouver|british columbia)\b/i, 'America/Vancouver'],
  [/\b(calgary|edmonton|alberta)\b/i, 'America/Edmonton'],
  [/\b(mexico city|mexico)\b/i, 'America/Mexico_City'],
  [/\b(sao paulo|são paulo|rio de janeiro|brazil|brasil)\b/i, 'America/Sao_Paulo'],
  [/\b(buenos aires|argentina)\b/i, 'America/Argentina/Buenos_Aires'],
  // Europe.
  [
    /\b(london|manchester|edinburgh|bristol|uk|united kingdom|england|scotland|wales|britain)\b/i,
    'Europe/London',
  ],
  [/\b(dublin|ireland)\b/i, 'Europe/Dublin'],
  [/\b(lisbon|porto|portugal)\b/i, 'Europe/Lisbon'],
  [/\b(berlin|munich|hamburg|frankfurt|cologne|germany|deutschland)\b/i, 'Europe/Berlin'],
  [/\b(paris|lyon|france)\b/i, 'Europe/Paris'],
  [/\b(amsterdam|rotterdam|netherlands|holland)\b/i, 'Europe/Amsterdam'],
  [/\b(madrid|barcelona|spain)\b/i, 'Europe/Madrid'],
  [/\b(rome|milan|italy)\b/i, 'Europe/Rome'],
  [/\b(zurich|geneva|switzerland)\b/i, 'Europe/Zurich'],
  [/\b(stockholm|sweden)\b/i, 'Europe/Stockholm'],
  [/\b(copenhagen|denmark)\b/i, 'Europe/Copenhagen'],
  [/\b(oslo|norway)\b/i, 'Europe/Oslo'],
  [/\b(helsinki|finland)\b/i, 'Europe/Helsinki'],
  [/\b(warsaw|krakow|poland)\b/i, 'Europe/Warsaw'],
  [/\b(prague|czech)\b/i, 'Europe/Prague'],
  [/\b(vienna|austria)\b/i, 'Europe/Vienna'],
  [/\b(brussels|belgium)\b/i, 'Europe/Brussels'],
  [/\b(kyiv|kiev|ukraine)\b/i, 'Europe/Kyiv'],
  [/\b(athens|greece)\b/i, 'Europe/Athens'],
  [/\b(istanbul|turkey|türkiye)\b/i, 'Europe/Istanbul'],
  // Middle East, Africa, Asia-Pacific.
  [/\b(tel aviv|israel)\b/i, 'Asia/Jerusalem'],
  [/\b(dubai|abu dhabi|uae|united arab emirates)\b/i, 'Asia/Dubai'],
  [/\b(lagos|nigeria)\b/i, 'Africa/Lagos'],
  [/\b(nairobi|kenya)\b/i, 'Africa/Nairobi'],
  [/\b(cape town|johannesburg|south africa)\b/i, 'Africa/Johannesburg'],
  [/\b(bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai|india)\b/i, 'Asia/Kolkata'],
  [/\b(singapore)\b/i, 'Asia/Singapore'],
  [/\b(hong kong)\b/i, 'Asia/Hong_Kong'],
  [/\b(tokyo|japan)\b/i, 'Asia/Tokyo'],
  [/\b(seoul|korea)\b/i, 'Asia/Seoul'],
  [/\b(shanghai|beijing|shenzhen|china)\b/i, 'Asia/Shanghai'],
  [/\b(manila|philippines)\b/i, 'Asia/Manila'],
  [/\b(jakarta|indonesia)\b/i, 'Asia/Jakarta'],
  [/\b(sydney|melbourne|australia)\b/i, 'Australia/Sydney'],
  [/\b(brisbane)\b/i, 'Australia/Brisbane'],
  [/\b(perth)\b/i, 'Australia/Perth'],
  [/\b(auckland|wellington|new zealand)\b/i, 'Pacific/Auckland'],
  // Broad US last, so "Austin, TX, United States" was already Central.
  [/\b(united states|usa|u\.s\.)\b/i, 'America/New_York'],
];

const TLD_ZONES: Readonly<Record<string, string>> = {
  uk: 'Europe/London',
  ie: 'Europe/Dublin',
  de: 'Europe/Berlin',
  fr: 'Europe/Paris',
  nl: 'Europe/Amsterdam',
  es: 'Europe/Madrid',
  it: 'Europe/Rome',
  pt: 'Europe/Lisbon',
  ch: 'Europe/Zurich',
  at: 'Europe/Vienna',
  be: 'Europe/Brussels',
  se: 'Europe/Stockholm',
  dk: 'Europe/Copenhagen',
  no: 'Europe/Oslo',
  fi: 'Europe/Helsinki',
  pl: 'Europe/Warsaw',
  cz: 'Europe/Prague',
  gr: 'Europe/Athens',
  tr: 'Europe/Istanbul',
  ua: 'Europe/Kyiv',
  il: 'Asia/Jerusalem',
  ae: 'Asia/Dubai',
  in: 'Asia/Kolkata',
  sg: 'Asia/Singapore',
  hk: 'Asia/Hong_Kong',
  jp: 'Asia/Tokyo',
  kr: 'Asia/Seoul',
  cn: 'Asia/Shanghai',
  au: 'Australia/Sydney',
  nz: 'Pacific/Auckland',
  za: 'Africa/Johannesburg',
  ng: 'Africa/Lagos',
  ke: 'Africa/Nairobi',
  br: 'America/Sao_Paulo',
  mx: 'America/Mexico_City',
  ar: 'America/Argentina/Buenos_Aires',
  ca: 'America/Toronto',
};

// US state codes only as a ", XX" suffix ("Irvine, CA"), and only after every
// place name has had its chance: "or" and "co" are words, and "Toronto, ON, CA"
// is Canada.
const STATE_ZONES: Readonly<Record<string, string>> = {
  ca: 'America/Los_Angeles',
  wa: 'America/Los_Angeles',
  or: 'America/Los_Angeles',
  nv: 'America/Los_Angeles',
  az: 'America/Phoenix',
  co: 'America/Denver',
  ut: 'America/Denver',
  id: 'America/Denver',
  mt: 'America/Denver',
  nm: 'America/Denver',
  tx: 'America/Chicago',
  il: 'America/Chicago',
  mn: 'America/Chicago',
  wi: 'America/Chicago',
  mo: 'America/Chicago',
  tn: 'America/Chicago',
  ia: 'America/Chicago',
  ok: 'America/Chicago',
  al: 'America/Chicago',
  la: 'America/Chicago',
  ny: 'America/New_York',
  nj: 'America/New_York',
  ma: 'America/New_York',
  fl: 'America/New_York',
  ga: 'America/New_York',
  va: 'America/New_York',
  nc: 'America/New_York',
  pa: 'America/New_York',
  oh: 'America/New_York',
  mi: 'America/New_York',
  md: 'America/New_York',
  ct: 'America/New_York',
  dc: 'America/New_York',
};

function zoneFromPlace(text: string | null | undefined): string | undefined {
  const place = (text ?? '').trim();
  if (!place) return undefined;
  for (const [pattern, zone] of PLACE_ZONES) {
    if (pattern.test(place)) return zone;
  }
  const state = /,\s*([A-Z]{2})(?:\s*,\s*(?:US|USA|United States))?\s*$/.exec(place)?.[1];
  return state ? STATE_ZONES[state.toLowerCase()] : undefined;
}

function zoneFromAddress(address: string | null | undefined): string | undefined {
  const domain = (address ?? '').split('@')[1]?.toLowerCase();
  if (!domain) return undefined;
  const tld = domain.split('.').pop();
  return tld ? TLD_ZONES[tld] : undefined;
}

/** The recipient's best-guess IANA timezone, and what it was inferred from. */
export function recipientTimezone(input: {
  readonly personLocation?: string | null;
  readonly companyLocation?: string | null;
  readonly address?: string | null;
}): { readonly zone: string; readonly source: 'person' | 'company' | 'domain' | 'default' } {
  const person = zoneFromPlace(input.personLocation);
  if (person) return { zone: person, source: 'person' };
  const company = zoneFromPlace(input.companyLocation);
  if (company) return { zone: company, source: 'company' };
  const domain = zoneFromAddress(input.address);
  if (domain) return { zone: domain, source: 'domain' };
  return { zone: DEFAULT_TIMEZONE, source: 'default' };
}

interface LocalTime {
  readonly weekday: number; // 0 = Sunday
  readonly hour: number;
  readonly minute: number;
}

function localTime(at: Date, zone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return localTime(at, DEFAULT_TIMEZONE);
  }
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** True when `at` falls inside Monday-Friday business hours in `zone`. */
export function inBusinessHours(at: Date, zone: string): boolean {
  const local = localTime(at, zone);
  if (local.weekday === 0 || local.weekday === 6) return false;
  return local.hour >= BUSINESS_HOURS.start && local.hour < BUSINESS_HOURS.end;
}

/**
 * The next moment business hours open in `zone`, at or after `at`, to the
 * minute. Walks forward in 15-minute steps (at most a long weekend), which is
 * exact at the top of the hour and needs no timezone arithmetic of its own.
 */
export function nextBusinessOpening(at: Date, zone: string): Date {
  if (inBusinessHours(at, zone)) return at;
  const step = 15 * 60_000;
  let probe = new Date(Math.ceil(at.getTime() / step) * step);
  for (let i = 0; i < 4 * 24 * 4; i += 1) {
    if (inBusinessHours(probe, zone)) return probe;
    probe = new Date(probe.getTime() + step);
  }
  return probe;
}
