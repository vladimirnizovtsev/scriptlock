import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../../src/identity/normalize.js';
import { findFrameEntry } from '../../../src/manifest/match.js';
import type { FrameInfo, IdentityConfig, Manifest } from '../../../src/types.js';

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
