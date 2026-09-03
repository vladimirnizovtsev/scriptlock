import { describe, expect, it } from 'vitest';
import { diff } from '../../../src/diff/diff.js';
import type { DiffEvent, DiffMode } from '../../../src/types.js';
import {
  APP_ID,
  APP_SHA,
  APP_STRUCT,
  fakeNormalizeUrl,
  hex,
  INLINE_ID,
  INLINE_SHA,
  INLINE_STRUCT,
  mainFrame,
  makeEntry,
  makeFrame,
  makeFrameEntry,
  makeManifest,
  makeScript,
  makeSnapshot,
  STRIPE_ID,
  STRIPE_SHA,
} from './helpers.js';

const MODES: DiffMode[] = ['gate', 'drift'];

function ofType(events: DiffEvent[], type: DiffEvent['type']): DiffEvent[] {
  return events.filter((e) => e.type === type);
}

function run(snapshotOverrides: Parameters<typeof makeSnapshot>[0], manifestOverrides: Parameters<typeof makeManifest>[0], mode: DiffMode) {
  return diff({ snapshot: makeSnapshot(snapshotOverrides), manifest: makeManifest(manifestOverrides), mode, normalizeUrl: fakeNormalizeUrl });
}

describe('diff: clean run', () => {
  it.each(MODES)('produces no events and exit 0 when everything matches (%s)', (mode) => {
    const result = run(
      { scripts: [makeScript(), makeScript({ id: STRIPE_ID, url: STRIPE_ID, sha256: STRIPE_SHA, structuralHash: hex('1') })] },
      { scripts: [makeEntry(), makeEntry({ id: STRIPE_ID, integrity: 'track', integrityMethod: 'source-tracked', sha256: STRIPE_SHA })] },
      mode,
    );
    expect(result.events).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({ fail: 0, warn: 0, info: 0, merchantScripts: 2, totalScripts: 2, approved: 2 });
    expect(result.mode).toBe(mode);
    expect(result.profile).toBe('default');
    expect(result.scannedAt).toBe('2026-09-02T10:00:05.000Z');
  });
});

describe('diff: blocked', () => {
  it.each(MODES)('emits a fail event and exit 2 (%s)', (mode) => {
    const result = run({ blocked: { vendor: 'cloudflare', evidence: "title contains 'Just a moment...'" } }, {}, mode);
    const [event] = ofType(result.events, 'blocked');
    expect(event?.severity).toBe('fail');
    expect(event?.message).toContain('cloudflare');
    expect(result.exitCode).toBe(2);
  });

  it('exit 2 wins over fail findings', () => {
    const result = run({ blocked: { vendor: 'akamai', evidence: 'x' }, scripts: [makeScript({ id: 'https://evil.example/x.js' })] }, {}, 'gate');
    expect(result.summary.fail).toBe(2);
    expect(result.exitCode).toBe(2);
  });
});

describe('diff: new', () => {
  it('merchant scope fails in both modes', () => {
    for (const mode of MODES) {
      const result = run({ scripts: [makeScript({ entity: { name: 'Acme', category: 'analytics' }, loadedBy: 'https://gtm.example/gtm.js' })] }, {}, mode);
      const [event] = result.events;
      expect(event?.type).toBe('new');
      expect(event?.severity).toBe('fail');
      expect(event?.scope).toBe('merchant');
      expect(event?.subject).toBe(APP_ID);
      expect(event?.message).toContain('Acme');
      expect(event?.message).toContain('loaded by https://gtm.example/gtm.js');
      expect(event?.observed?.id).toBe(APP_ID);
      expect(result.exitCode).toBe(1);
    }
  });

  it.each(['tpsp', 'threeds', 'embedded'] as const)('%s scope is info in gate and warn in drift', (scope) => {
    const script = makeScript({ id: 'https://frame.example/x.js', scope, frameId: 'f1' });
    const gate = run({ scripts: [script] }, {}, 'gate');
    expect(gate.events[0]?.severity).toBe('info');
    expect(gate.exitCode).toBe(0);
    expect(gate.summary.merchantScripts).toBe(0);
    expect(gate.summary.totalScripts).toBe(1);
    const drift = run({ scripts: [script] }, {}, 'drift');
    expect(drift.events[0]?.severity).toBe('warn');
    expect(drift.exitCode).toBe(0);
  });

  it('never reports harness scripts', () => {
    const result = run({ scripts: [makeScript({ scope: 'harness', id: 'eval:x:1' })] }, {}, 'gate');
    expect(result.events).toEqual([]);
    expect(result.summary.totalScripts).toBe(0);
  });
});

