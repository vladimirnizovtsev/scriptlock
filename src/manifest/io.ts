/**
 * Reading and writing scriptlock.lock.yaml.
 *
 * Owns: `readManifest()`, `writeManifest()`, `parseManifest()`,
 * `serialiseManifest()`, `sortManifest()`, `emptyManifest()`.
 *
 * Serialisation is deterministic: keys are emitted in the order declared in
 * `src/types.ts`, header values in `SECURITY_HEADER_NAMES` order, scripts are
 * sorted by scope (merchant, tpsp, threeds, embedded, harness) then id, frames
 * by match and ignore globs by value, all using code-unit comparison (not
 * locale collation). Lines are never folded so long CSP values stay on one
 * line. Strings that would otherwise parse as another YAML type or contain
 * special characters are quoted by the yaml library. Limitation: comments in
 * a hand-edited manifest are not preserved across a write.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ScriptlockError } from '../errors.js';
import {
  SECURITY_HEADER_NAMES,
  type Manifest,
  type ManifestFrame,
  type ManifestScript,
  type Scope,
  type SecurityHeaders,
} from '../types.js';
import { formatManifestIssues, manifestSchema, toManifest } from './schema.js';

const SCOPE_ORDER: readonly Scope[] = ['merchant', 'tpsp', 'threeds', 'embedded', 'harness'];

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function scopeRank(scope: Scope): number {
  const index = SCOPE_ORDER.indexOf(scope);
  return index === -1 ? SCOPE_ORDER.length : index;
}

export function compareScripts(a: ManifestScript, b: ManifestScript): number {
  return scopeRank(a.scope) - scopeRank(b.scope) || compareStrings(a.id, b.id);
}

export function compareFrames(a: ManifestFrame, b: ManifestFrame): number {
  return compareStrings(a.match, b.match);
}

/** An empty manifest with a strict header policy. */
export function emptyManifest(profile: string, url: string): Manifest {
  return {
    version: 1,
    profile,
    url,
    headers: { policy: 'strict', values: {} },
    frames: [],
    scripts: [],
    ignore: [],
  };
}

function orderedScript(s: ManifestScript): Record<string, unknown> {
  const out: Record<string, unknown> = { id: s.id };
  if (s.match !== undefined) out['match'] = s.match;
  out['kind'] = s.kind;
  out['scope'] = s.scope;
  out['integrity'] = s.integrity;
  out['integrityMethod'] = s.integrityMethod;
  if (s.sha256 !== undefined) out['sha256'] = s.sha256;
  if (s.structuralHash !== undefined) out['structuralHash'] = s.structuralHash;
  out['owner'] = s.owner;
  out['category'] = s.category;
  out['justification'] = s.justification;
  out['approvedBy'] = s.approvedBy;
  out['approvedAt'] = s.approvedAt;
  if (s.coveredAtApproval !== undefined) {
    out['coveredAtApproval'] = {
      count: s.coveredAtApproval.count,
      scannedAt: s.coveredAtApproval.scannedAt,
      ids: [...s.coveredAtApproval.ids],
    };
  }
  if (s.notes !== undefined) out['notes'] = s.notes;
  if (s.lastSeenSha256 !== undefined) out['lastSeenSha256'] = s.lastSeenSha256;
  return out;
}

function orderedFrame(f: ManifestFrame): Record<string, unknown> {
  return {
    match: f.match,
    scope: f.scope,
    owner: f.owner,
    justification: f.justification,
    approvedBy: f.approvedBy,
    approvedAt: f.approvedAt,
  };
}

function orderedHeaders(values: SecurityHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SECURITY_HEADER_NAMES) {
    const value = values[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Returns a copy of the manifest with scripts, frames and ignore sorted. */
export function sortManifest(manifest: Manifest): Manifest {
  return {
    ...manifest,
    frames: [...manifest.frames].sort(compareFrames),
    scripts: [...manifest.scripts].sort(compareScripts),
    ignore: [...manifest.ignore].sort(compareStrings),
  };
}

/** Deterministic YAML for a manifest: same manifest, byte-identical output. */
export function serialiseManifest(manifest: Manifest): string {
  const sorted = sortManifest(manifest);
  const document = {
    version: sorted.version,
    profile: sorted.profile,
    url: sorted.url,
    headers: {
      policy: sorted.headers.policy,
      values: orderedHeaders(sorted.headers.values),
    },
    frames: sorted.frames.map(orderedFrame),
    scripts: sorted.scripts.map(orderedScript),
    ignore: sorted.ignore,
  };
  return YAML.stringify(document, {
    lineWidth: 0,
    indent: 2,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    singleQuote: false,
  });
}

/** Parses and validates manifest YAML text. `where` is used in error messages. */
export function parseManifest(text: string, where: string = 'manifest'): Manifest {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScriptlockError('MANIFEST_INVALID', `Invalid YAML in ${where}: ${detail}`, { cause: error });
  }
  if (raw === null || raw === undefined) {
    throw new ScriptlockError('MANIFEST_INVALID', `Manifest ${where} is empty`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScriptlockError('MANIFEST_INVALID', `Manifest ${where} must be a YAML mapping`);
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ScriptlockError('MANIFEST_INVALID', `Invalid manifest ${where}:\n${formatManifestIssues(result.error.issues)}`);
  }
  return toManifest(result.data);
}

export async function readManifest(file: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ScriptlockError('MANIFEST_NOT_FOUND', `Manifest not found: ${file}`, {
        exitCode: 1,
        hint: 'Run "scriptlock scan" and then "scriptlock approve --all-new" to create it',
        cause: error,
      });
    }
    throw error;
  }
  return parseManifest(text, file);
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serialiseManifest(manifest), 'utf8');
}
