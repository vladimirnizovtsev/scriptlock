import { describe, expect, it } from 'vitest';
import type { IdentityConfig } from '../../../src/types.js';
import { BUILTIN_CACHE_BUSTERS, normalizeUrl } from '../../../src/identity/normalize.js';
import { sha256 } from '../../../src/identity/hash.js';

const cfg: IdentityConfig = { stripQuery: [], keepQuery: [], collapseHashes: true };

describe('normalizeUrl: scheme, host, port, fragment (rule 1)', () => {
  it('lower-cases scheme and host', () => {
    expect(normalizeUrl('HTTPS://Shop.Example.COM/App.js', cfg)).toBe('https://shop.example.com/App.js');
  });

  it('drops default ports and keeps non-default ones', () => {
    expect(normalizeUrl('https://shop.example.com:443/a.js', cfg)).toBe('https://shop.example.com/a.js');
    expect(normalizeUrl('http://shop.example.com:80/a.js', cfg)).toBe('http://shop.example.com/a.js');
    expect(normalizeUrl('http://127.0.0.1:4321/a.js', cfg)).toBe('http://127.0.0.1:4321/a.js');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://shop.example.com/a.js#section', cfg)).toBe('https://shop.example.com/a.js');
  });

  it('drops credentials', () => {
    expect(normalizeUrl('https://user:pw@shop.example.com/a.js', cfg)).toBe('https://shop.example.com/a.js');
  });

  it('returns unparseable input trimmed and unchanged', () => {
    expect(normalizeUrl('  not a url  ', cfg)).toBe('not a url');
  });
});

describe('normalizeUrl: blob and data URLs (rule 2)', () => {
  it('reduces blob: URLs to blob:<origin>', () => {
    expect(normalizeUrl('blob:https://shop.example.com/3f9c2a1b-0d77-4e1a-9c2a-1b0d77e1a3f9', cfg)).toBe(
      'blob:https://shop.example.com',
    );
    expect(normalizeUrl('blob:https://shop.example.com/aaaa', cfg)).toBe(
      normalizeUrl('blob:https://shop.example.com/bbbb', cfg),
    );
  });

  it('reduces blob: URLs with a null origin to blob:null', () => {
    expect(normalizeUrl('blob:null/3f9c2a1b', cfg)).toBe('blob:null');
  });

  it('reduces data: URLs to data:<sha256 prefix 16> of the payload', () => {
    const raw = 'data:text/javascript,alert(1)';
    const expected = `data:${sha256('text/javascript,alert(1)').slice(0, 16)}`;
    expect(normalizeUrl(raw, cfg)).toBe(expected);
    expect(normalizeUrl(raw, cfg)).toHaveLength('data:'.length + 16);
    expect(normalizeUrl('data:text/javascript,alert(2)', cfg)).not.toBe(expected);
  });
});

describe('normalizeUrl: path hash collapsing (rule 3)', () => {
  it('collapses a dotted hex chunk hash', () => {
    expect(normalizeUrl('https://shop.example.com/assets/app.3f9c2a1b.js', cfg)).toBe(
      'https://shop.example.com/assets/app.[hash].js',
    );
  });

  it('collapses the Stripe fingerprinted path', () => {
    expect(normalizeUrl('https://js.stripe.com/v3/fingerprinted/js/elements-inner-card-0a1b2c3d4e5f.js', cfg)).toBe(
      'https://js.stripe.com/v3/fingerprinted/js/elements-inner-card-[hash].js',
    );
  });

  it('collapses a webpack contenthash', () => {
    expect(normalizeUrl('https://shop.example.com/static/js/main.8e1f0a9c7b6d5e4f3a2b.js', cfg)).toBe(
      'https://shop.example.com/static/js/main.[hash].js',
    );
    expect(normalizeUrl('https://shop.example.com/_next/static/chunks/webpack-1a2b3c4d5e6f7a8b.js', cfg)).toBe(
      'https://shop.example.com/_next/static/chunks/webpack-[hash].js',
    );
  });

  it('collapses a whole hash-only path segment and a mixed base62 token of 16+ chars', () => {
    expect(normalizeUrl('https://cdn.example.com/0123456789abcdef/bundle.js', cfg)).toBe(
      'https://cdn.example.com/[hash]/bundle.js',
    );
    expect(normalizeUrl('https://cdn.example.com/build/aZ3kL9mQ2xP7vR4tW1yB.js', cfg)).toBe(
      'https://cdn.example.com/build/[hash].js',
    );
  });

  it('leaves short tokens, version-like tokens and plain words alone', () => {
    expect(normalizeUrl('https://js.stripe.com/v3', cfg)).toBe('https://js.stripe.com/v3');
    expect(normalizeUrl('https://shop.example.com/assets/app.min.js', cfg)).toBe(
      'https://shop.example.com/assets/app.min.js',
    );
    expect(normalizeUrl('https://shop.example.com/js/internationalization.js', cfg)).toBe(
      'https://shop.example.com/js/internationalization.js',
    );
    expect(normalizeUrl('https://shop.example.com/vendor-node_modules-react.js', cfg)).toBe(
      'https://shop.example.com/vendor-node_modules-react.js',
    );
  });

  it('does not collapse when collapseHashes is false', () => {
    expect(normalizeUrl('https://shop.example.com/assets/app.3f9c2a1b.js', { ...cfg, collapseHashes: false })).toBe(
      'https://shop.example.com/assets/app.3f9c2a1b.js',
    );
  });
});

