import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptlockError } from '../../../src/errors.js';
import { emptyManifest, parseManifest, readManifest, serialiseManifest, sortManifest, writeManifest } from '../../../src/manifest/io.js';
import type { Manifest, ManifestScript } from '../../../src/types.js';

const CSP = "default-src 'self'; script-src 'self' https://js.stripe.com https://www.googletagmanager.com 'nonce-abc123' 'strict-dynamic'; frame-src https://js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'";

function script(overrides: Partial<ManifestScript> & Pick<ManifestScript, 'id'>): ManifestScript {
  return {
    kind: 'external',
    scope: 'merchant',
    integrity: 'strict',
    integrityMethod: 'hash-strict',
    sha256: 'a'.repeat(64),
    owner: 'web',
    category: 'functional',
    justification: 'Storefront bundle',
    approvedBy: 'v.nizovtsev',
    approvedAt: '2026-09-02',
    ...overrides,
  };
}

function sample(): Manifest {
  return {
    version: 1,
    profile: 'checkout',
    url: 'https://shop.example.com/',
    headers: {
      policy: 'strict',
      values: {
        'strict-transport-security': 'max-age=63072000; includeSubDomains',
        'content-security-policy': CSP,
        'x-frame-options': 'DENY',
      },
    },
    frames: [
      { match: 'https://js.stripe.com/v3/elements-inner-card-[hash].html', scope: 'tpsp', owner: 'payments', justification: 'Stripe Elements', approvedBy: 'v', approvedAt: '2026-09-02' },
      { match: 'https://chat.example.net/widget', scope: 'embedded', owner: 'support', justification: 'Chat widget', approvedBy: 'v', approvedAt: '2026-09-02' },
    ],
    scripts: [
      script({ id: 'inline:https://shop.example.com:9f2c41ba0d77e1a3', kind: 'inline', integrity: 'structural', structuralHash: 'b'.repeat(64), category: 'framework', justification: 'Hydration state: literals change per request', notes: 'true' }),
      script({ id: 'https://js.stripe.com/v3/inner.js', scope: 'tpsp', integrity: 'track', integrityMethod: 'vendor-attested', category: 'payment', lastSeenSha256: 'c'.repeat(64) }),
      script({ id: 'https://shop.example.com/assets/app.[hash].js', match: 'https://shop.example.com/assets/app-*.js' }),
      script({ id: 'https://js.stripe.com/v3', integrity: 'track', integrityMethod: 'source-tracked', category: 'payment', justification: 'Stripe.js loader; evergreen' }),
      script({ id: 'https://cdn.example.net/vendor.js?id=GTM-ABC', integrity: 'url-only', integrityMethod: 'none', category: 'tag-manager', justification: '2026-09-02' }),
      script({ id: 'eval:https://widget.example.net:0011223344556677', kind: 'eval', scope: 'embedded', integrity: 'structural', structuralHash: 'd'.repeat(64), category: 'other', justification: 'Widget eval' }),
    ],
    ignore: ['https://shop.example.com/preview-*.js', 'https://abtest.example.net/debug.js'],
  };
}

describe('serialiseManifest', () => {
  it('is deterministic regardless of input order', () => {
    const a = sample();
    const b = sample();
    b.scripts.reverse();
    b.frames.reverse();
    b.ignore.reverse();
    b.headers.values = { 'x-frame-options': 'DENY', 'content-security-policy': CSP, 'strict-transport-security': 'max-age=63072000; includeSubDomains' };
    expect(serialiseManifest(a)).toBe(serialiseManifest(b));
    expect(serialiseManifest(a)).toBe(serialiseManifest(a));
  });

  it('emits keys in types.ts order, scripts sorted by scope then id, frames by match, ignore sorted', () => {
    const text = serialiseManifest(sample());
    const lines = text.split('\n');
    const topLevel = lines.filter((line) => /^[a-z]+:/.test(line)).map((line) => line.split(':')[0]);
    expect(topLevel).toEqual(['version', 'profile', 'url', 'headers', 'frames', 'scripts', 'ignore']);

    const headerNames = lines.filter((line) => line.startsWith('    ') && /^    [a-z-]+:/.test(line) && lines.indexOf(line) < lines.indexOf('frames:')).map((line) => line.trim().split(':')[0]);
    expect(headerNames).toEqual(['content-security-policy', 'strict-transport-security', 'x-frame-options']);

    const ids = lines.filter((line) => line.startsWith('  - id: ')).map((line) => line.slice('  - id: '.length).replace(/^"|"$/g, ''));
    expect(ids).toEqual([
      'https://cdn.example.net/vendor.js?id=GTM-ABC',
      'https://js.stripe.com/v3',
      'https://shop.example.com/assets/app.[hash].js',
      'inline:https://shop.example.com:9f2c41ba0d77e1a3',
      'https://js.stripe.com/v3/inner.js',
      'eval:https://widget.example.net:0011223344556677',
    ]);

    const frames = lines.filter((line) => line.startsWith('  - match: ')).map((line) => line.slice('  - match: '.length));
    expect(frames).toEqual(['https://chat.example.net/widget', 'https://js.stripe.com/v3/elements-inner-card-[hash].html']);

    const ignoreStart = lines.indexOf('ignore:');
    expect(lines.slice(ignoreStart + 1, ignoreStart + 3).map((line) => line.trim())).toEqual([
      '- https://abtest.example.net/debug.js',
      '- https://shop.example.com/preview-*.js',
    ]);

    const scriptKeys = lines.slice(lines.indexOf('scripts:') + 1).filter((line) => /^    [a-zA-Z0-9]+:/.test(line) || line.startsWith('  - id:')).map((line) => line.trim().replace(/^- /, '').split(':')[0]);
    const firstEntry = scriptKeys.slice(0, scriptKeys.indexOf('id', 1));
    expect(firstEntry).toEqual(['id', 'kind', 'scope', 'integrity', 'integrityMethod', 'sha256', 'owner', 'category', 'justification', 'approvedBy', 'approvedAt']);
    const appEntryStart = lines.findIndex((line) => line.includes('app.[hash].js'));
    expect(lines[appEntryStart + 1]?.trim().startsWith('match:')).toBe(true);
  });

  it('keeps long CSP values on one line and ends with a newline', () => {
    const text = serialiseManifest(sample());
    const cspLine = text.split('\n').find((line) => line.includes('content-security-policy'));
    expect(cspLine).toBeDefined();
    expect(cspLine).toContain("'strict-dynamic'");
    expect(cspLine).toContain("'unsafe-inline'");
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\n\n');
  });

  it('does not emit undefined optional keys', () => {
    const text = serialiseManifest(sample());
    expect(text).not.toMatch(/match: undefined|notes: undefined|sha256: undefined|structuralHash: undefined|lastSeenSha256: undefined/);
    expect(text).not.toContain('null');
  });
});

