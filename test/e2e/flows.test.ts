/**
 * End-to-end flows through the command layer, in-process (no child
 * processes), against the fixture server: scan, approve, diff in gate and
 * drift mode, a first-party deploy, a tracked vendor change, new scripts in
 * merchant and tpsp scope, the challenge page, a header change, history and
 * the multi-run union. Tests are ordered and share one temporary directory.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_APP_HASH, defaultSecurityHeaders, start, type FixtureServer } from '../../fixtures/server.js';
import { runApprove } from '../../src/commands/approve.js';
import { runDiff } from '../../src/commands/diff.js';
import { runReport } from '../../src/commands/report.js';
import { lastSnapshotPath, runScan, type CommandContext } from '../../src/commands/scan.js';
import { readManifest } from '../../src/manifest/io.js';
import type { DiffEvent, DiffEventType, DiffResult, ManifestScript } from '../../src/types.js';

let server: FixtureServer;
let dir: string;
let stdout: string[] = [];
let stderr: string[] = [];
let appId: string;
let vendorId: string;
let extraId: string;
let frameExtraId: string;
let lastPath: string;

const APPROVER = { owner: 'web', category: 'functional' as const, justification: 'fixture site scripts', approvedBy: 'tester' };
const TODAY = new Date().toISOString().slice(0, 10);

function ctx(): CommandContext {
  stdout = [];
  stderr = [];
  return {
    cwd: dir,
    verbose: false,
    color: false,
    toolVersion: '0.0.0-test',
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
  };
}

function ofType(result: DiffResult | undefined, type: DiffEventType): DiffEvent[] {
  return (result?.events ?? []).filter((event) => event.type === type);
}

function entry(scripts: ManifestScript[], id: string): ManifestScript {
  const found = scripts.find((script) => script.id === id);
  if (found === undefined) throw new Error(`no manifest entry ${id}; have ${scripts.map((s) => s.id).join(', ')}`);
  return found;
}

beforeAll(async () => {
  server = await start();
  dir = mkdtempSync(join(tmpdir(), 'scriptlock-flows-'));
  appId = `${server.origin}/app.[hash].js`;
  vendorId = `${server.origin}/vendor.js`;
  extraId = `${server.origin}/extra.js`;
  frameExtraId = `${server.crossOrigin}/frame-extra.js`;
  lastPath = lastSnapshotPath(dir, 'default');
  writeFileSync(
    join(dir, 'scriptlock.config.yaml'),
    [
      'version: 1',
      'browser:',
      '  channel: chromium',
      '  headless: true',
      '  timeoutMs: 30000',
      'scope:',
      '  tpsp: ["localhost"]',
      'profiles:',
      '  default:',
      `    url: ${server.origin}/`,
      '    wait: load',
      '    settleMs: 2500',
      '    runs: 1',
      '    history: false',
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scan, approve and diff flows', () => {
  it('scan writes .scriptlock/last.default.json without source text and prints a summary', async () => {
    const { snapshot, path } = await runScan(ctx(), { profile: 'default' });
    expect(path).toBe(lastPath);
    expect(existsSync(lastPath)).toBe(true);
    const written = readFileSync(lastPath, 'utf8');
    expect(written).not.toContain('"source"');
    expect(JSON.parse(written).scripts.length).toBe(snapshot.scripts.length);
    expect(snapshot.scripts.some((s) => s.id === appId)).toBe(true);
    expect(snapshot.scripts.some((s) => s.id === vendorId)).toBe(true);
    expect(snapshot.scripts.find((s) => s.rawUrl?.endsWith('/frame-cross.js'))?.scope).toBe('tpsp');
    const summary = stdout.join('\n');
    expect(summary).toContain('scripts by scope and kind');
    expect(summary).toContain('third-party hosts');
    expect(summary).toContain('initiator tree depth: ');
    expect(summary).toContain('security headers present (5/10)');
    expect(summary).toContain('cross-origin frames: 1 (1 tpsp)');
    expect(summary).toContain(`snapshot: ${lastPath}`);
  });

  it('diff without a manifest prints approve --all-new instructions and exits 1', async () => {
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: lastPath });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result).toBeUndefined();
    expect(outcome.manifestPath).toBe(join(dir, 'scriptlock.lock.yaml'));
    const text = stderr.join('\n');
    expect(text).toContain('no manifest found');
    expect(text).toContain('scriptlock approve --all-new');
    expect(existsSync(outcome.manifestPath)).toBe(false);
  });

  it('approve --all-new creates the manifest with integrity defaults, frames and headers', async () => {
    const outcome = await runApprove(ctx(), { profile: 'default', allNew: true, ...APPROVER });
    expect(outcome.created).toBe(true);
    expect(outcome.approvedBy).toBe('tester');
    expect(outcome.approvedAt).toBe(TODAY);
    expect(outcome.added.length).toBeGreaterThanOrEqual(10);
    expect(outcome.framesAdded).toEqual([`${server.crossOrigin}/frame-cross.html`]);
    expect(stdout.join('\n')).toContain('manifest: ');

    const manifest = await readManifest(join(dir, 'scriptlock.lock.yaml'));
    expect(manifest.profile).toBe('default');
    expect(manifest.url).toBe(`${server.origin}/`);
    expect(manifest.headers.policy).toBe('strict');
    expect(manifest.headers.values['x-frame-options']).toBe('SAMEORIGIN');
    expect(manifest.headers.values['content-security-policy']).toContain('script-src');
    expect(manifest.frames).toEqual([
      {
        match: `${server.crossOrigin}/frame-cross.html`,
        scope: 'tpsp',
        owner: 'web',
        justification: 'fixture site scripts',
        approvedBy: 'tester',
        approvedAt: TODAY,
      },
    ]);
    const app = entry(manifest.scripts, appId);
    expect(app).toMatchObject({ kind: 'external', scope: 'merchant', integrity: 'strict', integrityMethod: 'hash-strict', owner: 'web', category: 'functional' });
    expect(app.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry(manifest.scripts, vendorId).integrity).toBe('strict');
    const crossExternal = entry(manifest.scripts, `${server.crossOrigin}/frame-cross.js`);
    expect(crossExternal).toMatchObject({ scope: 'tpsp', integrity: 'track', integrityMethod: 'source-tracked' });
    for (const script of manifest.scripts.filter((s) => s.kind === 'inline' || s.kind === 'eval')) {
      expect(script.integrity).toBe('structural');
      expect(script.structuralHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.scripts.some((s) => s.kind === 'blob')).toBe(true);
    expect(manifest.scripts.some((s) => s.scope === 'harness')).toBe(false);
  });

  it('diff gate after approval is clean (exit 0, no events) across a fresh scan', async () => {
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.events).toEqual([]);
    expect(outcome.result?.summary.approved).toBe(outcome.result?.summary.totalScripts);
    expect(outcome.result?.summary.merchantScripts).toBeGreaterThan(0);
    expect(stdout.join('\n')).toContain('clean: no findings');
  });

  it('re-approving vendor.js with --integrity track keeps owner and category', async () => {
    const outcome = await runApprove(ctx(), {
      profile: 'default',
      ids: [vendorId],
      integrity: 'track',
      integrityMethod: 'vendor-attested',
      approvedBy: 'tester',
    });
    expect(outcome.updated).toEqual([vendorId]);
    expect(outcome.added).toEqual([]);
    const vendor = entry((await readManifest(outcome.manifestPath)).scripts, vendorId);
    expect(vendor).toMatchObject({ integrity: 'track', integrityMethod: 'vendor-attested', owner: 'web', category: 'functional' });
  });

  it('a deploy of the first-party bundle fails the gate with changed (the id stays stable through [hash])', async () => {
    server.setBundle('cafebabe12345678', "(function () {\n  window.__app = { build: 'v2', ready: true, deployed: 2 };\n})();\n");
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate', format: 'md', out: 'reports/deploy.md' });
    expect(outcome.exitCode).toBe(1);
    const changed = ofType(outcome.result, 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ subject: appId, severity: 'fail', scope: 'merchant' });
    expect(changed[0]?.observed?.rawUrl).toBe(`${server.origin}/app.cafebabe12345678.js`);
    expect(ofType(outcome.result, 'new')).toEqual([]);
    expect(ofType(outcome.result, 'removed')).toEqual([]);
    expect(outcome.outPath).toBe(join(dir, 'reports', 'deploy.md'));
    expect(readFileSync(outcome.outPath ?? '', 'utf8')).toContain('| changed | fail | merchant |');
    expect(stdout.join('\n')).toContain('report (md) written to');
  });

  it('re-approving the bundle accepts the new hash', async () => {
    const outcome = await runApprove(ctx(), { profile: 'default', ids: [appId], approvedBy: 'tester' });
    expect(outcome.updated).toEqual([appId]);
    const clean = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: lastPath });
    expect(clean.exitCode).toBe(0);
    expect(clean.result?.events).toEqual([]);
  });

  it('a vendor.js body change under track is info, and --refresh records lastSeenSha256', async () => {
    server.setVendorVersion(2);
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.events).toHaveLength(1);
    expect(ofType(outcome.result, 'changed')[0]).toMatchObject({ subject: vendorId, severity: 'info' });
    expect(outcome.result?.summary.info).toBe(1);

    const refreshed = await runApprove(ctx(), { profile: 'default', refresh: true });
    expect(refreshed.refreshed).toEqual([vendorId]);
    const vendor = entry((await readManifest(refreshed.manifestPath)).scripts, vendorId);
    expect(vendor.lastSeenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(vendor.lastSeenSha256).not.toBe(vendor.sha256);

    const clean = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: lastPath });
    expect(clean.exitCode).toBe(0);
    expect(clean.result?.events).toEqual([]);
  });

  it('a new first-party script fails the gate as new and can be approved by id', async () => {
    server.setExtraScript(true);
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate', format: 'json' });
    expect(outcome.exitCode).toBe(1);
    const added = ofType(outcome.result, 'new');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ subject: extraId, severity: 'fail', scope: 'merchant' });
    const parsed = JSON.parse(stdout.join('')) as { exitCode: number; events: { type: string; subject: string }[] };
    expect(parsed.exitCode).toBe(1);
    expect(parsed.events.some((event) => event.type === 'new' && event.subject === extraId)).toBe(true);

    const approved = await runApprove(ctx(), { profile: 'default', ids: [extraId], ...APPROVER });
    expect(approved.added).toEqual([extraId]);
    expect(entry(approved.manifest.scripts, extraId)).toMatchObject({ scope: 'merchant', integrity: 'strict' });
  });

  it('a new script inside the tpsp frame is info in gate and warn in drift', async () => {
    server.setFrameExtraScript(true);
    const gate = await runDiff(ctx(), { profile: 'default', mode: 'gate' });
    expect(gate.exitCode).toBe(0);
    const gateNew = ofType(gate.result, 'new');
    expect(gateNew).toHaveLength(1);
    expect(gateNew[0]).toMatchObject({ subject: frameExtraId, severity: 'info', scope: 'tpsp' });

    const drift = await runDiff(ctx(), { profile: 'default', mode: 'drift', snapshot: lastPath });
    expect(drift.exitCode).toBe(0);
    const driftNew = ofType(drift.result, 'new');
    expect(driftNew).toHaveLength(1);
    expect(driftNew[0]).toMatchObject({ subject: frameExtraId, severity: 'warn', scope: 'tpsp' });
    expect(drift.result?.summary.warn).toBe(1);

    const approved = await runApprove(ctx(), { profile: 'default', allNew: true, ...APPROVER });
    expect(approved.added).toEqual([frameExtraId]);
    expect(entry(approved.manifest.scripts, frameExtraId)).toMatchObject({ scope: 'tpsp', integrity: 'track' });
  });

  it('the challenge page yields blocked with exit 2, and approve refuses the blocked snapshot', async () => {
    server.setBlocked(true);
    try {
      const scanOutcome = await runScan(ctx(), { profile: 'default' });
      expect(scanOutcome.exitCode).toBe(2);
      expect(scanOutcome.snapshot.blocked?.vendor).toBe('cloudflare');
      expect(existsSync(scanOutcome.path)).toBe(true);

      const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate' });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.snapshot.blocked?.vendor).toBe('cloudflare');
      expect(outcome.snapshot.documentStatus).toBe(503);
      const blocked = ofType(outcome.result, 'blocked');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.severity).toBe('fail');
      expect(stdout.join('\n')).toContain('blocked');

      await expect(runApprove(ctx(), { profile: 'default', allNew: true, ...APPROVER })).rejects.toMatchObject({
        code: 'SCAN_BLOCKED',
        exitCode: 2,
      });
    } finally {
      server.setBlocked(false);
    }
  });

  it('a changed security header fails the gate and --headers re-approves the observed values', async () => {
    server.setHeaders({ ...defaultSecurityHeaders(server.crossOrigin), 'X-Frame-Options': 'DENY' });
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate' });
    expect(outcome.exitCode).toBe(1);
    const changed = ofType(outcome.result, 'header-changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ subject: 'x-frame-options', severity: 'fail', before: 'SAMEORIGIN', after: 'DENY' });
    expect(ofType(outcome.result, 'header-added')).toEqual([]);
    expect(ofType(outcome.result, 'header-removed')).toEqual([]);

    const approved = await runApprove(ctx(), { profile: 'default', headers: true });
    expect(approved.headersRecorded).toBe(true);
    expect(approved.manifest.headers.values['x-frame-options']).toBe('DENY');
    const clean = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: lastPath });
    expect(clean.exitCode).toBe(0);
    expect(clean.result?.events).toEqual([]);
  });

  it('diff --history appends the snapshot, the result and an index line', async () => {
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'drift', snapshot: lastPath, history: true });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.historyPath).toBeDefined();
    expect(existsSync(outcome.historyPath ?? '')).toBe(true);
    expect(outcome.historyPath).toContain(join(dir, '.scriptlock', 'history', 'default'));
    const index = readFileSync(join(dir, '.scriptlock', 'history', 'default', 'index.jsonl'), 'utf8').trim().split('\n');
    expect(index).toHaveLength(1);
    expect(JSON.parse(index[0] ?? '')).toMatchObject({ exitCode: 0, fail: 0, blocked: false, url: `${server.origin}/` });
  });

  it('runs: 2 unions both runs and the union is clean against the manifest', async () => {
    const { snapshot } = await runScan(ctx(), { profile: 'default', runs: 2 });
    expect(snapshot.runs).toBe(2);
    expect(snapshot.scripts.length).toBeGreaterThanOrEqual(10);
    for (const script of snapshot.scripts) expect(script.observedInRuns).toBe(2);
    expect(snapshot.scripts.some((s) => s.id === appId && s.rawUrl === `${server.origin}/app.cafebabe12345678.js`)).toBe(true);
    expect(server.appHash).not.toBe(DEFAULT_APP_HASH);
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: lastPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.events).toEqual([]);
  });

  it('report renders the inventory as markdown and JSON with authorisation status', async () => {
    const md = await runReport(ctx(), { profile: 'default', format: 'md' });
    expect(md.manifestMissing).toBe(false);
    expect(md.report).toContain('## Scriptlock inventory: default');
    expect(md.report).toContain('### Scope: merchant');
    expect(md.report).toContain('### Scope: tpsp');
    expect(md.report).toContain('Owner / category: web / functional');
    expect(md.report).toContain('| approved |');
    expect(md.report).not.toContain('| unapproved |');
    expect(md.report).toContain('x-frame-options');

    const json = await runReport(ctx(), { profile: 'default', format: 'json', out: 'reports/inventory.json' });
    expect(json.outPath).toBe(join(dir, 'reports', 'inventory.json'));
    const parsed = JSON.parse(readFileSync(json.outPath ?? '', 'utf8')) as {
      summary: { scripts: number; approved: number; unapproved: number; stale: number };
      scopes: { scope: string; groups: { owner: string | null; scripts: { id: string; status: string }[] }[] }[];
      frames: { url: string; status: string }[];
      headers: { policy: string; values: Record<string, string> };
    };
    expect(parsed.summary.approved).toBe(parsed.summary.scripts);
    expect(parsed.summary.unapproved).toBe(0);
    expect(parsed.summary.stale).toBe(0);
    expect(parsed.scopes.map((s) => s.scope)).toEqual(['merchant', 'tpsp']);
    expect(parsed.scopes[0]?.groups[0]?.owner).toBe('web');
    expect(parsed.frames).toEqual([{ url: `${server.crossOrigin}/frame-cross.html`, scope: 'tpsp', status: 'approved' }]);
    expect(parsed.headers.policy).toBe('strict');
    expect(parsed.headers.values['x-frame-options']).toBe('DENY');
  });
});
