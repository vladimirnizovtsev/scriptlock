import { describe, expect, it } from 'vitest';
import { diff } from '../../../src/diff/diff.js';
import { renderJson } from '../../../src/report/json.js';
import { APP_ID, fakeNormalizeUrl, hex, makeEntry, makeFrameEntry, makeManifest, makeScript, makeSnapshot } from '../diff/helpers.js';

describe('renderJson', () => {
  const result = diff({
    snapshot: makeSnapshot({ scripts: [makeScript({ sha256: hex('f'), source: 'var secret = 1;' })] }),
    manifest: makeManifest({ scripts: [makeEntry()], frames: [makeFrameEntry()] }),
    mode: 'drift',
    normalizeUrl: fakeNormalizeUrl,
  });

  it('is valid JSON with stable top-level and event key order', () => {
    const text = renderJson(result);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['mode', 'profile', 'url', 'scannedAt', 'summary', 'exitCode', 'events']);
    expect(Object.keys(parsed['summary'] as object)).toEqual(['fail', 'warn', 'info', 'merchantScripts', 'totalScripts', 'approved']);
    const events = parsed['events'] as Record<string, unknown>[];
    expect(events).toHaveLength(2);
    expect(Object.keys(events[0] ?? {})).toEqual(['type', 'severity', 'subject', 'scope', 'message', 'before', 'after', 'observed', 'expected']);
    expect(Object.keys(events[1] ?? {})).toEqual(['type', 'severity', 'subject', 'scope', 'message', 'expected']);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('never writes script source and orders observed keys as declared', () => {
    const text = renderJson(result);
    expect(text).not.toContain('secret');
    const parsed = JSON.parse(text) as { events: { observed?: Record<string, unknown>; expected?: Record<string, unknown> }[] };
    const observed = parsed.events[0]?.observed ?? {};
    expect(Object.keys(observed).slice(0, 3)).toEqual(['id', 'kind', 'scope']);
    expect(observed['id']).toBe(APP_ID);
    expect(Object.keys(parsed.events[1]?.expected ?? {})).toEqual(['match', 'scope', 'owner', 'justification', 'approvedBy', 'approvedAt']);
  });

  it('is deterministic', () => {
    expect(renderJson(result)).toBe(renderJson(result));
  });
});
