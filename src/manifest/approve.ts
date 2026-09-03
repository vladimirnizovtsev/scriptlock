/**
 * Adding and refreshing manifest entries from a snapshot (`scriptlock approve`).
 *
 * Owns: `approveScripts()`, `approveFrames()`, `refreshTracked()`,
 * `refreshScripts()`, `ApproveMeta`, `ApproveFrameMeta`, `ApproveHelpers`.
 *
 * All functions are pure: they return a new Manifest and never mutate the
 * input. Integrity defaults follow DESIGN.md section 6. First-party detection
 * uses `helpers.isFirstParty` when given, otherwise `isFirstParty` from the
 * identity module (script host equals the main-frame host or is a subdomain
 * of it). blob: scripts are judged by their embedded origin and data: scripts
 * by the frame origin. Limitations: the main origin comes from the snapshot's
 * main frame, falling back to `finalUrl`; a snapshot without either cannot
 * classify parties and treats everything as third-party.
 */
import { ScriptlockError } from '../errors.js';
import { isFirstParty as identityIsFirstParty } from '../identity/identity.js';
import type {
  FrameInfo,
  IntegrityDefaults,
  IntegrityMethod,
  IntegrityPolicy,
  Manifest,
  ManifestFrame,
  ManifestScript,
  ObservedScript,
  Scope,
  ScriptCategory,
  Snapshot,
} from '../types.js';
import { findFrameEntry, findScriptEntry, isIgnored } from './match.js';

export interface ApproveMeta {
  owner?: string;
  category?: ScriptCategory;
  justification?: string;
  approvedBy: string;
  /** ISO date (YYYY-MM-DD). */
  approvedAt: string;
  /** Overrides the integrity default derived from kind and party. */
  integrity?: IntegrityPolicy;
  /** Overrides the method default derived from the policy. */
  integrityMethod?: IntegrityMethod;
  /** Overrides the observed scope. */
  scope?: Scope;
  notes?: string;
}

export interface ApproveFrameMeta {
  owner?: string;
  justification?: string;
  approvedBy: string;
  approvedAt: string;
  scope?: Scope;
}

export interface ApproveHelpers {
  /** True when `url` belongs to the first party of `mainOrigin`. */
  isFirstParty?: (url: string, mainOrigin: string) => boolean;
}

/** Literal accepted in place of ids to mean "every unapproved script / frame". */
export const ALL_NEW = '*';

/**
 * The URL whose host decides the party of a URL-addressed script: the URL
 * itself, the origin embedded in a `blob:` id, or the frame origin for
 * `data:` scripts and scripts without a URL.
 */
export function firstPartySubject(observed: Pick<ObservedScript, 'url' | 'rawUrl' | 'frameOrigin'>): string {
  const url = observed.url ?? observed.rawUrl;
  if (url === undefined || url.startsWith('data:')) return observed.frameOrigin;
  if (url.startsWith('blob:')) return url.slice('blob:'.length);
  return url;
}

function mainOriginOf(snapshot: Snapshot): string | undefined {
  const main = snapshot.frames.find((frame) => frame.isMain);
  if (main !== undefined && main.origin) return main.origin;
  try {
    return new URL(snapshot.finalUrl || snapshot.url).origin;
  } catch {
    return undefined;
  }
}

export function defaultIntegrityMethod(policy: IntegrityPolicy): IntegrityMethod {
  return policy === 'strict' || policy === 'structural' ? 'hash-strict' : 'source-tracked';
}

/**
 * True when a script's body was never read, so no body hash exists: worker
 * entries (v1 records the URL only) and any observation missing a sha256.
 * Such entries can only be url-only; strict/structural would claim enforcement
 * of a body Scriptlock never saw.
 */
export function bodyNotCaptured(observed: Pick<ObservedScript, 'kind' | 'sha256'>): boolean {
  return observed.kind === 'worker' || observed.sha256 === undefined;
}

/** Integrity policy for an observed script per DESIGN.md section 6. */
export function defaultIntegrityFor(
  observed: ObservedScript,
  snapshot: Snapshot,
  defaults: IntegrityDefaults,
  helpers: ApproveHelpers = {},
): IntegrityPolicy {
  if (bodyNotCaptured(observed)) return 'url-only';
  if (observed.kind === 'inline') return defaults.inline;
  if (observed.kind === 'eval') return defaults.eval;
  const isFirstParty = helpers.isFirstParty ?? identityIsFirstParty;
  const mainOrigin = mainOriginOf(snapshot);
  if (mainOrigin === undefined) return defaults.thirdParty;
  return isFirstParty(firstPartySubject(observed), mainOrigin) ? defaults.firstParty : defaults.thirdParty;
}

