import { describe, expect, it } from 'vitest';
import { ScriptlockError } from '../../../src/errors.js';
import {
  approveFrames,
  approveScripts,
  firstPartySubject,
  refreshScripts,
  refreshTracked,
  type ApproveMeta,
} from '../../../src/manifest/approve.js';
import { emptyManifest } from '../../../src/manifest/io.js';
import type { FrameInfo, IntegrityDefaults, Manifest, ObservedScript, Snapshot } from '../../../src/types.js';

const MAIN = 'https://shop.example.com';
const DEFAULTS: IntegrityDefaults = { firstParty: 'strict', thirdParty: 'track', inline: 'structural', eval: 'structural' };

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function observed(id: string, overrides: Partial<ObservedScript> = {}): ObservedScript {
  const isUrl = /^(https?|blob|data):/.test(id);
  return {
    id,
    kind: 'external',
    scope: 'merchant',
    ...(isUrl ? { url: id, rawUrl: id } : {}),
    hasSourceURL: false,
    frameId: 'main',
    frameUrl: `${MAIN}/checkout`,
    frameOrigin: MAIN,
    target: 'page',
    sha256: hex('a'),
    structuralHash: hex('b'),
    size: 100,
    isModule: false,
    observedInRuns: 1,
    ...overrides,
  };
}

function frame(url: string, overrides: Partial<FrameInfo> = {}): FrameInfo {
  const origin = new URL(url).origin;
  return { id: url, url, origin, isMain: false, scope: 'embedded', crossOrigin: origin !== MAIN, ...overrides };
}

function snapshot(scripts: ObservedScript[], frames: FrameInfo[] = []): Snapshot {
  return {
    version: 1,
    tool: { name: 'scriptlock', version: '0.0.0' },
    profile: 'checkout',
    url: `${MAIN}/checkout`,
    finalUrl: `${MAIN}/checkout`,
    startedAt: '2026-09-02T10:00:00.000Z',
    finishedAt: '2026-09-02T10:00:05.000Z',
    runs: 1,
    vantage: { userAgent: 'ua', browser: 'chromium 151', headless: true },
    documentStatus: 200,
    headers: {},
    frames: [{ id: 'main', url: `${MAIN}/checkout`, origin: MAIN, isMain: true, scope: 'merchant', crossOrigin: false }, ...frames],
    scripts,
    warnings: [],
  };
}

const META: ApproveMeta = {
  owner: 'web',
  category: 'functional',
  justification: 'Built from this repository',
  approvedBy: 'v.nizovtsev',
  approvedAt: '2026-09-02',
};

function base(): Manifest {
  return emptyManifest('checkout', `${MAIN}/checkout`);
}

