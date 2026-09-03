import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../../src/identity/normalize.js';
import { coveringScriptEntries, escapeGlob, findFrameEntry, globMatches, globNarrowness, matchingScriptEntries } from '../../../src/manifest/match.js';
import type { FrameInfo, IdentityConfig, Manifest, ManifestScript } from '../../../src/types.js';

const cfg: IdentityConfig = { stripQuery: [], keepQuery: [], collapseHashes: true };

function manifest(match: string): Manifest {
  return {
    version: 1,
    profile: 'p',
    url: 'https://shop.example.com/',
    headers: { policy: 'ignore', values: {} },
    frames: [{ match, scope: 'tpsp', owner: 'payments', justification: 'j', approvedBy: 'v', approvedAt: '2026-09-02' }],
    scripts: [],
    ignore: [],
  };
}

function frame(url: string): FrameInfo {
  return { id: 'f', url, origin: 'https://js.stripe.com', isMain: false, scope: 'tpsp', crossOrigin: true };
}

describe('findFrameEntry with normalised frame URLs', () => {
  it('matches a [hash] frame entry against a normalised hashed frame URL', () => {
    const normalised = normalizeUrl('https://js.stripe.com/v3/elements-inner-card-0a1b2c3d4e5f.html', cfg);
    expect(normalised).toBe('https://js.stripe.com/v3/elements-inner-card-[hash].html');
    const m = manifest('https://js.stripe.com/v3/elements-inner-card-[hash].html');
    expect(findFrameEntry(m, frame(normalised))).toBeDefined();
    // A provider deploy changes the hash; the normalised URL is unchanged, so the match holds.
    const afterDeploy = normalizeUrl('https://js.stripe.com/v3/elements-inner-card-99887766aabb.html', cfg);
    expect(findFrameEntry(m, frame(afterDeploy))).toBeDefined();
  });

  it('matches a * glob and an exact URL', () => {
    expect(findFrameEntry(manifest('https://js.stripe.com/v3/*.html'), frame('https://js.stripe.com/v3/elements-inner-card-[hash].html'))).toBeDefined();
    expect(findFrameEntry(manifest('https://chat.example/widget'), frame('https://chat.example/widget'))).toBeDefined();
    expect(findFrameEntry(manifest('https://chat.example/widget'), frame('https://other.example/widget'))).toBeUndefined();
  });
});

describe('coveringScriptEntries', () => {
  const ID = 'https://shop.example.com/assets/app.abc.js';
  const GLOB = 'https://shop.example.com/assets/*.js';

  function entry(overrides: Partial<ManifestScript> & Pick<ManifestScript, 'id'>): ManifestScript {
    return { kind: 'external', scope: 'merchant', integrity: 'track', integrityMethod: 'source-tracked', owner: 'web', category: 'functional', justification: 'j', approvedBy: 'v', approvedAt: '2026-09-02', ...overrides };
  }

  function withScripts(scripts: ManifestScript[]): Manifest {
    return { version: 1, profile: 'p', url: 'https://shop.example.com/', headers: { policy: 'ignore', values: {} }, frames: [], scripts, ignore: [] };
  }

  it('returns the exact entry first and the glob it shadows after it', () => {
    const exact = entry({ id: ID });
    const glob = entry({ id: GLOB, match: GLOB });
    const m = withScripts([glob, exact]);
    // The entry that is enforced is still the exact one.
    expect(matchingScriptEntries(m, ID)).toEqual([exact]);
    expect(coveringScriptEntries(m, ID)).toEqual([exact, glob]);
    expect(coveringScriptEntries(m, 'https://shop.example.com/other/x.js')).toEqual([]);
  });
});

describe('globNarrowness', () => {
  it('accepts one wildcard inside one directory of one http(s) host', () => {
    for (const glob of [
      'https://shop.example.com/_next/static/chunks/*.js',
      'http://127.0.0.1:8080/assets/app-*.js',
      'https://shop.example.com/a/b/c/*.mjs',
      'https://shop.example.com/build\\(2\\)/*.js',
    ]) {
      expect(globNarrowness(glob), glob).toBeUndefined();
    }
  });

  it('refuses everything that can reach past that directory', () => {
    const cases: Array<[string, RegExp]> = [
      ['**', /\*\*/],
      ['https://shop.example.com/**', /\*\*/],
      ['https://shop.example.com/assets/**/*.js', /\*\*/],
      ['!nothing', /"!"/],
      ['{https://a.example/x/*.js,https://b.example/y/*.js}', /"\{"/],
      ['https://shop.example.com/@(a|b)/*.js', /"\(", "\|", "\)"/],
      ['https://shop.example.com/*.js', /root of the host/],
      ['https://*.example.com/a/*.js', /not an http\(s\) host and directory/],
      ['*.js', /not an http\(s\) host and directory/],
      ['https://shop.example.com/assets/*/deep.js', /past a "\/"/],
      ['https://shop.example.com/assets/app.js', /no wildcard/],
      ['   ', /empty/],
    ];
    for (const [glob, message] of cases) {
      expect(globNarrowness(glob)?.reason, glob).toMatch(message);
    }
  });
});

describe('escapeGlob', () => {
  it('makes a path with glob metacharacters match itself literally', () => {
    const directory = 'https://shop.example.com/build(2)/chunks';
    const glob = `${escapeGlob(directory)}/*.js`;
    expect(globMatches(glob, `${directory}/app.abc.js`)).toBe(true);
    expect(globMatches(glob, 'https://shop.example.com/build2/chunks/app.abc.js')).toBe(false);
    expect(globNarrowness(glob)).toBeUndefined();
  });
});
