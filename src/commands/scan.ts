/**
 * `scriptlock scan` (DESIGN.md section 8): run one profile through the collector,
 * write the snapshot to `.scriptlock/last.<profile>.json` (or `--out`) and print
 * a summary (scripts by scope and kind, third-party hosts, initiator tree
 * depth, security headers present) or the snapshot JSON with `--json`.
 *
 * What every command shares lives next door: `CommandContext` and profile
 * resolution in commands/context.ts, the snapshot file layer in
 * commands/snapshot.ts.
 *
 * Limitations: flow modules named in `steps` are resolved by the collector
 * against process.cwd(), not `CommandContext.cwd`.
 */
import path from 'node:path';
import pc from 'picocolors';
import { scan } from '../collector/collect.js';
import { isFirstParty } from '../identity/identity.js';
import { snapshotToJson } from '../report/json.js';
import { renderColumns } from '../report/text.js';
import {
  APPROVABLE_SCOPES,
  SCRIPT_KINDS,
  SECURITY_HEADER_NAMES,
  type ObservedScript,
  type ScanOptions,
  type Snapshot,
} from '../types.js';
import { loadProfile, plural, type CommandContext } from './context.js';
import { lastSnapshotPath, writeSnapshot } from './snapshot.js';

export interface ScanCommandOptions {
  profile: string;
  /** Overrides `profile.runs`. */
  runs?: number | undefined;
  /** Snapshot output path, relative to cwd; defaults to `.scriptlock/last.<profile>.json`. */
  out?: string | undefined;
  /** Print the snapshot JSON instead of the summary. */
  json?: boolean | undefined;
}

export interface ScanCommandResult {
  snapshot: Snapshot;
  /** Absolute path of the written snapshot. */
  path: string;
  configPath: string;
  /** 2 when the page was a bot-management challenge (blocked), else 0. */
  exitCode: 0 | 2;
}

export async function runScan(ctx: CommandContext, opts: ScanCommandOptions): Promise<ScanCommandResult> {
  const loaded = await loadProfile(ctx, opts.profile);
  const runs = opts.runs ?? loaded.profile.runs;
  const file = opts.out !== undefined ? path.resolve(ctx.cwd, opts.out) : lastSnapshotPath(ctx.cwd, opts.profile);

  ctx.err(`scanning ${loaded.profile.url} (profile ${opts.profile}, ${plural(runs, 'run')})`);
  const scanOptions: ScanOptions = { config: loaded.config, profile: opts.profile, runs, toolVersion: ctx.toolVersion };
  if (ctx.verbose) scanOptions.onProgress = (message) => ctx.err(`  ${message}`);
  const snapshot = await scan(scanOptions);
  await writeSnapshot(file, snapshot);

  if (opts.json === true) ctx.out(JSON.stringify(snapshotToJson(snapshot), null, 2));
  else ctx.out(renderScanSummary(snapshot, file, { color: ctx.color }));
  if (snapshot.blocked !== undefined) {
    ctx.err(
      `the page was a bot-management challenge (${snapshot.blocked.vendor}); the inventory is unreliable. Allowlist the scanner (browser.extraHeaders) and scan again.`,
    );
  }
  return { snapshot, path: file, configPath: loaded.configPath, exitCode: snapshot.blocked !== undefined ? 2 : 0 };
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.host === '' ? undefined : parsed.host;
  } catch {
    return undefined;
  }
}

/** Longest `loadedBy` chain in the inventory (a script without a parent has depth 1). */
function initiatorTreeDepth(scripts: readonly ObservedScript[]): number {
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const memo = new Map<string, number>();
  const depthOf = (script: ObservedScript, seen: Set<string>): number => {
    const cached = memo.get(script.id);
    if (cached !== undefined) return cached;
    let depth = 1;
    const parent = script.loadedBy !== undefined && !seen.has(script.loadedBy) ? byId.get(script.loadedBy) : undefined;
    if (parent !== undefined) {
      seen.add(script.id);
      depth = 1 + depthOf(parent, seen);
    }
    memo.set(script.id, depth);
    return depth;
  };
  return scripts.reduce((max, script) => Math.max(max, depthOf(script, new Set([script.id]))), 0);
}

