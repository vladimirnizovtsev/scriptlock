import { describe, expect, it } from 'vitest';
import { bundleHints, bundlePath, diff } from '../../../src/diff/diff.js';
import { globMatches, isNarrowGlob } from '../../../src/manifest/match.js';
import type { DiffEvent, ObservedScript } from '../../../src/types.js';
import { fakeNormalizeUrl, hex, makeEntry, makeManifest, makeScript, makeSnapshot } from './helpers.js';

const CHUNKS = 'https://nzv.dev/_next/static/chunks';

function chunk(stem: string, seed: string, extension: string = 'js') {
  const id = `${CHUNKS}/${stem}.${extension}`;
  return makeScript({ id, url: id, rawUrl: id, sha256: hex(seed), structuralHash: hex(seed) });
}

function hintsFor(scripts: ReturnType<typeof makeScript>[]): string[] {
  const result = diff({
    snapshot: makeSnapshot({ scripts }),
    manifest: makeManifest(),
    mode: 'gate',
    normalizeUrl: fakeNormalizeUrl,
  });
  return result.hints ?? [];
}

function newEvent(subject: string): DiffEvent {
  return { type: 'new', severity: 'fail', subject, message: 'unapproved external script in merchant scope' };
}

describe('bundlePath', () => {
  it('splits an http(s) id into directory, extension and stem', () => {
    expect(bundlePath(`${CHUNKS}/1ixzeq6_vmaz2.js`)).toEqual({ directory: CHUNKS, extension: 'js', stem: '1ixzeq6_vmaz2' });
    expect(bundlePath('https://nzv.dev/app.mjs')).toEqual({ directory: 'https://nzv.dev', extension: 'mjs', stem: 'app' });
  });

  it('returns undefined for ids that cannot be a bundle chunk', () => {
    expect(bundlePath('inline:https://nzv.dev:9f2c41ba0d77e1a3')).toBeUndefined();
    expect(bundlePath('eval:https://nzv.dev:9f2c41ba0d77e1a3')).toBeUndefined();
    expect(bundlePath('blob:https://nzv.dev')).toBeUndefined();
    expect(bundlePath('https://nzv.dev/vendor.js?id=GTM-ABC')).toBeUndefined();
    expect(bundlePath('https://nzv.dev/chunks/noextension')).toBeUndefined();
    expect(bundlePath('not a url')).toBeUndefined();
  });
});

