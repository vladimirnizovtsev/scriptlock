/**
 * Snapshot + Manifest -> DiffResult (DESIGN.md section 7).
 *
 * Walks observed scripts against manifest entries, then manifest entries
 * against observations (removed), then headers and frames. Severities come
 * from diff/policy.ts. Harness scripts are dropped and ignored ids skipped.
 * A manifest with no script entry fails as `empty-manifest` before anything
 * else is compared: it authorises nothing, so it can never be reported clean.
 *
 * When several manifest entries match one id the first in file order wins and
 * a note is added to `result.warnings`. Sibling `new` scripts in one build
 * directory produce a `scriptlock approve --match` suggestion in
 * `result.hints`; hints are advisory and never change a severity, the summary
 * or the exit code. Limitations: spoof detection normalises the claimed
 * sourceURL with the identity module's default configuration unless `identity`
 * is passed; a sourceURL that is not a parseable URL is compared as a raw
 * string only. Hint detection only understands http(s) ids with a file
 * extension and no query string.
 */
import { normalizeUrl as realNormalizeUrl } from '../identity/normalize.js';
import {
  coveringScriptEntries,
  escapeGlob,
  findFrameEntry,
  findScriptEntry,
  globMatches,
  isIgnored,
  isNarrowGlob,
  matchingScriptEntries,
} from '../manifest/match.js';
import {
  SECURITY_HEADER_NAMES,
  type DiffEvent,
  type DiffEventType,
  type DiffMode,
  type DiffOptions,
  type DiffResult,
  type IdentityConfig,
  type Manifest,
  type ManifestFrame,
  type ManifestScript,
  type ObservedScript,
  type Scope,
  type SecurityHeaderName,
  type Severity,
} from '../types.js';
import { severityFor, type PolicySeverity } from './policy.js';

export type NormalizeUrlFn = (raw: string, cfg: IdentityConfig) => string;

/**
 * The invocation a printed hint command has to reproduce, so a pasted command
 * acts on the profile and configuration this run used.
 */
export interface HintContext {
  /** Profile of this run; `default` and undefined print no `--profile`. */
  profile?: string | undefined;
  /** `--config <path>` of this run; undefined prints no `--config`. */
  config?: string | undefined;
  /**
   * How `scriptlock` is typed in this project, e.g. `npx scriptlock` or
   * `pnpm exec scriptlock`. Defaults to the bare name, which is what a global
   * install and a library caller want; the CLI passes the detected runner.
   */
  runner?: string | undefined;
}

/** Optional extras accepted on top of DiffOptions, mainly for tests. */
export interface DiffExtras {
  /** URL normaliser used for spoof detection; defaults to identity/normalize. */
  normalizeUrl?: NormalizeUrlFn;
  /** Identity configuration passed to the normaliser. */
  identity?: IdentityConfig;
  /** Flags the printed hint commands must carry; defaults to the snapshot's profile. */
  hintContext?: HintContext;
}

/** Optional event fields; `undefined` values are dropped. */
interface EventExtra {
  scope?: Scope | undefined;
  observed?: ObservedScript | undefined;
  expected?: ManifestScript | ManifestFrame | undefined;
  before?: string | undefined;
  after?: string | undefined;
}

const DEFAULT_IDENTITY: IdentityConfig = { stripQuery: [], keepQuery: [], collapseHashes: true };

