/**
 * Synthetic Snapshot and Manifest builders for diff, report and history tests.
 * Every factory returns a complete object with sensible defaults and applies
 * the given overrides on top.
 */
import type {
  FrameInfo,
  Manifest,
  ManifestFrame,
  ManifestScript,
  ObservedScript,
  Snapshot,
} from '../../../src/types.js';

export const MAIN_URL = 'https://shop.example.com/checkout';
export const MAIN_ORIGIN = 'https://shop.example.com';

export const APP_ID = 'https://shop.example.com/assets/app.[hash].js';
export const APP_SHA = 'a'.repeat(64);
export const APP_STRUCT = 'b'.repeat(64);
export const STRIPE_ID = 'https://js.stripe.com/v3';
export const STRIPE_SHA = 'c'.repeat(64);
export const INLINE_ID = 'inline:https://shop.example.com:9f2c41ba0d77e1a3';
export const INLINE_SHA = 'd'.repeat(64);
export const INLINE_STRUCT = 'e'.repeat(64);

/** Overrides may carry `undefined` to remove an optional field from the factory output. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

export function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

export function makeScript(overrides: Overrides<ObservedScript> = {}): ObservedScript {
  const base: ObservedScript = {
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
    structuralHash: APP_STRUCT,
    size: 1234,
    isModule: false,
    observedInRuns: 1,
  };
  return { ...base, ...overrides } as ObservedScript;
}

export function makeEntry(overrides: Overrides<ManifestScript> = {}): ManifestScript {
  const base: ManifestScript = {
    id: APP_ID,
    kind: 'external',
    scope: 'merchant',
    integrity: 'strict',
    integrityMethod: 'hash-strict',
    sha256: APP_SHA,
    structuralHash: APP_STRUCT,
    owner: 'web',
    category: 'functional',
    justification: 'Storefront bundle built from this repository',
    approvedBy: 'tester',
    approvedAt: '2026-09-01',
  };
  return { ...base, ...overrides } as ManifestScript;
}

export function makeFrameEntry(overrides: Partial<ManifestFrame> = {}): ManifestFrame {
  return {
    match: 'https://js.stripe.com/v3/elements-inner-card-[hash].html',
    scope: 'tpsp',
    owner: 'payments',
    justification: 'Stripe Elements card field',
    approvedBy: 'tester',
    approvedAt: '2026-09-01',
    ...overrides,
  };
}

export function makeFrame(overrides: Partial<FrameInfo> = {}): FrameInfo {
  return {
    id: 'frame-1',
    url: 'https://js.stripe.com/v3/elements-inner-card-[hash].html',
    origin: 'https://js.stripe.com',
    isMain: false,
    parentId: 'main',
    scope: 'tpsp',
    crossOrigin: true,
    ...overrides,
  };
}

export function mainFrame(): FrameInfo {
  return { id: 'main', url: MAIN_URL, origin: MAIN_ORIGIN, isMain: true, scope: 'merchant', crossOrigin: false };
}

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    version: 1,
    tool: { name: 'scriptlock', version: '0.0.0-test' },
    profile: 'default',
    url: MAIN_URL,
    finalUrl: MAIN_URL,
    startedAt: '2026-09-02T10:00:00.000Z',
    finishedAt: '2026-09-02T10:00:05.000Z',
    runs: 1,
    vantage: { userAgent: 'test-agent', browser: 'chromium 151 (test)', headless: true },
    documentStatus: 200,
    headers: {},
    frames: [mainFrame()],
    scripts: [],
    warnings: [],
  };
  return { ...base, ...overrides };
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  const base: Manifest = {
    version: 1,
    profile: 'default',
    url: MAIN_URL,
    headers: { policy: 'ignore', values: {} },
    frames: [],
    scripts: [],
    ignore: [],
  };
  return { ...base, ...overrides };
}

/** Deterministic stand-in for identity/normalize used by spoof tests. */
export function fakeNormalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.searchParams.delete('v');
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}
