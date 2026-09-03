/**
 * Matching observed scripts and frames against manifest entries, and the
 * narrowness rules a `match` glob must satisfy before it can be approved.
 *
 * Rules (DESIGN.md section 6): exact `id` equality wins; otherwise the first
 * entry in file order whose `match` glob matches the observed id. Globs use
 * picomatch with case-insensitive matching. `ignore` globs are checked the
 * same way. Limitation: a `match` glob that also equals another entry's exact
 * id is resolved by file order, and the diff module reports a warning when
 * more than one entry matches.
 *
 * `matchingScriptEntries` returns the winner (exact ids shadow globs);
 * `coveringScriptEntries` returns every entry that authorises the id,
 * including a glob shadowed by an exact entry, so the diff does not report
 * that glob as removed.
 *
 * `globNarrowness` owns the shape rules for `approve --match`: a glob entry is
 * never checked against a body hash, so it may only ever expand inside one
 * directory of one host. `escapeGlob` turns a literal path into glob-safe text.
 */
import picomatch from 'picomatch';
import type { FrameInfo, Manifest, ManifestFrame, ManifestScript, ObservedScript } from '../types.js';

const matcherCache = new WeakMap<object, Map<string, (s: string) => boolean>>();

/** Cache owner for globs that do not belong to a manifest (see `globMatches`). */
const STANDALONE = {};

function compile(owner: object, glob: string): (s: string) => boolean {
  let cache = matcherCache.get(owner);
  if (!cache) {
    cache = new Map();
    matcherCache.set(owner, cache);
  }
  let fn = cache.get(glob);
  if (!fn) {
    fn = picomatch(glob, { nocase: true, dot: true });
    cache.set(glob, fn);
  }
  return fn;
}

/**
 * True when `value` matches `glob` under the same rules as a manifest `match`
 * (picomatch, case-insensitive). Used by `scriptlock approve --match` before
 * any entry exists.
 */
export function globMatches(glob: string, value: string): boolean {
  return glob === value || compile(STANDALONE, glob)(value);
}

/** Returns every manifest script entry that matches the observed id, in file order. */
export function matchingScriptEntries(manifest: Manifest, observedId: string): ManifestScript[] {
  const exact = manifest.scripts.filter((entry) => entry.id === observedId);
  if (exact.length > 0) return exact;
  return globScriptEntries(manifest, observedId);
}

function globScriptEntries(manifest: Manifest, observedId: string): ManifestScript[] {
  return manifest.scripts.filter((entry) => entry.match !== undefined && compile(manifest, entry.match)(observedId));
}

/**
 * Every entry that authorises `observedId`: exact-id entries first, then the
 * glob entries they shadow. `matchingScriptEntries` decides which entry is
 * enforced; this one answers "was this entry observed", so a glob whose files
 * all also have exact entries is not reported as `removed` for ever.
 */
export function coveringScriptEntries(manifest: Manifest, observedId: string): ManifestScript[] {
  const exact = manifest.scripts.filter((entry) => entry.id === observedId);
  const globs = globScriptEntries(manifest, observedId).filter((entry) => !exact.includes(entry));
  return [...exact, ...globs];
}

/** The manifest entry that authorises an observed script, by the script or by its id. */
export function findScriptEntry(manifest: Manifest, observed: Pick<ObservedScript, 'id'> | string): ManifestScript | undefined {
  return matchingScriptEntries(manifest, typeof observed === 'string' ? observed : observed.id)[0];
}

/** Frames are matched by their (normalised) URL against `match` (exact or glob). */
export function findFrameEntry(manifest: Manifest, frame: Pick<FrameInfo, 'url'>): ManifestFrame | undefined {
  return manifest.frames.find((entry) => entry.match === frame.url || compile(manifest, entry.match)(frame.url));
}

export function isIgnored(manifest: Manifest, observedId: string): boolean {
  return manifest.ignore.some((glob) => glob === observedId || compile(manifest, glob)(observedId));
}

// ---------------------------------------------------------------------------
// Glob narrowness (`scriptlock approve --match`)
// ---------------------------------------------------------------------------

/** Picomatch metacharacters that must be escaped to match a literal path. */
const GLOB_SPECIAL = /[\\*?[\]{}()!+@|]/g;

/** Escapes every glob metacharacter so `text` is matched literally. */
export function escapeGlob(text: string): string {
  return text.replace(GLOB_SPECIAL, '\\$&');
}

