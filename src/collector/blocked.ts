/**
 * Bot-management challenge page detection (DESIGN.md 3.3 step 7).
 *
 * Pure function over the main document status, title, HTML and response
 * headers. Recognises Cloudflare (`cf-mitigated: challenge` header, "Just a
 * moment..." title, `_cf_chl_opt` / `challenge-running` /
 * `cf-browser-verification` markup), Akamai ("Access Denied" reference pages,
 * the `bm-verify` block page, the SEC-CPT crypto challenge served from
 * `/_sec/cp_challenge/`, typically with HTTP 428), DataDome
 * (captcha-delivery.com host) and PerimeterX / HUMAN (`px-captcha`, `_pxhc`
 * block pages), plus, without vendor markers, HTTP 403 / 428 / 429 / 503 on
 * the main document.
 *
 * Markers that also appear on ordinary pages are weak: the Cloudflare
 * JavaScript-detections loader under `/cdn-cgi/challenge-platform/`, the
 * Turnstile widget (`cf-chl-widget`, hence a bare `cf-chl`), a generic
 * `challenge-form` element, the PerimeterX sensor bootstrap (`_pxAppId`) and
 * the Akamai `sec-cpt` script name. They only count when the main document
 * status is a challenge status, so a 200 page carrying a sensor snippet is
 * not reported as blocked.
 *
 * Limitations: marker based; a vendor that changes its interstitial markup is
 * only caught by the status-code rule. A legitimately failing page (503 from
 * the origin) is reported as "unknown" blocked, which is the safe default for
 * an inventory that would otherwise be trusted.
 */
import type { BlockedInfo } from '../types.js';

export interface BlockedInput {
  /** HTTP status of the main document; 0 when no response was observed. */
  status: number;
  title: string;
  html: string;
  url?: string;
  /** Response headers of the main document, any name case. */
  headers?: Record<string, string>;
}

/** Statuses that vendors use for challenge and block pages (428 is Akamai SEC-CPT). */
export const BLOCKED_STATUSES: ReadonlySet<number> = new Set([403, 428, 429, 503]);

interface Context {
  input: BlockedInput;
  html: string;
  title: string;
  /** Lower-cased header names and values. */
  headers: Record<string, string>;
  challengeStatus: boolean;
}

interface Marker {
  vendor: string;
  /** Returns evidence when the page is a challenge page of this vendor. */
  test: (ctx: Context) => string | undefined;
}

function firstIncluded(html: string, needles: readonly string[]): string | undefined {
  return needles.find((needle) => html.includes(needle));
}

const CLOUDFLARE_STRONG = ['_cf_chl_opt', 'challenge-running', 'cf-browser-verification'];
const CLOUDFLARE_WEAK = ['/cdn-cgi/challenge-platform/', 'cf-chl', 'challenge-form'];
const AKAMAI_STRONG = ['/_sec/cp_challenge/', 'bm-verify'];
const AKAMAI_WEAK = ['sec-cpt', 'sec_cpt'];
const PERIMETERX_STRONG = ['px-captcha', '_pxhc'];
const PERIMETERX_WEAK = ['_pxappid'];

const MARKERS: Marker[] = [
  {
    vendor: 'cloudflare',
    test: ({ html, title, headers, challengeStatus }) => {
      if (headers['cf-mitigated'] === 'challenge') return "response header cf-mitigated: challenge";
      if (title.includes('just a moment')) return "title contains 'Just a moment...'";
      const strong = firstIncluded(html, CLOUDFLARE_STRONG);
      if (strong !== undefined) return `body contains Cloudflare challenge marker '${strong}'`;
      const weak = firstIncluded(html, CLOUDFLARE_WEAK);
      if (weak !== undefined && challengeStatus) return `body contains Cloudflare marker '${weak}'`;
      return undefined;
    },
  },
  {
    vendor: 'akamai',
    test: ({ html, title, challengeStatus }) => {
      const reference = /reference\s*(#|number|id)?\s*[:.]?\s*[0-9a-f]{2,}[.-]/i.test(html);
      if (title.includes('access denied') && (reference || html.includes('errors.edgesuite.net'))) {
        return "title 'Access Denied' with an Akamai reference id";
      }
      const strong = firstIncluded(html, AKAMAI_STRONG);
      if (strong !== undefined) return `body contains Akamai Bot Manager marker '${strong}'`;
      const weak = firstIncluded(html, AKAMAI_WEAK);
      if (weak !== undefined && challengeStatus) return `body contains Akamai marker '${weak}'`;
      return undefined;
    },
  },
  {
    vendor: 'datadome',
    test: ({ html }) => {
      if (html.includes('captcha-delivery.com')) return "body references the DataDome captcha host 'captcha-delivery.com'";
      if (html.includes('dd.js') && html.includes('datadome') && html.includes('captcha')) return 'body contains DataDome captcha markers';
      return undefined;
    },
  },
  {
    vendor: 'perimeterx',
    test: ({ html, challengeStatus }) => {
      const strong = firstIncluded(html, PERIMETERX_STRONG);
      if (strong !== undefined) return `body contains PerimeterX marker '${strong}'`;
      const weak = firstIncluded(html, PERIMETERX_WEAK);
      if (weak !== undefined && challengeStatus) return `body contains PerimeterX marker '${weak}'`;
      return undefined;
    },
  },
];

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] === undefined ? '' : decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value.trim().toLowerCase();
  return out;
}

export function detectBlocked(input: BlockedInput): BlockedInfo | undefined {
  const ctx: Context = {
    input,
    html: input.html.toLowerCase(),
    title: (input.title === '' ? extractTitle(input.html) : input.title).toLowerCase(),
    headers: lowerHeaders(input.headers),
    challengeStatus: BLOCKED_STATUSES.has(input.status),
  };
  for (const marker of MARKERS) {
    const evidence = marker.test(ctx);
    if (evidence !== undefined) {
      return { vendor: marker.vendor, evidence: ctx.challengeStatus ? `${evidence}; main document status ${input.status}` : evidence };
    }
  }
  if (ctx.challengeStatus) {
    return { vendor: 'unknown', evidence: `main document status ${input.status}` };
  }
  return undefined;
}
