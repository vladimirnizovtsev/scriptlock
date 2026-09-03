/**
 * `scriptlock report` (DESIGN.md section 8): render the inventory of the last
 * snapshot (or `--snapshot`) with its authorisation status against the
 * manifest (approved / unapproved / stale), grouped by scope, then owner and
 * category, as markdown (report/markdown.ts) or JSON (report/json.ts). Both
 * renderers format the one model built by report/inventory.ts.
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
import { renderInventoryJson } from '../report/json.js';
import { renderInventoryMarkdown } from '../report/markdown.js';
import type { Manifest, Snapshot } from '../types.js';
import { loadProfile, type CommandContext } from './context.js';
import { lastSnapshotPath, readSnapshot } from './snapshot.js';

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
