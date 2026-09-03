/**
 * Adding and refreshing manifest entries from a snapshot (`scriptlock approve`).
 *
 * Owns: `approveScripts()`, `approveMatch()`, `approveFrames()`,
 * `refreshTracked()`, `refreshScripts()`, `redundantScriptEntries()`,
 * `ApproveMeta`, `ApproveFrameMeta`, `ApproveHelpers`.
 *
 * All functions are pure: they return a new Manifest and never mutate the
 * input. Integrity defaults follow DESIGN.md section 6. First-party detection
 * uses `helpers.isFirstParty` when given, otherwise `isFirstParty` from the
 * identity module (script host equals the main-frame host or is a subdomain
 * of it). blob: scripts are judged by their embedded origin and data: scripts
 * by the frame origin. Limitations: the main origin comes from the snapshot's
 * main frame, falling back to `finalUrl`; a snapshot without either cannot
 * classify parties and treats everything as third-party.
 *
 * A glob entry created by `approveMatch()` authorises many bodies and is never
 * pinned to one of them: `strict` and `structural` are refused, no hash is
 * written, both refresh paths leave it alone, and `approveScripts()` adds a new
 * exact entry rather than overwriting the glob when one of the ids it covers is
 * approved on its own. The glob itself must pass `globNarrowness` (one
 * directory of one host).
 */
import { ScriptlockError } from '../errors.js';
import { isFirstParty as identityIsFirstParty } from '../identity/identity.js';
import type {
  CoveredAtApproval,
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
  ScriptKind,
  Snapshot,
} from '../types.js';
import { findFrameEntry, findScriptEntry, globMatches, globNarrowness, isIgnored } from './match.js';

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

function defaultIntegrityMethod(policy: IntegrityPolicy): IntegrityMethod {
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

/** Punctuation-only text (`...`) or an unfilled `<placeholder>` from a printed command. */
const PLACEHOLDER = /^(?:[.<>\s]*|<[^<>]*>)$/;

/**
 * The manifest is the evidence artifact, so a field that still holds the
 * placeholder printed by `diff`, `init` or a hint is refused rather than
 * written: `justification: ...` documents nothing.
 */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

function assertNotPlaceholder(subject: string, field: string, value: string): void {
  if (!isPlaceholder(value)) return;
  throw new ScriptlockError('UNSUPPORTED', `Approving ${subject} requires a real ${field}, not the placeholder "${value}"`, {
    hint: `Replace the placeholder from the printed command with the actual ${field}`,
  });
}

function requireMeta(id: string, meta: ApproveMeta): { owner: string; category: ScriptCategory; justification: string } {
  const { owner, category, justification } = meta;
  const missing: string[] = [];
  if (owner === undefined || owner === '') missing.push('owner');
  if (category === undefined) missing.push('category');
  if (justification === undefined || justification === '') missing.push('justification');
  if (owner === undefined || category === undefined || justification === undefined || missing.length > 0) {
    throw new ScriptlockError('UNSUPPORTED', `Approving new script ${id} requires ${missing.join(', ')}`, {
      hint: 'Pass --owner, --category and --justification',
    });
  }
  assertNotPlaceholder(id, 'owner', owner);
  assertNotPlaceholder(id, 'justification', justification);
  return { owner, category, justification };
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
  if (meta.owner !== undefined && meta.owner !== '') assertNotPlaceholder(existing.id, 'owner', meta.owner);
  if (meta.justification !== undefined && meta.justification !== '') assertNotPlaceholder(existing.id, 'justification', meta.justification);
  const integrity = notCaptured ? 'url-only' : (meta.integrity ?? existing.integrity);
  const integrityMethod = notCaptured
    ? (meta.integrityMethod ?? 'none')
    : (meta.integrityMethod ?? (meta.integrity !== undefined && meta.integrity !== existing.integrity ? defaultIntegrityMethod(integrity) : existing.integrityMethod));
  // Rebuilt from `rest` so the hashes and notes below are the only ones set:
  // a stale lastSeenSha256 must not survive a re-approval.
  const { lastSeenSha256: _lastSeen, sha256: _sha, structuralHash: _struct, notes: _notes, ...rest } = existing;
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
 * (exact id, or a pinned entry whose glob matches) refreshes its hashes,
 * approver and date, drops `lastSeenSha256`, and keeps owner, category and
 * justification unless new values are given.
 *
 * An id covered by an unpinned glob entry (`approve --match`) gets its own new
 * exact entry instead: the glob holds no hash and stands for many bodies, so
 * rewriting it from one observation would pin the whole directory to that one
 * script and report every sibling as `changed`. The exact entry wins over the
 * glob in `matchingScriptEntries`, so both coexist.
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
    const matched = scripts.find((entry) => entry.id === observed.id) ?? findScriptEntry({ ...manifest, scripts }, observed);
    const existing = matched !== undefined && isUnpinnedGlobEntry(matched) && matched.id !== observed.id ? undefined : matched;
    if (existing === undefined) {
      scripts.push(newScriptEntry(observed, snapshot, meta, defaults, helpers));
    } else {
      const index = scripts.indexOf(existing);
      scripts[index] = updatedScriptEntry(existing, observed, meta);
    }
  }
  return { ...manifest, scripts };
}

