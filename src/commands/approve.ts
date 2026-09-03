/**
 * `scriptlock approve` (DESIGN.md section 8): turn observed scripts and frames
 * from the last snapshot (or `--snapshot`) into manifest entries, re-approve
 * existing entries with their current hashes, refresh tracked hashes with
 * `--refresh`, and record the observed security headers with `--headers`.
 * The manifest is created (headers policy strict, values from the snapshot)
 * when it does not exist yet; `--all-new` also approves every cross-origin
 * frame without an entry and adds headers that are observed but not yet
 * recorded. `--approved-by` defaults to `git config user.name`, then $USER,
 * then "unknown"; `approvedAt` is today's UTC date.
 *
 * Limitations: a blocked snapshot is refused (SCAN_BLOCKED) because its
 * inventory is unreliable. Owner, category and justification are required
 * only when a new entry is created; re-approval keeps the existing values.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import path from 'node:path';
import { manifestPathFor } from '../config/load.js';
import { isScriptlockError, ScriptlockError } from '../errors.js';
import {
  ALL_NEW,
  approveFrames,
  approveScripts,
  refreshScripts,
  refreshTracked,
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

export async function runApprove(ctx: CommandContext, opts: ApproveCommandOptions): Promise<ApproveCommandResult> {
  const ids = [...(opts.ids ?? [])];
  const allNew = opts.allNew === true;
  const refresh = opts.refresh === true;
  const headers = opts.headers === true;
  if (ids.length === 0 && !allNew && !refresh && !headers) {
    throw new ScriptlockError('UNSUPPORTED', 'nothing to approve: pass at least one script id, --all-new, --refresh or --headers', {
      exitCode: 2,
      hint: 'Run "scriptlock scan" and pick ids from its output, or use --all-new to approve every unapproved script',
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
  if (refresh) {
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
  const framesAdded = manifest.frames.map((frame) => frame.match).filter((match) => !beforeFrames.has(match));

  const unchanged = !created && added.length === 0 && updated.length === 0 && refreshed.length === 0 && framesAdded.length === 0 && JSON.stringify(before.headers) === JSON.stringify(manifest.headers);
  const lines: string[] = [];
  lines.push(`manifest: ${manifestPath} (${created ? 'created' : unchanged ? 'unchanged' : 'updated'})`);
  if (refresh) {
    if (refreshed.length > 0) lines.push(`  ${plural(refreshed.length, 'entry', 'entries')} refreshed`);
    else lines.push('  all tracked entries up to date, nothing to refresh');
  } else {
    const parts = [`${plural(added.length, 'script entry', 'script entries')} added`];
    if (updated.length > 0) parts.push(`${updated.length} re-approved`);
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
  if (framesAdded.length > 0) {
    lines.push('  frames added:');
    for (const match of framesAdded.slice(0, limit)) lines.push(`    ${match}`);
  }
  ctx.out(lines.join('\n'));

  return { manifest, manifestPath, snapshotPath, created, approvedBy, approvedAt, added, updated, framesAdded, refreshed, headersRecorded };
}
