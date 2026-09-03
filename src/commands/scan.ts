/**
 * `scriptlock scan` (DESIGN.md section 8): run one profile through the collector,
 * write the snapshot to `.scriptlock/last.<profile>.json` (or `--out`) and print
 * a summary (scripts by scope and kind, third-party hosts, initiator tree
 * depth, security headers present) or the snapshot JSON with `--json`.
 *
 * Also owns what every command shares: `CommandContext` (built by the CLI,
 * or in-process by tests), `loadProfile` / `requireProfile`, and the snapshot
 * file helpers `lastSnapshotPath`, `parseSnapshot`, `readSnapshot`,
 * `writeSnapshot`.
 *
 * Limitations: snapshot validation is structural (zod, unknown keys pass
 * through), so a hand-edited file of plausible shape is accepted. Flow
 * modules named in `steps` are resolved by the collector against
 * process.cwd(), not `CommandContext.cwd`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { z } from 'zod';
import { scan } from '../collector/collect.js';
import { loadConfig } from '../config/load.js';
import { ScriptlockError } from '../errors.js';
import { snapshotToJson } from '../history/store.js';
import { isFirstParty } from '../identity/identity.js';
import {
  SECURITY_HEADER_NAMES,
  type ObservedScript,
  type ProfileConfig,
  type ScanOptions,
  type Scope,
  type ScriptKind,
  type Snapshot,
  type ScriptlockConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// Shared command plumbing
// ---------------------------------------------------------------------------

export interface CommandContext {
  /** Directory the configuration, manifest and `.scriptlock/` are resolved against. */
  cwd: string;
  /** `--config <path>` (relative to cwd); undefined means the default lookup. */
  configPath?: string | undefined;
  verbose: boolean;
  /** Whether terminal output may use colour. */
  color: boolean;
  /** Version stamped into snapshots. */
  toolVersion: string;
  /** Writes a block of text to standard output; a newline is appended unless present. */
  out: (text: string) => void;
  /** Writes a block of text to standard error (progress, warnings, instructions). */
  err: (text: string) => void;
  /** Environment used for defaults such as the approver name. Defaults to process.env. */
  env?: Record<string, string | undefined> | undefined;
}

export interface LoadedProfile {
  config: ScriptlockConfig;
  configPath: string;
  name: string;
  profile: ProfileConfig;
}

export function requireProfile(config: ScriptlockConfig, name: string): ProfileConfig {
  const profile = config.profiles[name];
  if (profile === undefined) {
    const known = Object.keys(config.profiles).join(', ') || '(none)';
    throw new ScriptlockError('PROFILE_NOT_FOUND', `profile "${name}" is not defined in the configuration; known profiles: ${known}`, {
      exitCode: 2,
      hint: 'Pass --profile <name> with one of the profiles listed above, or add the profile to scriptlock.config.yaml',
    });
  }
  return profile;
}

/** Loads the configuration for `ctx` and resolves one profile. */
export async function loadProfile(ctx: CommandContext, name: string): Promise<LoadedProfile> {
  const { config, path: configPath } = await loadConfig(ctx.cwd, ctx.configPath);
  return { config, configPath, name, profile: requireProfile(config, name) };
}

export function plural(count: number, word: string, pluralWord: string = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

// ---------------------------------------------------------------------------
// Snapshot files
// ---------------------------------------------------------------------------

/** `.scriptlock/last.<profile>.json` under `cwd`. */
export function lastSnapshotPath(cwd: string, profile: string): string {
  return path.join(cwd, '.scriptlock', `last.${profile}.json`);
}

const scopeSchema = z.enum(['merchant', 'tpsp', 'threeds', 'embedded', 'harness']);
const kindSchema = z.enum(['external', 'inline', 'eval', 'blob', 'data', 'wasm', 'worker', 'unknown']);

const frameSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  origin: z.string(),
  isMain: z.boolean(),
  scope: scopeSchema,
  crossOrigin: z.boolean(),
});

const scriptSchema = z.looseObject({
  id: z.string().min(1),
  kind: kindSchema,
  scope: scopeSchema,
  hasSourceURL: z.boolean(),
  frameId: z.string(),
  frameUrl: z.string(),
  frameOrigin: z.string(),
  target: z.enum(['page', 'iframe', 'worker', 'service_worker']),
  sha256: z.string().optional(),
  structuralHash: z.string().optional(),
  size: z.number(),
  isModule: z.boolean(),
  observedInRuns: z.number().int().nonnegative(),
});