describe('normalizeUrl: query handling (rule 4)', () => {
  it('exposes the exact built-in cache-buster list', () => {
    expect([...BUILTIN_CACHE_BUSTERS]).toEqual([
      'v',
      'ver',
      'version',
      'cb',
      '_',
      't',
      'ts',
      'timestamp',
      'rnd',
      'rand',
      'random',
      'nocache',
      'cache',
      'h',
      'hash',
      'bust',
      '_t',
      '_v',
    ]);
  });

  it('removes every built-in cache buster', () => {
    const query = BUILTIN_CACHE_BUSTERS.map((name, i) => `${name}=${i}`).join('&');
    expect(normalizeUrl(`https://cdn.example.com/vendor.js?${query}`, cfg)).toBe('https://cdn.example.com/vendor.js');
  });

  it('removes a cache buster and keeps identity-relevant values', () => {
    expect(normalizeUrl('https://cdn.example.com/vendor.js?v=12', cfg)).toBe('https://cdn.example.com/vendor.js');
    expect(normalizeUrl('https://www.googletagmanager.com/gtm.js?id=GTM-ABC', cfg)).toBe(
      'https://www.googletagmanager.com/gtm.js?id=GTM-ABC',
    );
    expect(normalizeUrl('https://www.googletagmanager.com/gtm.js?id=GTM-ABC&_=1700000000', cfg)).toBe(
      'https://www.googletagmanager.com/gtm.js?id=GTM-ABC',
    );
  });

  it('sorts remaining parameters by name', () => {
    expect(normalizeUrl('https://cdn.example.com/a.js?z=1&a=2&m=3', cfg)).toBe('https://cdn.example.com/a.js?a=2&m=3&z=1');
  });

  it('keeps the original encoding of parameter values', () => {
    expect(normalizeUrl('https://cdn.example.com/a.js?u=https%3A%2F%2Fx.test%2F&a=b%20c', cfg)).toBe(
      'https://cdn.example.com/a.js?a=b%20c&u=https%3A%2F%2Fx.test%2F',
    );
  });

  it('applies cfg.stripQuery', () => {
    expect(normalizeUrl('https://cdn.example.com/a.js?sid=abc&id=1', { ...cfg, stripQuery: ['sid'] })).toBe(
      'https://cdn.example.com/a.js?id=1',
    );
  });

  it('cfg.keepQuery overrides built-ins and stripQuery', () => {
    expect(normalizeUrl('https://cdn.example.com/a.js?v=3&t=9', { ...cfg, keepQuery: ['v'] })).toBe(
      'https://cdn.example.com/a.js?v=3',
    );
    expect(
      normalizeUrl('https://cdn.example.com/a.js?sid=1', { ...cfg, stripQuery: ['sid'], keepQuery: ['sid'] }),
    ).toBe('https://cdn.example.com/a.js?sid=1');
  });

  it('drops an empty query and keeps duplicate parameters in order', () => {
    expect(normalizeUrl('https://cdn.example.com/a.js?', cfg)).toBe('https://cdn.example.com/a.js');
    expect(normalizeUrl('https://cdn.example.com/a.js?v=1&', cfg)).toBe('https://cdn.example.com/a.js');
    expect(normalizeUrl('https://cdn.example.com/a.js?b=2&a=1&a=0', cfg)).toBe('https://cdn.example.com/a.js?a=1&a=0&b=2');
  });
});

describe('normalizeUrl: identity is the normalised string (rule 5)', () => {
  it('is idempotent', () => {
    const once = normalizeUrl('HTTPS://Shop.Example.com:443/assets/app.3f9c2a1b.js?v=1&id=2#x', cfg);
    expect(once).toBe('https://shop.example.com/assets/app.[hash].js?id=2');
    expect(normalizeUrl(once, cfg)).toBe(once);
  });

  it('applies all rules together', () => {
    expect(
      normalizeUrl(
        'HTTPS://JS.Stripe.com:443/v3/fingerprinted/js/elements-inner-card-0a1b2c3d4e5f.js?ts=1&locale=en#top',
        cfg,
      ),
    ).toBe('https://js.stripe.com/v3/fingerprinted/js/elements-inner-card-[hash].js?locale=en');
  });
});
