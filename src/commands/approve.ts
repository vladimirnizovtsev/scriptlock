/**
 * `scriptlock approve` (DESIGN.md section 8): turn observed scripts and frames
 * from the last snapshot (or `--snapshot`) into manifest entries, authorise a
 * whole build directory with one glob entry via `--match`, re-approve existing
 * entries with their current hashes, refresh tracked hashes with `--refresh`,
 * and record the observed security headers with `--headers`.
 * The manifest is created (headers policy strict, values from the snapshot)
 * when it does not exist yet; `--all-new` also approves every cross-origin
 * frame without an entry and adds headers that are observed but not yet
 * recorded. `--approved-by` defaults to `git config user.name`, then $USER,
 * then "unknown"; `approvedAt` is today's UTC date.
 *
 * Limitations: a blocked snapshot is refused (SCAN_BLOCKED) because its
 * inventory is unreliable. Owner, category and justification are required
 * only when a new entry is created; re-approval keeps the existing values.
 * `--match` writes exactly one entry and therefore cannot be combined with
 * script ids, `--all-new` or `--refresh`; it lists every id the glob authorises
 * with its scope (never truncated: the glob is the widest authorisation in the
 * manifest), and reports the exact-id entries it makes redundant, which
 * `--replace` removes.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import path from 'node:path';
import { manifestPathFor } from '../config/load.js';
import { isScriptlockError, ScriptlockError } from '../errors.js';
import {
  ALL_NEW,
  approveFrames,
  approveMatch,
  approveScripts,
  redundantScriptEntries,
  refreshScripts,
  refreshTracked,
  scriptsMatchingGlob,
  type ApproveFrameMeta,
  type ApproveMeta,
} from '../manifest/approve.js';
import { emptyManifest, readManifest, writeManifest } from '../manifest/io.js';
import {
  SECURITY_HEADER_NAMES,
  type IntegrityMethod,
  type IntegrityPolicy,
  type Manifest,
  type ManifestScript,
  type Scope,
  type ScriptCategory,
  type SecurityHeaders,
  type Snapshot,
} from '../types.js';
import { lastSnapshotPath, loadProfile, plural, readSnapshot, type CommandContext } from './scan.js';

export const SCRIPT_CATEGORIES: readonly ScriptCategory[] = [
  'payment',
  'functional',
  'framework',
  'tag-manager',
  'analytics',
  'marketing',
  'advertising',
  'consent',
  'customer-success',
  'security',
  'ab-testing',
  'cdn',
  'other',
];
export const INTEGRITY_POLICIES: readonly IntegrityPolicy[] = ['strict', 'structural', 'track', 'url-only'];
export const INTEGRITY_METHODS: readonly IntegrityMethod[] = ['hash-strict', 'sri', 'csp', 'vendor-attested', 'source-tracked', 'none'];
export const APPROVABLE_SCOPES: readonly Scope[] = ['merchant', 'tpsp', 'threeds', 'embedded'];

export interface ApproveCommandOptions {
  profile: string;
  /** Observed script ids to approve (or refresh with `refresh`). */
  ids?: readonly string[] | undefined;
  /** Approve every script and cross-origin frame without an entry. */
  allNew?: boolean | undefined;
  /**
   * Authorise every observed script matching this glob with one entry whose
   * `id` and `match` are the glob. For content-hashed build output.
   */
  match?: string | undefined;
  /** With `--match`: remove the exact-id entries the glob makes redundant. */
  replace?: boolean | undefined;
  owner?: string | undefined;
  category?: ScriptCategory | undefined;
  justification?: string | undefined;
  integrity?: IntegrityPolicy | undefined;
  integrityMethod?: IntegrityMethod | undefined;
  approvedBy?: string | undefined;
  scope?: Scope | undefined;
  notes?: string | undefined;
  /** Refresh lastSeenSha256 on track entries and the hashes of the listed entries. */
  refresh?: boolean | undefined;
  /** Replace the approved security header values with the observed ones. */
  headers?: boolean | undefined;
  /** Snapshot file (relative to cwd) instead of `.scriptlock/last.<profile>.json`. */
  snapshot?: string | undefined;
}

