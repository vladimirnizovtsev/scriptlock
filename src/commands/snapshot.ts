/**
 * The snapshot file layer shared by every command (DESIGN.md section 2).
 *
 * Owns: `lastSnapshotPath` (`.scriptlock/last.<profile>.json`), `snapshotSchema`
 * and the three file operations `parseSnapshot`, `readSnapshot` and
 * `writeSnapshot`. A written snapshot never carries script source text; that
 * rule lives in `snapshotToJson` (report/json.ts) and is applied on every path
 * in and out of this module.
 *
 * Header names are validated against `SECURITY_HEADER_NAMES`, so a snapshot
 * carrying some other response header (a hand-edited file, or one produced by
 * another tool) is refused rather than diffed: `Snapshot.headers` is typed as
 * `SecurityHeaders`, and a `set-cookie` value reaching the diff would be
 * printed into a CI log or a pull request comment as a `header-added` event.
 *
 * Limitations: validation is otherwise structural (zod, unknown keys pass
 * through), so a hand-edited file of plausible shape is accepted, and the
 * fields the schema does not check reach `Snapshot` through the catchall
 * unvalidated — see `toSnapshot`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ScriptlockError } from '../errors.js';
import { headerNameSchema } from '../manifest/schema.js';
import { snapshotToJson } from '../report/json.js';
import { SCOPES, SCRIPT_KINDS, type Snapshot } from '../types.js';

/** `.scriptlock/last.<profile>.json` under `cwd`. */
export function lastSnapshotPath(cwd: string, profile: string): string {
  return path.join(cwd, '.scriptlock', `last.${profile}.json`);
}

const scopeSchema = z.enum(SCOPES);
const kindSchema = z.enum(SCRIPT_KINDS);

const frameSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  origin: z.string(),
  isMain: z.boolean(),
  scope: scopeSchema,
  crossOrigin: z.boolean(),
});

const scriptSchema = z.looseObject({
  id: z.string().min(1),
  kind: kindSchema,
  scope: scopeSchema,
  hasSourceURL: z.boolean(),
  frameId: z.string(),
  frameUrl: z.string(),
  frameOrigin: z.string(),
  target: z.enum(['page', 'iframe', 'worker', 'service_worker']),
  sha256: z.string().optional(),
  structuralHash: z.string().optional(),
  size: z.number(),
  isModule: z.boolean(),
  observedInRuns: z.number().int().nonnegative(),
});

/** Structural schema of a snapshot file; unknown keys are kept. */
export const snapshotSchema = z.looseObject({
  version: z.literal(1),
  tool: z.looseObject({ name: z.literal('scriptlock'), version: z.string() }),
  profile: z.string().min(1),
  url: z.string(),
  finalUrl: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  runs: z.number().int().positive(),
  vantage: z.looseObject({ userAgent: z.string(), browser: z.string(), headless: z.boolean() }),
  documentStatus: z.number(),
  headers: z.partialRecord(headerNameSchema, z.string()),
  frames: z.array(frameSchema),
  scripts: z.array(scriptSchema),
  blocked: z.looseObject({ vendor: z.string(), evidence: z.string() }).optional(),
  warnings: z.array(z.string()),
});

type SnapshotSchemaOutput = z.output<typeof snapshotSchema>;

/**
 * Narrows validated schema output to the `Snapshot` contract type.
 *
 * The schema is deliberately loose, so the contract fields it does not
 * declare — `url`, `rawUrl`, `initiator`, `entity`, `loadedBy`,
 * `responseHeaders` — reach the output through the catchall and are taken as
 * written. This is the single place that trust is expressed, and it is applied
 * to `result.data` rather than to the raw `JSON.parse` output, so a default or
 * a transform added to `snapshotSchema` later actually takes effect.
 */
function toSnapshot(parsed: SnapshotSchemaOutput): Snapshot {
  return parsed as unknown as Snapshot;
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
}

/** Parses and validates snapshot JSON. Any `source` text is dropped. */
export function parseSnapshot(text: string, where: string = 'snapshot'): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScriptlockError('SNAPSHOT_INVALID', `Invalid JSON in ${where}: ${detail}`, {
      hint: 'Run "scriptlock scan" to write a fresh snapshot',
      cause: error,
    });
  }
  const result = snapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new ScriptlockError('SNAPSHOT_INVALID', `Invalid snapshot ${where}:\n${formatIssues(result.error.issues)}`, {
      hint: 'Run "scriptlock scan" to write a fresh snapshot',
    });
  }
  return snapshotToJson(toSnapshot(result.data));
}

export async function readSnapshot(file: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ScriptlockError('SNAPSHOT_NOT_FOUND', `Snapshot not found: ${file}`, {
        exitCode: 2,
        hint: 'Run "scriptlock scan" first, or pass --snapshot <file>',
        cause: error,
      });
    }
    throw error;
  }
  return parseSnapshot(text, file);
}

/** Writes the snapshot as pretty JSON (never with script sources), creating directories. */
export async function writeSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshotToJson(snapshot), null, 2) + '\n', 'utf8');
}
