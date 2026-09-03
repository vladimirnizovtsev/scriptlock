/**
 * URL normaliser (DESIGN.md section 4.1).
 *
 * Owns: turning an observed script URL into its stable identity string:
 * lower-case scheme and host, default ports and fragment dropped, credentials
 * dropped, blob: and data: URLs reduced to origin / payload hash, hash-like
 * path tokens collapsed to `[hash]`, cache-buster query parameters removed and
 * the remaining parameters sorted by name with their original encoding kept.
 *
 * Limitations: input that the WHATWG URL parser rejects is returned trimmed
 * but otherwise unchanged. Query parameter names are compared case
 * sensitively after percent-decoding. The 16+ character alphanumeric hash rule
 * additionally requires at least one digit so that long English words in
 * paths are not collapsed (see the deviation note in the module tests).
 */
import type { IdentityConfig } from '../types.js';
import { sha256Prefix } from './hash.js';

/** Query parameters removed before identity is computed (DESIGN.md 4.1 rule 4). */
export const BUILTIN_CACHE_BUSTERS: readonly string[] = [
  'v',
  'ver',
  'version',
  'cb',
  '_',
  't',
  'ts',
  'timestamp',
  'rnd',
  'rand',
  'random',
  'nocache',
  'cache',
  'h',
  'hash',
  'bust',
  '_t',
  '_v',
];

const HEX_TOKEN = /^[A-Fa-f0-9]{8,}$/;
const LONG_TOKEN = /^[A-Za-z0-9]{16,}$/;
const HAS_DIGIT = /[0-9]/;
const HASH_PLACEHOLDER = '[hash]';

/** True when a path token (already split on `.`, `-`, `_`, `/`) looks like a build hash. */
function isHashToken(token: string): boolean {
  if (token === HASH_PLACEHOLDER) return false;
  if (HEX_TOKEN.test(token)) return true;
  return LONG_TOKEN.test(token) && HAS_DIGIT.test(token);
}

/** Replace hash-like tokens in a URL path, keeping every delimiter in place. */
export function collapsePathHashes(pathname: string): string {
  // Split keeping delimiters so the path can be reassembled verbatim.
  const parts = pathname.split(/([./_-])/);
  return parts.map((part) => (isHashToken(part) ? HASH_PLACEHOLDER : part)).join('');
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * Filter and sort a raw query string. Parameters are kept with their original
 * encoding; only their (decoded) names are used for filtering and ordering.
 * Returns the query without a leading `?`, or an empty string.
 */
export function normalizeQuery(rawQuery: string, cfg: IdentityConfig): string {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (query === '') return '';
  const keep = new Set(cfg.keepQuery);
  const strip = new Set<string>([...BUILTIN_CACHE_BUSTERS, ...cfg.stripQuery]);
  const entries: Array<{ name: string; raw: string; index: number }> = [];
  let index = 0;
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const name = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    if (strip.has(name) && !keep.has(name)) continue;
    entries.push({ name, raw: pair, index: index++ });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index));
  return entries.map((entry) => entry.raw).join('&');
}

function blobIdentity(url: URL, raw: string): string {
  // The WHATWG parser exposes the inner origin of blob: URLs; fall back to
  // parsing the opaque path when it does not.
  if (url.origin && url.origin !== 'null') return `blob:${url.origin}`;
  try {
    const inner = new URL(url.pathname);
    if (inner.origin && inner.origin !== 'null') return `blob:${inner.origin}`;
  } catch {
    // fall through
  }
  const match = /^blob:([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(raw.trim());
  return match?.[1] !== undefined ? `blob:${match[1].toLowerCase()}` : 'blob:null';
}

function dataIdentity(raw: string): string {
  const payload = raw.trim().replace(/^data:/i, '');
  return `data:${sha256Prefix(payload, 16)}`;
}

/**
 * Normalise a script URL into its identity string. See the module header for
 * the rules. The result is also the value of `ObservedScript.url`.
 */
export function normalizeUrl(raw: string, cfg: IdentityConfig): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (url.protocol === 'blob:') return blobIdentity(url, trimmed);
  if (url.protocol === 'data:') return dataIdentity(trimmed);

  url.hash = '';
  url.username = '';
  url.password = '';

  const query = normalizeQuery(url.search, cfg);
  url.search = '';

  // Opaque paths (about:blank, javascript:...) have no host and cannot be
  // rewritten through the pathname setter; return them as parsed.
  if (url.host === '' && !url.pathname.startsWith('/')) {
    return url.href + (query !== '' ? `?${query}` : '');
  }

  const pathname = cfg.collapseHashes ? collapsePathHashes(url.pathname) : url.pathname;
  url.pathname = pathname;
  // The URL setter may percent-encode characters; keep the string form we
  // computed so `[hash]` survives verbatim.
  const base = `${url.protocol}//${url.host}${pathname}`;
  return query !== '' ? `${base}?${query}` : base;
}
