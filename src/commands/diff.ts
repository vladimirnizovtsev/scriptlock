/**
 * `scriptlock diff` (DESIGN.md section 8): scan (or load `--snapshot`), compare
 * with the manifest, render the report as text, markdown or JSON, optionally
 * append history, and return the exit code (0 clean, 1 findings, 2 blocked).
 * Without a manifest it prints instructions to run `approve --all-new` and
 * returns 1. A scan performed here also refreshes `.scriptlock/last.<profile>.json`
 * so `scriptlock approve` can act on what the diff just reported; a blocked
 * scan is written to `.scriptlock/blocked.<profile>.json` instead, so a
 * challenge page cannot destroy the last good snapshot.
 *
 * Limitations: with `--out` the report is written in full (also on exit code
 * 1 or 2) and only a one-line summary is printed; history is written only when
 * a diff result exists (not when the manifest is missing).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scan } from '../collector/collect.js';
import { manifestPathFor } from '../config/load.js';
import { diff, type HintContext } from '../diff/diff.js';
import { isScriptlockError } from '../errors.js';
import { appendHistory } from '../history/store.js';
import { readManifest } from '../manifest/io.js';
import { renderJson } from '../report/json.js';
import { renderMarkdown } from '../report/markdown.js';
import { exitCodeMeaning, renderText } from '../report/text.js';
import type { DiffMode, DiffResult, Manifest, ScanOptions, Snapshot } from '../types.js';
import { lastSnapshotPath, loadProfile, plural, readSnapshot, writeSnapshot, type CommandContext } from './scan.js';

export type DiffFormat = 'text' | 'md' | 'json';

export const DIFF_FORMATS: readonly DiffFormat[] = ['text', 'md', 'json'];

export interface DiffCommandOptions {
  profile: string;
  mode: DiffMode;
  /** Snapshot file to compare instead of scanning (relative to cwd). */
  snapshot?: string | undefined;
  format?: DiffFormat | undefined;
  /** Append the snapshot and result under `.scriptlock/history/<profile>/` (also when `profile.history`). */
  history?: boolean | undefined;
  /** Write the report to this file (relative to cwd) instead of standard output. */
  out?: string | undefined;
}

export interface DiffCommandResult {
  exitCode: 0 | 1 | 2;
  /** Absent when no manifest exists. */
  result?: DiffResult;
  snapshot: Snapshot;
  /** Path the snapshot was read from, or written to after a scan. */
  snapshotPath: string;
  manifestPath: string;
  /** Path of the history snapshot when history was written. */
  historyPath?: string;
  /** Rendered report; empty when there was no manifest. */
  report: string;
  /** Absolute path of the written report when `out` was given. */
  outPath?: string;
}

/** `.scriptlock/history` under `cwd`. */
export function historyDir(cwd: string): string {
  return path.join(cwd, '.scriptlock', 'history');
}

/** `.scriptlock/blocked.<profile>.json` under `cwd`: a blocked scan, kept out of `last.<profile>.json`. */
export function blockedSnapshotPath(cwd: string, profile: string): string {
  return path.join(cwd, '.scriptlock', `blocked.${profile}.json`);
}

export function renderReport(result: DiffResult, format: DiffFormat, color: boolean): string {
  switch (format) {
    case 'md':
      return renderMarkdown(result);
    case 'json':
      return renderJson(result);
    default:
      return renderText(result, { color });
  }
}

function summaryLine(result: DiffResult): string {
  const { fail, warn, info } = result.summary;
  return `${fail} fail, ${warn} warn, ${info} info; exit code ${result.exitCode} (${exitCodeMeaning(result.exitCode)})`;
}

export function missingManifestInstructions(profile: string, manifestPath: string, snapshot: Snapshot, snapshotPath: string): string {
  const scripts = snapshot.scripts.filter((s) => s.scope !== 'harness').length;
  return [
    `error: no manifest found for profile "${profile}" (expected ${manifestPath})`,
    `The snapshot with ${plural(scripts, 'script')} is at ${snapshotPath}. Review it, then create the manifest from it:`,
    `  scriptlock approve --all-new --profile ${profile} --owner "<team>" --category "<category>" --justification "<why these scripts belong on the page>"`,
    'Commit the manifest next to scriptlock.config.yaml and run "scriptlock diff" again.',
  ].join('\n');
}