describe('round trip', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'scriptlock-manifest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write then read yields an equal, sorted manifest, and rewriting is byte-identical', async () => {
    const file = path.join(dir, 'nested', 'scriptlock.checkout.lock.yaml');
    const manifest = sample();
    await writeManifest(file, manifest);
    const read = await readManifest(file);
    expect(read).toEqual(sortManifest(manifest));
    expect(read.scripts.find((s) => s.id.startsWith('inline:'))?.notes).toBe('true');
    expect(read.scripts.find((s) => s.id.includes('vendor.js'))?.justification).toBe('2026-09-02');
    const first = await readFile(file, 'utf8');
    await writeManifest(file, read);
    expect(await readFile(file, 'utf8')).toBe(first);
  });

  it('parses the DESIGN.md example', () => {
    const text = `version: 1
profile: checkout
url: https://shop.example.com/
headers:
  policy: strict
  values:
    content-security-policy: "default-src 'self'; script-src 'self' https://js.stripe.com"
    strict-transport-security: max-age=63072000; includeSubDomains
frames:
  - match: https://js.stripe.com/v3/elements-inner-card-[hash].html
    scope: tpsp
    owner: payments
    justification: Stripe Elements card field
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-02
scripts:
  - id: https://shop.example.com/assets/app.[hash].js
    kind: external
    scope: merchant
    integrity: strict
    integrityMethod: hash-strict
    sha256: 9f2c
    owner: web
    category: functional
    justification: Storefront bundle built from this repository
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-02
ignore: []
`;
    const manifest = parseManifest(text);
    expect(manifest.headers.values['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(manifest.frames[0]?.approvedAt).toBe('2026-09-02');
    expect(manifest.scripts[0]?.sha256).toBe('9f2c');
  });

  it('fills defaults for absent collections', () => {
    const manifest = parseManifest('version: 1\nprofile: default\nurl: https://x.example/\n');
    expect(manifest).toEqual(emptyManifest('default', 'https://x.example/'));
  });
});

describe('errors', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'scriptlock-manifest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('MANIFEST_NOT_FOUND with exit code 1 and an approve hint', async () => {
    const file = path.join(dir, 'scriptlock.lock.yaml');
    await expect(readManifest(file)).rejects.toMatchObject({
      code: 'MANIFEST_NOT_FOUND',
      exitCode: 1,
      message: expect.stringContaining(file),
      hint: expect.stringContaining('approve --all-new'),
    });
  });

  it('MANIFEST_INVALID names the path and the problem', async () => {
    const file = path.join(dir, 'scriptlock.lock.yaml');
    await writeFile(file, 'version: 1\nprofile: default\nurl: https://x.example/\nscripts:\n  - id: a\n    kind: external\n    scope: merchant\n    integrity: strict\n    integrityMethod: hash-strict\n    owner: web\n    category: functional\n    justification: j\n    approvedBy: v\n    approvedAt: 2026-09-02\n');
    let caught: unknown;
    try {
      await readManifest(file);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptlockError);
    const err = caught as ScriptlockError;
    expect(err.code).toBe('MANIFEST_INVALID');
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain(file);
    expect(err.message).toContain('scripts.0.sha256');
    expect(err.message).toContain('strict integrity requires sha256');
  });

  it('rejects duplicate ids, unknown keys, bad enums, bad dates and malformed YAML', () => {
    const base = sample();
    const dup = { ...base, scripts: [base.scripts[2], base.scripts[2]] } as Manifest;
    expect(() => parseManifest(serialiseManifest(dup))).toThrow(/duplicate script id/);
    expect(() => parseManifest(serialiseManifest(base).replace('policy: strict', 'policy: loose'))).toThrow(/headers.policy/);
    expect(() => parseManifest(serialiseManifest(base).replace('approvedAt: 2026-09-02', 'approvedAt: yesterday'))).toThrow(/approvedAt/);
    expect(() => parseManifest(serialiseManifest(base) + 'extra: 1\n')).toThrow(/extra/);
    expect(() => parseManifest('version: [1', 'lock.yaml')).toThrow(/Invalid YAML in lock.yaml/);
    expect(() => parseManifest('', 'lock.yaml')).toThrow(/empty/);
    expect(() => parseManifest('- a\n')).toThrow(/mapping/);
  });
});
