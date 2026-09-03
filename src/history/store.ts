/**
 * Flat-file history: appends a snapshot (and optionally its diff) under
 * <dir>/<profile>/ as <timestamp>.snapshot.json / <timestamp>.diff.json and
 * keeps <dir>/<profile>/index.jsonl with one line per run.
 *
 * The timestamp is the snapshot's finishedAt in ISO form with colons replaced
 * by dashes (file-system safe on every platform). Script `source` text is
 * never written. Limitation: two appends of the same snapshot overwrite the
 * same files but add two index lines; there is no locking for concurrent
 * writers.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resultToJson, snapshotToJson } from '../report/json.js';
import type { DiffResult, Snapshot } from '../types.js';

export interface HistoryIndexLine {
  at: string;
  url: string;
  exitCode: 0 | 1 | 2 | null;
  fail: number;
  warn: number;
  info: number;
  blocked: boolean;
}

export function historyStem(snapshot: Snapshot): string {
  const parsed = Date.parse(snapshot.finishedAt);
  const iso = Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
  return iso.replace(/:/g, '-');
}

function indexLine(snapshot: Snapshot, result?: DiffResult): HistoryIndexLine {
  return {
    at: snapshot.finishedAt,
    url: snapshot.url,
    exitCode: result ? result.exitCode : null,
    fail: result ? result.summary.fail : 0,
    warn: result ? result.summary.warn : 0,
    info: result ? result.summary.info : 0,
    blocked: snapshot.blocked !== undefined,
  };
}

/** Writes the history files and returns the snapshot path. */
export async function appendHistory(
  dir: string,
  profile: string,
  snapshot: Snapshot,
  result?: DiffResult,
): Promise<string> {
  const profileDir = join(dir, profile);
  await mkdir(profileDir, { recursive: true });
  const stem = historyStem(snapshot);
  const snapshotPath = join(profileDir, `${stem}.snapshot.json`);
  await writeFile(snapshotPath, JSON.stringify(snapshotToJson(snapshot), null, 2) + '\n', 'utf8');
  if (result) {
    const diffPath = join(profileDir, `${stem}.diff.json`);
    await writeFile(diffPath, JSON.stringify(resultToJson(result), null, 2) + '\n', 'utf8');
  }
  await appendFile(join(profileDir, 'index.jsonl'), JSON.stringify(indexLine(snapshot, result)) + '\n', 'utf8');
  return snapshotPath;
}