export interface ApproveCommandResult {
  manifest: Manifest;
  manifestPath: string;
  snapshotPath: string;
  /** True when the manifest did not exist before. */
  created: boolean;
  approvedBy: string;
  approvedAt: string;
  /** Script ids added as new entries. */
  added: string[];
  /** Existing entries re-approved with their current hashes. */
  updated: string[];
  /** Frame matches added. */
  framesAdded: string[];
  /** Entries whose lastSeenSha256 or approved hashes were refreshed. */
  refreshed: string[];
  /** Observed script ids authorised by the `--match` entry, when `--match` was used. */
  covered?: string[];
  /** Exact-id entries the `--match` glob makes redundant (removed when `--replace`). */
  redundant?: string[];
  /** True when `--replace` removed the redundant entries. */
  replaced?: boolean;
  /** True when header values were written from the snapshot. */
  headersRecorded: boolean;
}

/** `git config user.name`, then $USER / $USERNAME, then "unknown". */
export function detectApprover(env: Record<string, string | undefined> = process.env, cwd?: string): string {
  try {
    const options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] };
    if (cwd !== undefined) options.cwd = cwd;
    const result = spawnSync('git', ['config', 'user.name'], options);
    const name = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (name !== '') return name;
  } catch {
    // git is not installed or not runnable; fall through to the environment.
  }
  const user = env['USER'] ?? env['USERNAME'];
  return user !== undefined && user.trim() !== '' ? user.trim() : 'unknown';
}

/** Today's UTC date as YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function assertChoice<T extends string>(value: string | undefined, choices: readonly T[], flag: string): asserts value is T | undefined {
  if (value !== undefined && !(choices as readonly string[]).includes(value)) {
    throw new ScriptlockError('UNSUPPORTED', `invalid value "${value}" for ${flag}; expected one of ${choices.join(', ')}`, { exitCode: 2 });
  }
}

function entryKey(entry: ManifestScript): string {
  return JSON.stringify(entry);
}

function describeEntry(entry: ManifestScript): string {
  return `${entry.id} (${entry.kind}, ${entry.scope}, ${entry.integrity}/${entry.integrityMethod})`;
}

/**
 * Refuses to create a manifest out of nothing. A snapshot with no script and
 * no security header is what a typo'd URL, an error page or a page that never
 * loaded produces; approving it writes an empty inventory that every later
 * `diff` would have to call clean.
 */
function assertWorthApproving(snapshot: Snapshot, snapshotPath: string): void {
  const scripts = snapshot.scripts.filter((script) => script.scope !== 'harness').length;
  if (scripts > 0 || Object.keys(snapshot.headers).length > 0) return;
  const status = snapshot.documentStatus === 0 ? 'no response' : `HTTP ${snapshot.documentStatus}`;
  throw new ScriptlockError(
    'UNSUPPORTED',
    `snapshot ${snapshotPath} recorded no scripts and no security headers (${snapshot.url}, ${status}); refusing to create a manifest that authorises nothing`,
    {
      exitCode: 2,
      hint: 'Check the profile URL in scriptlock.config.yaml, open it in a browser, then run "scriptlock scan" again',
    },
  );
}