export async function runDiff(ctx: CommandContext, opts: DiffCommandOptions): Promise<DiffCommandResult> {
  const loaded = await loadProfile(ctx, opts.profile);
  const format = opts.format ?? 'text';
  const manifestPath = manifestPathFor(opts.profile, loaded.profile, ctx.cwd);

  let snapshot: Snapshot;
  let snapshotPath: string;
  if (opts.snapshot !== undefined) {
    snapshotPath = path.resolve(ctx.cwd, opts.snapshot);
    snapshot = await readSnapshot(snapshotPath);
    if (snapshot.profile !== opts.profile) {
      ctx.err(
        `warning: snapshot ${snapshotPath} was recorded for profile "${snapshot.profile}"; comparing it with the manifest of profile "${opts.profile}"`,
      );
    }
  } else {
    ctx.err(`scanning ${loaded.profile.url} (profile ${opts.profile}, ${plural(loaded.profile.runs, 'run')})`);
    const scanOptions: ScanOptions = {
      config: loaded.config,
      profile: opts.profile,
      runs: loaded.profile.runs,
      toolVersion: ctx.toolVersion,
    };
    if (ctx.verbose) scanOptions.onProgress = (message) => ctx.err(`  ${message}`);
    snapshot = await scan(scanOptions);
    if (snapshot.blocked === undefined) {
      snapshotPath = lastSnapshotPath(ctx.cwd, opts.profile);
    } else {
      // A challenge page must not overwrite the last good snapshot that
      // `approve` and `report` read; it is kept as evidence under its own name.
      snapshotPath = blockedSnapshotPath(ctx.cwd, opts.profile);
      ctx.err(
        `the scan was blocked (${snapshot.blocked.vendor}); writing ${snapshotPath} and leaving ${lastSnapshotPath(ctx.cwd, opts.profile)} untouched`,
      );
    }
    await writeSnapshot(snapshotPath, snapshot);
    if (ctx.verbose) ctx.err(`snapshot written to ${snapshotPath}`);
  }
  for (const warning of snapshot.warnings) ctx.err(`warning: ${warning}`);

  let manifest: Manifest;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    if (!isScriptlockError(error) || error.code !== 'MANIFEST_NOT_FOUND') throw error;
    ctx.err(missingManifestInstructions(opts.profile, manifestPath, snapshot, snapshotPath));
    return { exitCode: 1, snapshot, snapshotPath, manifestPath, report: '' };
  }

  // Hints are printed as ready-to-paste commands, so they must name the same
  // profile and configuration file this run used.
  const hintContext: HintContext = { profile: opts.profile };
  if (ctx.configPath !== undefined) hintContext.config = ctx.configPath;
  const result = diff({ snapshot, manifest, mode: opts.mode, identity: loaded.config.identity, hintContext });
  for (const warning of result.warnings ?? []) ctx.err(`warning: ${warning}`);

  const report = renderReport(result, format, ctx.color && opts.out === undefined);
  const outcome: DiffCommandResult = { exitCode: result.exitCode, result, snapshot, snapshotPath, manifestPath, report };

  if (opts.out !== undefined) {
    const outPath = path.resolve(ctx.cwd, opts.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, report, 'utf8');
    outcome.outPath = outPath;
    ctx.out(`report (${format}) written to ${outPath}: ${summaryLine(result)}`);
  } else {
    ctx.out(report);
  }

  if (opts.history === true || loaded.profile.history) {
    const historyPath = await appendHistory(historyDir(ctx.cwd), opts.profile, snapshot, result);
    outcome.historyPath = historyPath;
    if (ctx.verbose) ctx.err(`history written to ${historyPath}`);
  }
  return outcome;
}