function requireMeta(id: string, meta: ApproveMeta): { owner: string; category: ScriptCategory; justification: string } {
  const missing: string[] = [];
  if (meta.owner === undefined || meta.owner === '') missing.push('owner');
  if (meta.category === undefined) missing.push('category');
  if (meta.justification === undefined || meta.justification === '') missing.push('justification');
  if (missing.length > 0) {
    throw new ScriptlockError('UNSUPPORTED', `Approving new script ${id} requires ${missing.join(', ')}`, {
      hint: 'Pass --owner, --category and --justification',
    });
  }
  return { owner: meta.owner as string, category: meta.category as ScriptCategory, justification: meta.justification as string };
}

function resolveScriptIds(manifest: Manifest, snapshot: Snapshot, ids: readonly string[]): ObservedScript[] {
  const byId = new Map<string, ObservedScript>();
  for (const script of snapshot.scripts) {
    if (script.scope !== 'harness' && !byId.has(script.id)) byId.set(script.id, script);
  }
  const selected = new Map<string, ObservedScript>();
  for (const id of ids) {
    if (id === ALL_NEW) {
      for (const script of byId.values()) {
        if (findScriptEntry(manifest, script) === undefined && !isIgnored(manifest, script.id)) {
          selected.set(script.id, script);
        }
      }
      continue;
    }
    const script = byId.get(id);
    if (script === undefined) {
      throw new ScriptlockError(
        'SNAPSHOT_INVALID',
        `Script ${id} was not observed in the snapshot for profile ${snapshot.profile} (${snapshot.scripts.length} scripts recorded)`,
        { hint: 'Check the id against "scriptlock scan" output, or use --all-new to approve every unapproved script' },
      );
    }
    selected.set(script.id, script);
  }
  return [...selected.values()];
}

function assertHashable(id: string, meta: ApproveMeta, notCaptured: boolean): void {
  if (notCaptured && (meta.integrity === 'strict' || meta.integrity === 'structural')) {
    throw new ScriptlockError(
      'UNSUPPORTED',
      `Cannot apply ${meta.integrity} integrity to ${id}: its body was not captured (worker entries record the URL only)`,
      { hint: 'Approve it with --integrity url-only, or omit --integrity to use the default' },
    );
  }
}

function newScriptEntry(observed: ObservedScript, snapshot: Snapshot, meta: ApproveMeta, defaults: IntegrityDefaults, helpers: ApproveHelpers): ManifestScript {
  const required = requireMeta(observed.id, meta);
  const notCaptured = bodyNotCaptured(observed);
  assertHashable(observed.id, meta, notCaptured);
  const integrity = notCaptured ? 'url-only' : (meta.integrity ?? defaultIntegrityFor(observed, snapshot, defaults, helpers));
  const integrityMethod = notCaptured ? (meta.integrityMethod ?? 'none') : (meta.integrityMethod ?? defaultIntegrityMethod(integrity));
  const entry: ManifestScript = {
    id: observed.id,
    kind: observed.kind,
    scope: meta.scope ?? observed.scope,
    integrity,
    integrityMethod,
    owner: required.owner,
    category: required.category,
    justification: required.justification,
    approvedBy: meta.approvedBy,
    approvedAt: meta.approvedAt,
    ...(meta.notes !== undefined ? { notes: meta.notes } : {}),
  };
  if (observed.sha256 !== undefined) entry.sha256 = observed.sha256;
  if (observed.structuralHash !== undefined) entry.structuralHash = observed.structuralHash;
  return entry;
}

function updatedScriptEntry(existing: ManifestScript, observed: ObservedScript, meta: ApproveMeta): ManifestScript {
  const notCaptured = bodyNotCaptured(observed);
  assertHashable(existing.id, meta, notCaptured);
  const integrity = notCaptured ? 'url-only' : (meta.integrity ?? existing.integrity);
  const integrityMethod = notCaptured
    ? (meta.integrityMethod ?? 'none')
    : (meta.integrityMethod ?? (meta.integrity !== undefined && meta.integrity !== existing.integrity ? defaultIntegrityMethod(integrity) : existing.integrityMethod));
  const { lastSeenSha256: _dropped, sha256: _sha, structuralHash: _struct, notes: _notes, ...rest } = existing;
  void _dropped;
  void _sha;
  void _struct;
  void _notes;
  const entry: ManifestScript = {
    ...rest,
    kind: observed.kind,
    scope: meta.scope ?? existing.scope,
    integrity,
    integrityMethod,
    owner: meta.owner !== undefined && meta.owner !== '' ? meta.owner : existing.owner,
    category: meta.category ?? existing.category,
    justification: meta.justification !== undefined && meta.justification !== '' ? meta.justification : existing.justification,
    approvedBy: meta.approvedBy,
    approvedAt: meta.approvedAt,
  };
  if (observed.sha256 !== undefined) entry.sha256 = observed.sha256;
  if (observed.structuralHash !== undefined) entry.structuralHash = observed.structuralHash;
  const notes = meta.notes !== undefined ? meta.notes : existing.notes;
  if (notes !== undefined) entry.notes = notes;
  return entry;
}