export async function runApprove(ctx: CommandContext, opts: ApproveCommandOptions): Promise<ApproveCommandResult> {
  const ids = [...(opts.ids ?? [])];
  const allNew = opts.allNew === true;
  const refresh = opts.refresh === true;
  const headers = opts.headers === true;
  const replace = opts.replace === true;
  const match = opts.match !== undefined && opts.match.trim() !== '' ? opts.match.trim() : undefined;
  if (ids.length === 0 && !allNew && !refresh && !headers && match === undefined) {
    throw new ScriptlockError('UNSUPPORTED', 'nothing to approve: pass at least one script id, --match, --all-new, --refresh or --headers', {
      exitCode: 2,
      hint: 'Run "scriptlock scan" and pick ids from its output, or use --all-new to approve every unapproved script',
    });
  }
  if (match !== undefined) {
    const conflict = ids.length > 0 ? 'script ids' : allNew ? '--all-new' : refresh ? '--refresh' : undefined;
    if (conflict !== undefined) {
      throw new ScriptlockError('UNSUPPORTED', `--match writes one glob entry and cannot be combined with ${conflict}`, {
        exitCode: 2,
        hint: 'Run "scriptlock approve --match" on its own, then approve the remaining scripts in a second command',
      });
    }
  } else if (replace) {
    throw new ScriptlockError('UNSUPPORTED', '--replace removes the entries a glob makes redundant and only applies with --match', {
      exitCode: 2,
      hint: 'Run "scriptlock approve --match <glob> --replace"',
    });
  }
  assertChoice(opts.category, SCRIPT_CATEGORIES, '--category');
  assertChoice(opts.integrity, INTEGRITY_POLICIES, '--integrity');
  assertChoice(opts.integrityMethod, INTEGRITY_METHODS, '--integrity-method');
  assertChoice(opts.scope, APPROVABLE_SCOPES, '--scope');

  const loaded = await loadProfile(ctx, opts.profile);
  const manifestPath = manifestPathFor(opts.profile, loaded.profile, ctx.cwd);
  const snapshotPath = opts.snapshot !== undefined ? path.resolve(ctx.cwd, opts.snapshot) : lastSnapshotPath(ctx.cwd, opts.profile);
  const snapshot = await readSnapshot(snapshotPath);
  if (snapshot.blocked !== undefined) {
    throw new ScriptlockError(
      'SCAN_BLOCKED',
      `snapshot ${snapshotPath} was recorded behind a bot-management challenge page (${snapshot.blocked.vendor}: ${snapshot.blocked.evidence}); refusing to approve an unreliable inventory`,
      { exitCode: 2, hint: 'Allowlist the scanner (browser.extraHeaders) and run "scriptlock scan" again' },
    );
  }

  let manifest: Manifest;
  let created = false;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    if (!isScriptlockError(error) || error.code !== 'MANIFEST_NOT_FOUND') throw error;
    assertWorthApproving(snapshot, snapshotPath);
    manifest = emptyManifest(opts.profile, loaded.profile.url);
    manifest.headers.values = { ...snapshot.headers };
    created = true;
  }
  const before = manifest;

  const approvedBy = opts.approvedBy !== undefined && opts.approvedBy.trim() !== '' ? opts.approvedBy.trim() : detectApprover(ctx.env ?? process.env, ctx.cwd);
  const approvedAt = todayUtc();
  const meta: ApproveMeta = { approvedBy, approvedAt };
  if (opts.owner !== undefined) meta.owner = opts.owner;
  if (opts.category !== undefined) meta.category = opts.category;
  if (opts.justification !== undefined) meta.justification = opts.justification;
  if (opts.integrity !== undefined) meta.integrity = opts.integrity;
  if (opts.integrityMethod !== undefined) meta.integrityMethod = opts.integrityMethod;
  if (opts.scope !== undefined) meta.scope = opts.scope;
  if (opts.notes !== undefined) meta.notes = opts.notes;

  let headersRecorded = created;
  let covered: string[] | undefined;
  let coveredScopes: Map<string, Scope> | undefined;
  let redundant: string[] | undefined;
  if (match !== undefined) {
    redundant = redundantScriptEntries(manifest, match).map((entry) => entry.id);
    manifest = approveMatch(manifest, snapshot, match, meta, { replace });
    const matched = scriptsMatchingGlob(snapshot, match);
    covered = matched.map((script) => script.id);
    coveredScopes = new Map(matched.map((script) => [script.id, script.scope]));
  } else if (refresh) {
    manifest = refreshTracked(manifest, snapshot);
    const targets = allNew ? [ALL_NEW, ...ids] : ids;
    if (targets.length > 0) manifest = refreshScripts(manifest, snapshot, targets, { approvedBy, approvedAt });
  } else if (ids.length > 0 || allNew) {
    const targets = allNew ? [ALL_NEW, ...ids] : ids;
    manifest = approveScripts(manifest, snapshot, targets, meta, loaded.config.integrity);
    if (allNew) {
      const frameMeta: ApproveFrameMeta = { approvedBy, approvedAt };
      if (opts.owner !== undefined) frameMeta.owner = opts.owner;
      if (opts.justification !== undefined) frameMeta.justification = opts.justification;
      manifest = approveFrames(manifest, snapshot, [ALL_NEW], frameMeta);
      const values: SecurityHeaders = { ...manifest.headers.values };
      let addedHeader = false;
      for (const name of SECURITY_HEADER_NAMES) {
        const observed = snapshot.headers[name];
        if (observed !== undefined && values[name] === undefined) {
          values[name] = observed;
          addedHeader = true;
        }
      }
      if (addedHeader) {
        manifest = { ...manifest, headers: { policy: manifest.headers.policy, values } };
        headersRecorded = true;
      }
    }
  }
  if (headers) {
    manifest = { ...manifest, headers: { policy: manifest.headers.policy, values: { ...snapshot.headers } } };
    headersRecorded = true;
  }

  await writeManifest(manifestPath, manifest);

  const beforeById = new Map(before.scripts.map((entry) => [entry.id, entry]));
  const added: string[] = [];
  const updated: string[] = [];
  const refreshed: string[] = [];
  for (const entry of manifest.scripts) {
    const previous = beforeById.get(entry.id);
    if (previous === undefined) added.push(entry.id);
    else if (entryKey(previous) !== entryKey(entry)) (refresh ? refreshed : updated).push(entry.id);
  }
  const beforeFrames = new Set(before.frames.map((frame) => frame.match));
  const framesAdded = manifest.frames.map((frame) => frame.match).filter((frameMatch) => !beforeFrames.has(frameMatch));
  const afterIds = new Set(manifest.scripts.map((entry) => entry.id));
  const removed = before.scripts.map((entry) => entry.id).filter((id) => !afterIds.has(id));

  const unchanged =
    !created &&
    added.length === 0 &&
    updated.length === 0 &&
    refreshed.length === 0 &&
    framesAdded.length === 0 &&
    removed.length === 0 &&
    JSON.stringify(before.headers) === JSON.stringify(manifest.headers);
  const lines: string[] = [];
  lines.push(`manifest: ${manifestPath} (${created ? 'created' : unchanged ? 'unchanged' : 'updated'})`);
  if (refresh) {
    if (refreshed.length > 0) lines.push(`  ${plural(refreshed.length, 'entry', 'entries')} refreshed`);
    else lines.push('  all tracked entries up to date, nothing to refresh');
  } else {
    const parts = [`${plural(added.length, 'script entry', 'script entries')} added`];
    if (updated.length > 0) parts.push(`${updated.length} re-approved`);
    if (removed.length > 0) parts.push(`${removed.length} removed as redundant`);
    if (framesAdded.length > 0) parts.push(`${plural(framesAdded.length, 'frame entry', 'frame entries')} added`);
    if (headersRecorded) parts.push(`${plural(Object.keys(manifest.headers.values).length, 'security header')} recorded`);
    lines.push(`  ${parts.join(', ')}`);
  }
  if (added.length > 0 || updated.length > 0 || (refresh && refreshed.length > 0)) lines.push(`  approved by ${approvedBy} on ${approvedAt}`);
  const limit = ctx.verbose ? Number.POSITIVE_INFINITY : 25;
  const listed = (label: string, entries: string[]): void => {
    if (entries.length === 0) return;
    lines.push(`  ${label}:`);
    const byId = new Map(manifest.scripts.map((entry) => [entry.id, entry]));
    entries.slice(0, limit).forEach((id) => {
      const entry = byId.get(id);
      lines.push(`    ${entry === undefined ? id : describeEntry(entry)}`);
    });
    if (entries.length > limit) lines.push(`    ... and ${entries.length - limit} more (use --verbose to list all)`);
  };
  listed('added', added);
  listed('re-approved', updated);
  listed('refreshed', refreshed);
  if (match !== undefined && covered !== undefined) {
    // Never truncated: this one entry is the widest authorisation in the
    // manifest, so the approval record must show everything it covered.
    lines.push(`  the glob ${match} authorises ${plural(covered.length, 'observed script')}:`);
    for (const id of covered) lines.push(`    ${id} [${coveredScopes?.get(id) ?? 'unknown'}]`);
    lines.push('  every script it authorises keeps its own identity and body hash in the inventory');
    lines.push('  this entry authorises anything matching the glob, so the integrity of those bodies comes from your build pipeline, not from scriptlock');
    lines.push('  it also exempts them from spoofed and moved detection, which only fire on scripts with no matching entry');
    if (redundant !== undefined && redundant.length > 0) {
      lines.push(`  ${plural(redundant.length, 'existing entry', 'existing entries')} ${replace ? 'removed as redundant' : 'now redundant'}, because the glob authorises the same ids:`);
      for (const id of redundant) lines.push(`    ${id}`);
      if (!replace) {
        lines.push('    every future diff reports them as removed; re-run with --replace to delete them');
      }
    }
  }
  if (framesAdded.length > 0) {
    lines.push('  frames added:');
    for (const frameMatch of framesAdded.slice(0, limit)) lines.push(`    ${frameMatch}`);
  }
  ctx.out(lines.join('\n'));

  const result: ApproveCommandResult = {
    manifest,
    manifestPath,
    snapshotPath,
    created,
    approvedBy,
    approvedAt,
    added,
    updated,
    framesAdded,
    refreshed,
    headersRecorded,
  };
  if (covered !== undefined) result.covered = covered;
  if (redundant !== undefined) {
    result.redundant = redundant;
    result.replaced = replace && redundant.length > 0;
  }
  return result;
}