/** Hash prefix used in event messages; before/after keep the full value. */
function shortHash(value: string | undefined): string {
  if (value === undefined || value === '') return '(none)';
  return value.length > 12 ? value.slice(0, 12) : value;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function scopeOf(scope: Scope | undefined): { scope?: Scope } {
  return scope === undefined ? {} : { scope };
}

// ---------------------------------------------------------------------------
// Hints: content-hashed bundle directories
// ---------------------------------------------------------------------------

/** Sibling `new` scripts in one directory before a `--match` entry is suggested. */
export const BUNDLE_HINT_THRESHOLD = 3;
/** Upper bound on suggestions in one result, one per directory. */
export const MAX_HINTS = 3;

const EXTENSION = /^[A-Za-z0-9]{1,8}$/;

interface BundleGroup {
  directory: string;
  extension: string;
  stems: Set<string>;
  ids: string[];
}

/**
 * Splits an observed id into the directory it lives in, its file extension and
 * its file stem. Returns undefined for anything that is not an http(s) URL
 * with a file name, an extension and no query string (inline, eval, blob and
 * data ids, and cache-busted URLs, are never bundle chunks).
 */
export function bundlePath(id: string): { directory: string; extension: string; stem: string } | undefined {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search !== '') return undefined;
  const slash = url.pathname.lastIndexOf('/');
  if (slash === -1) return undefined;
  const file = url.pathname.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = file.slice(dot + 1);
  if (!EXTENSION.test(extension)) return undefined;
  return { directory: `${url.origin}${url.pathname.slice(0, slash)}`, extension, stem: file.slice(0, dot) };
}

/**
 * One `scriptlock approve --match` suggestion per directory in which three or
 * more `new` scripts share the origin, the directory and the extension while
 * their file stems differ: the content-hashed bundle pattern of Next.js, Vite,
 * Nuxt, Astro and webpack, where every build renames every chunk.
 *
 * The suggested glob is built from the escaped directory, and is emitted only
 * when it is narrow enough for `approve --match` to accept and actually matches
 * every id in the group, so the printed command always runs. Its placeholders
 * are quoted, so the command survives a copy and paste into a shell, and it
 * carries the `--profile` and `--config` of this run so a paste cannot land on
 * another profile's manifest.
 */
export function bundleHints(events: readonly DiffEvent[], context: HintContext = {}): string[] {
  const scriptlock = context.runner === undefined || context.runner === '' ? 'scriptlock' : context.runner;
  const target = [
    ...(context.profile !== undefined && context.profile !== '' && context.profile !== 'default' ? [`--profile "${context.profile}"`] : []),
    ...(context.config !== undefined && context.config !== '' ? [`--config "${context.config}"`] : []),
  ].join(' ');
  const targetFlags = target === '' ? '' : ` ${target}`;
  const groups = new Map<string, BundleGroup>();
  for (const event of events) {
    if (event.type !== 'new') continue;
    const parsed = bundlePath(event.subject);
    if (parsed === undefined) continue;
    const key = `${parsed.directory} ${parsed.extension}`;
    const group = groups.get(key) ?? { directory: parsed.directory, extension: parsed.extension, stems: new Set<string>(), ids: [] };
    group.stems.add(parsed.stem);
    group.ids.push(event.subject);
    groups.set(key, group);
  }
  const candidates = [...groups.values()]
    .filter((group) => group.stems.size >= BUNDLE_HINT_THRESHOLD)
    .sort((a, b) => b.stems.size - a.stems.size || (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));

  const hints: string[] = [];
  const directories = new Set<string>();
  for (const group of candidates) {
    if (hints.length >= MAX_HINTS) break;
    if (directories.has(group.directory)) continue;
    const glob = `${escapeGlob(group.directory)}/*.${group.extension}`;
    // A directory whose name carries glob metacharacters, or that is not one
    // directory below a host, cannot be suggested: the command would be refused.
    if (!isNarrowGlob(glob) || !group.ids.every((id) => globMatches(glob, id))) continue;
    directories.add(group.directory);
    hints.push(
      `${group.stems.size} new scripts under ${group.directory}/ differ only in their file name, which is the content-hashed bundle pattern: every build renames them, so every deploy reports them as new. One entry can authorise that one directory, not its subdirectories, at the price of hashing none of their bodies:\n` +
        `${scriptlock} approve --match "${glob}"${targetFlags} --owner "<team>" --category framework --justification "<why this build directory is authorised>"`,
    );
  }
  return hints;
}