export function renderScanSummary(snapshot: Snapshot, file: string, opts: { color?: boolean } = {}): string {
  const c = pc.createColors(opts.color ?? false);
  const scripts = snapshot.scripts.filter((s) => s.scope !== 'harness');
  const lines: string[] = [];

  lines.push(`${c.bold('scriptlock scan')} ${snapshot.profile} ${snapshot.url}`);
  const statusLine = `status ${snapshot.documentStatus}, ${plural(snapshot.runs, 'run')}, ${snapshot.vantage.browser}, finished ${snapshot.finishedAt}`;
  // A non-2xx main document means the inventory is of an error page, not of the
  // page under test; it must not read as ordinary run metadata.
  const ok = snapshot.documentStatus >= 200 && snapshot.documentStatus <= 299;
  lines.push(ok ? c.dim(statusLine) : c.red(statusLine));
  lines.push(`snapshot: ${file}`);
  if (snapshot.blocked !== undefined) {
    lines.push(c.red(`blocked: ${snapshot.blocked.vendor} (${snapshot.blocked.evidence}); the inventory is unreliable`));
  }
  lines.push('');

  const kinds = SCRIPT_KINDS.filter((kind) => scripts.some((s) => s.kind === kind));
  const header = ['scope', ...kinds, 'total'];
  const rows: string[][] = APPROVABLE_SCOPES.filter((scope) => scripts.some((s) => s.scope === scope)).map((scope) => {
    const inScope = scripts.filter((s) => s.scope === scope);
    return [scope, ...kinds.map((kind) => String(inScope.filter((s) => s.kind === kind).length)), String(inScope.length)];
  });
  if (rows.length > 1) rows.push(['all', ...kinds.map((kind) => String(scripts.filter((s) => s.kind === kind).length)), String(scripts.length)]);
  lines.push(c.bold(`scripts by scope and kind (${scripts.length} total)`));
  if (rows.length === 0) lines.push('  no scripts observed');
  else lines.push(...renderColumns(header, rows));
  lines.push('');

  const mainOrigin = snapshot.frames.find((f) => f.isMain)?.origin ?? snapshot.finalUrl ?? snapshot.url;
  const hosts = new Map<string, { count: number; entity: string | undefined }>();
  for (const script of scripts) {
    const url = script.rawUrl ?? script.url;
    if (url === undefined) continue;
    const host = hostOf(url);
    if (host === undefined || isFirstParty(url, mainOrigin)) continue;
    const current = hosts.get(host) ?? { count: 0, entity: undefined };
    current.count += 1;
    if (current.entity === undefined && script.entity !== undefined) current.entity = `${script.entity.name} (${script.entity.category})`;
    hosts.set(host, current);
  }
  lines.push(c.bold(`third-party hosts (${hosts.size})`));
  if (hosts.size === 0) lines.push('  none');
  else {
    const hostRows = [...hosts.entries()]
      .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
      .map(([host, info]) => [host, String(info.count), info.entity ?? '']);
    lines.push(...renderColumns(['host', 'scripts', 'entity'], hostRows));
  }
  lines.push('');

  lines.push(`initiator tree depth: ${initiatorTreeDepth(scripts)}`);
  const present = SECURITY_HEADER_NAMES.filter((name) => snapshot.headers[name] !== undefined);
  lines.push(`security headers present (${present.length}/${SECURITY_HEADER_NAMES.length}): ${present.length === 0 ? 'none' : present.join(', ')}`);
  const crossFrames = snapshot.frames.filter((f) => !f.isMain && f.crossOrigin);
  const byScope = APPROVABLE_SCOPES.map((scope) => [scope, crossFrames.filter((f) => f.scope === scope).length] as const).filter(([, n]) => n > 0);
  lines.push(`cross-origin frames: ${crossFrames.length}${byScope.length > 0 ? ` (${byScope.map(([scope, n]) => `${n} ${scope}`).join(', ')})` : ''}`);
  if (snapshot.warnings.length > 0) {
    lines.push(c.yellow(`warnings (${snapshot.warnings.length}):`));
    for (const warning of snapshot.warnings) lines.push(c.yellow(`  - ${warning}`));
  }
  return lines.join('\n') + '\n';
}
