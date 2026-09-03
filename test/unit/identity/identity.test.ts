import { describe, expect, it } from 'vitest';
import type { IdentityConfig } from '../../../src/types.js';
import {
  BUILTIN_CACHE_BUSTERS,
  BUILTIN_THREEDS_HOSTS,
  BUILTIN_TPSP_HOSTS,
  classifyFrame,
  deriveId,
  isFirstParty,
  lookupEntity,
  normalizeUrl,
  sha256,
  structuralHash,
} from '../../../src/identity/identity.js';

const cfg: IdentityConfig = { stripQuery: [], keepQuery: [], collapseHashes: true };
const origin = 'https://shop.example.com';

describe('identity module surface', () => {
  it('re-exports the public functions and constants', () => {
    expect(typeof normalizeUrl).toBe('function');
    expect(typeof structuralHash).toBe('function');
    expect(typeof sha256).toBe('function');
    expect(typeof deriveId).toBe('function');
    expect(typeof classifyFrame).toBe('function');
    expect(typeof lookupEntity).toBe('function');
    expect(typeof isFirstParty).toBe('function');
    expect(BUILTIN_CACHE_BUSTERS.length).toBeGreaterThan(0);
    expect(BUILTIN_TPSP_HOSTS).toContain('js.stripe.com');
    expect(BUILTIN_THREEDS_HOSTS).toContain('*.cardinalcommerce.com');
  });
});

describe('deriveId: URL-addressed kinds', () => {
  it('uses the normalised rawUrl for external scripts', () => {
    expect(
      deriveId({ kind: 'external', rawUrl: 'https://shop.example.com/assets/app.3f9c2a1b.js?v=1', frameOrigin: origin, source: 'x' }, cfg),
    ).toBe('https://shop.example.com/assets/app.[hash].js');
  });

  it('prefers embedderName over a sourceURL-rewritten rawUrl', () => {
    expect(
      deriveId(
        {
          kind: 'external',
          rawUrl: 'https://js.stripe.com/v3',
          embedderName: 'https://shop.example.com/spoof.js',
          frameOrigin: origin,
          source: '//# sourceURL=https://js.stripe.com/v3',
        },
        cfg,
      ),
    ).toBe('https://shop.example.com/spoof.js');
  });

  it('falls back to rawUrl when embedderName is empty', () => {
    expect(deriveId({ kind: 'external', rawUrl: 'https://cdn.example.com/a.js', embedderName: '', frameOrigin: origin, source: '' }, cfg)).toBe(
      'https://cdn.example.com/a.js',
    );
  });

  it('derives blob and data identities through normalizeUrl', () => {
    expect(deriveId({ kind: 'blob', rawUrl: 'blob:https://shop.example.com/uuid-1', frameOrigin: origin, source: 'x' }, cfg)).toBe(
      'blob:https://shop.example.com',
    );
    expect(deriveId({ kind: 'data', rawUrl: 'data:text/javascript,1', frameOrigin: origin, source: '1' }, cfg)).toBe(
      normalizeUrl('data:text/javascript,1', cfg),
    );
  });

  it('derives worker identities from the URL', () => {
    expect(deriveId({ kind: 'worker', rawUrl: 'https://shop.example.com/worker.js?cb=1', frameOrigin: origin, source: '' }, cfg)).toBe(
      'https://shop.example.com/worker.js',
    );
  });

  it('falls back to a structural id when a URL-addressed script has no URL', () => {
    const id = deriveId({ kind: 'external', frameOrigin: origin, source: 'a()' }, cfg);
    expect(id).toBe(`external:${origin}:${structuralHash('a()').slice(0, 16)}`);
  });
});

describe('deriveId: inline and eval', () => {
  it('uses kind, frame origin and the structural hash prefix', () => {
    const source = 'self.__next_f.push([1,"state"])';
    const prefix = structuralHash(source).slice(0, 16);
    expect(deriveId({ kind: 'inline', frameOrigin: origin, source }, cfg)).toBe(`inline:${origin}:${prefix}`);
    expect(deriveId({ kind: 'eval', frameOrigin: origin, source }, cfg)).toBe(`eval:${origin}:${prefix}`);
    expect(prefix).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable when only literals change and differs when code changes', () => {
    const a = deriveId({ kind: 'inline', frameOrigin: origin, source: 'self.__next_f.push([1,"abc"])' }, cfg);
    const b = deriveId({ kind: 'inline', frameOrigin: origin, source: 'self.__next_f.push([1,"xyz"])' }, cfg);
    const c = deriveId({ kind: 'inline', frameOrigin: origin, source: 'self.__next_f.pop()' }, cfg);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('ignores rawUrl for inline scripts', () => {
    const a = deriveId({ kind: 'inline', rawUrl: 'https://shop.example.com/', frameOrigin: origin, source: 'a()' }, cfg);
    expect(a.startsWith('inline:')).toBe(true);
  });

  it('differs per frame origin', () => {
    const a = deriveId({ kind: 'inline', frameOrigin: origin, source: 'a()' }, cfg);
    const b = deriveId({ kind: 'inline', frameOrigin: 'https://other.example.com', source: 'a()' }, cfg);
    expect(a).not.toBe(b);
  });
});

describe('deriveId: wasm', () => {
  it('uses the URL when present', () => {
    expect(deriveId({ kind: 'wasm', rawUrl: 'https://shop.example.com/m.wasm?v=2', frameOrigin: origin, source: '' }, cfg)).toBe(
      'https://shop.example.com/m.wasm',
    );
  });

  it('uses the sha256 prefix otherwise', () => {
    expect(deriveId({ kind: 'wasm', frameOrigin: origin, source: 'bytes' }, cfg)).toBe(`wasm:${origin}:${sha256('bytes').slice(0, 16)}`);
  });
});