/**
 * Approves scripts from the snapshot. `ids` are observed ids, or the literal
 * `*` for every script without an entry (and not ignored). An id not present
 * in the snapshot throws SNAPSHOT_INVALID. Re-approving an existing entry
 * (exact id, or an entry whose glob matches) refreshes its hashes, approver
 * and date, drops `lastSeenSha256`, and keeps owner, category and
 * justification unless new values are given.
 */
export function approveScripts(
  manifest: Manifest,
  snapshot: Snapshot,
  ids: readonly string[],
  meta: ApproveMeta,
  defaults: IntegrityDefaults,
  helpers: ApproveHelpers = {},
): Manifest {
  const scripts = [...manifest.scripts];
  for (const observed of resolveScriptIds(manifest, snapshot, ids)) {
    const existing = scripts.find((entry) => entry.id === observed.id) ?? findScriptEntry({ ...manifest, scripts }, observed);
    if (existing === undefined) {
      scripts.push(newScriptEntry(observed, snapshot, meta, defaults, helpers));
    } else {
      const index = scripts.indexOf(existing);
      scripts[index] = updatedScriptEntry(existing, observed, meta);
    }
  }
  return { ...manifest, scripts };
}

function resolveFrames(manifest: Manifest, snapshot: Snapshot, matches: readonly string[]): FrameInfo[] {
  const candidates = snapshot.frames.filter((frame) => !frame.isMain && frame.crossOrigin);
  const selected = new Map<string, FrameInfo>();
  for (const match of matches) {
    if (match === ALL_NEW) {
      for (const frame of candidates) {
        if (findFrameEntry(manifest, frame) === undefined) selected.set(frame.url, frame);
      }
      continue;
    }
    const frame = snapshot.frames.find((candidate) => candidate.url === match) ?? findFrameByGlob(candidates, match);
    if (frame === undefined) {
      throw new ScriptlockError('SNAPSHOT_INVALID', `Frame ${match} was not observed in the snapshot for profile ${snapshot.profile}`, {
        hint: 'Check the frame URL against "scriptlock scan" output',
      });
    }
    selected.set(match, frame);
  }
  return [...selected.values()];
}

function findFrameByGlob(frames: readonly FrameInfo[], glob: string): FrameInfo | undefined {
  const probe: Manifest = {
    version: 1,
    profile: '',
    url: '',
    headers: { policy: 'ignore', values: {} },
    frames: [{ match: glob, scope: 'embedded', owner: '', justification: '', approvedBy: '', approvedAt: '' }],
    scripts: [],
    ignore: [],
  };
  return frames.find((frame) => findFrameEntry(probe, frame) !== undefined);
}

/**
 * Approves cross-origin frames. `matches` are observed frame URLs, globs that
 * match at least one observed cross-origin frame, or `*` for every
 * cross-origin frame without an entry. The entry's `match` is the value
 * given (or the frame URL for `*`).
 */
