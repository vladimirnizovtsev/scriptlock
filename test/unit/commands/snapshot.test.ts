/**
 * Snapshot file parsing. The interesting case is a snapshot that did not come
 * from this tool: `Snapshot.headers` is typed as `SecurityHeaders`, and the
 * diff both compares and prints those values, so a foreign header name must be
 * refused at the door rather than reported as `header-added` with its value.
 */
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '../../../src/commands/snapshot.js';
import { isScriptlockError } from '../../../src/errors.js';
import type { Snapshot } from '../../../src/types.js';

function snapshotJson(overrides: Partial<Snapshot> = {}): string {
  const base: Snapshot = {
    version: 1,
    tool: { name: 'scriptlock', version: '0.0.0-test' },
    profile: 'default',
    url: 'https://shop.example.com/checkout',
    finalUrl: 'https://shop.example.com/checkout',
    startedAt: '2026-09-02T10:00:00.000Z',
    finishedAt: '2026-09-02T10:00:05.000Z',
    runs: 1,
    vantage: { userAgent: 'test-agent', browser: 'chromium 151 (test)', headless: true },
    documentStatus: 200,
    headers: {},
    frames: [],
    scripts: [],
    warnings: [],
  };
  return JSON.stringify({ ...base, ...overrides });
}

describe('parseSnapshot', () => {
  it('accepts the security headers it knows and keeps their values', () => {
    const parsed = parseSnapshot(snapshotJson({ headers: { 'content-security-policy': "default-src 'self'", 'x-frame-options': 'DENY' } }));
    expect(parsed.headers).toEqual({ 'content-security-policy': "default-src 'self'", 'x-frame-options': 'DENY' });
  });

  it('refuses a response header that is not a security header', () => {
    // Left to `z.record(z.string(), z.string())` this file parsed, and the diff
    // then reported `header-added set-cookie` with the cookie in the message,
    // straight into a CI log or a pull request comment.
    let caught: unknown;
    try {
      parseSnapshot(snapshotJson({ headers: { 'set-cookie': 'session=abc' } as Snapshot['headers'] }), 'foreign.json');
    } catch (error) {
      caught = error;
    }
    expect(isScriptlockError(caught)).toBe(true);
    expect((caught as Error).message).toContain('Invalid snapshot foreign.json');
    expect((caught as Error).message).toContain('set-cookie');
  });

  it('drops script source text so a parsed snapshot can never carry a body', () => {
    const withSource = JSON.parse(snapshotJson()) as Record<string, unknown>;
    withSource['scripts'] = [
      {
        id: 'https://shop.example.com/app.js',
        kind: 'external',
        scope: 'merchant',
        hasSourceURL: false,
        frameId: 'main',
        frameUrl: 'https://shop.example.com/checkout',
        frameOrigin: 'https://shop.example.com',
        target: 'page',
        size: 10,
        isModule: false,
        observedInRuns: 1,
        source: 'alert(1)',
      },
    ];
    const parsed = parseSnapshot(JSON.stringify(withSource));
    expect(parsed.scripts[0]).not.toHaveProperty('source');
    expect(parsed.scripts[0]?.id).toBe('https://shop.example.com/app.js');
  });

  it('reports the field path when the file is not a snapshot at all', () => {
    expect(() => parseSnapshot('{"version":2}')).toThrow(/Invalid snapshot/);
    expect(() => parseSnapshot('not json')).toThrow(/Invalid JSON/);
  });
});
