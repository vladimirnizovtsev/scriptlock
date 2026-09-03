/**
 * `scriptlock report` (DESIGN.md section 8): render the inventory of the last
 * snapshot (or `--snapshot`) with its authorisation status against the
 * manifest (approved / unapproved / stale), grouped by scope, then owner and
 * category, as markdown (report/markdown.ts) or JSON (`renderInventoryJson`
 * here).
 *
 * Limitations: without a manifest every script is reported as unapproved and
 * a warning is printed; the JSON shape is specific to this command and is not
 * the snapshot format.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manifestPathFor } from '../config/load.js';
import { isScriptlockError } from '../errors.js';
import { emptyManifest, readManifest } from '../manifest/io.js';
import { findFrameEntry, findScriptEntry } from '../manifest/match.js';
import { integrityLabel, inventoryStatus, renderInventoryMarkdown, type InventoryStatus } from '../report/markdown.js';
import {
  SECURITY_HEADER_NAMES,
  type Manifest,
  type ManifestScript,
  type ObservedScript,
  type Scope,
  type Snapshot,
} from '../types.js';
import { lastSnapshotPath, loadProfile, readSnapshot, type CommandContext } from './scan.js';

export type ReportFormat = 'md' | 'json';

export const REPORT_FORMATS: readonly ReportFormat[] = ['md', 'json'];

export interface ReportCommandOptions {
  profile: string;
  format?: ReportFormat | undefined;
  /** Snapshot file (relative to cwd) instead of `.scriptlock/last.<profile>.json`. */
  snapshot?: string | undefined;
  /** Write the report to this file (relative to cwd) instead of standard output. */
  out?: string | undefined;
}

export interface ReportCommandResult {
  report: string;
  snapshot: Snapshot;
  manifest: Manifest;
  manifestPath: string;
  /** True when no manifest exists and an empty one was assumed. */
  manifestMissing: boolean;
  outPath?: string;
}

const SCOPE_ORDER: readonly Scope[] = ['merchant', 'tpsp', 'threeds', 'embedded'];

export interface InventoryScriptJson {
  id: string;
  kind: ObservedScript['kind'];
  status: InventoryStatus;
  integrity: string;
  integrityPolicy?: ManifestScript['integrity'];
  integrityMethod?: ManifestScript['integrityMethod'];
  owner?: string;
  category?: ManifestScript['category'];
  justification?: string;
  approvedBy?: string;
  approvedAt?: string;
  url?: string;
  sha256?: string;
  structuralHash?: string;
  entity?: ObservedScript['entity'];
  loadedBy?: string;
  observedInRuns: number;
}

export interface InventoryGroupJson {
  owner: string | null;
  category: string | null;
  scripts: InventoryScriptJson[];
}

export interface InventoryJson {
  profile: string;
  url: string;
  scannedAt: string;
  runs: number;
  blocked?: Snapshot['blocked'];
  summary: { scripts: number; approved: number; unapproved: number; stale: number };
  scopes: { scope: Scope; scripts: number; groups: InventoryGroupJson[] }[];
  frames: { url: string; scope: Scope; status: 'approved' | 'unapproved' }[];
  headers: { policy: Manifest['headers']['policy']; values: Record<string, string> };
}

function scriptJson(script: ObservedScript, entry: ManifestScript | undefined): InventoryScriptJson {
  const out: InventoryScriptJson = {
    id: script.id,
    kind: script.kind,
    status: inventoryStatus(script, entry),
    integrity: integrityLabel(entry),
    observedInRuns: script.observedInRuns,
  };
  if (script.sha256 !== undefined) out.sha256 = script.sha256;
  if (script.structuralHash !== undefined) out.structuralHash = script.structuralHash;
  if (entry !== undefined) {
    out.integrityPolicy = entry.integrity;
    out.integrityMethod = entry.integrityMethod;
    out.owner = entry.owner;
    out.category = entry.category;
    out.justification = entry.justification;
    out.approvedBy = entry.approvedBy;
    out.approvedAt = entry.approvedAt;
  }
  if (script.url !== undefined) out.url = script.url;
  if (script.entity !== undefined) out.entity = script.entity;
  if (script.loadedBy !== undefined) out.loadedBy = script.loadedBy;
  return out;
}

