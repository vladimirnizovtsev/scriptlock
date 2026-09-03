import { describe, expect, it } from 'vitest';
import { diff } from '../../../src/diff/diff.js';
import { renderText } from '../../../src/report/text.js';
import { APP_ID, APP_SHA, fakeNormalizeUrl, hex, makeEntry, makeManifest, makeScript, makeSnapshot, STRIPE_ID, STRIPE_SHA } from '../diff/helpers.js';

const ANSI = new RegExp('\\u001b\\[');

function sample() {
  return diff({
    snapshot: makeSnapshot({
      scripts: [
        makeScript({ sha256: hex('f') }),
        makeScript({ id: 'https://frame.example/x.js', scope: 'tpsp', sha256: hex('1') }),
        makeScript({ id: STRIPE_ID, sha256: hex('2') }),
      ],
    }),
    manifest: makeManifest({
      scripts: [makeEntry(), makeEntry({ id: STRIPE_ID, integrity: 'track', sha256: STRIPE_SHA }), makeEntry({ id: 'https://gone.example/c.js' })],
    }),
    mode: 'gate',
    normalizeUrl: fakeNormalizeUrl,
  });
}

describe('renderText', () => {
  it('prints a header, grouped events and a summary with the exit code meaning', () => {
    const text = renderText(sample(), { color: false });
    expect(text).toContain('scriptlock diff (gate) https://shop.example.com/checkout');
    expect(text).toContain('profile: default');
    expect(text).toContain('FAIL (1)');
    expect(text).toContain('WARN (1)');
    expect(text).toContain('INFO (2)');
    expect(text).toContain(`changed        ${APP_ID} [merchant]`);
    expect(text).toContain(APP_SHA.slice(0, 12));
    expect(text).not.toContain(APP_SHA);
    expect(text).toContain('removed        https://gone.example/c.js');
    expect(text).toContain('summary: 1 fail, 1 warn, 2 info; exit code 1 (findings at fail severity)');
    expect(text.indexOf('FAIL')).toBeLessThan(text.indexOf('WARN'));
    expect(text.indexOf('WARN')).toBeLessThan(text.indexOf('INFO'));
    expect(text).not.toMatch(ANSI);
    expect(text).not.toMatch(/—/);
  });

  it('reports a clean run', () => {
    const result = diff({ snapshot: makeSnapshot(), manifest: makeManifest(), mode: 'drift', normalizeUrl: fakeNormalizeUrl });
    const text = renderText(result, { color: false });
    expect(text).toContain('clean: no findings');
    expect(text).toContain('exit code 0 (clean)');
  });

  it('explains exit code 2 and shows header before/after values', () => {
    const result = diff({
      snapshot: makeSnapshot({ blocked: { vendor: 'cloudflare', evidence: 'Just a moment' }, headers: { 'x-frame-options': 'DENY' } }),
      manifest: makeManifest({ headers: { policy: 'strict', values: { 'x-frame-options': 'SAMEORIGIN' } } }),
      mode: 'gate',
      normalizeUrl: fakeNormalizeUrl,
    });
    const text = renderText(result, { color: false });
    expect(text).toContain('blocked');
    expect(text).toContain('before: SAMEORIGIN');
    expect(text).toContain('after:  DENY');
    expect(text).toContain('exit code 2 (scan blocked or run error)');
  });

  it('emits ANSI codes when color is forced on', () => {
    expect(renderText(sample(), { color: true })).toMatch(ANSI);
  });
});

describe('renderText: hints', () => {
  const CHUNKS = 'https://shop.example.com/_next/static/chunks';
  const COMMAND = `scriptlock approve --match "${CHUNKS}/*.js" --owner "<team>" --category framework --justification "<why this build directory is authorised>"`;

  function bundleResult() {
    const scripts = ['1ixzeq6_vmaz2', '2hh4ipina8zdg', 'turbopack-1l_s3wnkx96or'].map((stem, index) => {
      const id = `${CHUNKS}/${stem}.js`;
      return makeScript({ id, url: id, rawUrl: id, sha256: hex(String(index + 1)) });
    });
    return diff({ snapshot: makeSnapshot({ scripts }), manifest: makeManifest(), mode: 'gate', normalizeUrl: fakeNormalizeUrl });
  }

  it('prints the approve --match suggestion between the events and the summary', () => {
    const text = renderText(bundleResult(), { color: false });
    expect(text).toContain('HINTS (1)');
    expect(text).toContain(`3 new scripts under ${CHUNKS}/ differ only in their file name`);
    expect(text).toContain(`    ${COMMAND}`);
    expect(text.indexOf('FAIL')).toBeLessThan(text.indexOf('HINTS'));
    expect(text.indexOf('HINTS')).toBeLessThan(text.indexOf('summary:'));
    expect(text).not.toMatch(ANSI);
    expect(text).not.toMatch(/—/);
  });

  it('prints no hint section when there is nothing to suggest', () => {
    expect(renderText(sample(), { color: false })).not.toContain('HINTS');
  });
});