// ---------------------------------------------------------------------------
// Glob entries (`scriptlock approve --match`)
// ---------------------------------------------------------------------------

/** Integrity of a glob entry when neither the flag nor an existing entry says otherwise. */
const GLOB_INTEGRITY: IntegrityPolicy = 'track';

/**
 * Observed scripts (harness excluded, deduplicated by id, in snapshot order)
 * whose id matches `glob` under the manifest matching rules.
 */
export function scriptsMatchingGlob(snapshot: Snapshot, glob: string): ObservedScript[] {
  const seen = new Set<string>();
  const out: ObservedScript[] = [];
  for (const script of snapshot.scripts) {
    if (script.scope === 'harness' || seen.has(script.id)) continue;
    if (!globMatches(glob, script.id)) continue;
    seen.add(script.id);
    out.push(script);
  }
  return out;
}

/** The kind shared by every matched script, otherwise `external`. */
function commonKind(covered: readonly ObservedScript[]): ScriptKind {
  const first = covered[0]?.kind;
  if (first === undefined) return 'external';
  return covered.every((script) => script.kind === first) ? first : 'external';
}

/** Every distinct scope among the matched scripts, in first-observed order. */
function coveredScopes(covered: readonly ObservedScript[]): Scope[] {
  const scopes: Scope[] = [];
  for (const script of covered) if (!scopes.includes(script.scope)) scopes.push(script.scope);
  return scopes;
}

/** Ids the glob authorised at approval time, capped so one entry stays readable. */
export const COVERAGE_EVIDENCE_LIMIT = 50;

function coverageEvidence(snapshot: Snapshot, covered: readonly ObservedScript[]): CoveredAtApproval {
  return {
    count: covered.length,
    scannedAt: snapshot.finishedAt,
    ids: covered.slice(0, COVERAGE_EVIDENCE_LIMIT).map((script) => script.id),
  };
}

/**
 * True for a `match` entry that was never pinned to a single body: it
 * authorises many scripts with many bodies, so there is no hash to refresh.
 */
function isUnpinnedGlobEntry(entry: ManifestScript): boolean {
  return entry.match !== undefined && entry.sha256 === undefined && entry.structuralHash === undefined;
}

/**
 * Exact-id entries that the glob now also authorises. After `approve --match`
 * they are dead weight: the chunk names they hold are content-hashed and never
 * come back, so every later diff reports each of them as `removed`.
 */
export function redundantScriptEntries(manifest: Manifest, glob: string): ManifestScript[] {
  return manifest.scripts.filter((entry) => entry.match === undefined && entry.id !== glob && globMatches(glob, entry.id));
}

