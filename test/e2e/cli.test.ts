/**
 * CLI process tests: runs src/cli.ts through the tsx CLI (no build needed)
 * as a child process in a temporary directory and checks help, version,
 * init, error rendering, usage errors and exit-code propagation from
 * snapshot files, plus one real scan / approve / diff / report sequence
 * against the fixture server. That sequence uses an asynchronous spawn: the
 * fixture server runs in this process, and spawnSync would block the event
 * loop it needs to answer the child's requests.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type FixtureServer } from '../../fixtures/server.js';
import { parseConfig } from '../../src/config/load.js';
import { emptyManifest, serialiseManifest } from '../../src/manifest/io.js';
import type { Manifest, ObservedScript, Snapshot } from '../../src/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliPath = join(repoRoot, 'src', 'cli.ts');
const packageVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Equivalent of `npx tsx src/cli.ts <args>` without the npx lookup. */
function scriptlock(cwd: string, args: string[], timeoutMs = 90_000): CliRun {
  const result = spawnSync(process.execPath, [tsxCli, cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Same as `scriptlock`, without blocking the event loop (needed while the fixture server serves the child). */
function scriptlockAsync(cwd: string, args: string[], timeoutMs = 90_000): Promise<CliRun> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`scriptlock ${args.join(' ')} timed out after ${timeoutMs} ms\n${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

const MAIN_URL = 'https://shop.example.com/checkout';
const MAIN_ORIGIN = 'https://shop.example.com';
const APP_ID = 'https://shop.example.com/assets/app.[hash].js';
const APP_SHA = 'a'.repeat(64);

function syntheticSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const now = new Date().toISOString();
  const script: ObservedScript = {
    id: APP_ID,
    kind: 'external',
    scope: 'merchant',
    url: APP_ID,
    rawUrl: 'https://shop.example.com/assets/app.3f9c2a1b.js',
    hasSourceURL: false,
    frameId: 'main',
    frameUrl: MAIN_URL,
    frameOrigin: MAIN_ORIGIN,
    target: 'page',
    sha256: APP_SHA,
    structuralHash: 'b'.repeat(64),
    size: 1234,
    isModule: false,
    observedInRuns: 1,
  };
  return {
    version: 1,
    tool: { name: 'scriptlock', version: '0.0.0-test' },
    profile: 'default',
    url: MAIN_URL,
    finalUrl: MAIN_URL,
    startedAt: now,
    finishedAt: now,
    runs: 1,
    vantage: { userAgent: 'test', browser: 'chromium 0.0.0 (test)', headless: true },
    documentStatus: 200,
    headers: {},
    frames: [{ id: 'main', url: MAIN_URL, origin: MAIN_ORIGIN, isMain: true, scope: 'merchant', crossOrigin: false }],
    scripts: [script],
    warnings: [],
    ...overrides,
  };
}

function approvedManifest(): Manifest {
  const manifest = emptyManifest('default', MAIN_URL);
  manifest.scripts.push({
    id: APP_ID,
    kind: 'external',
    scope: 'merchant',
    integrity: 'strict',
    integrityMethod: 'hash-strict',
    sha256: APP_SHA,
    owner: 'web',
    category: 'functional',
    justification: 'Storefront bundle',
    approvedBy: 'tester',
    approvedAt: '2026-09-01',
  });
  return manifest;
}

function writeConfig(dir: string, url: string, extra: string[] = []): void {
  writeFileSync(
    join(dir, 'scriptlock.config.yaml'),
    ['version: 1', ...extra, 'profiles:', '  default:', `    url: ${url}`, '    wait: load', '    settleMs: 2500', ''].join('\n'),
  );
}

let dir: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'scriptlock-')));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scriptlock CLI', () => {
  it('prints help listing every command and the exit codes', () => {
    const run = scriptlock(dir, ['--help']);
    expect(run.status).toBe(0);
    for (const command of ['init', 'scan', 'diff', 'approve', 'report']) expect(run.stdout).toContain(command);
    expect(run.stdout).toContain('--config <path>');
    expect(run.stdout).toContain('--verbose');
    expect(run.stdout).toContain('--no-color');
    expect(run.stdout).toContain('Exit codes: 0 clean, 1 findings');
  });

  it('prints the package version', () => {
    const run = scriptlock(dir, ['--version']);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(packageVersion);
  });

  it('diff --help prints the severity matrix from diff/policy.ts', () => {
    const run = scriptlock(dir, ['diff', '--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Severity matrix (gate vs drift)');
    expect(run.stdout).toContain('header-changed');
    expect(run.stdout).toContain('not emitted');
    expect(run.stdout).toContain('blocked');
    expect(run.stdout).toContain('--gate');
    expect(run.stdout).toContain('--drift');
  });

  it('reports usage errors with exit code 2', () => {
    const run = scriptlock(dir, ['scan', '--bogus']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("error: unknown option '--bogus'");
    const badChoice = scriptlock(dir, ['diff', '--format', 'xml', '--snapshot', 'nothing.json']);
    expect(badChoice.status).toBe(2);
    expect(badChoice.stderr).toContain('--format');
  });

  it('init writes the configuration, refuses to overwrite it and honours --force and --url', () => {
    const init = scriptlock(dir, ['init']);
    expect(init.status).toBe(0);
    const file = join(dir, 'scriptlock.config.yaml');
    expect(existsSync(file)).toBe(true);
    expect(init.stdout).toContain(`wrote ${file}`);
    const config = parseConfig(readFileSync(file, 'utf8'), { env: {} });
    expect(config.profiles['default']?.url).toBe('https://shop.example.com/checkout');
    expect(config.integrity).toEqual({ firstParty: 'strict', thirdParty: 'track', inline: 'structural', eval: 'structural' });

    const again = scriptlock(dir, ['init']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('error: configuration already exists');
    expect(again.stderr).toContain('hint: ');

    const forced = scriptlock(dir, ['init', '--force', '--url', 'http://shop.example.test/checkout']);
    expect(forced.status).toBe(0);
    expect(parseConfig(readFileSync(file, 'utf8'), { env: {} }).profiles['default']?.url).toBe('http://shop.example.test/checkout');
  });

  it('scan without a configuration fails with exit code 2, an error line and a hint', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'scriptlock-empty-')));
    try {
      const run = scriptlock(empty, ['scan']);
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(/^error: No scriptlock\.config\.yaml/m);
      expect(run.stderr).toContain('hint: Run "scriptlock init"');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('approve without ids, --all-new, --refresh or --headers fails with exit code 2', () => {
    const run = scriptlock(dir, ['approve']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('error: nothing to approve');
    const badCategory = scriptlock(dir, ['approve', '--all-new', '--category', 'nonsense']);
    expect(badCategory.status).toBe(2);
    expect(badCategory.stderr).toContain('--category');
  });

  describe('diff exit codes from a snapshot file', () => {
    let work: string;
    const snapshotFile = 'snapshot.json';

    beforeAll(() => {
      work = realpathSync(mkdtempSync(join(tmpdir(), 'scriptlock-diffcodes-')));
      writeConfig(work, MAIN_URL);
      writeFileSync(join(work, snapshotFile), JSON.stringify(syntheticSnapshot(), null, 2));
    });

    afterAll(() => {
      rmSync(work, { recursive: true, force: true });
    });

    it('exits 1 with instructions when there is no manifest', () => {
      const run = scriptlock(work, ['diff', '--snapshot', snapshotFile]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('no manifest found for profile "default"');
      expect(run.stderr).toContain('scriptlock approve --all-new');
    });

    it('exits 0 when the snapshot matches the manifest', () => {
      writeFileSync(join(work, 'scriptlock.lock.yaml'), serialiseManifest(approvedManifest()));
      const run = scriptlock(work, ['diff', '--gate', '--snapshot', snapshotFile]);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('clean: no findings');
      expect(run.stdout).toContain('exit code 0');
    });

    it('exits 1 on a new merchant script and renders json and markdown', () => {
      writeFileSync(join(work, 'scriptlock.lock.yaml'), serialiseManifest(emptyManifest('default', MAIN_URL)));
      const text = scriptlock(work, ['diff', '--snapshot', snapshotFile]);
      expect(text.status).toBe(1);
      expect(text.stdout).toContain('FAIL (1)');
      expect(text.stdout).toContain(APP_ID);

      const json = scriptlock(work, ['diff', '--drift', '--snapshot', snapshotFile, '--format', 'json']);
      expect(json.status).toBe(1);
      const parsed = JSON.parse(json.stdout) as { mode: string; exitCode: number; events: { type: string; severity: string }[] };
      expect(parsed.mode).toBe('drift');
      expect(parsed.exitCode).toBe(1);
      expect(parsed.events).toEqual([{ type: 'new', severity: 'fail', subject: APP_ID, scope: 'merchant', message: expect.any(String), observed: expect.any(Object) }]);

      const md = scriptlock(work, ['diff', '--snapshot', snapshotFile, '--format', 'md', '--out', 'out/report.md']);
      expect(md.status).toBe(1);
      const report = readFileSync(join(work, 'out', 'report.md'), 'utf8');
      expect(report).toContain('## Scriptlock diff: default (gate)');
      expect(report).toContain('| new | fail | merchant |');
      expect(md.stdout).toContain('report (md) written to');
    });

    it('exits 2 when the snapshot was blocked', () => {
      writeFileSync(join(work, 'scriptlock.lock.yaml'), serialiseManifest(approvedManifest()));
      writeFileSync(
        join(work, 'blocked.json'),
        JSON.stringify(syntheticSnapshot({ documentStatus: 503, blocked: { vendor: 'cloudflare', evidence: "title contains 'Just a moment...'" } })),
      );
      const run = scriptlock(work, ['diff', '--snapshot', 'blocked.json']);
      expect(run.status).toBe(2);
      expect(run.stdout).toContain('blocked');
      expect(run.stdout).toContain('exit code 2');
    });

    it('exits 2 on an invalid snapshot file', () => {
      writeFileSync(join(work, 'broken.json'), '{"version": 2}');
      const run = scriptlock(work, ['diff', '--snapshot', 'broken.json']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('error: Invalid snapshot');
      const missing = scriptlock(work, ['diff', '--snapshot', 'missing.json']);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('error: Snapshot not found');
    });
  });

  describe('scan against a blocked page exits 2 but still writes the snapshot', () => {
    let blockedServer: FixtureServer;
    let work: string;

    beforeAll(async () => {
      blockedServer = await start();
      blockedServer.setBlocked(true);
      work = realpathSync(mkdtempSync(join(tmpdir(), 'scriptlock-scan-blocked-')));
      writeConfig(work, `${blockedServer.origin}/`);
    });

    afterAll(async () => {
      await blockedServer.close();
      rmSync(work, { recursive: true, force: true });
    });

    it('reports blocked, exits 2 and leaves the snapshot on disk', async () => {
      const run = await scriptlockAsync(work, ['scan']);
      expect(run.status).toBe(2);
      expect(run.stdout).toContain('blocked');
      expect(existsSync(join(work, '.scriptlock', 'last.default.json'))).toBe(true);
    });
  });

  describe('against the fixture server', () => {
    let server: FixtureServer;
    let work: string;

    beforeAll(async () => {
      server = await start();
      work = realpathSync(mkdtempSync(join(tmpdir(), 'scriptlock-e2e-')));
      writeConfig(work, `${server.origin}/`, ['scope:', '  tpsp: ["localhost"]']);
    });

    afterAll(async () => {
      await server.close();
      rmSync(work, { recursive: true, force: true });
    });

    it('scans, approves, diffs and reports through the CLI', async () => {
      const scan = await scriptlockAsync(work, ['scan']);
      expect(scan.status).toBe(0);
      const snapshotPath = join(work, '.scriptlock', 'last.default.json');
      expect(scan.stdout).toContain(`snapshot: ${snapshotPath}`);
      expect(scan.stdout).toContain('scripts by scope and kind');
      expect(scan.stderr).toContain(`scanning ${server.origin}/`);
      expect(existsSync(snapshotPath)).toBe(true);
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
      expect(snapshot.scripts.some((s) => s.id === `${server.origin}/app.[hash].js`)).toBe(true);

      const approve = await scriptlockAsync(work, [
        'approve',
        '--all-new',
        '--owner',
        'web',
        '--category',
        'functional',
        '--justification',
        'Fixture site, reviewed in the test',
        '--approved-by',
        'tester',
      ]);
      expect(approve.status).toBe(0);
      const manifestPath = join(work, 'scriptlock.lock.yaml');
      expect(approve.stdout).toContain(`manifest: ${manifestPath} (created)`);
      expect(approve.stdout).toContain('approved by tester on');
      expect(existsSync(manifestPath)).toBe(true);
      expect(readFileSync(manifestPath, 'utf8')).toContain('approvedBy: tester');

      const diff = await scriptlockAsync(work, ['diff', '--gate', '--verbose']);
      expect(diff.status).toBe(0);
      expect(diff.stdout).toContain('clean: no findings');
      expect(diff.stderr).toContain('snapshot written to');

      const report = await scriptlockAsync(work, ['report', '--format', 'md']);
      expect(report.status).toBe(0);
      expect(report.stdout).toContain('## Scriptlock inventory: default');
      expect(report.stdout).toContain('| approved |');
      const json = await scriptlockAsync(work, ['report', '--format', 'json']);
      expect(json.status).toBe(0);
      const inventory = JSON.parse(json.stdout) as { summary: { scripts: number; approved: number } };
      expect(inventory.summary.approved).toBe(inventory.summary.scripts);
    });
  });
});
