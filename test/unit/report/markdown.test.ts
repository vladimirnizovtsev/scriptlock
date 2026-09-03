import { describe, expect, it } from 'vitest';
import { diff } from '../../../src/diff/diff.js';
import { inventoryStatus, renderInventoryMarkdown, renderMarkdown } from '../../../src/report/markdown.js';

function balancedBackticks(md: string): void {
  for (const line of md.split('\n')) {
    expect({ line, ticks: (line.match(/`/g) ?? []).length % 2 }).toEqual({ line, ticks: 0 });
  }
}
import {
  APP_ID,
  APP_SHA,
  fakeNormalizeUrl,
  hex,
  INLINE_ID,
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
} from '../diff/helpers.js';

describe('renderMarkdown', () => {
  it('renders a table of fail/warn events and a collapsed details block for info', () => {
    const result = diff({
      snapshot: makeSnapshot({
        scripts: [makeScript({ sha256: hex('f') }), makeScript({ id: 'https://a.example/pipe|y.js', scope: 'tpsp', sha256: hex('1') })],
        headers: { 'x-frame-options': 'DENY' },
      }),
      manifest: makeManifest({ scripts: [makeEntry()], headers: { policy: 'track', values: { 'x-frame-options': 'SAMEORIGIN' } } }),
      mode: 'gate',
      normalizeUrl: fakeNormalizeUrl,
    });
    const md = renderMarkdown(result);
    expect(md).toContain('## Scriptlock diff: default (gate)');
    expect(md).toContain('**Result: 1 fail, 0 warn, 2 info; exit code 1 (findings at fail severity).**');
    expect(md).toContain('| Type | Severity | Scope | Subject | Message |');
    expect(md).toContain(`| changed | fail | merchant | \`${APP_ID}\` |`);
    expect(md).toContain(APP_SHA.slice(0, 12));
    expect(md).not.toContain(APP_SHA);
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>2 informational events</summary>');
    expect(md).toContain('</details>');
    expect(md).toContain('| new | info | tpsp |');
    expect(md).toContain('pipe\\|y.js');
    expect(md).toContain('before: `SAMEORIGIN`, after: `DENY`');
    expect(md.indexOf('| changed |')).toBeLessThan(md.indexOf('<details>'));
    expect(md).not.toMatch(/—/);
  });

  it('says so when there are no findings', () => {
    const md = renderMarkdown(diff({ snapshot: makeSnapshot(), manifest: makeManifest(), mode: 'gate', normalizeUrl: fakeNormalizeUrl }));
    expect(md).toContain('No findings.');
    expect(md).not.toContain('<details>');
    expect(md).toContain('exit code 0 (clean)');
  });
});

describe('renderInventoryMarkdown', () => {
  const snapshot = makeSnapshot({
    scripts: [
      makeScript(),
      makeScript({ id: STRIPE_ID, url: STRIPE_ID, sha256: hex('9'), entity: { name: 'Stripe', category: 'utility' } }),
      makeScript({ id: 'https://shop.example.com/old.js', sha256: hex('3') }),
      makeScript({ id: 'https://unknown.example/u.js', sha256: hex('4'), loadedBy: APP_ID }),
      makeScript({ id: 'https://frame.example/f.js', scope: 'tpsp', sha256: hex('5') }),
      makeScript({ id: 'eval:x:1', scope: 'harness', sha256: hex('6') }),
    ],
    frames: [mainFrame(), makeFrame(), makeFrame({ id: 'f2', url: 'https://chat.example/widget', origin: 'https://chat.example', scope: 'embedded' })],
    headers: { 'content-security-policy': "default-src 'self'" },
  });
  const manifest = makeManifest({
    scripts: [
      makeEntry(),
      makeEntry({ id: STRIPE_ID, integrity: 'track', integrityMethod: 'vendor-attested', sha256: STRIPE_SHA, owner: 'payments', category: 'payment' }),
      makeEntry({ id: 'https://shop.example.com/old.js', sha256: hex('0') }),
    ],
    frames: [makeFrameEntry()],
    headers: { policy: 'strict', values: {} },
  });

  it('groups by scope then owner/category with status and integrity columns', () => {
    const md = renderInventoryMarkdown(snapshot, manifest);
    expect(md).toContain('## Scriptlock inventory: default');
    expect(md).toContain('Scripts: 5 observed, 2 approved, 2 unapproved, 1 stale');
    expect(md).toContain('### Scope: merchant (4 scripts)');
    expect(md).toContain('### Scope: tpsp (1 script)');
    expect(md).toContain('#### Owner / category: payments / payment');
    expect(md).toContain('#### Owner / category: web / functional');
    expect(md).toContain('#### Unapproved');
    expect(md).toContain(`| \`${APP_ID}\` | external | approved | strict (hash-strict) |`);
    expect(md).toContain(`| \`${STRIPE_ID}\` | external | approved | not assured (source-tracked) [track] | Stripe (utility) |`);
    expect(md).toContain('| `https://shop.example.com/old.js` | external | stale | strict (hash-strict) |');
    expect(md).toContain(`| \`https://unknown.example/u.js\` | external | unapproved | none |  | \`${APP_ID}\` |`);
    expect(md).not.toContain('eval:x:1');
    expect(md.indexOf('web / functional')).toBeLessThan(md.indexOf('#### Unapproved'));
    expect(md).toContain('### Cross-origin frames (2)');
    expect(md).toContain('| https://chat.example/widget | embedded | unapproved |');
    expect(md).toContain('| tpsp | approved |');
    expect(md).toContain('### Security headers (policy: strict)');
    expect(md).toContain("| content-security-policy | `default-src 'self'` |");
    expect(md).not.toMatch(/—/);
  });

  it('flags blocked snapshots and empty headers', () => {
    const md = renderInventoryMarkdown(makeSnapshot({ blocked: { vendor: 'datadome', evidence: 'captcha' } }), makeManifest());
    expect(md).toContain('challenge page was detected (datadome)');
    expect(md).toContain('No security headers observed');
  });

  it('inventoryStatus treats url-only and track entries as approved regardless of body', () => {
    const script = makeScript({ sha256: hex('1'), structuralHash: hex('2') });
    expect(inventoryStatus(script, makeEntry({ integrity: 'track' }))).toBe('approved');
    expect(inventoryStatus(script, makeEntry({ integrity: 'url-only' }))).toBe('approved');
    expect(inventoryStatus(script, makeEntry({ integrity: 'strict' }))).toBe('stale');
    expect(inventoryStatus(script, undefined)).toBe('unapproved');
    const inline = makeScript({ id: INLINE_ID, kind: 'inline', structuralHash: hex('7') });
    expect(inventoryStatus(inline, makeEntry({ id: INLINE_ID, integrity: 'structural', structuralHash: INLINE_STRUCT }))).toBe('stale');
  });
});

describe('markdown keeps long code spans whole and backticks balanced', () => {
  const LONG_ID = `https://cdn.example.com/${'a'.repeat(160)}.js`;
  const LONG_CSP = `default-src 'self'; script-src 'self' ${Array.from({ length: 20 }, (_, i) => `https://cdn${i}.example.com`).join(' ')}`;

  it('does not truncate a >120-char id or a full CSP in the inventory', () => {
    const snapshot = makeSnapshot({ scripts: [makeScript({ id: LONG_ID, url: LONG_ID })], headers: { 'content-security-policy': LONG_CSP } });
    const md = renderInventoryMarkdown(snapshot, makeManifest({ headers: { policy: 'strict', values: {} } }));
    expect(md).toContain(LONG_ID);
    expect(md).toContain(LONG_CSP);
    balancedBackticks(md);
  });

  it('closes the code span even when a diff event message is truncated', () => {
    const result = diff({
      snapshot: makeSnapshot({ headers: { 'content-security-policy': LONG_CSP } }),
      manifest: makeManifest({ headers: { policy: 'strict', values: { 'content-security-policy': "default-src 'none'" } } }),
      mode: 'gate',
      normalizeUrl: fakeNormalizeUrl,
    });
    balancedBackticks(renderMarkdown(result));
  });
});