/** Options for `approveMatch`. */
export interface ApproveMatchOptions {
  /** Remove the exact-id entries the glob makes redundant (`approve --match --replace`). */
  replace?: boolean;
}

function assertNarrowGlob(glob: string): void {
  const problem = globNarrowness(glob);
  if (problem === undefined) return;
  throw new ScriptlockError(
    'UNSUPPORTED',
    `Refusing the glob ${glob}: ${problem.reason}. A glob entry authorises every id that matches it, on this deploy and on every future one, and none of those bodies is ever hashed`,
    { hint: problem.hint },
  );
}

/**
 * Creates or updates the single entry that authorises every observed script
 * matching `glob` (content-hashed build output). The entry's `id` and `match`
 * are both the glob, so it is only ever reached through glob matching and each
 * observed script keeps its own identity and body hash in the inventory.
 *
 * The glob must be narrow (see `globNarrowness`): one directory of one http(s)
 * host, with the wildcard inside that directory. `kind` is derived from the
 * matched scripts (their shared value, otherwise `external`). The scope is
 * theirs when they share one; a glob that spans scopes is refused unless
 * `meta.scope` names the scope deliberately, because a merchant-scope glob
 * must not silently authorise a script running in a provider frame.
 *
 * Integrity is `track` / `source-tracked`: the glob stands for many bodies now
 * and for unknown bodies later, so `strict` and `structural` are refused and no
 * sha256 or structuralHash is ever written on the entry. `coveredAtApproval`
 * records what the glob authorised when it was approved, so the lockfile itself
 * carries the breadth evidence.
 *
 * Throws SNAPSHOT_INVALID when the glob matches nothing.
 */