/** Why a glob is too broad to be approved, with the advice to print with it. */
export interface GlobProblem {
  reason: string;
  hint: string;
}

const NARROW_HINT =
  'Name one host and one directory, e.g. "https://shop.example.com/_next/static/chunks/*.js"; a glob entry is never checked against a body hash, so it must not reach further than one build output directory';

interface GlobShape {
  /** Wildcard-free, unescaped text before the first wildcard. */
  literal: string;
  hasWildcard: boolean;
  hasDoubleStar: boolean;
  /** Unescaped metacharacters that can span several names, hosts or scopes. */
  spanning: string[];
  /** True when a `/` follows the first wildcard, so the glob spans directories. */
  crossesDirectory: boolean;
}

/** Splits a glob into the parts the narrowness rules are expressed over. */
function shapeOf(glob: string): GlobShape {
  const shape: GlobShape = { literal: '', hasWildcard: false, hasDoubleStar: false, spanning: [], crossesDirectory: false };
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === '\\') {
      const escaped = glob[i + 1];
      if (escaped !== undefined && !shape.hasWildcard) shape.literal += escaped;
      i += 1;
      continue;
    }
    if (char === '*' || char === '?' || char === '[') {
      if (char === '*' && glob[i + 1] === '*') shape.hasDoubleStar = true;
      shape.hasWildcard = true;
      continue;
    }
    if (char === '{' || char === '}' || char === '(' || char === ')' || char === '|' || char === '!') {
      if (!shape.spanning.includes(char)) shape.spanning.push(char);
      continue;
    }
    if (shape.hasWildcard) {
      if (char === '/') shape.crossesDirectory = true;
      continue;
    }
    shape.literal += char;
  }
  return shape;
}

/**
 * Returns why `glob` is too broad for `approve --match`, or undefined when it
 * is narrow enough. A glob entry authorises every id that matches it, now and
 * on every future deploy, and no body of those ids is ever hashed, so the
 * wildcard may only expand inside one directory of one http(s) host:
 *
 * - `**`, a leading `!`, and `{ } ( ) |` are refused: each of them can span
 *   several directories, hosts or scopes.
 * - the wildcard-free prefix must be an http(s) origin plus at least one path
 *   segment, which also rules out a wildcard in the scheme or the authority.
 * - no `/` may follow the wildcard, so one glob covers one directory.
 * - a glob with no wildcard at all authorises exactly one id and belongs in an
 *   ordinary exact-id entry (`scriptlock approve <id>`).
 */
export function globNarrowness(glob: string): GlobProblem | undefined {
  const trimmed = glob.trim();
  if (trimmed === '') return { reason: 'it is empty', hint: NARROW_HINT };
  if (trimmed.startsWith('!')) {
    return { reason: 'it starts with "!", which authorises everything the rest of the glob does not match', hint: NARROW_HINT };
  }
  const shape = shapeOf(trimmed);
  if (shape.hasDoubleStar) {
    return { reason: 'it contains "**", which reaches across directories', hint: NARROW_HINT };
  }
  if (shape.spanning.length > 0) {
    return {
      reason: `it contains ${shape.spanning.map((char) => `"${char}"`).join(', ')}, which can span several names, hosts or scopes`,
      hint: NARROW_HINT,
    };
  }
  if (!shape.hasWildcard) {
    return {
      reason: 'it contains no wildcard, so it authorises exactly one id',
      hint: 'Approve that id directly: scriptlock approve "<id>" --owner "<team>" --category "<category>" --justification "<why>"',
    };
  }
  const slash = shape.literal.lastIndexOf('/');
  const directory = slash === -1 ? '' : shape.literal.slice(0, slash + 1);
  let url: URL | undefined;
  try {
    url = new URL(directory);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.host === '') {
    return { reason: 'the text before the wildcard is not an http(s) host and directory', hint: NARROW_HINT };
  }
  if (url.pathname === '/') {
    return { reason: 'it covers the root of the host rather than one directory', hint: NARROW_HINT };
  }
  if (shape.crossesDirectory) {
    return { reason: 'its wildcard reaches past a "/" into another directory', hint: NARROW_HINT };
  }
  return undefined;
}

/** True when the glob is narrow enough to be written as a manifest entry. */
export function isNarrowGlob(glob: string): boolean {
  return globNarrowness(glob) === undefined;
}
