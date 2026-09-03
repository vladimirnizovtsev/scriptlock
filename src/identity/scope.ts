/**
 * Frame scope classification (DESIGN.md section 5) and first-party test.
 *
 * Owns: the built-in TPSP and 3DS host glob lists, `classifyFrame`,
 * `hostMatches` and `isFirstParty`. Host globs are matched with picomatch
 * against the frame's host name (no port), case-insensitively and anchored: a
 * bare glob such as `localhost` matches exactly that host and nothing else;
 * `*.stripe.com` matches any subdomain of stripe.com but not `stripe.com`
 * itself. The ACS 3DS built-ins are label-anchored (`acs.*`, `*.acs.*`), so an
 * ACS challenge host matches but a host that merely contains the letters
 * `acs` (for example `macs.example.net`) is not treated as a 3DS frame.
 *
 * Limitations: frames with an empty, `about:` or otherwise unparseable URL
 * inherit their creator's origin in the browser; this module cannot see the
 * creator and classifies them as `merchant`. A broad substring glob configured
 * by the user (for example `*acs*`) is still matched against the whole host.
 */
import picomatch from 'picomatch';
import type { Scope, ScopeConfig } from '../types.js';

/** Built-in payment provider (TPSP) host globs. */
export const BUILTIN_TPSP_HOSTS: readonly string[] = [
  'js.stripe.com',
  '*.stripe.com',
  'checkoutshopper-live.adyen.com',
  '*.adyen.com',
  '*.paypal.com',
  '*.paypalobjects.com',
  '*.braintreegateway.com',
  '*.braintree-api.com',
  '*.checkout.com',
  '*.klarna.com',
  '*.klarnaservices.com',
  '*.mollie.com',
  '*.squareup.com',
  '*.squarecdn.com',
  'pay.google.com',
  '*.apple.com',
  '*.authorize.net',
  '*.worldpay.com',
  '*.payments.worldpay.com',
  '*.nuvei.com',
  '*.2checkout.com',
  '*.paddle.com',
  '*.recurly.com',
  '*.chargebee.com',
  '*.gocardless.com',
];

/** Built-in 3-D Secure / ACS host globs. */
export const BUILTIN_THREEDS_HOSTS: readonly string[] = [
  '*.cardinalcommerce.com',
  '*.arcot.com',
  '*3dsecure*',
  'acs.*',
  '*.acs.*',
  '*.3ds.*',
  '*.modirum.com',
  '*.netcetera.com',
  '*.gpayments.com',
];

const matcherCache = new Map<string, (host: string) => boolean>();

function matcher(glob: string): (host: string) => boolean {
  let fn = matcherCache.get(glob);
  if (!fn) {
    fn = picomatch(glob, { nocase: true, dot: true });
    matcherCache.set(glob, fn);
  }
  return fn;
}

/** True when `host` matches any of the globs (anchored, case-insensitive). */
export function hostMatches(host: string, globs: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return globs.some((glob) => glob !== '' && matcher(glob)(lower));
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isBlankFrameUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || /^about:/i.test(trimmed);
}

export interface FrameToClassify {
  url: string;
  isMain: boolean;
  /** Origin (or any URL) of the main frame. */
  mainOrigin: string;
}

/** Classify a frame into a scope; scripts inside inherit it. */
export function classifyFrame(frame: FrameToClassify, cfg: ScopeConfig): Scope {
  if (frame.isMain) return 'merchant';
  if (isBlankFrameUrl(frame.url)) return 'merchant';
  const url = parseUrl(frame.url);
  if (!url) return 'merchant';
  const main = parseUrl(frame.mainOrigin);
  if (main && url.origin === main.origin && url.origin !== 'null') return 'merchant';

  const host = url.hostname;
  if (hostMatches(host, [...BUILTIN_TPSP_HOSTS, ...cfg.tpsp])) return 'tpsp';
  if (hostMatches(host, [...BUILTIN_THREEDS_HOSTS, ...cfg.threeds])) return 'threeds';
  return 'embedded';
}

/**
 * True when the URL's host equals the main frame's host or is a subdomain of
 * it. Used by the manifest module to pick integrity defaults.
 */
export function isFirstParty(url: string, mainOrigin: string): boolean {
  const target = parseUrl(url);
  const main = parseUrl(mainOrigin);
  if (!target || !main) return false;
  const host = target.hostname.toLowerCase();
  const mainHost = main.hostname.toLowerCase();
  if (host === '' || mainHost === '') return false;
  return host === mainHost || host.endsWith(`.${mainHost}`);
}
