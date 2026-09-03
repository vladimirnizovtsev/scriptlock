/**
 * Snapshot + Manifest -> DiffResult (DESIGN.md section 7).
 *
 * Walks observed scripts against manifest entries, then manifest entries
 * against observations (removed), then headers and frames. Severities come
 * from diff/policy.ts. Harness scripts are dropped and ignored ids skipped.
 *
 * When several manifest entries match one id the first in file order wins and
 * a note is added to `result.warnings`. Limitations: spoof detection
 * normalises the claimed sourceURL with the identity module's default
 * configuration unless `identity` is passed; a sourceURL that is not a
 * parseable URL is compared as a raw string only.
 */
import { normalizeUrl as realNormalizeUrl } from '../identity/normalize.js';
import { findFrameEntry, findScriptEntryById, isIgnored, matchingScriptEntries } from '../manifest/match.js';
import {
  SECURITY_HEADER_NAMES,
  type DiffEvent,
  type DiffEventType,
  type DiffOptions,
  type DiffResult,
  type IdentityConfig,
  type ManifestFrame,
  type ManifestScript,
  type ObservedScript,
  type Scope,
  type SecurityHeaderName,
  type Severity,
} from '../types.js';
import { severityFor, type PolicySeverity } from './policy.js';

export type NormalizeUrlFn = (raw: string, cfg: IdentityConfig) => string;

/** Optional extras accepted on top of DiffOptions, mainly for tests. */
export interface DiffExtras {
  /** URL normaliser used for spoof detection; defaults to identity/normalize. */
  normalizeUrl?: NormalizeUrlFn;
  /** Identity configuration passed to the normaliser. */
  identity?: IdentityConfig;
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
export function shortHash(value: string | undefined): string {
  if (value === undefined || value === '') return '(none)';
  return value.length > 12 ? value.slice(0, 12) : value;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function scopeOf(scope: Scope | undefined): { scope?: Scope } {
  return scope === undefined ? {} : { scope };
}

export function diff(options: DiffOptions & DiffExtras): DiffResult {
  const { snapshot, manifest, mode } = options;
  const normalize = options.normalizeUrl ?? realNormalizeUrl;
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const events: DiffEvent[] = [];
  const warnings: string[] = [];

  const push = (
    type: DiffEventType,
    severity: PolicySeverity,
    subject: string,
    message: string,
    extra: EventExtra = {},
  ): void => {
    if (severity === 'none') return;
    const event: DiffEvent = { type, severity, subject, message };
    if (extra.scope !== undefined) event.scope = extra.scope;
    if (extra.observed !== undefined) event.observed = extra.observed;
    if (extra.expected !== undefined) event.expected = extra.expected;
    if (extra.before !== undefined) event.before = extra.before;
    if (extra.after !== undefined) event.after = extra.after;
    events.push(event);
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
    for (const match of matches) observedEntries.add(match); // shadowed entries count as observed, not removed
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
      compareBody(script, entry);
      continue;
    }

    if (detectSpoof(script)) continue;
    if (detectMoved(script)) continue;

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

  function compareBody(script: ObservedScript, entry: ManifestScript): void {
    const severity = severityFor(mode, 'changed', script.scope, entry.integrity);
    if (severity === 'none') return;
    // A body that was never captured (worker entries) has nothing to compare.
    if (script.sha256 === undefined && script.structuralHash === undefined) return;
    switch (entry.integrity) {
      case 'strict': {
        if (entry.sha256 !== undefined && script.sha256 !== undefined && entry.sha256 !== script.sha256) {
          push(
            'changed',
            severity,
            script.id,
            `sha256 changed under strict policy: ${shortHash(entry.sha256)} -> ${shortHash(script.sha256)}`,
            { scope: script.scope, observed: script, expected: entry, before: entry.sha256, after: script.sha256 },
          );
        }
        return;
      }
      case 'structural': {
        if (entry.structuralHash !== undefined && script.structuralHash !== undefined && entry.structuralHash !== script.structuralHash) {
          push(
            'changed',
            severity,
            script.id,
            `structural hash changed under structural policy: ${shortHash(entry.structuralHash)} -> ${shortHash(script.structuralHash)}`,
            {
              scope: script.scope,
              observed: script,
              expected: entry,
              before: entry.structuralHash,
              after: script.structuralHash,
            },
          );
        }
        return;
      }
      case 'track': {
        if (script.sha256 === undefined) return;
        const known = [entry.sha256, entry.lastSeenSha256].filter((h): h is string => h !== undefined && h !== '');
        if (known.length === 0 || known.includes(script.sha256)) return;
        const before = entry.lastSeenSha256 ?? entry.sha256;
        push(
          'changed',
          severity,
          script.id,
          `body changed under track policy (informational): ${shortHash(before)} -> ${shortHash(script.sha256)}`,
          { scope: script.scope, observed: script, expected: entry, before, after: script.sha256 },
        );
        return;
      }
      case 'url-only':
        return;
      default:
        return;
    }
  }

  function detectSpoof(script: ObservedScript): boolean {
    if (!script.hasSourceURL || !script.sourceUrl) return false;
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
      const target = findScriptEntryById(manifest, candidate);
      if (!target) continue;
      push(
        'spoofed',
        severityFor(mode, 'spoofed', script.scope),
        script.id,
        `script claims sourceURL ${claimed} which matches approved entry ${target.id}, but its real id has no manifest entry`,
        { scope: script.scope, observed: script, expected: target, before: target.id, after: script.id },
      );
      return true;
    }
    return false;
  }

  function detectMoved(script: ObservedScript): boolean {
    if (script.sha256 === undefined) return false; // no body hash: nothing can have moved
    const original = approvedHashes.get(script.sha256);
    if (!original || original.id === script.id) return false;
    push(
      'moved',
      severityFor(mode, 'moved', script.scope),
      script.id,
      `body matches approved ${original.integrity} entry ${original.id} but was observed from a different source`,
      { scope: script.scope, observed: script, expected: original, before: original.id, after: script.id },
    );
    return true;
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
    const names = new Set<SecurityHeaderName>(SECURITY_HEADER_NAMES);
    for (const name of Object.keys(manifest.headers.values) as SecurityHeaderName[]) names.add(name);
    for (const name of Object.keys(snapshot.headers) as SecurityHeaderName[]) names.add(name);
    for (const name of names) {
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
  };
}
