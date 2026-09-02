/**
 * Matching observed scripts and frames against manifest entries.
 *
 * Rules (DESIGN.md section 6): exact `id` equality wins; otherwise the first
 * entry in file order whose `match` glob matches the observed id. Globs use
 * picomatch with case-insensitive matching. `ignore` globs are checked the
 * same way. Limitation: a `match` glob that also equals another entry's exact
 * id is resolved by file order, and the diff module reports a warning when
 * more than one entry matches.
 */
import picomatch from 'picomatch';
import type { FrameInfo, Manifest, ManifestFrame, ManifestScript, ObservedScript } from '../types.js';

const matcherCache = new WeakMap<object, Map<string, (s: string) => boolean>>();

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

/** Returns every manifest script entry that matches the observed id, in file order. */
export function matchingScriptEntries(manifest: Manifest, observedId: string): ManifestScript[] {
  const exact = manifest.scripts.filter((entry) => entry.id === observedId);
  if (exact.length > 0) return exact;
  return manifest.scripts.filter((entry) => entry.match !== undefined && compile(manifest, entry.match)(observedId));
}

export function findScriptEntry(manifest: Manifest, observed: Pick<ObservedScript, 'id'>): ManifestScript | undefined {
  return matchingScriptEntries(manifest, observed.id)[0];
}

export function findScriptEntryById(manifest: Manifest, observedId: string): ManifestScript | undefined {
  return matchingScriptEntries(manifest, observedId)[0];
}

/** Frames are matched by their (normalised) URL against `match` (exact or glob). */
export function findFrameEntry(manifest: Manifest, frame: Pick<FrameInfo, 'url'>): ManifestFrame | undefined {
  return manifest.frames.find((entry) => entry.match === frame.url || compile(manifest, entry.match)(frame.url));
}

export function isIgnored(manifest: Manifest, observedId: string): boolean {
  return manifest.ignore.some((glob) => glob === observedId || compile(manifest, glob)(observedId));
}