export function approveMatch(
  manifest: Manifest,
  snapshot: Snapshot,
  glob: string,
  meta: ApproveMeta,
  options: ApproveMatchOptions = {},
): Manifest {
  assertNarrowGlob(glob);
  const covered = scriptsMatchingGlob(snapshot, glob);
  if (covered.length === 0) {
    const observed = snapshot.scripts.filter((script) => script.scope !== 'harness').length;
    throw new ScriptlockError(
      'SNAPSHOT_INVALID',
      `Glob ${glob} matches none of the ${observed} scripts observed in the snapshot for profile ${snapshot.profile}`,
      {
        hint: 'The glob is matched against observed script ids (normalised URLs), not against file paths; check it against "scriptlock scan" output',
      },
    );
  }

  const redundant = options.replace === true ? new Set(redundantScriptEntries(manifest, glob)) : new Set<ManifestScript>();
  const scripts = manifest.scripts.filter((entry) => !redundant.has(entry));
  const index = scripts.findIndex((entry) => entry.id === glob || entry.match === glob);
  const existing = index === -1 ? undefined : scripts[index];
  const integrity = meta.integrity ?? existing?.integrity ?? GLOB_INTEGRITY;
  if (integrity === 'strict' || integrity === 'structural') {
    throw new ScriptlockError(
      'UNSUPPORTED',
      `Cannot apply ${integrity} integrity to the glob ${glob}: it authorises ${covered.length} observed script${covered.length === 1 ? '' : 's'} today and any file matching it tomorrow, while one entry holds a single approved hash, which cannot stand for all of their bodies`,
      {
        hint: 'Use --integrity track (the default for a glob) and assure the bodies of these files in the build pipeline, or approve each id on its own with --integrity strict',
      },
    );
  }

  const scopes = coveredScopes(covered);
  // `covered` is non-empty (checked above), so it contributed at least one scope.
  const [primaryScope] = scopes;
  if (primaryScope === undefined) {
    throw new ScriptlockError('SNAPSHOT_INVALID', `Glob ${glob} matched scripts with no scope`, {
      hint: 'Re-run "scriptlock scan" and approve from the fresh snapshot',
    });
  }
  if (meta.scope === undefined && scopes.length > 1) {
    throw new ScriptlockError(
      'UNSUPPORTED',
      `The glob ${glob} matches scripts in ${scopes.length} scopes (${scopes.join(', ')}) and one entry records one scope, so it would authorise scripts outside the scope it names`,
      {
        hint: `Narrow the glob, or name the scope the entry stands for with --scope ${primaryScope} (the glob still authorises the scripts in the other scopes, and each is reported as scope-changed)`,
      },
    );
  }

  const required =
    existing === undefined
      ? requireMeta(glob, meta)
      : {
          owner: meta.owner !== undefined && meta.owner !== '' ? meta.owner : existing.owner,
          category: meta.category ?? existing.category,
          justification: meta.justification !== undefined && meta.justification !== '' ? meta.justification : existing.justification,
        };
  if (existing !== undefined) {
    assertNotPlaceholder(glob, 'owner', required.owner);
    assertNotPlaceholder(glob, 'justification', required.justification);
  }
  const integrityMethod =
    meta.integrityMethod ?? (existing !== undefined && existing.integrity === integrity ? existing.integrityMethod : defaultIntegrityMethod(integrity));
  const notes = meta.notes ?? existing?.notes;

  const entry: ManifestScript = {
    id: existing?.id ?? glob,
    match: glob,
    kind: commonKind(covered),
    scope: meta.scope ?? primaryScope,
    integrity,
    integrityMethod,
    owner: required.owner,
    category: required.category,
    justification: required.justification,
    approvedBy: meta.approvedBy,
    approvedAt: meta.approvedAt,
    coveredAtApproval: coverageEvidence(snapshot, covered),
    ...(notes !== undefined ? { notes } : {}),
  };

  if (index === -1) scripts.push(entry);
  else scripts[index] = entry;
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

/** The first frame whose URL matches `glob` under the manifest matching rules. */
function findFrameByGlob(frames: readonly FrameInfo[], glob: string): FrameInfo | undefined {
  return frames.find((frame) => globMatches(glob, frame.url));
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
      const { owner, justification } = meta;
      const missing: string[] = [];
      if (owner === undefined || owner === '') missing.push('owner');
      if (justification === undefined || justification === '') missing.push('justification');
      if (owner === undefined || justification === undefined || missing.length > 0) {
        throw new ScriptlockError('UNSUPPORTED', `Approving new frame ${match} requires ${missing.join(', ')}`, {
          hint: 'Pass --owner and --justification',
        });
      }
      const entry: ManifestFrame = {
        match,
        scope: meta.scope ?? frame.scope,
        owner,
        justification,
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
 * Entries not observed are left untouched, and so is a `match` glob entry that
 * carries no approved hash: it covers many bodies, so recording one of them
 * would claim a body the entry never approved.
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
    if (isUnpinnedGlobEntry(entry)) return entry; // one glob, many bodies: nothing to track
    if (observed.sha256 === undefined) return entry; // body not captured: nothing to track
    if (entry.sha256 === observed.sha256) {
      if (entry.lastSeenSha256 === undefined) return entry;
      const { lastSeenSha256: _lastSeen, ...rest } = entry;
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
 * SNAPSHOT_INVALID. A `match` glob entry with no approved hash is left
 * untouched: it covers many bodies and none of them is the approved one.
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
    if (!targets.has(entry) || isUnpinnedGlobEntry(entry)) return entry;
    const observed = observedFor.get(entry);
    if (observed === undefined) return entry;
    const { lastSeenSha256: _lastSeen, sha256: _sha, structuralHash: _struct, ...rest } = entry;
    const next: ManifestScript = { ...rest };
    if (observed.sha256 !== undefined) next.sha256 = observed.sha256;
    if (observed.structuralHash !== undefined) next.structuralHash = observed.structuralHash;
    if (meta.approvedBy !== undefined) next.approvedBy = meta.approvedBy;
    if (meta.approvedAt !== undefined) next.approvedAt = meta.approvedAt;
    return next;
  });
  return { ...manifest, scripts };
}
