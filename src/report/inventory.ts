/**
 * The inventory model behind `scriptlock report` (DESIGN.md section 8).
 *
 * Owns: `buildInventory()`, which pairs every observed script with the manifest
 * entry that authorises it, assigns the authorisation status, groups the result
 * by scope then by owner and category, and lists the cross-origin frames and
 * the observed security headers. `inventoryStatus` and `integrityLabel` are
 * the two per-entry judgements the renderers share.
 *
 * report/markdown.ts and report/json.ts are pure formatters over this model.
 * They used to derive it separately and had already drifted: one grouped on
 * `owner / category` and the other on `owner category`, so the same pair of
 * entries could land in different buckets.
 *
 * Limitations: harness scripts are dropped, as everywhere else; a script with
 * no entry lands in the single unapproved group, which is always ordered last.
 */
import { findFrameEntry, findScriptEntry } from '../manifest/match.js';
import {
  APPROVABLE_SCOPES,
  SECURITY_HEADER_NAMES,
  type Manifest,
  type ManifestScript,
  type ObservedScript,
  type Scope,
  type ScriptCategory,
  type SecurityHeaders,
  type Snapshot,
} from '../types.js';

export type InventoryStatus = 'approved' | 'unapproved' | 'stale';

/** stale: the approved hash of a strict (sha256) or structural (structuralHash) entry differs. */
export function inventoryStatus(script: ObservedScript, entry: ManifestScript | undefined): InventoryStatus {
  if (!entry) return 'unapproved';
  if (entry.integrity === 'strict' && entry.sha256 !== undefined && entry.sha256 !== script.sha256) return 'stale';
  if (entry.integrity === 'structural' && entry.structuralHash !== undefined && entry.structuralHash !== script.structuralHash) {
    return 'stale';
  }
  return 'approved';
}

/** What actually assures this entry's body, worded so `track` never reads as "covered". */
export function integrityLabel(entry: ManifestScript | undefined): string {
  if (!entry) return 'none';
  if (entry.kind === 'worker') return 'body not captured (url-only)';
  if (entry.integrity === 'track' || entry.integrity === 'url-only') {
    return `not assured (${entry.integrityMethod}) [${entry.integrity}]`;
  }
  return `${entry.integrity} (${entry.integrityMethod})`;
}

export interface InventoryRow {
  script: ObservedScript;
  entry: ManifestScript | undefined;
  status: InventoryStatus;
}

/** One owner/category bucket within a scope; both fields are null for unapproved scripts. */
export interface InventoryGroup {
  owner: string | null;
  category: ScriptCategory | null;
  rows: InventoryRow[];
}

export interface InventoryScope {
  scope: Scope;
  /** Scripts observed in this scope, before grouping. */
  count: number;
  groups: InventoryGroup[];
}

export interface InventoryFrame {
  url: string;
  scope: Scope;
  status: 'approved' | 'unapproved';
}

export interface Inventory {
  profile: string;
  url: string;
  scannedAt: string;
  runs: number;
  blocked?: Snapshot['blocked'];
  counts: { scripts: number; approved: number; unapproved: number; stale: number };
  /** Non-empty scopes in report order; `harness` never appears. */
  scopes: InventoryScope[];
  frames: InventoryFrame[];
  headers: { policy: Manifest['headers']['policy']; values: SecurityHeaders };
}

/** Unambiguous bucket key: `owner` and `category` cannot run into each other. */
function groupKey(entry: ManifestScript | undefined): string {
  return entry === undefined ? '' : JSON.stringify([entry.owner, entry.category]);
}

function compareGroups(a: InventoryGroup, b: InventoryGroup): number {
  // The unapproved group is always last: it is the one a reviewer must act on,
  // and it has no owner to sort by.
  if (a.owner === null) return b.owner === null ? 0 : 1;
  if (b.owner === null) return -1;
  return `${a.owner}/${a.category}`.localeCompare(`${b.owner}/${b.category}`);
}

export function buildInventory(snapshot: Snapshot, manifest: Manifest): Inventory {
  const rows: InventoryRow[] = snapshot.scripts
    .filter((script) => script.scope !== 'harness')
    .map((script) => {
      const entry = findScriptEntry(manifest, script);
      return { script, entry, status: inventoryStatus(script, entry) };
    });

  const counts = { scripts: rows.length, approved: 0, unapproved: 0, stale: 0 };
  for (const row of rows) counts[row.status] += 1;

  const scopes: InventoryScope[] = [];
  for (const scope of APPROVABLE_SCOPES) {
    const inScope = rows.filter((row) => row.script.scope === scope);
    if (inScope.length === 0) continue;
    const groups = new Map<string, InventoryGroup>();
    for (const row of inScope) {
      const key = groupKey(row.entry);
      let group = groups.get(key);
      if (group === undefined) {
        group = { owner: row.entry?.owner ?? null, category: row.entry?.category ?? null, rows: [] };
        groups.set(key, group);
      }
      group.rows.push(row);
    }
    const ordered = [...groups.values()].sort(compareGroups);
    for (const group of ordered) group.rows.sort((a, b) => a.script.id.localeCompare(b.script.id));
    scopes.push({ scope, count: inScope.length, groups: ordered });
  }

  const frames: InventoryFrame[] = snapshot.frames
    .filter((frame) => !frame.isMain && frame.crossOrigin)
    .map((frame) => ({
      url: frame.url,
      scope: frame.scope,
      status: findFrameEntry(manifest, frame) !== undefined ? 'approved' : 'unapproved',
    }));

  const values: SecurityHeaders = {};
  for (const name of SECURITY_HEADER_NAMES) {
    const value = snapshot.headers[name];
    if (value !== undefined) values[name] = value;
  }

  const inventory: Inventory = {
    profile: snapshot.profile,
    url: snapshot.url,
    scannedAt: snapshot.finishedAt,
    runs: snapshot.runs,
    counts,
    scopes,
    frames,
    headers: { policy: manifest.headers.policy, values },
  };
  if (snapshot.blocked !== undefined) inventory.blocked = snapshot.blocked;
  return inventory;
}
