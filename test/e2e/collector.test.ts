/**
 * E2E tests for the collector against the fixture server (DESIGN.md section 10).
 * Requires the Playwright-managed Chromium build.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scan } from '../../src/collector/collect.js';
import type { ObservedScript, Snapshot, ScriptlockConfig } from '../../src/types.js';
import { start, type FixtureServer } from '../../fixtures/server.js';

let server: FixtureServer;

function makeConfig(url: string, overrides: Partial<ScriptlockConfig> = {}): ScriptlockConfig {
  return {
    version: 1,
    browser: {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1366, height: 900 },
      timeoutMs: 30_000,
    },
    identity: { stripQuery: [], keepQuery: [], collapseHashes: true },
    scope: { tpsp: [], threeds: [] },
    integrity: { firstParty: 'strict', thirdParty: 'track', inline: 'structural', eval: 'structural' },
    profiles: {
      default: { url, wait: 'load', settleMs: 2500, runs: 1, history: false },
    },
    ...overrides,
  };
}

function byRawUrlSuffix(snapshot: Snapshot, suffix: string): ObservedScript {
  const found = snapshot.scripts.find((s) => s.rawUrl !== undefined && s.rawUrl.endsWith(suffix));
  if (found === undefined) {
    throw new Error(`no script with rawUrl ending in ${suffix}; have ${snapshot.scripts.map((s) => s.rawUrl ?? s.id).join(', ')}`);
  }
  return found;
}

beforeAll(async () => {
  server = await start();
});

afterAll(async () => {
  await server.close();
});

describe('collector', () => {
  let snapshot: Snapshot;

  beforeAll(async () => {
    snapshot = await scan({ config: makeConfig(`${server.origin}/`), profile: 'default', toolVersion: '0.0.0-test' });
  });

  it('records snapshot metadata and vantage', () => {
    expect(snapshot.version).toBe(1);
    expect(snapshot.tool).toEqual({ name: 'scriptlock', version: '0.0.0-test' });
    expect(snapshot.profile).toBe('default');
    expect(snapshot.url).toBe(`${server.origin}/`);
    expect(snapshot.finalUrl).toBe(`${server.origin}/`);
    expect(snapshot.runs).toBe(1);
    expect(snapshot.documentStatus).toBe(200);
    expect(snapshot.blocked).toBeUndefined();
    expect(snapshot.vantage.userAgent).toMatch(/Chrome/);
    expect(snapshot.vantage.browser).toMatch(/^chromium \d+\.\d+/);
    expect(snapshot.vantage.headless).toBe(true);
    expect(snapshot.vantage.channel).toBe('chromium');
    expect(snapshot.vantage.host).toBeTruthy();
    expect(Date.parse(snapshot.startedAt)).toBeLessThanOrEqual(Date.parse(snapshot.finishedAt));
  });

  it('never carries source text', () => {
    for (const script of snapshot.scripts) expect(script.source).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('"source"');
  });

  it('captures the main document security headers', () => {
    expect(snapshot.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(snapshot.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(snapshot.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(snapshot.headers['x-content-type-options']).toBe('nosniff');
    expect(snapshot.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(Object.keys(snapshot.headers)).not.toContain('content-type');
  });

  it('captures inline classic and module scripts in the main frame as merchant', () => {
    const main = snapshot.frames.find((f) => f.isMain);
    expect(main).toBeDefined();
    const inline = snapshot.scripts.filter((s) => s.kind === 'inline' && s.frameId === main?.id);
    expect(inline.length).toBeGreaterThanOrEqual(3);
    expect(inline.some((s) => s.isModule)).toBe(true);
    expect(inline.some((s) => !s.isModule)).toBe(true);
    for (const script of inline) {
      expect(script.scope).toBe('merchant');
      expect(script.target).toBe('page');
      expect(script.id).toMatch(/^inline:http:\/\/127\.0\.0\.1:\d+:[0-9a-f]{16}$/);
      expect(script.url).toBeUndefined();
      expect(script.frameOrigin).toBe(server.origin);
      expect(script.initiator?.type).toBe('parser');
    }
  });

  it('captures the first-party bundle with normalised id, hashes and response headers', () => {
    const app = byRawUrlSuffix(snapshot, `/app.${server.appHash}.js`);
    expect(app.kind).toBe('external');
    expect(app.scope).toBe('merchant');
    expect(app.id).toBe(`${server.origin}/app.[hash].js`);
    expect(app.url).toBe(app.id);
    expect(app.hasSourceURL).toBe(false);
    expect(app.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(app.structuralHash).toMatch(/^[0-9a-f]{64}$/);
    expect(app.size).toBeGreaterThan(0);
    expect(app.initiator?.type).toBe('parser');
    expect(app.responseHeaders?.contentType).toContain('javascript');
    expect(app.responseHeaders?.cacheControl).toBe('public, max-age=300');
    expect(app.responseHeaders?.etag).toBeDefined();
    expect(app.responseHeaders?.lastModified).toBe('Tue, 01 Sep 2026 10:00:00 GMT');
  });

  it('strips the cache buster from vendor.js', () => {
    const vendor = byRawUrlSuffix(snapshot, '/vendor.js?v=1');
    expect(vendor.kind).toBe('external');
    expect(vendor.id).toBe(`${server.origin}/vendor.js`);
  });

  it('captures the dynamically inserted script with a script initiator resolved to the inserting inline script', () => {
    const dynamic = byRawUrlSuffix(snapshot, '/dynamic.js');
    expect(dynamic.kind).toBe('external');
    expect(dynamic.initiator?.type).toBe('script');
    expect(dynamic.initiator?.stack?.length).toBeGreaterThan(0);
    expect(dynamic.loadedBy).toBeDefined();
    const parent = snapshot.scripts.find((s) => s.id === dynamic.loadedBy);
    expect(parent?.kind).toBe('inline');
    expect(dynamic.initiator?.scriptId).toBe(dynamic.loadedBy);
  });

  it('captures eval and new Function as eval scripts with a stack', () => {
    const evals = snapshot.scripts.filter((s) => s.kind === 'eval');
    expect(evals.length).toBeGreaterThanOrEqual(2);
    for (const script of evals) {
      expect(script.id).toMatch(/^eval:http:\/\/127\.0\.0\.1:\d+:[0-9a-f]{16}$/);
      expect(script.scope).toBe('merchant');
      expect(script.initiator?.type).toBe('script');
      expect(script.loadedBy).toBeDefined();
      expect(script.size).toBeGreaterThan(0);
    }
  });

  it('captures the blob: script', () => {
    const blob = snapshot.scripts.find((s) => s.kind === 'blob');
    expect(blob).toBeDefined();
    expect(blob?.rawUrl).toMatch(/^blob:http:\/\/127\.0\.0\.1:\d+\//);
    expect(blob?.id).toBe(`blob:${server.origin}`);
    expect(blob?.initiator?.type).toBe('script');
  });

  it('captures the late script inserted after 1500 ms', () => {
    const late = byRawUrlSuffix(snapshot, '/late.js');
    expect(late.kind).toBe('external');
    expect(late.initiator?.type).toBe('script');
  });

  it('records the spoofed sourceURL without using it for identity', () => {
    const spoof = byRawUrlSuffix(snapshot, '/spoof.js');
    expect(spoof.hasSourceURL).toBe(true);
    expect(spoof.sourceUrl).toBe('https://js.stripe.com/v3');
    expect(spoof.rawUrl).toBe(`${server.origin}/spoof.js`);
    expect(spoof.id).toBe(`${server.origin}/spoof.js`);
    expect(spoof.url).toBe(spoof.id);
    expect(snapshot.scripts.some((s) => s.id === 'https://js.stripe.com/v3')).toBe(false);
  });

  it('captures same-origin frame scripts as merchant in an iframe target', () => {
    const external = byRawUrlSuffix(snapshot, '/frame-same.js');
    expect(external.scope).toBe('merchant');
    expect(external.target).toBe('iframe');
    expect(external.frameUrl).toBe(`${server.origin}/frame-same.html`);
    const inline = snapshot.scripts.find((s) => s.kind === 'inline' && s.frameId === external.frameId);
    expect(inline).toBeDefined();
    expect(inline?.scope).toBe('merchant');
    const frame = snapshot.frames.find((f) => f.id === external.frameId);
    expect(frame?.scope).toBe('merchant');
    expect(frame?.crossOrigin).toBe(false);
    expect(frame?.isMain).toBe(false);
  });

  it('captures cross-origin frame scripts as embedded by default', () => {
    const external = byRawUrlSuffix(snapshot, '/frame-cross.js');
    expect(external.rawUrl).toBe(`${server.crossOrigin}/frame-cross.js`);
    expect(external.scope).toBe('embedded');
    expect(external.target).toBe('iframe');
    expect(external.frameOrigin).toBe(server.crossOrigin);
    const inline = snapshot.scripts.find((s) => s.kind === 'inline' && s.frameId === external.frameId);
    expect(inline?.scope).toBe('embedded');
    expect(inline?.id).toBe(`inline:${server.crossOrigin}:${inline?.structuralHash.slice(0, 16)}`);
    const frame = snapshot.frames.find((f) => f.id === external.frameId);
    expect(frame?.scope).toBe('embedded');
    expect(frame?.crossOrigin).toBe(true);
    expect(frame?.origin).toBe(server.crossOrigin);
    expect(frame?.parentId).toBe(snapshot.frames.find((f) => f.isMain)?.id);
  });

  it('contains no harness scripts', () => {
    for (const script of snapshot.scripts) {
      expect(script.scope).not.toBe('harness');
      if (script.kind !== 'worker') expect(script.size).toBeGreaterThan(0);
      if (script.rawUrl === undefined) expect(script.initiator).toBeDefined();
      if (script.kind === 'eval') expect(script.initiator?.stack?.length).toBeGreaterThan(0);
    }
    expect(snapshot.scripts.filter((s) => s.sha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toEqual([]);
  });

  it('records every expected script kind exactly once per id', () => {
    const ids = snapshot.scripts.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(snapshot.scripts.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['inline', 'external', 'eval', 'blob']));
    for (const script of snapshot.scripts) expect(script.observedInRuns).toBe(1);
  });
});

describe('collector with scope.tpsp containing localhost', () => {
  it('classifies the cross-origin frame and its scripts as tpsp', async () => {
    const config = makeConfig(`${server.origin}/`);
    config.scope.tpsp = ['localhost'];
    const snapshot = await scan({ config, profile: 'default', toolVersion: '0.0.0-test' });
    const external = byRawUrlSuffix(snapshot, '/frame-cross.js');
    expect(external.scope).toBe('tpsp');
    const inline = snapshot.scripts.find((s) => s.kind === 'inline' && s.frameId === external.frameId);
    expect(inline?.scope).toBe('tpsp');
    expect(snapshot.frames.find((f) => f.id === external.frameId)?.scope).toBe('tpsp');
    expect(byRawUrlSuffix(snapshot, '/frame-same.js').scope).toBe('merchant');
    expect(byRawUrlSuffix(snapshot, `/app.${server.appHash}.js`).scope).toBe('merchant');
  });
});

describe('collector with runs: 2', () => {
  it('unions the runs and counts observations per id', async () => {
    const single = await scan({ config: makeConfig(`${server.origin}/`), profile: 'default', toolVersion: '0.0.0-test' });
    const snapshot = await scan({ config: makeConfig(`${server.origin}/`), profile: 'default', runs: 2, toolVersion: '0.0.0-test' });
    expect(snapshot.runs).toBe(2);
    expect(snapshot.scripts.length).toBe(single.scripts.length);
    expect(new Set(snapshot.scripts.map((s) => s.id))).toEqual(new Set(single.scripts.map((s) => s.id)));
    for (const script of snapshot.scripts) expect(script.observedInRuns).toBe(2);
    // The nonce-bearing inline script has a per-request sha256 but a stable structural id.
    const hydration = snapshot.scripts.find((s) => {
      const other = single.scripts.find((x) => x.id === s.id);
      return s.kind === 'inline' && other !== undefined && other.sha256 !== s.sha256;
    });
    expect(hydration).toBeDefined();
    expect(hydration?.structuralHash).toBe(single.scripts.find((x) => x.id === hydration?.id)?.structuralHash);
    expect(snapshot.frames.filter((f) => f.isMain).length).toBe(1);
  });
});

describe('collector worker entries', () => {
  it('records the dedicated worker entry URL with an empty body hash and a warning', async () => {
    const snapshot = await scan({ config: makeConfig(`${server.origin}/?worker=1`), profile: 'default', toolVersion: '0.0.0-test' });
    const worker = snapshot.scripts.find((s) => s.kind === 'worker');
    expect(worker).toBeDefined();
    expect(worker?.rawUrl).toBe(`${server.origin}/worker.js`);
    expect(worker?.id).toBe(`${server.origin}/worker.js`);
    expect(worker?.target).toBe('worker');
    expect(worker?.scope).toBe('merchant');
    expect(worker?.size).toBe(0);
    // The body is never read, so there is no body hash (never the empty-string hash).
    expect(worker?.sha256).toBeUndefined();
    expect(worker?.structuralHash).toBeUndefined();
    expect(snapshot.warnings.some((w) => w.includes('worker.js') && w.includes('not captured'))).toBe(true);
    // Inline scripts still resolve as inline when the document URL has a query string.
    expect(snapshot.scripts.filter((s) => s.kind === 'inline').length).toBeGreaterThanOrEqual(3);
  });
});

describe('collector string-timer and stackless page code', () => {
  it('records setTimeout(string) / setInterval(string) as eval scripts, not harness', async () => {
    const plain = await scan({ config: makeConfig(`${server.origin}/`), profile: 'default', toolVersion: '0.0.0-test' });
    const withVectors = await scan({ config: makeConfig(`${server.origin}/?vectors=1`), profile: 'default', toolVersion: '0.0.0-test' });
    const baselineEvals = plain.scripts.filter((s) => s.kind === 'eval').length;
    const evals = withVectors.scripts.filter((s) => s.kind === 'eval');
    // The two timer strings are compiled without a URL and without a stack; they
    // must still be inventoried rather than dropped as harness artefacts.
    expect(evals.length).toBeGreaterThanOrEqual(baselineEvals + 2);
    expect(evals.some((s) => s.initiator?.type === 'other')).toBe(true);
    for (const script of withVectors.scripts) {
      expect(script.scope).not.toBe('harness');
      if (script.kind === 'eval') expect(script.size).toBeGreaterThan(0);
    }
  });
});

describe('collector extra-header scoping', () => {
  it('sends browser.extraHeaders to the profile host but never to a cross-origin host', async () => {
    server.clearRequests();
    const config = makeConfig(`${server.origin}/`);
    config.browser.extraHeaders = { 'X-Scanner-Token': 'secret-token' };
    await scan({ config, profile: 'default', toolVersion: '0.0.0-test' });
    const reqs = server.requests;
    const firstParty = reqs.filter((r) => r.host.startsWith('127.0.0.1'));
    const crossOrigin = reqs.filter((r) => r.host.startsWith('localhost'));
    expect(firstParty.some((r) => r.token === 'secret-token')).toBe(true);
    expect(crossOrigin.length).toBeGreaterThan(0);
    expect(crossOrigin.every((r) => r.token === undefined)).toBe(true);
  });

  it('widens the allowlist with browser.extraHeadersHosts', async () => {
    server.clearRequests();
    const config = makeConfig(`${server.origin}/`);
    config.browser.extraHeaders = { 'X-Scanner-Token': 'secret-token' };
    config.browser.extraHeadersHosts = ['localhost'];
    await scan({ config, profile: 'default', toolVersion: '0.0.0-test' });
    const crossOrigin = server.requests.filter((r) => r.host.startsWith('localhost'));
    expect(crossOrigin.length).toBeGreaterThan(0);
    expect(crossOrigin.some((r) => r.token === 'secret-token')).toBe(true);
  });
});

describe('collector blocked detection', () => {
  it('flags the challenge page as blocked while still recording the inventory', async () => {
    const snapshot = await scan({ config: makeConfig(`${server.origin}/challenge`), profile: 'default', toolVersion: '0.0.0-test' });
    expect(snapshot.documentStatus).toBe(503);
    expect(snapshot.blocked).toBeDefined();
    expect(snapshot.blocked?.vendor).toBe('cloudflare');
    expect(snapshot.blocked?.evidence).toMatch(/cf-mitigated|Just a moment/);
    expect(snapshot.blocked?.evidence).toContain('503');
    expect(snapshot.scripts.some((s) => s.kind === 'inline')).toBe(true);
  });
});

describe('collector errors', () => {
  it('rejects an unknown profile', async () => {
    await expect(scan({ config: makeConfig(`${server.origin}/`), profile: 'missing', toolVersion: '0.0.0-test' })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      exitCode: 2,
    });
  });

  it('reports a failed navigation', async () => {
    const config = makeConfig('http://127.0.0.1:1/');
    config.browser.timeoutMs = 5000;
    await expect(scan({ config, profile: 'default', toolVersion: '0.0.0-test' })).rejects.toMatchObject({
      code: 'NAVIGATION_FAILED',
      exitCode: 2,
    });
  });

  it('reports a failed step', async () => {
    const config = makeConfig(`${server.origin}/`);
    config.browser.timeoutMs = 2000;
    config.profiles['default']!.steps = [{ click: '#does-not-exist' }];
    await expect(scan({ config, profile: 'default', toolVersion: '0.0.0-test' })).rejects.toMatchObject({
      code: 'STEP_FAILED',
      exitCode: 2,
    });
  });

  it('reports a missing browser executable with an install hint', async () => {
    const config = makeConfig(`${server.origin}/`);
    config.browser.executablePath = '/nonexistent/path/to/chromium';
    await expect(scan({ config, profile: 'default', toolVersion: '0.0.0-test' })).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
      exitCode: 2,
      hint: expect.stringContaining('browser.executablePath'),
    });
  });
});

describe('collector steps DSL', () => {
  it('runs goto, fill, select, click, waitFor, press and wait steps', async () => {
    const config = makeConfig(`${server.origin}/`);
    config.profiles['default']!.settleMs = 500;
    config.profiles['default']!.steps = [
      { goto: '/frame-same.html' },
      { goto: '/' },
      { waitFor: '#email' },
      { fill: { selector: '#email', value: 'test@example.com' } },
      { select: { selector: '#country', value: 'fr' } },
      { click: '#pay' },
      { press: 'Tab' },
      { wait: 100 },
    ];
    const snapshot = await scan({ config, profile: 'default', toolVersion: '0.0.0-test' });
    expect(snapshot.finalUrl).toBe(`${server.origin}/`);
    // Scripts from the intermediate navigation are recorded in their own frame URL.
    const sameFrameScripts = snapshot.scripts.filter((s) => s.frameUrl === `${server.origin}/frame-same.html`);
    expect(sameFrameScripts.length).toBeGreaterThan(0);
    expect(byRawUrlSuffix(snapshot, `/app.${server.appHash}.js`).scope).toBe('merchant');
    for (const script of snapshot.scripts) expect(script.scope).not.toBe('harness');
  });
});

describe('collector flow modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scriptlock-flow-'));

  it('runs a .mjs flow module exporting a default function', async () => {
    const modulePath = join(dir, 'flow.mjs');
    writeFileSync(modulePath, "export default async function flow(page) { await page.fill('#email', 'flow@example.com'); await page.goto(page.url()); }\n");
    const config = makeConfig(`${server.origin}/`);
    config.profiles['default']!.settleMs = 500;
    config.profiles['default']!.steps = modulePath;
    const snapshot = await scan({ config, profile: 'default', toolVersion: '0.0.0-test' });
    expect(snapshot.finalUrl).toBe(`${server.origin}/`);
    expect(byRawUrlSuffix(snapshot, `/app.${server.appHash}.js`).kind).toBe('external');
  });

  it('runs a .ts flow module through tsx', async () => {
    const modulePath = join(dir, 'flow.ts');
    writeFileSync(modulePath, "import type { Page } from 'playwright-core';\nexport default async function flow(page: Page): Promise<void> { const value: string = 'ts@example.com'; await page.fill('#email', value); }\n");
    const config = makeConfig(`${server.origin}/`);
    config.profiles['default']!.settleMs = 500;
    config.profiles['default']!.steps = modulePath;
    const snapshot = await scan({ config, profile: 'default', toolVersion: '0.0.0-test' });
    expect(snapshot.documentStatus).toBe(200);
  });

  it('rejects a module without a default function export', async () => {
    const modulePath = join(dir, 'bad.mjs');
    writeFileSync(modulePath, 'export const nothing = 1;\n');
    const config = makeConfig(`${server.origin}/`);
    config.profiles['default']!.steps = modulePath;
    await expect(scan({ config, profile: 'default', toolVersion: '0.0.0-test' })).rejects.toMatchObject({ code: 'STEP_FAILED', exitCode: 2 });
  });
});
