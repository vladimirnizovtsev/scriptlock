/**
 * The `--history` tri-state of `scriptlock diff`: neither flag follows the profile,
 * `--history` forces a write and `--no-history` suppresses one even when the profile
 * asks for it. The last case is what keeps one run from leaving two lines in
 * `.scriptlock/history/<profile>/index.jsonl` when a caller diffs twice over one scan,
 * which is exactly what the GitHub Action did while the profile set `history: true`.
 *
 * No browser and no network: every run compares a snapshot file with `--snapshot`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDiff } from '../../../src/commands/diff.js';
import type { CommandContext } from '../../../src/commands/scan.js';
import { serialiseManifest } from '../../../src/manifest/io.js';
import { makeManifest, makeSnapshot, MAIN_URL } from '../diff/helpers.js';

let dir: string;

function writeWorkspace(profileHistory: boolean): void {
  writeFileSync(
    join(dir, 'scriptlock.config.yaml'),
    ['version: 1', 'profiles:', '  default:', `    url: ${MAIN_URL}`, `    history: ${profileHistory}`, ''].join('\n'),
  );
  writeFileSync(join(dir, 'scriptlock.lock.yaml'), serialiseManifest(makeManifest()));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(makeSnapshot()));
}

function ctx(): CommandContext {
  return {
    cwd: dir,
    verbose: false,
    color: false,
    toolVersion: '0.0.0-test',
    out: () => undefined,
    err: () => undefined,
  };
}

function indexLines(): number {
  const file = join(dir, '.scriptlock', 'history', 'default', 'index.jsonl');
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scriptlock-diff-history-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('diff history flag', () => {
  it('follows profile.history when neither flag is given', async () => {
    writeWorkspace(true);
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: 'snapshot.json' });
    expect(outcome.historyPath).toBeDefined();
    expect(indexLines()).toBe(1);
  });

  it('writes nothing when the profile does not ask and no flag is given', async () => {
    writeWorkspace(false);
    const outcome = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: 'snapshot.json' });
    expect(outcome.historyPath).toBeUndefined();
    expect(indexLines()).toBe(0);
  });

  it('--history overrides a profile that does not ask', async () => {
    writeWorkspace(false);
    await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: 'snapshot.json', history: true });
    expect(indexLines()).toBe(1);
  });

  it('--no-history overrides profile.history, so two diffs leave one index line', async () => {
    writeWorkspace(true);
    // What the action does: one diff writes the history, the second renders another
    // format from the same snapshot and must not append a second, identical line.
    await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: 'snapshot.json', history: true });
    const second = await runDiff(ctx(), { profile: 'default', mode: 'gate', snapshot: 'snapshot.json', history: false });
    expect(second.historyPath).toBeUndefined();
    expect(indexLines()).toBe(1);
  });
});