/**
 * Builds a DiffEvent, or undefined when the severity matrix says this event is
 * not emitted at all. Optional fields are omitted rather than set to undefined.
 */
function buildEvent(type: DiffEventType, severity: PolicySeverity, subject: string, message: string, extra: EventExtra = {}): DiffEvent | undefined {
  if (severity === 'none') return undefined;
  const built: DiffEvent = { type, severity, subject, message };
  if (extra.scope !== undefined) built.scope = extra.scope;
  if (extra.observed !== undefined) built.observed = extra.observed;
  if (extra.expected !== undefined) built.expected = extra.expected;
  if (extra.before !== undefined) built.before = extra.before;
  if (extra.after !== undefined) built.after = extra.after;
  return built;
}

// ---------------------------------------------------------------------------
// Per-script comparisons (step 3 of the pipeline in `diff`)
//
// Each returns the event it found, or undefined; the caller pushes it. Keeping
// them at module scope leaves the numbered steps inside `diff` contiguous, and
// makes each one testable on its own.
// ---------------------------------------------------------------------------

/**
 * The `changed` event for one script against the entry that authorises it, or
 * undefined when the policy does not compare bodies, the body was never
 * captured, or the body still matches.
 */
function compareBody(script: ObservedScript, entry: ManifestScript, mode: DiffMode): DiffEvent | undefined {
  const severity = severityFor(mode, 'changed', script.scope, entry.integrity);
  if (severity === 'none') return undefined;
  switch (entry.integrity) {
    case 'strict': {
      if (entry.sha256 === undefined || script.sha256 === undefined || entry.sha256 === script.sha256) return undefined;
      return buildEvent('changed', severity, script.id, `sha256 changed under strict policy: ${shortHash(entry.sha256)} -> ${shortHash(script.sha256)}`, {
        scope: script.scope,
        observed: script,
        expected: entry,
        before: entry.sha256,
        after: script.sha256,
      });
    }
    case 'structural': {
      if (entry.structuralHash === undefined || script.structuralHash === undefined || entry.structuralHash === script.structuralHash) {
        return undefined;
      }
      return buildEvent(
        'changed',
        severity,
        script.id,
        `structural hash changed under structural policy: ${shortHash(entry.structuralHash)} -> ${shortHash(script.structuralHash)}`,
        { scope: script.scope, observed: script, expected: entry, before: entry.structuralHash, after: script.structuralHash },
      );
    }
    case 'track': {
      if (script.sha256 === undefined) return undefined;
      const known = [entry.sha256, entry.lastSeenSha256].filter((h): h is string => h !== undefined && h !== '');
      // An entry with no approved hash is a `match` glob entry, which stands for
      // many bodies and pins none of them (DESIGN.md section 6). Without this it
      // would report every script it covers as changed on every run.
      if (known.length === 0 || known.includes(script.sha256)) return undefined;
      const before = entry.lastSeenSha256 ?? entry.sha256;
      return buildEvent(
        'changed',
        severity,
        script.id,
        `body changed under track policy (informational): ${shortHash(before)} -> ${shortHash(script.sha256)}`,
        { scope: script.scope, observed: script, expected: entry, before, after: script.sha256 },
      );
    }
    case 'url-only':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The `spoofed` event for a script whose claimed `sourceURL` resolves to a
 * manifest entry while its real id has none.
 */
function detectSpoof(script: ObservedScript, manifest: Manifest, mode: DiffMode, normalize: NormalizeUrlFn, identity: IdentityConfig): DiffEvent | undefined {
  if (!script.hasSourceURL || !script.sourceUrl) return undefined;
  const claimed = script.sourceUrl;
  let normalised: string | undefined;
  try {
    normalised = normalize(claimed, identity);
  } catch {
    normalised = undefined;
  }
  const candidates = [normalised, claimed].filter((c): c is string => c !== undefined && c !== '');
  for (const candidate of candidates) {
    if (candidate === script.id) continue;
    const target = findScriptEntry(manifest, candidate);
    if (!target) continue;
    return buildEvent(
      'spoofed',
      severityFor(mode, 'spoofed', script.scope),
      script.id,
      `script claims sourceURL ${claimed} which matches approved entry ${target.id}, but its real id has no manifest entry`,
      { scope: script.scope, observed: script, expected: target, before: target.id, after: script.id },
    );
  }
  return undefined;
}

/**
 * The `moved` event for a script whose body equals an approved strict or
 * structural entry's hash but which was observed under a different id.
 */
function detectMoved(script: ObservedScript, approvedHashes: ReadonlyMap<string, ManifestScript>, mode: DiffMode): DiffEvent | undefined {
  if (script.sha256 === undefined) return undefined; // no body hash: nothing can have moved
  const original = approvedHashes.get(script.sha256);
  if (!original || original.id === script.id) return undefined;
  return buildEvent(
    'moved',
    severityFor(mode, 'moved', script.scope),
    script.id,
    `body matches approved ${original.integrity} entry ${original.id} but was observed from a different source`,
    { scope: script.scope, observed: script, expected: original, before: original.id, after: script.id },
  );
}

export function diff(options: DiffOptions & DiffExtras): DiffResult {
  const { snapshot, manifest, mode } = options;
  const normalize = options.normalizeUrl ?? realNormalizeUrl;
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const events: DiffEvent[] = [];
  const warnings: string[] = [];

  const push = (type: DiffEventType, severity: PolicySeverity, subject: string, message: string, extra: EventExtra = {}): void => {
    pushEvent(buildEvent(type, severity, subject, message, extra));
  };

  /** Appends an event a helper produced and reports whether there was one. */
  const pushEvent = (found: DiffEvent | undefined): boolean => {
    if (found === undefined) return false;
    events.push(found);
    return true;
  };

  // 1. blocked
  if (snapshot.blocked) {
    push(
      'blocked',
      severityFor(mode, 'blocked'),
      snapshot.finalUrl || snapshot.url,
      `bot-management challenge page detected (${snapshot.blocked.vendor}): ${snapshot.blocked.evidence}; the inventory is unreliable`,
    );
  }

  // 1b. a manifest with no script entry is not an inventory. Without this an
  // empty manifest (typically written from a snapshot of an error page) makes
  // every later run report clean, gate included.
  if (manifest.scripts.length === 0) {
    push(
      'empty-manifest',
      severityFor(mode, 'empty-manifest'),
      manifest.profile,
      'the manifest holds no script entry, so nothing is authorised and no change can be detected; approve the inventory of a page that actually loaded',
    );
  }

  // 2. approved-hash index for moved detection
  const approvedHashes = new Map<string, ManifestScript>();
  for (const entry of manifest.scripts) {
    if ((entry.integrity === 'strict' || entry.integrity === 'structural') && entry.sha256) {
      if (!approvedHashes.has(entry.sha256)) approvedHashes.set(entry.sha256, entry);
    }
  }

  // 3. observed scripts
  const scripts = snapshot.scripts.filter((s) => s.scope !== 'harness');
  const observedEntries = new Set<ManifestScript>();
  let approved = 0;

  for (const script of scripts) {
    const matches = matchingScriptEntries(manifest, script.id);
    const entry = matches[0];
    if (matches.length > 1) {
      warnings.push(
        `script ${script.id} matches ${matches.length} manifest entries (${matches.map((m) => m.id).join(', ')}); the first in file order was used`,
      );
    }
    // Every entry that authorises this id counts as observed, including a glob
    // shadowed by an exact entry; otherwise the glob is `removed` for ever.
    for (const match of coveringScriptEntries(manifest, script.id)) observedEntries.add(match);
    if (isIgnored(manifest, script.id)) continue;

    if (entry) {
      approved += 1;
      if (entry.scope !== script.scope) {
        push(
          'scope-changed',
          severityFor(mode, 'scope-changed', script.scope),
          script.id,
          `approved in scope ${entry.scope}, observed in scope ${script.scope}`,
          { scope: script.scope, observed: script, expected: entry, before: entry.scope, after: script.scope },
        );
      }
      pushEvent(compareBody(script, entry, mode));
      continue;
    }

    if (pushEvent(detectSpoof(script, manifest, mode, normalize, identity))) continue;
    if (pushEvent(detectMoved(script, approvedHashes, mode))) continue;

    const entity = script.entity ? ` (${script.entity.name})` : '';
    const loadedBy = script.loadedBy ? `, loaded by ${script.loadedBy}` : '';
    push(
      'new',
      severityFor(mode, 'new', script.scope),
      script.id,
      `unapproved ${script.kind} script in ${script.scope} scope${entity}${loadedBy}`,
      { scope: script.scope, observed: script },
    );
  }

  // 4. removed entries
  for (const entry of manifest.scripts) {
    if (observedEntries.has(entry)) continue;
    if (isIgnored(manifest, entry.id)) continue;
    push(
      'removed',
      severityFor(mode, 'removed', entry.scope),
      entry.id,
      `approved script not observed in ${plural(snapshot.runs, 'run')}`,
      { scope: entry.scope, expected: entry },
    );
  }

  // 5. headers
  const headerPolicy = manifest.headers.policy;
  if (headerPolicy !== 'ignore') {
    const severity = severityFor(mode, 'header-changed', undefined, headerPolicy);
    // Both sides are validated against SECURITY_HEADER_NAMES on the way in (the
    // manifest and snapshot schemas, and the collector's own header filter), so
    // this list is every header either side can hold.
    for (const name of SECURITY_HEADER_NAMES) {
      const before = manifest.headers.values[name];
      const after = snapshot.headers[name];
      if (before === undefined && after === undefined) continue;
      if (before !== undefined && after !== undefined) {
        if (before !== after) {
          push('header-changed', severity, name, `${name} value differs from the manifest`, { before, after });
        }
      } else if (after !== undefined) {
        push('header-added', severity, name, `${name} is present in the response but not in the manifest`, { after });
      } else {
        push('header-removed', severity, name, `${name} is in the manifest but missing from the response`, { before });
      }
    }
  }

  // 6. frames
  const observedFrames = new Set<ManifestFrame>();
  for (const frame of snapshot.frames) {
    if (frame.isMain || !frame.crossOrigin) continue;
    const entry = findFrameEntry(manifest, frame);
    if (entry) {
      observedFrames.add(entry);
      continue;
    }
    push(
      'new-frame',
      severityFor(mode, 'new-frame', frame.scope),
      frame.url,
      `cross-origin frame in ${frame.scope} scope has no manifest entry`,
      scopeOf(frame.scope),
    );
  }
  for (const entry of manifest.frames) {
    if (observedFrames.has(entry)) continue;
    push('removed-frame', severityFor(mode, 'removed-frame', entry.scope), entry.match, 'approved frame not observed', {
      scope: entry.scope,
      expected: entry,
    });
  }

  // 7. summary and exit code
  const count = (severity: Severity): number => events.filter((e) => e.severity === severity).length;
  const summary: DiffResult['summary'] = {
    fail: count('fail'),
    warn: count('warn'),
    info: count('info'),
    merchantScripts: scripts.filter((s) => s.scope === 'merchant').length,
    totalScripts: scripts.length,
    approved,
  };
  const exitCode: DiffResult['exitCode'] = events.some((e) => e.type === 'blocked') ? 2 : summary.fail > 0 ? 1 : 0;

  return {
    mode,
    profile: snapshot.profile,
    url: snapshot.url,
    scannedAt: snapshot.finishedAt,
    events,
    summary,
    exitCode,
    warnings,
    hints: bundleHints(events, options.hintContext ?? { profile: snapshot.profile }),
  };
}