/** Structural schema of a snapshot file; unknown keys are kept. */
export const snapshotSchema = z.looseObject({
  version: z.literal(1),
  tool: z.looseObject({ name: z.literal('scriptlock'), version: z.string() }),
  profile: z.string().min(1),
  url: z.string(),
  finalUrl: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  runs: z.number().int().positive(),
  vantage: z.looseObject({ userAgent: z.string(), browser: z.string(), headless: z.boolean() }),
  documentStatus: z.number(),
  headers: z.record(z.string(), z.string()),
  frames: z.array(frameSchema),
  scripts: z.array(scriptSchema),
  blocked: z.looseObject({ vendor: z.string(), evidence: z.string() }).optional(),
  warnings: z.array(z.string()),
});

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
}

/** Parses and validates snapshot JSON. Any `source` text is dropped. */
export function parseSnapshot(text: string, where: string = 'snapshot'): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScriptlockError('SNAPSHOT_INVALID', `Invalid JSON in ${where}: ${detail}`, {
      hint: 'Run "scriptlock scan" to write a fresh snapshot',
      cause: error,
    });
  }
  const result = snapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new ScriptlockError('SNAPSHOT_INVALID', `Invalid snapshot ${where}:\n${formatIssues(result.error.issues)}`, {
      hint: 'Run "scriptlock scan" to write a fresh snapshot',
    });
  }
  return snapshotToJson(raw as Snapshot);
}

export async function readSnapshot(file: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ScriptlockError('SNAPSHOT_NOT_FOUND', `Snapshot not found: ${file}`, {
        exitCode: 2,
        hint: 'Run "scriptlock scan" first, or pass --snapshot <file>',
        cause: error,
      });
    }
    throw error;
  }
  return parseSnapshot(text, file);
}

/** Writes the snapshot as pretty JSON (never with script sources), creating directories. */
export async function writeSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshotToJson(snapshot), null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// The scan command
// ---------------------------------------------------------------------------

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

const KIND_ORDER: readonly ScriptKind[] = ['external', 'inline', 'eval', 'blob', 'data', 'wasm', 'worker', 'unknown'];
const SCOPE_ORDER: readonly Scope[] = ['merchant', 'tpsp', 'threeds', 'embedded'];

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (text.length >= width) return text;
  const fill = ' '.repeat(width - text.length);
  return align === 'left' ? text + fill : fill + text;
}

/** Renders aligned columns; numeric cells are right-aligned. */
export function renderColumns(header: readonly string[], rows: readonly (readonly string[])[], indent: string = '  '): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[], isHeader: boolean): string =>
    indent +
    cells
      .map((cell, i) => {
        const width = widths[i] ?? cell.length;
        const numeric = !isHeader && /^\d+$/.test(cell);
        return i === cells.length - 1 && !numeric ? cell : pad(cell, width, numeric ? 'right' : 'left');
      })
      .join('  ')
      .trimEnd();
  return [line(header, true), ...rows.map((row) => line(row, false))];
}

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.host === '' ? undefined : parsed.host;
  } catch {
    return undefined;
  }
}

/** Longest `loadedBy` chain in the inventory (a script without a parent has depth 1). */
export function initiatorTreeDepth(scripts: readonly ObservedScript[]): number {
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

  const kinds = KIND_ORDER.filter((kind) => scripts.some((s) => s.kind === kind));
  const header = ['scope', ...kinds, 'total'];
  const rows: string[][] = SCOPE_ORDER.filter((scope) => scripts.some((s) => s.scope === scope)).map((scope) => {
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
  const byScope = SCOPE_ORDER.map((scope) => [scope, crossFrames.filter((f) => f.scope === scope).length] as const).filter(([, n]) => n > 0);
  lines.push(`cross-origin frames: ${crossFrames.length}${byScope.length > 0 ? ` (${byScope.map(([scope, n]) => `${n} ${scope}`).join(', ')})` : ''}`);
  if (snapshot.warnings.length > 0) {
    lines.push(c.yellow(`warnings (${snapshot.warnings.length}):`));
    for (const warning of snapshot.warnings) lines.push(c.yellow(`  - ${warning}`));
  }
  return lines.join('\n') + '\n';
}
