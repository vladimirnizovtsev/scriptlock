/**
 * Header extraction helpers (DESIGN.md 3.3 step 6).
 *
 * Owns: lower-casing CDP header maps, picking the SecurityHeaders subset from
 * the main document response and the small response-header subset recorded
 * for URL-addressed scripts.
 *
 * Limitations: CDP joins repeated headers with a newline in one value; the
 * value is kept as delivered. Headers are read from `Network.responseReceived`,
 * which for cached responses reflects the cached headers.
 */
import { SECURITY_HEADER_NAMES, type ObservedScript, type SecurityHeaderName, type SecurityHeaders } from '../types.js';

/** Returns a copy of the header map with lower-cased names. Later duplicates win. */
export function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/** Picks only the security-impacting headers listed in SECURITY_HEADER_NAMES. */
export function extractSecurityHeaders(headers: Record<string, string>): SecurityHeaders {
  const lower = lowerCaseHeaders(headers);
  const out: SecurityHeaders = {};
  for (const name of SECURITY_HEADER_NAMES) {
    const value = lower[name];
    if (value !== undefined) out[name as SecurityHeaderName] = value;
  }
  return out;
}

/** Picks the response-header subset recorded next to URL-addressed scripts. */
export function pickScriptResponseHeaders(headers: Record<string, string>): ObservedScript['responseHeaders'] | undefined {
  const lower = lowerCaseHeaders(headers);
  const out: NonNullable<ObservedScript['responseHeaders']> = {};
  if (lower['content-type'] !== undefined) out.contentType = lower['content-type'];
  if (lower['cache-control'] !== undefined) out.cacheControl = lower['cache-control'];
  if (lower['last-modified'] !== undefined) out.lastModified = lower['last-modified'];
  if (lower['etag'] !== undefined) out.etag = lower['etag'];
  return Object.keys(out).length > 0 ? out : undefined;
}