describe('approveScripts defaults', () => {
  const snap = snapshot([
    observed(`${MAIN}/assets/app.[hash].js`),
    observed('https://static.shop.example.com/lib.js'),
    observed('https://js.stripe.com/v3', { scope: 'merchant' }),
    observed(`inline:${MAIN}:0011223344556677`, { kind: 'inline' }),
    observed(`eval:${MAIN}:8899aabbccddeeff`, { kind: 'eval', sha256: hex('e'), structuralHash: hex('f') }),
    observed(`blob:${MAIN}`, { kind: 'blob' }),
    observed('data:1234567890abcdef', { kind: 'data', frameOrigin: 'https://widget.example.net', scope: 'embedded' }),
  ]);

  it('first-party external gets strict / hash-strict with both hashes recorded', () => {
    const out = approveScripts(base(), snap, [`${MAIN}/assets/app.[hash].js`], META, DEFAULTS);
    expect(out.scripts).toHaveLength(1);
    expect(out.scripts[0]).toEqual({
      id: `${MAIN}/assets/app.[hash].js`,
      kind: 'external',
      scope: 'merchant',
      integrity: 'strict',
      integrityMethod: 'hash-strict',
      sha256: hex('a'),
      structuralHash: hex('b'),
      owner: 'web',
      category: 'functional',
      justification: 'Built from this repository',
      approvedBy: 'v.nizovtsev',
      approvedAt: '2026-09-02',
    });
  });

  it('subdomains of the main host are first-party', () => {
    const out = approveScripts(base(), snap, ['https://static.shop.example.com/lib.js'], META, DEFAULTS);
    expect(out.scripts[0]?.integrity).toBe('strict');
  });

  it('third-party external gets track / source-tracked', () => {
    const out = approveScripts(base(), snap, ['https://js.stripe.com/v3'], META, DEFAULTS);
    expect(out.scripts[0]).toMatchObject({ integrity: 'track', integrityMethod: 'source-tracked', sha256: hex('a') });
  });

  it('inline and eval get structural / hash-strict', () => {
    const out = approveScripts(base(), snap, [`inline:${MAIN}:0011223344556677`, `eval:${MAIN}:8899aabbccddeeff`], META, DEFAULTS);
    expect(out.scripts.map((s) => [s.kind, s.integrity, s.integrityMethod, s.structuralHash])).toEqual([
      ['inline', 'structural', 'hash-strict', hex('b')],
      ['eval', 'structural', 'hash-strict', hex('f')],
    ]);
  });

  it('blob scripts use their embedded origin; data scripts use the frame origin', () => {
    const out = approveScripts(base(), snap, [`blob:${MAIN}`, 'data:1234567890abcdef'], META, DEFAULTS);
    expect(out.scripts.find((s) => s.kind === 'blob')?.integrity).toBe('strict');
    expect(out.scripts.find((s) => s.kind === 'data')?.integrity).toBe('track');
  });

  it('honours configured defaults and explicit overrides', () => {
    const custom: IntegrityDefaults = { firstParty: 'track', thirdParty: 'url-only', inline: 'strict', eval: 'url-only' };
    const out = approveScripts(base(), snap, ['*'], META, custom);
    const byId = new Map(out.scripts.map((s) => [s.id, s]));
    expect(byId.get(`${MAIN}/assets/app.[hash].js`)).toMatchObject({ integrity: 'track', integrityMethod: 'source-tracked' });
    expect(byId.get('https://js.stripe.com/v3')).toMatchObject({ integrity: 'url-only', integrityMethod: 'source-tracked' });
    expect(byId.get(`inline:${MAIN}:0011223344556677`)).toMatchObject({ integrity: 'strict', integrityMethod: 'hash-strict' });
    expect(byId.get(`eval:${MAIN}:8899aabbccddeeff`)).toMatchObject({ integrity: 'url-only', integrityMethod: 'source-tracked' });

    const explicit = approveScripts(base(), snap, ['https://js.stripe.com/v3'], { ...META, integrity: 'strict', integrityMethod: 'sri', scope: 'tpsp', notes: 'pinned' }, DEFAULTS);
    expect(explicit.scripts[0]).toMatchObject({ integrity: 'strict', integrityMethod: 'sri', scope: 'tpsp', notes: 'pinned' });
  });

  it('uses an injected isFirstParty helper when given', () => {
    const calls: Array<[string, string]> = [];
    const out = approveScripts(base(), snap, ['https://js.stripe.com/v3'], META, DEFAULTS, {
      isFirstParty: (url, mainOrigin) => {
        calls.push([url, mainOrigin]);
        return true;
      },
    });
    expect(calls).toEqual([['https://js.stripe.com/v3', MAIN]]);
    expect(out.scripts[0]?.integrity).toBe('strict');
  });

  it('firstPartySubject unwraps blob: origins and falls back to the frame origin', () => {
    expect(firstPartySubject(observed(`${MAIN}/a.js`))).toBe(`${MAIN}/a.js`);
    expect(firstPartySubject(observed(`blob:${MAIN}`, { kind: 'blob' }))).toBe(MAIN);
    expect(firstPartySubject(observed('data:abc', { kind: 'data', frameOrigin: 'https://widget.example.net' }))).toBe('https://widget.example.net');
    expect(firstPartySubject({ frameOrigin: MAIN })).toBe(MAIN);
  });

  it('lookalike hosts are third-party through the identity helper', () => {
    const lookalikes = snapshot([observed('https://shop.example.com.evil.net/a.js'), observed('https://notshop.example.com/a.js')]);
    const out = approveScripts(base(), lookalikes, ['*'], META, DEFAULTS);
    expect(out.scripts.map((s) => s.integrity)).toEqual(['track', 'track']);
  });
});