/** Inventory with authorisation status, grouped by scope, then owner and category. */
export function inventoryToJson(snapshot: Snapshot, manifest: Manifest): InventoryJson {
  const scripts = snapshot.scripts.filter((s) => s.scope !== 'harness');
  const rows = scripts.map((script) => {
    const entry = findScriptEntry(manifest, script);
    return { script, entry, json: scriptJson(script, entry) };
  });
  const summary = { scripts: rows.length, approved: 0, unapproved: 0, stale: 0 };
  for (const row of rows) summary[row.json.status] += 1;

  const scopes: InventoryJson['scopes'] = [];
  for (const scope of SCOPE_ORDER) {
    const inScope = rows.filter((row) => row.script.scope === scope);
    if (inScope.length === 0) continue;
    const groups = new Map<string, InventoryGroupJson>();
    for (const row of inScope) {
      const key = row.entry ? `${row.entry.owner} ${row.entry.category}` : ' ';
      let group = groups.get(key);
      if (group === undefined) {
        group = { owner: row.entry?.owner ?? null, category: row.entry?.category ?? null, scripts: [] };
        groups.set(key, group);
      }
      group.scripts.push(row.json);
    }
    const ordered = [...groups.values()].sort((a, b) => {
      if (a.owner === null) return 1;
      if (b.owner === null) return -1;
      return `${a.owner}/${a.category}`.localeCompare(`${b.owner}/${b.category}`);
    });
    for (const group of ordered) group.scripts.sort((a, b) => a.id.localeCompare(b.id));
    scopes.push({ scope, scripts: inScope.length, groups: ordered });
  }

  const frames: InventoryJson['frames'] = snapshot.frames
    .filter((frame) => !frame.isMain && frame.crossOrigin)
    .map((frame) => ({
      url: frame.url,
      scope: frame.scope,
      status: findFrameEntry(manifest, frame) !== undefined ? 'approved' : 'unapproved',
    }));

  const values: Record<string, string> = {};
  for (const name of SECURITY_HEADER_NAMES) {
    const value = snapshot.headers[name];
    if (value !== undefined) values[name] = value;
  }

  const out: InventoryJson = {
    profile: snapshot.profile,
    url: snapshot.url,
    scannedAt: snapshot.finishedAt,
    runs: snapshot.runs,
    summary,
    scopes,
    frames,
    headers: { policy: manifest.headers.policy, values },
  };
  if (snapshot.blocked !== undefined) out.blocked = snapshot.blocked;
  return out;
}

export function renderInventoryJson(snapshot: Snapshot, manifest: Manifest): string {
  return JSON.stringify(inventoryToJson(snapshot, manifest), null, 2) + '\n';
}

export async function runReport(ctx: CommandContext, opts: ReportCommandOptions): Promise<ReportCommandResult> {
  const loaded = await loadProfile(ctx, opts.profile);
  const format = opts.format ?? 'md';
  const manifestPath = manifestPathFor(opts.profile, loaded.profile, ctx.cwd);
  const snapshotPath = opts.snapshot !== undefined ? path.resolve(ctx.cwd, opts.snapshot) : lastSnapshotPath(ctx.cwd, opts.profile);
  const snapshot = await readSnapshot(snapshotPath);

  let manifest: Manifest;
  let manifestMissing = false;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    if (!isScriptlockError(error) || error.code !== 'MANIFEST_NOT_FOUND') throw error;
    manifest = emptyManifest(opts.profile, loaded.profile.url);
    manifestMissing = true;
    ctx.err(`warning: no manifest found at ${manifestPath}; every script is reported as unapproved`);
  }

  const report = format === 'json' ? renderInventoryJson(snapshot, manifest) : renderInventoryMarkdown(snapshot, manifest);
  const result: ReportCommandResult = { report, snapshot, manifest, manifestPath, manifestMissing };
  if (opts.out !== undefined) {
    const outPath = path.resolve(ctx.cwd, opts.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, report, 'utf8');
    result.outPath = outPath;
    ctx.out(`report (${format}) written to ${outPath}`);
  } else {
    ctx.out(report);
  }
  return result;
}
