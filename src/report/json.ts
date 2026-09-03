/**
 * Machine-readable rendering of a DiffResult and of a Snapshot.
 *
 * Keys are emitted in a fixed order (the order declared in types.ts) so the
 * output is stable across runs and diffable. Observed scripts never carry
 * `source`. `warnings` and `hints` are emitted only when they are not empty.
 * `snapshotToJson` is the one place that enforces DESIGN.md 3.3 step 10 — a
 * written snapshot never carries script source text — for every writer of a
 * snapshot: `scriptlock scan`, `--json` output and the history store.
 * Limitation: unknown extra keys on a DiffResult input are dropped; a snapshot
 * keeps them.
 */
import type {
  DiffEvent,
  DiffResult,
  Manifest,
  ManifestFrame,
  ManifestScript,
  ObservedScript,
  Scope,
  Snapshot,
} from '../types.js';
import { buildInventory, integrityLabel, type InventoryRow, type InventoryStatus } from './inventory.js';

type Json = Record<string, unknown>;

/** Snapshot as written to disk: identical shape, without script sources. */
export function snapshotToJson(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    scripts: snapshot.scripts.map((script) => {
      const { source: _source, ...rest } = script;
      return rest;
    }),
  };
}

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

function observedToJson(script: ObservedScript): Json {
  return pick(script, OBSERVED_KEYS);
}

function expectedToJson(expected: ManifestScript | ManifestFrame): Json {
  return 'id' in expected ? pick(expected, SCRIPT_ENTRY_KEYS) : pick(expected, FRAME_ENTRY_KEYS);
}

function eventToJson(event: DiffEvent): Json {
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
  if (result.hints !== undefined && result.hints.length > 0) out['hints'] = [...result.hints];
  return out;
}

export function renderJson(result: DiffResult): string {
  return JSON.stringify(resultToJson(result), null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Inventory (`scriptlock report --format json`)
// ---------------------------------------------------------------------------

export interface InventoryScriptJson {
  id: string;
  kind: ObservedScript['kind'];
  status: InventoryStatus;
  integrity: string;
  integrityPolicy?: ManifestScript['integrity'];
  integrityMethod?: ManifestScript['integrityMethod'];
  owner?: string;
  category?: ManifestScript['category'];
  justification?: string;
  approvedBy?: string;
  approvedAt?: string;
  url?: string;
  sha256?: string;
  structuralHash?: string;
  entity?: ObservedScript['entity'];
  loadedBy?: string;
  observedInRuns: number;
}

export interface InventoryGroupJson {
  owner: string | null;
  category: string | null;
  scripts: InventoryScriptJson[];
}

export interface InventoryJson {
  profile: string;
  url: string;
  scannedAt: string;
  runs: number;
  blocked?: Snapshot['blocked'];
  summary: { scripts: number; approved: number; unapproved: number; stale: number };
  scopes: { scope: Scope; scripts: number; groups: InventoryGroupJson[] }[];
  frames: { url: string; scope: Scope; status: 'approved' | 'unapproved' }[];
  headers: { policy: Manifest['headers']['policy']; values: Record<string, string> };
}

function inventoryRowToJson(row: InventoryRow): InventoryScriptJson {
  const { script, entry } = row;
  const out: InventoryScriptJson = {
    id: script.id,
    kind: script.kind,
    status: row.status,
    integrity: integrityLabel(entry),
    observedInRuns: script.observedInRuns,
  };
  if (script.sha256 !== undefined) out.sha256 = script.sha256;
  if (script.structuralHash !== undefined) out.structuralHash = script.structuralHash;
  if (entry !== undefined) {
    out.integrityPolicy = entry.integrity;
    out.integrityMethod = entry.integrityMethod;
    out.owner = entry.owner;
    out.category = entry.category;
    out.justification = entry.justification;
    out.approvedBy = entry.approvedBy;
    out.approvedAt = entry.approvedAt;
  }
  if (script.url !== undefined) out.url = script.url;
  if (script.entity !== undefined) out.entity = script.entity;
  if (script.loadedBy !== undefined) out.loadedBy = script.loadedBy;
  return out;
}

/** Inventory with authorisation status, grouped by scope, then owner and category. */
export function inventoryToJson(snapshot: Snapshot, manifest: Manifest): InventoryJson {
  const inventory = buildInventory(snapshot, manifest);
  const out: InventoryJson = {
    profile: inventory.profile,
    url: inventory.url,
    scannedAt: inventory.scannedAt,
    runs: inventory.runs,
    summary: inventory.counts,
    scopes: inventory.scopes.map((section) => ({
      scope: section.scope,
      scripts: section.count,
      groups: section.groups.map((group) => ({
        owner: group.owner,
        category: group.category,
        scripts: group.rows.map(inventoryRowToJson),
      })),
    })),
    frames: inventory.frames.map((frame) => ({ url: frame.url, scope: frame.scope, status: frame.status })),
    headers: { policy: inventory.headers.policy, values: { ...inventory.headers.values } },
  };
  if (inventory.blocked !== undefined) out.blocked = inventory.blocked;
  return out;
}

export function renderInventoryJson(snapshot: Snapshot, manifest: Manifest): string {
  return JSON.stringify(inventoryToJson(snapshot, manifest), null, 2) + '\n';
}