export function approveFrames(manifest: Manifest, snapshot: Snapshot, matches: readonly string[], meta: ApproveFrameMeta): Manifest {
  const frames = [...manifest.frames];
  const wanted = new Map<string, FrameInfo>();
  for (const match of matches) {
    for (const frame of resolveFrames(manifest, snapshot, [match])) {
      wanted.set(match === ALL_NEW ? frame.url : match, frame);
    }
  }
  for (const [match, frame] of wanted) {
    const index = frames.findIndex((entry) => entry.match === match);
    const existing = index === -1 ? undefined : frames[index];
    if (existing === undefined) {
      const missing: string[] = [];
      if (meta.owner === undefined || meta.owner === '') missing.push('owner');
      if (meta.justification === undefined || meta.justification === '') missing.push('justification');
      if (missing.length > 0) {
        throw new ScriptlockError('UNSUPPORTED', `Approving new frame ${match} requires ${missing.join(', ')}`, {
          hint: 'Pass --owner and --justification',
        });
      }
      const entry: ManifestFrame = {
        match,
        scope: meta.scope ?? frame.scope,
        owner: meta.owner as string,
        justification: meta.justification as string,
        approvedBy: meta.approvedBy,
        approvedAt: meta.approvedAt,
      };
      frames.push(entry);
    } else {
      frames[index] = {
        ...existing,
        scope: meta.scope ?? existing.scope,
        owner: meta.owner !== undefined && meta.owner !== '' ? meta.owner : existing.owner,
        justification: meta.justification !== undefined && meta.justification !== '' ? meta.justification : existing.justification,
        approvedBy: meta.approvedBy,
        approvedAt: meta.approvedAt,
      };
    }
  }
  return { ...manifest, frames };
}

/**
 * Updates `lastSeenSha256` on every `track` entry observed with a body that
 * differs from the approved `sha256`; removes it when the body matches again.
 * Entries not observed are left untouched.
 */
export function refreshTracked(manifest: Manifest, snapshot: Snapshot): Manifest {
  const observedFor = new Map<ManifestScript, ObservedScript>();
  for (const observed of snapshot.scripts) {
    if (observed.scope === 'harness') continue;
    const entry = findScriptEntry(manifest, observed);
    if (entry !== undefined && entry.integrity === 'track' && !observedFor.has(entry)) observedFor.set(entry, observed);
  }
  const scripts = manifest.scripts.map((entry) => {
    const observed = observedFor.get(entry);
    if (observed === undefined) return entry;
    if (observed.sha256 === undefined) return entry; // body not captured: nothing to track
    if (entry.sha256 === observed.sha256) {
      if (entry.lastSeenSha256 === undefined) return entry;
      const { lastSeenSha256: _dropped, ...rest } = entry;
      void _dropped;
      return rest;
    }
    if (entry.lastSeenSha256 === observed.sha256) return entry;
    return { ...entry, lastSeenSha256: observed.sha256 };
  });
  return { ...manifest, scripts };
}

/**
 * Refreshes `sha256` and `structuralHash` (and drops `lastSeenSha256`) on the
 * listed entries from the snapshot without changing approval metadata, unless
 * `approvedBy` / `approvedAt` are given. `ids` may be `*` for every entry
 * that was observed. An id with no manifest entry or not observed throws
 * SNAPSHOT_INVALID.
 */
export function refreshScripts(
  manifest: Manifest,
  snapshot: Snapshot,
  ids: readonly string[],
  meta: { approvedBy?: string; approvedAt?: string } = {},
): Manifest {
  const observedFor = new Map<ManifestScript, ObservedScript>();
  for (const observed of snapshot.scripts) {
    if (observed.scope === 'harness') continue;
    const entry = findScriptEntry(manifest, observed);
    if (entry !== undefined && !observedFor.has(entry)) observedFor.set(entry, observed);
  }
  const targets = new Set<ManifestScript>();
  for (const id of ids) {
    if (id === ALL_NEW) {
      for (const entry of observedFor.keys()) targets.add(entry);
      continue;
    }
    const entry = manifest.scripts.find((candidate) => candidate.id === id) ?? findScriptEntry(manifest, { id });
    if (entry === undefined) {
      throw new ScriptlockError('SNAPSHOT_INVALID', `Script ${id} has no manifest entry to refresh`, {
        hint: 'Use "scriptlock approve" to add it first',
      });
    }
    if (!observedFor.has(entry)) {
      throw new ScriptlockError('SNAPSHOT_INVALID', `Script ${id} was not observed in the snapshot for profile ${snapshot.profile}`);
    }
    targets.add(entry);
  }
  const scripts = manifest.scripts.map((entry) => {
    if (!targets.has(entry)) return entry;
    const observed = observedFor.get(entry) as ObservedScript;
    const { lastSeenSha256: _dropped, sha256: _sha, structuralHash: _struct, ...rest } = entry;
    void _dropped;
    void _sha;
    void _struct;
    const next: ManifestScript = { ...rest };
    if (observed.sha256 !== undefined) next.sha256 = observed.sha256;
    if (observed.structuralHash !== undefined) next.structuralHash = observed.structuralHash;
    if (meta.approvedBy !== undefined) next.approvedBy = meta.approvedBy;
    if (meta.approvedAt !== undefined) next.approvedAt = meta.approvedAt;
    return next;
  });
  return { ...manifest, scripts };
}
