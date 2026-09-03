/**
 * Machine-readable rendering of a DiffResult.
 *
 * Keys are emitted in a fixed order (the order declared in types.ts) so the
 * output is stable across runs and diffable. Observed scripts never carry
 * `source`. Limitation: unknown extra keys on inputs are dropped.
 */
import type { DiffEvent, DiffResult, ManifestFrame, ManifestScript, ObservedScript } from '../types.js';

type Json = Record<string, unknown>;

function pick<T extends object>(value: T, keys: readonly (keyof T)[]): Json {
  const out: Json = {};
  for (const key of keys) {
    const v = value[key];
    if (v !== undefined) out[key as string] = v;
  }
  return out;
}

const OBSERVED_KEYS: readonly (keyof ObservedScript)[] = [
  'id',
  'kind',
  'scope',
  'url',
  'rawUrl',
  'sourceUrl',
  'hasSourceURL',
  'frameId',
  'frameUrl',
  'frameOrigin',
  'target',
  'sha256',
  'structuralHash',
  'size',
  'isModule',
  'initiator',
  'loadedBy',
  'entity',
  'responseHeaders',
  'observedInRuns',
];

const SCRIPT_ENTRY_KEYS: readonly (keyof ManifestScript)[] = [
  'id',
  'match',
  'kind',
  'scope',
  'integrity',
  'integrityMethod',
  'sha256',
  'structuralHash',
  'owner',
  'category',
  'justification',
  'approvedBy',
  'approvedAt',
  'notes',
  'lastSeenSha256',
];

const FRAME_ENTRY_KEYS: readonly (keyof ManifestFrame)[] = [
  'match',
  'scope',
  'owner',
  'justification',
  'approvedBy',
  'approvedAt',
];

export function observedToJson(script: ObservedScript): Json {
  return pick(script, OBSERVED_KEYS);
}

function expectedToJson(expected: ManifestScript | ManifestFrame): Json {
  return 'id' in expected ? pick(expected, SCRIPT_ENTRY_KEYS) : pick(expected, FRAME_ENTRY_KEYS);
}

export function eventToJson(event: DiffEvent): Json {
  const out: Json = { type: event.type, severity: event.severity, subject: event.subject };
  if (event.scope !== undefined) out['scope'] = event.scope;
  out['message'] = event.message;
  if (event.before !== undefined) out['before'] = event.before;
  if (event.after !== undefined) out['after'] = event.after;
  if (event.observed !== undefined) out['observed'] = observedToJson(event.observed);
  if (event.expected !== undefined) out['expected'] = expectedToJson(event.expected);
  return out;
}

/** Plain object form of a DiffResult with stable key order. */
export function resultToJson(result: DiffResult): Json {
  const out: Json = {
    mode: result.mode,
    profile: result.profile,
    url: result.url,
    scannedAt: result.scannedAt,
    summary: {
      fail: result.summary.fail,
      warn: result.summary.warn,
      info: result.summary.info,
      merchantScripts: result.summary.merchantScripts,
      totalScripts: result.summary.totalScripts,
      approved: result.summary.approved,
    },
    exitCode: result.exitCode,
    events: result.events.map(eventToJson),
  };
  if (result.warnings !== undefined && result.warnings.length > 0) out['warnings'] = [...result.warnings];
  return out;
}

export function renderJson(result: DiffResult): string {
  return JSON.stringify(resultToJson(result), null, 2) + '\n';
}