describe('diff: removed', () => {
  it.each(MODES)('entry without observation is warn (%s)', (mode) => {
    const result = run({ runs: 2 }, { scripts: [makeEntry()] }, mode);
    const [event] = result.events;
    expect(event?.type).toBe('removed');
    expect(event?.severity).toBe('warn');
    expect(event?.subject).toBe(APP_ID);
    expect(event?.scope).toBe('merchant');
    expect(event?.message).toContain('2 runs');
    expect(event?.expected).toMatchObject({ id: APP_ID });
    expect(result.exitCode).toBe(0);
  });

  it('a glob entry counts as observed when any id matches it', () => {
    const entry = makeEntry({ id: 'https://shop.example.com/assets/chunk.[hash].js', match: 'https://shop.example.com/assets/chunk.*.js' });
    const result = run({ scripts: [makeScript({ id: 'https://shop.example.com/assets/chunk.abc.js', sha256: APP_SHA })] }, { scripts: [entry] }, 'gate');
    expect(ofType(result.events, 'removed')).toEqual([]);
    expect(ofType(result.events, 'new')).toEqual([]);
    expect(result.summary.approved).toBe(1);
  });
});

describe('diff: changed', () => {
  it.each(MODES)('strict sha256 mismatch fails (%s)', (mode) => {
    const result = run({ scripts: [makeScript({ sha256: hex('f') })] }, { scripts: [makeEntry()] }, mode);
    const [event] = result.events;
    expect(event?.type).toBe('changed');
    expect(event?.severity).toBe('fail');
    expect(event?.before).toBe(APP_SHA);
    expect(event?.after).toBe(hex('f'));
    expect(event?.message).toContain('strict');
    expect(event?.message).toContain(APP_SHA.slice(0, 12));
    expect(result.exitCode).toBe(1);
  });

  it('strict ignores a structural-only difference', () => {
    const result = run({ scripts: [makeScript({ structuralHash: hex('9') })] }, { scripts: [makeEntry()] }, 'gate');
    expect(result.events).toEqual([]);
  });

  it.each(MODES)('structural hash mismatch fails, sha256 difference alone does not (%s)', (mode) => {
    const entry = makeEntry({ id: INLINE_ID, kind: 'inline', integrity: 'structural', sha256: INLINE_SHA, structuralHash: INLINE_STRUCT });
    const literalOnly = makeScript({ id: INLINE_ID, kind: 'inline', url: undefined, sha256: hex('7'), structuralHash: INLINE_STRUCT });
    expect(run({ scripts: [literalOnly] }, { scripts: [entry] }, mode).events).toEqual([]);
    const reshaped = makeScript({ id: INLINE_ID, kind: 'inline', url: undefined, sha256: hex('7'), structuralHash: hex('8') });
    const result = run({ scripts: [reshaped] }, { scripts: [entry] }, mode);
    expect(result.events[0]).toMatchObject({ type: 'changed', severity: 'fail', before: INLINE_STRUCT, after: hex('8') });
    expect(result.exitCode).toBe(1);
  });

  it.each(MODES)('track body change is info and never fails (%s)', (mode) => {
    const entry = makeEntry({ id: STRIPE_ID, integrity: 'track', integrityMethod: 'vendor-attested', sha256: STRIPE_SHA, structuralHash: undefined });
    const result = run({ scripts: [makeScript({ id: STRIPE_ID, url: STRIPE_ID, sha256: hex('5') })] }, { scripts: [entry] }, mode);
    expect(result.events[0]).toMatchObject({ type: 'changed', severity: 'info', before: STRIPE_SHA, after: hex('5') });
    expect(result.exitCode).toBe(0);
    expect(result.summary.info).toBe(1);
  });

  it('track accepts sha256 or lastSeenSha256', () => {
    const entry = makeEntry({ id: STRIPE_ID, integrity: 'track', sha256: STRIPE_SHA, lastSeenSha256: hex('5') });
    expect(run({ scripts: [makeScript({ id: STRIPE_ID, sha256: hex('5') })] }, { scripts: [entry] }, 'gate').events).toEqual([]);
    expect(run({ scripts: [makeScript({ id: STRIPE_ID, sha256: STRIPE_SHA })] }, { scripts: [entry] }, 'gate').events).toEqual([]);
    const changed = run({ scripts: [makeScript({ id: STRIPE_ID, sha256: hex('6') })] }, { scripts: [entry] }, 'gate');
    expect(changed.events[0]?.before).toBe(hex('5'));
  });

  it.each(MODES)('url-only is never emitted (%s)', (mode) => {
    const entry = makeEntry({ integrity: 'url-only', integrityMethod: 'source-tracked' });
    const result = run({ scripts: [makeScript({ sha256: hex('f'), structuralHash: hex('e') })] }, { scripts: [entry] }, mode);
    expect(result.events).toEqual([]);
    expect(result.summary.approved).toBe(1);
  });
});