describe('approveScripts selection', () => {
  const snap = snapshot([
    observed(`${MAIN}/a.js`),
    observed(`${MAIN}/b.js`, { sha256: hex('1') }),
    observed('https://js.stripe.com/v3', { scope: 'tpsp' }),
    observed(`${MAIN}/preview-1.js`),
    observed(`${MAIN}/harness.js`, { scope: 'harness' }),
  ]);

  it("'*' approves every unapproved, non-ignored, non-harness script and leaves existing entries alone", () => {
    const start = approveScripts(base(), snap, [`${MAIN}/a.js`], META, DEFAULTS);
    const existing = start.scripts[0];
    const withIgnore: Manifest = { ...start, ignore: [`${MAIN}/preview-*.js`] };
    const out = approveScripts(withIgnore, snap, ['*'], { ...META, owner: 'later', approvedAt: '2026-09-03' }, DEFAULTS);
    expect(out.scripts.map((s) => s.id).sort()).toEqual([`${MAIN}/a.js`, `${MAIN}/b.js`, 'https://js.stripe.com/v3'].sort());
    expect(out.scripts.find((s) => s.id === `${MAIN}/a.js`)).toBe(existing);
    expect(out.scripts.find((s) => s.id === `${MAIN}/b.js`)?.owner).toBe('later');
    expect(out.scripts.find((s) => s.id === 'https://js.stripe.com/v3')?.scope).toBe('tpsp');
    expect(approveScripts(out, snap, ['*'], META, DEFAULTS).scripts).toEqual(out.scripts);
  });

  it("'*' skips scripts already covered by a match glob", () => {
    const withGlob: Manifest = {
      ...base(),
      scripts: [
        {
          id: `${MAIN}/bundle.js`,
          match: `${MAIN}/*.js`,
          kind: 'external',
          scope: 'merchant',
          integrity: 'strict',
          integrityMethod: 'hash-strict',
          sha256: hex('9'),
          owner: 'web',
          category: 'functional',
          justification: 'j',
          approvedBy: 'v',
          approvedAt: '2026-09-01',
        },
      ],
    };
    const out = approveScripts(withGlob, snap, ['*'], META, DEFAULTS);
    expect(out.scripts.map((s) => s.id)).toEqual([`${MAIN}/bundle.js`, 'https://js.stripe.com/v3']);
  });

  it('throws SNAPSHOT_INVALID for an id that is not in the snapshot', () => {
    let caught: unknown;
    try {
      approveScripts(base(), snap, [`${MAIN}/missing.js`], META, DEFAULTS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptlockError);
    const err = caught as ScriptlockError;
    expect(err.code).toBe('SNAPSHOT_INVALID');
    expect(err.message).toContain(`${MAIN}/missing.js`);
    expect(err.message).toContain('checkout');
    expect(err.hint).toContain('--all-new');
  });

  it('requires owner, category and justification for new entries', () => {
    expect(() => approveScripts(base(), snap, [`${MAIN}/a.js`], { approvedBy: 'v', approvedAt: '2026-09-02' }, DEFAULTS)).toThrow(/owner, category, justification/);
  });

  it('does not mutate its inputs', () => {
    const manifest = base();
    const before = JSON.stringify(manifest);
    approveScripts(manifest, snap, ['*'], META, DEFAULTS);
    expect(JSON.stringify(manifest)).toBe(before);
  });
});

describe('re-approval', () => {
  const first = snapshot([observed(`${MAIN}/a.js`), observed('https://js.stripe.com/v3')]);
  const later = snapshot([
    observed(`${MAIN}/a.js`, { sha256: hex('2'), structuralHash: hex('3') }),
    observed('https://js.stripe.com/v3', { sha256: hex('4') }),
  ]);

  it('updates hashes, approver and date; keeps owner, category and justification when not given', () => {
    const start = approveScripts(base(), first, ['*'], { ...META, notes: 'n' }, DEFAULTS);
    const tracked = refreshTracked(start, later);
    expect(tracked.scripts.find((s) => s.id === 'https://js.stripe.com/v3')?.lastSeenSha256).toBe(hex('4'));
    const out = approveScripts(tracked, later, ['*', `${MAIN}/a.js`, 'https://js.stripe.com/v3'], { approvedBy: 'bot', approvedAt: '2026-09-09' }, DEFAULTS);
    expect(out.scripts).toHaveLength(2);
    const a = out.scripts.find((s) => s.id === `${MAIN}/a.js`);
    expect(a).toMatchObject({ sha256: hex('2'), structuralHash: hex('3'), approvedBy: 'bot', approvedAt: '2026-09-09', owner: 'web', category: 'functional', justification: META.justification, notes: 'n', integrity: 'strict' });
    const stripe = out.scripts.find((s) => s.id === 'https://js.stripe.com/v3');
    expect(stripe).toMatchObject({ sha256: hex('4'), approvedBy: 'bot', integrity: 'track' });
    expect(stripe).not.toHaveProperty('lastSeenSha256');
  });

  it('takes new owner, category, justification, integrity and scope when given', () => {
    const start = approveScripts(base(), first, ['*'], META, DEFAULTS);
    const out = approveScripts(start, later, ['https://js.stripe.com/v3'], { ...META, owner: 'payments', category: 'payment', justification: 'Stripe loader', integrity: 'strict', scope: 'tpsp' }, DEFAULTS);
    expect(out.scripts.find((s) => s.id === 'https://js.stripe.com/v3')).toMatchObject({
      owner: 'payments',
      category: 'payment',
      justification: 'Stripe loader',
      integrity: 'strict',
      integrityMethod: 'hash-strict',
      scope: 'tpsp',
    });
  });

  it('refreshes an entry matched through its glob', () => {
    const start = approveScripts(base(), first, [`${MAIN}/a.js`], META, DEFAULTS);
    const globbed: Manifest = { ...start, scripts: start.scripts.map((s) => ({ ...s, id: `${MAIN}/a.[hash].js`, match: `${MAIN}/a*.js` })) };
    const out = approveScripts(globbed, later, [`${MAIN}/a.js`], { approvedBy: 'bot', approvedAt: '2026-09-09' }, DEFAULTS);
    expect(out.scripts).toHaveLength(1);
    expect(out.scripts[0]).toMatchObject({ id: `${MAIN}/a.[hash].js`, sha256: hex('2'), approvedBy: 'bot' });
  });
});

describe('refreshTracked', () => {
  const first = snapshot([observed(`${MAIN}/a.js`), observed('https://js.stripe.com/v3'), observed('https://cdn.example.net/gtm.js')]);
  const start = approveScripts(base(), first, ['*'], META, DEFAULTS);

  it('records lastSeenSha256 on changed track entries only', () => {
    const later = snapshot([
      observed(`${MAIN}/a.js`, { sha256: hex('5') }),
      observed('https://js.stripe.com/v3', { sha256: hex('6') }),
      observed('https://cdn.example.net/gtm.js'),
    ]);
    const out = refreshTracked(start, later);
    expect(out.scripts.find((s) => s.id === `${MAIN}/a.js`)).toBe(start.scripts.find((s) => s.id === `${MAIN}/a.js`));
    expect(out.scripts.find((s) => s.id === 'https://js.stripe.com/v3')?.lastSeenSha256).toBe(hex('6'));
    expect(out.scripts.find((s) => s.id === 'https://cdn.example.net/gtm.js')).not.toHaveProperty('lastSeenSha256');
    expect(start.scripts.find((s) => s.id === 'https://js.stripe.com/v3')).not.toHaveProperty('lastSeenSha256');
  });

  it('is idempotent, leaves unobserved entries untouched and clears lastSeenSha256 when the body reverts', () => {
    const changed = snapshot([observed('https://js.stripe.com/v3', { sha256: hex('6') })]);
    const once = refreshTracked(start, changed);
    expect(refreshTracked(once, changed).scripts).toEqual(once.scripts);
    expect(once.scripts).toHaveLength(3);
    const reverted = refreshTracked(once, first);
    expect(reverted.scripts.find((s) => s.id === 'https://js.stripe.com/v3')).not.toHaveProperty('lastSeenSha256');
  });
});

describe('refreshScripts', () => {
  const first = snapshot([observed(`${MAIN}/a.js`), observed('https://js.stripe.com/v3')]);
  const start = approveScripts(base(), first, ['*'], META, DEFAULTS);
  const later = snapshot([observed(`${MAIN}/a.js`, { sha256: hex('7'), structuralHash: hex('8') })]);

  it('updates hashes of listed entries without touching approval metadata', () => {
    const out = refreshScripts(start, later, [`${MAIN}/a.js`]);
    expect(out.scripts.find((s) => s.id === `${MAIN}/a.js`)).toMatchObject({ sha256: hex('7'), structuralHash: hex('8'), approvedBy: 'v.nizovtsev', approvedAt: '2026-09-02' });
    expect(out.scripts.find((s) => s.id === 'https://js.stripe.com/v3')).toBe(start.scripts.find((s) => s.id === 'https://js.stripe.com/v3'));
    const stamped = refreshScripts(start, later, ['*'], { approvedBy: 'bot', approvedAt: '2026-09-09' });
    expect(stamped.scripts.find((s) => s.id === `${MAIN}/a.js`)).toMatchObject({ approvedBy: 'bot', approvedAt: '2026-09-09' });
  });

  it('throws for unknown or unobserved ids', () => {
    expect(() => refreshScripts(start, later, [`${MAIN}/nope.js`])).toThrow(ScriptlockError);
    expect(() => refreshScripts(start, later, ['https://js.stripe.com/v3'])).toThrow(/not observed/);
  });
});

describe('approveFrames', () => {
  const frames = [
    frame('https://js.stripe.com/v3/elements-inner-card-[hash].html', { scope: 'tpsp' }),
    frame('https://chat.example.net/widget'),
    frame(`${MAIN}/same-origin-frame`, { scope: 'merchant' }),
  ];
  const snap = snapshot([], frames);
  const meta = { owner: 'payments', justification: 'Provider frame', approvedBy: 'v', approvedAt: '2026-09-02' };

  it("'*' approves every cross-origin frame without an entry, inheriting the observed scope", () => {
    const out = approveFrames(base(), snap, ['*'], meta);
    expect(out.frames.map((f) => [f.match, f.scope])).toEqual([
      ['https://js.stripe.com/v3/elements-inner-card-[hash].html', 'tpsp'],
      ['https://chat.example.net/widget', 'embedded'],
    ]);
    expect(approveFrames(out, snap, ['*'], { ...meta, approvedAt: '2026-09-09' }).frames).toEqual(out.frames);
  });

  it('accepts exact URLs and globs, re-approves existing entries, rejects unknown frames', () => {
    const out = approveFrames(base(), snap, ['https://js.stripe.com/v3/*.html'], { ...meta, scope: 'tpsp' });
    expect(out.frames).toEqual([{ match: 'https://js.stripe.com/v3/*.html', scope: 'tpsp', owner: 'payments', justification: 'Provider frame', approvedBy: 'v', approvedAt: '2026-09-02' }]);
    const again = approveFrames(out, snap, ['https://js.stripe.com/v3/*.html'], { approvedBy: 'bot', approvedAt: '2026-09-09' });
    expect(again.frames[0]).toMatchObject({ owner: 'payments', justification: 'Provider frame', approvedBy: 'bot', approvedAt: '2026-09-09' });
    expect(() => approveFrames(base(), snap, ['https://nowhere.example/'], meta)).toThrow(/not observed/);
    expect(() => approveFrames(base(), snap, ['https://chat.example.net/widget'], { approvedBy: 'v', approvedAt: '2026-09-02' })).toThrow(/owner, justification/);
  });
});

describe('approveScripts: worker and body-not-captured entries', () => {
  const workerScript: ObservedScript = {
    id: `${MAIN}/worker.js`,
    kind: 'worker',
    scope: 'merchant',
    url: `${MAIN}/worker.js`,
    rawUrl: `${MAIN}/worker.js`,
    hasSourceURL: false,
    frameId: 'main',
    frameUrl: `${MAIN}/checkout`,
    frameOrigin: MAIN,
    target: 'worker',
    size: 0,
    isModule: false,
    observedInRuns: 1,
  };

  it('defaults a worker to url-only / none with no body hash, regardless of party', () => {
    const out = approveScripts(base(), snapshot([workerScript]), ['*'], META, DEFAULTS);
    expect(out.scripts).toHaveLength(1);
    expect(out.scripts[0]).toMatchObject({ id: `${MAIN}/worker.js`, kind: 'worker', integrity: 'url-only', integrityMethod: 'none' });
    expect(out.scripts[0]).not.toHaveProperty('sha256');
    expect(out.scripts[0]).not.toHaveProperty('structuralHash');
  });

  it('refuses --integrity strict or structural for a body that was not captured', () => {
    expect(() => approveScripts(base(), snapshot([workerScript]), [`${MAIN}/worker.js`], { ...META, integrity: 'strict' }, DEFAULTS)).toThrow(/body was not captured/);
    expect(() => approveScripts(base(), snapshot([workerScript]), [`${MAIN}/worker.js`], { ...META, integrity: 'structural' }, DEFAULTS)).toThrow(ScriptlockError);
    // url-only is accepted.
    expect(approveScripts(base(), snapshot([workerScript]), [`${MAIN}/worker.js`], { ...META, integrity: 'url-only' }, DEFAULTS).scripts[0]?.integrity).toBe('url-only');
  });

  it('re-approving a worker keeps it url-only and still carries no hash', () => {
    const start = approveScripts(base(), snapshot([workerScript]), ['*'], META, DEFAULTS);
    const out = approveScripts(start, snapshot([workerScript]), [`${MAIN}/worker.js`], { approvedBy: 'bot', approvedAt: '2026-09-09' }, DEFAULTS);
    expect(out.scripts[0]).toMatchObject({ integrity: 'url-only', integrityMethod: 'none', approvedBy: 'bot' });
    expect(out.scripts[0]).not.toHaveProperty('sha256');
  });
});