describe('diff hints: content-hashed bundles', () => {
  it('suggests one match entry when three sibling scripts are new', () => {
    const hints = hintsFor([chunk('1ixzeq6_vmaz2', '1'), chunk('2hh4ipina8zdg', '2'), chunk('turbopack-1l_s3wnkx96or', '3')]);
    expect(hints).toHaveLength(1);
    const hint = hints[0] ?? '';
    expect(hint).toContain('3 new scripts under https://nzv.dev/_next/static/chunks/');
    expect(hint).toContain('content-hashed bundle pattern');
    expect(hint.split('\n')[1]).toBe(
      `scriptlock approve --match "${CHUNKS}/*.js" --owner "<team>" --category framework --justification "<why this build directory is authorised>"`,
    );
    expect(hint).not.toMatch(/—/);
  });

  it('says the glob covers one directory only', () => {
    const hints = hintsFor([chunk('1ixzeq6_vmaz2', '1'), chunk('2hh4ipina8zdg', '2'), chunk('turbopack-1l_s3wnkx96or', '3')]);
    expect(hints[0]).toContain('that one directory, not its subdirectories');
  });

  it('does not fire below three sibling scripts', () => {
    expect(hintsFor([chunk('a1b2c3', '1'), chunk('d4e5f6', '2')])).toEqual([]);
  });

  it('suggests only a command that approve --match would accept', () => {
    // Scripts at the root of the host would need a glob covering the whole
    // origin, which approveMatch refuses, so no command is printed.
    const root = ['one', 'two', 'three'].map((stem, index) => {
      const id = `https://nzv.dev/${stem}.js`;
      return makeScript({ id, url: id, rawUrl: id, sha256: hex(String(index + 1)) });
    });
    expect(hintsFor(root)).toEqual([]);
  });

  it('escapes glob metacharacters in the directory so the printed glob matches the chunks', () => {
    const directory = 'https://nzv.dev/build(2)/chunks';
    const ids = ['1ixzeq6_vmaz2', '2hh4ipina8zdg', 'turbopack-1l_s3wnkx96or'].map((stem) => `${directory}/${stem}.js`);
    const hints = bundleHints(ids.map(newEvent));
    expect(hints).toHaveLength(1);
    const glob = /--match "([^"]+)"/.exec(hints[0] ?? '')?.[1] ?? '';
    expect(glob).toBe('https://nzv.dev/build\\(2\\)/chunks/*.js');
    for (const id of ids) expect(globMatches(glob, id)).toBe(true);
    expect(isNarrowGlob(glob)).toBe(true);
  });

  it('does not fire for unrelated ids', () => {
    const unrelated = [
      makeScript({ id: 'https://nzv.dev/vendor.js?id=GTM-ABC', url: 'https://nzv.dev/vendor.js?id=GTM-ABC', sha256: hex('1') }),
      makeScript({ id: 'inline:https://nzv.dev:0011223344556677', kind: 'inline', url: undefined, rawUrl: undefined, sha256: hex('2') }),
      makeScript({ id: 'https://nzv.dev/a/one.js', url: 'https://nzv.dev/a/one.js', sha256: hex('3') }),
      makeScript({ id: 'https://nzv.dev/b/two.js', url: 'https://nzv.dev/b/two.js', sha256: hex('4') }),
      makeScript({ id: 'https://other.example/c/three.js', url: 'https://other.example/c/three.js', sha256: hex('5') }),
    ];
    expect(hintsFor(unrelated)).toEqual([]);
  });

  it('keeps one suggestion per directory and at most three', () => {
    const scripts: ObservedScript[] = [];
    for (const dir of ['a', 'b', 'c', 'd', 'e']) {
      for (const stem of ['one', 'two', 'three']) {
        const id = `https://nzv.dev/${dir}/${stem}.js`;
        scripts.push(makeScript({ id, url: id, rawUrl: id, sha256: hex(dir) }));
      }
    }
    const hints = hintsFor(scripts);
    expect(hints).toHaveLength(3);
    const directories = hints.map((hint) => hint.split(' ').find((word) => word.startsWith('https://')));
    expect(new Set(directories).size).toBe(3);
  });

  it('emits one hint for a directory that mixes extensions', () => {
    const hints = bundleHints([
      newEvent(`${CHUNKS}/one.js`),
      newEvent(`${CHUNKS}/two.js`),
      newEvent(`${CHUNKS}/three.js`),
      newEvent(`${CHUNKS}/one.mjs`),
      newEvent(`${CHUNKS}/two.mjs`),
      newEvent(`${CHUNKS}/three.mjs`),
      newEvent(`${CHUNKS}/four.mjs`),
    ]);
    expect(hints).toHaveLength(1);
    // The larger group wins, so the suggested glob covers the four .mjs chunks.
    expect(hints[0]).toContain(`"${CHUNKS}/*.mjs"`);
  });

  it('ignores events that are not new', () => {
    const removed: DiffEvent[] = [`${CHUNKS}/one.js`, `${CHUNKS}/two.js`, `${CHUNKS}/three.js`].map((subject) => ({
      type: 'removed',
      severity: 'warn',
      subject,
      message: 'approved script not observed in 1 run',
    }));
    expect(bundleHints(removed)).toEqual([]);
  });

  it('is empty for a clean run and never changes the summary or exit code', () => {
    const result = diff({
      snapshot: makeSnapshot({ scripts: [makeScript()] }),
      manifest: makeManifest({ scripts: [makeEntry()] }),
      mode: 'gate',
      normalizeUrl: fakeNormalizeUrl,
    });
    expect(result.hints).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('leaves severities and the exit code untouched when it fires', () => {
    const result = diff({
      snapshot: makeSnapshot({ scripts: [chunk('one', '1'), chunk('two', '2'), chunk('three', '3')] }),
      manifest: makeManifest(),
      mode: 'gate',
      normalizeUrl: fakeNormalizeUrl,
    });
    expect(result.summary).toEqual({ fail: 3, warn: 0, info: 0, merchantScripts: 3, totalScripts: 3, approved: 0 });
    expect(result.exitCode).toBe(1);
    expect(result.hints).toHaveLength(1);
  });
});