describe('diff: moved', () => {
  it.each(MODES)('a new id with an approved strict hash is moved, not new (%s)', (mode) => {
    const moved = makeScript({ id: 'https://cdn.evil.example/app.js', url: 'https://cdn.evil.example/app.js', sha256: APP_SHA });
    const result = run({ scripts: [moved] }, { scripts: [makeEntry()] }, mode);
    const [event] = ofType(result.events, 'moved');
    expect(event?.severity).toBe('fail');
    expect(event?.subject).toBe('https://cdn.evil.example/app.js');
    expect(event?.message).toContain(APP_ID);
    expect(event?.expected).toMatchObject({ id: APP_ID });
    expect(ofType(result.events, 'new')).toEqual([]);
    expect(ofType(result.events, 'removed')).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('structural entries with a sha256 take part in the index; track entries do not', () => {
    const structural = makeEntry({ id: INLINE_ID, kind: 'inline', integrity: 'structural', sha256: INLINE_SHA, structuralHash: INLINE_STRUCT });
    const fromStructural = run({ scripts: [makeScript({ id: 'https://x.example/a.js', sha256: INLINE_SHA })] }, { scripts: [structural] }, 'gate');
    expect(fromStructural.events[0]?.type).toBe('moved');
    const track = makeEntry({ id: STRIPE_ID, integrity: 'track', sha256: STRIPE_SHA });
    const fromTrack = run({ scripts: [makeScript({ id: 'https://x.example/a.js', sha256: STRIPE_SHA })] }, { scripts: [track] }, 'gate');
    expect(fromTrack.events[0]?.type).toBe('new');
  });
});

describe('diff: spoofed', () => {
  const realId = 'https://shop.example.com/spoof.js';

  it.each(MODES)('sourceURL matching a manifest id while the real id is unknown fails (%s)', (mode) => {
    const spoof = makeScript({ id: realId, url: realId, hasSourceURL: true, sourceUrl: 'https://js.stripe.com/v3?v=9#x', sha256: hex('3') });
    const entry = makeEntry({ id: STRIPE_ID, integrity: 'track', sha256: STRIPE_SHA });
    const result = run({ scripts: [spoof] }, { scripts: [entry] }, mode);
    const [event] = ofType(result.events, 'spoofed');
    expect(event?.severity).toBe('fail');
    expect(event?.subject).toBe(realId);
    expect(event?.message).toContain(STRIPE_ID);
    expect(event?.expected).toMatchObject({ id: STRIPE_ID });
    expect(ofType(result.events, 'new')).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it('a sourceURL that matches no entry is just new', () => {
    const spoof = makeScript({ id: realId, hasSourceURL: true, sourceUrl: 'https://nobody.example/x.js', sha256: hex('3') });
    const result = run({ scripts: [spoof] }, { scripts: [makeEntry()] }, 'gate');
    expect(ofType(result.events, 'spoofed')).toEqual([]);
    expect(ofType(result.events, 'new')).toHaveLength(1);
  });

  it('an unparseable sourceURL does not throw and is compared as a raw string', () => {
    const spoof = makeScript({ id: realId, hasSourceURL: true, sourceUrl: 'webpack:///./src/index.js', sha256: hex('3') });
    const result = run({ scripts: [spoof] }, { scripts: [makeEntry({ id: 'webpack:///./src/index.js' })] }, 'gate');
    expect(ofType(result.events, 'spoofed')).toHaveLength(1);
  });

  it('a sourceURL is not a spoof when the script itself is approved', () => {
    const approved = makeScript({ hasSourceURL: true, sourceUrl: STRIPE_ID });
    const result = run({ scripts: [approved] }, { scripts: [makeEntry(), makeEntry({ id: STRIPE_ID, integrity: 'track' })] }, 'gate');
    expect(ofType(result.events, 'spoofed')).toEqual([]);
  });

  it('uses the real normaliser when none is injected', () => {
    const spoof = makeScript({ id: realId, hasSourceURL: true, sourceUrl: 'https://JS.STRIPE.COM/v3#frag', sha256: hex('3') });
    const result = diff({ snapshot: makeSnapshot({ scripts: [spoof] }), manifest: makeManifest({ scripts: [makeEntry({ id: STRIPE_ID, integrity: 'track' })] }), mode: 'gate' });
    expect(ofType(result.events, 'spoofed')).toHaveLength(1);
  });
});

describe('diff: scope-changed', () => {
  it.each(MODES)('entry scope differing from observed scope is warn (%s)', (mode) => {
    const result = run({ scripts: [makeScript({ scope: 'embedded', frameId: 'f1' })] }, { scripts: [makeEntry()] }, mode);
    const [event] = result.events;
    expect(event).toMatchObject({ type: 'scope-changed', severity: 'warn', before: 'merchant', after: 'embedded', scope: 'embedded' });
    expect(event?.message).toContain('approved in scope merchant');
    expect(result.exitCode).toBe(0);
  });
});

describe('diff: ignore list', () => {
  it('skips ignored ids by exact value and glob, and they do not count as approved', () => {
    const noisy = makeScript({ id: 'https://consent.example/preview.js', sha256: hex('2') });
    const globbed = makeScript({ id: 'https://ab.example/debug/x.js', sha256: hex('4') });
    const result = run({ scripts: [makeScript(), noisy, globbed] }, { scripts: [makeEntry()], ignore: ['https://consent.example/preview.js', 'https://ab.example/debug/*'] }, 'gate');
    expect(result.events).toEqual([]);
    expect(result.summary.totalScripts).toBe(3);
    expect(result.summary.approved).toBe(1);
  });

  it('an ignored entry is not reported as removed', () => {
    const result = run({}, { scripts: [makeEntry({ id: 'https://consent.example/preview.js' })], ignore: ['https://consent.example/*'] }, 'gate');
    expect(result.events).toEqual([]);
  });
});

describe('diff: headers', () => {
  const values = { 'content-security-policy': "default-src 'self'", 'strict-transport-security': 'max-age=63072000' } as const;

  it.each(MODES)('strict policy fails on changed, added and removed headers (%s)', (mode) => {
    const result = run(
      { headers: { 'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY' } },
      { headers: { policy: 'strict', values } },
      mode,
    );
    const types = result.events.map((e) => `${e.type}:${e.subject}:${e.severity}`).sort();
    expect(types).toEqual([
      'header-added:x-frame-options:fail',
      'header-changed:content-security-policy:fail',
      'header-removed:strict-transport-security:fail',
    ]);
    const changed = ofType(result.events, 'header-changed')[0];
    expect(changed?.before).toBe("default-src 'self'");
    expect(changed?.after).toBe("default-src 'none'");
    expect(ofType(result.events, 'header-added')[0]?.after).toBe('DENY');
    expect(ofType(result.events, 'header-removed')[0]?.before).toBe('max-age=63072000');
    expect(result.exitCode).toBe(1);
  });

  it.each(MODES)('track policy reports the same events as info (%s)', (mode) => {
    const result = run({ headers: { 'x-frame-options': 'DENY' } }, { headers: { policy: 'track', values } }, mode);
    expect(result.events).toHaveLength(3);
    expect(result.events.every((e) => e.severity === 'info')).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('ignore policy compares nothing', () => {
    const result = run({ headers: { 'x-frame-options': 'DENY' } }, { headers: { policy: 'ignore', values } }, 'gate');
    expect(result.events).toEqual([]);
  });

  it('identical headers produce no events under strict', () => {
    const result = run({ headers: { ...values } }, { headers: { policy: 'strict', values } }, 'gate');
    expect(result.events).toEqual([]);
  });
});

describe('diff: frames', () => {
  it.each(MODES)('cross-origin frame without entry is new-frame warn (%s)', (mode) => {
    const result = run({ frames: [mainFrame(), makeFrame()] }, {}, mode);
    expect(result.events[0]).toMatchObject({ type: 'new-frame', severity: 'warn', scope: 'tpsp', subject: makeFrame().url });
    expect(result.exitCode).toBe(0);
  });

  it('same-origin frames are not reported', () => {
    const result = run({ frames: [mainFrame(), makeFrame({ url: 'https://shop.example.com/inner', origin: 'https://shop.example.com', crossOrigin: false, scope: 'merchant' })] }, {}, 'gate');
    expect(result.events).toEqual([]);
  });

  it('a frame entry matches by exact url or glob', () => {
    const glob = run({ frames: [mainFrame(), makeFrame()] }, { frames: [makeFrameEntry({ match: 'https://js.stripe.com/v3/*.html' })] }, 'gate');
    expect(glob.events).toEqual([]);
    const exact = run({ frames: [mainFrame(), makeFrame()] }, { frames: [makeFrameEntry()] }, 'gate');
    expect(exact.events).toEqual([]);
  });

  it('removed-frame is info in gate and warn in drift', () => {
    const gate = run({}, { frames: [makeFrameEntry()] }, 'gate');
    expect(gate.events[0]).toMatchObject({ type: 'removed-frame', severity: 'info', subject: makeFrameEntry().match, scope: 'tpsp' });
    const drift = run({}, { frames: [makeFrameEntry()] }, 'drift');
    expect(drift.events[0]).toMatchObject({ type: 'removed-frame', severity: 'warn' });
  });
});

describe('diff: summary and exit codes', () => {
  it('counts severities and scripts', () => {
    const result = run(
      {
        scripts: [
          makeScript(),
          makeScript({ id: 'https://new.example/a.js', sha256: hex('1') }),
          makeScript({ id: 'https://frame.example/b.js', scope: 'tpsp', sha256: hex('2') }),
          makeScript({ id: STRIPE_ID, sha256: hex('3') }),
        ],
        frames: [mainFrame(), makeFrame()],
      },
      { scripts: [makeEntry(), makeEntry({ id: STRIPE_ID, integrity: 'track', sha256: STRIPE_SHA }), makeEntry({ id: 'https://gone.example/c.js' })] },
      'gate',
    );
    expect(result.summary).toEqual({ fail: 1, warn: 2, info: 2, merchantScripts: 3, totalScripts: 4, approved: 2 });
    expect(result.exitCode).toBe(1);
  });

  it('warn and info alone yield exit 0', () => {
    const result = run({ frames: [mainFrame(), makeFrame()] }, { scripts: [makeEntry()], frames: [makeFrameEntry({ match: 'https://other.example/x' })] }, 'gate');
    expect(result.summary.fail).toBe(0);
    expect(result.summary.warn).toBe(2);
    expect(result.summary.info).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('does not mutate its inputs', () => {
    const snapshot = makeSnapshot({ scripts: [makeScript({ source: 'secret' })] });
    const manifest = makeManifest();
    const before = JSON.stringify([snapshot, manifest]);
    diff({ snapshot, manifest, mode: 'gate', normalizeUrl: fakeNormalizeUrl });
    expect(JSON.stringify([snapshot, manifest])).toBe(before);
  });
});

describe('diff: worker (body-not-captured) entries', () => {
  const WORKER_ID = 'https://shop.example.com/worker.js';
  const worker = () => makeScript({ id: WORKER_ID, kind: 'worker', url: WORKER_ID, rawUrl: WORKER_ID, target: 'worker', size: 0, sha256: undefined, structuralHash: undefined });

  it('a url-only worker entry observed again is clean and counts as approved', () => {
    const entry = makeEntry({ id: WORKER_ID, kind: 'worker', integrity: 'url-only', integrityMethod: 'none', sha256: undefined, structuralHash: undefined });
    const result = run({ scripts: [worker()] }, { scripts: [entry] }, 'gate');
    expect(result.events).toEqual([]);
    expect(result.summary.approved).toBe(1);
  });

  it('a new empty-body worker is never reported as moved from a strict entry', () => {
    const result = run({ scripts: [worker()] }, { scripts: [makeEntry()] }, 'gate');
    expect(ofType(result.events, 'moved')).toEqual([]);
    expect(ofType(result.events, 'new')).toHaveLength(1);
    expect(ofType(result.events, 'removed')).toHaveLength(1);
  });
});
