import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diff } from '../../../src/diff/diff.js';
import { appendHistory, historyStem } from '../../../src/history/store.js';
import { fakeNormalizeUrl, hex, makeManifest, makeScript, makeSnapshot } from '../diff/helpers.js';

describe('appendHistory', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scriptlock-history-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes snapshot, diff and index line under <dir>/<profile>', async () => {
    const snapshot = makeSnapshot({ scripts: [makeScript({ source: 'top secret', sha256: hex('f') })] });
    const result = diff({ snapshot, manifest: makeManifest(), mode: 'gate', normalizeUrl: fakeNormalizeUrl });
    const path = await appendHistory(join(dir, 'history'), 'checkout', snapshot, result);
    const stem = '2026-09-02T10-00-05.000Z';
    expect(historyStem(snapshot)).toBe(stem);
    expect(path).toBe(join(dir, 'history', 'checkout', `${stem}.snapshot.json`));
    const files = (await readdir(join(dir, 'history', 'checkout'))).sort();
    expect(files).toEqual([`${stem}.diff.json`, `${stem}.snapshot.json`, 'index.jsonl']);

    const written = JSON.parse(await readFile(path, 'utf8')) as { scripts: Record<string, unknown>[]; profile: string };
    expect(written.profile).toBe('default');
    expect(written.scripts[0]).not.toHaveProperty('source');
    expect(written.scripts[0]?.['sha256']).toBe(hex('f'));
    expect(snapshot.scripts[0]?.source).toBe('top secret');

    const diffJson = JSON.parse(await readFile(join(dir, 'history', 'checkout', `${stem}.diff.json`), 'utf8')) as { exitCode: number; events: unknown[] };
    expect(diffJson.exitCode).toBe(1);
    expect(diffJson.events).toHaveLength(1);

    const index = (await readFile(join(dir, 'history', 'checkout', 'index.jsonl'), 'utf8')).trim().split('\n');
    expect(index).toHaveLength(1);
    expect(JSON.parse(index[0] ?? '')).toEqual({
      at: '2026-09-02T10:00:05.000Z',
      url: 'https://shop.example.com/checkout',
      exitCode: 1,
      fail: 1,
      warn: 0,
      info: 0,
      blocked: false,
    });
  });

  it('works without a result and appends to the index', async () => {
    const first = makeSnapshot({ blocked: { vendor: 'cloudflare', evidence: 'x' } });
    const second = makeSnapshot({ finishedAt: '2026-09-03T10:00:05.000Z' });
    await appendHistory(dir, 'default', first);
    await appendHistory(dir, 'default', second);
    const files = (await readdir(join(dir, 'default'))).sort();
    expect(files).toEqual(['2026-09-02T10-00-05.000Z.snapshot.json', '2026-09-03T10-00-05.000Z.snapshot.json', 'index.jsonl']);
    const lines = (await readFile(join(dir, 'default', 'index.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ exitCode: null, fail: 0, warn: 0, info: 0, blocked: true });
    expect(lines[1]).toMatchObject({ at: '2026-09-03T10:00:05.000Z', blocked: false });
  });

  it('falls back to the current time for an unparseable finishedAt', () => {
    const stem = historyStem(makeSnapshot({ finishedAt: 'not a date' }));
    expect(stem).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  });
});
