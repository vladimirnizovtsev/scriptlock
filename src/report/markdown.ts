/**
 * Markdown rendering for PR comments and GITHUB_STEP_SUMMARY.
 *
 * `renderMarkdown` renders a DiffResult: a heading, a result line, a table of
 * fail and warn events and a collapsed <details> block for info events.
 * `renderInventoryMarkdown` renders the script inventory of a snapshot with
 * its authorisation status against the manifest, grouped by scope, then by
 * owner and category. Hashes are shortened to 12 hex characters.
 * Limitation: table cells are single-line; pipes and newlines are escaped or
 * collapsed. A long free-text message cell is truncated, but an inline code
 * span (an id, a header value, a full CSP) is kept whole so the evidence is
 * not cut off; GitHub tables scroll horizontally. Truncation never leaves an
 * unbalanced backtick.
 */
import { findFrameEntry, findScriptEntry } from '../manifest/match.js';
import {
  SECURITY_HEADER_NAMES,
  type DiffEvent,
  type DiffResult,
  type Manifest,
  type ManifestScript,
  type ObservedScript,
  type Scope,
  type Snapshot,
} from '../types.js';
import { exitCodeMeaning, shortValue } from './text.js';

const SCOPE_ORDER: readonly Scope[] = ['merchant', 'tpsp', 'threeds', 'embedded'];
const MAX_CELL = 200;

function flatten(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function escapeCell(value: string): string {
  // A finished code span (id, header value) is already escaped and balanced;
  // keep it whole so the evidence is not cut mid-value.
  if (value.length > 1 && value.startsWith('`') && value.endsWith('`')) return value;
  let flat = flatten(value);
  if (flat.length > MAX_CELL) flat = `${flat.slice(0, MAX_CELL - 3)}...`;
  // Never leave a code span open across the truncation boundary.
  if (((flat.match(/`/g) ?? []).length) % 2 === 1) flat += '`';
  return flat;
}

function code(value: string): string {
  return `\`${flatten(value).replace(/`/g, "'")}\``;
}

function table(header: string[], rows: string[][]): string[] {
  const out = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const row of rows) out.push(`| ${row.map(escapeCell).join(' | ')} |`);
  return out;
}

function eventRow(event: DiffEvent): string[] {
  let message = event.message;
  if (event.before !== undefined || event.after !== undefined) {
    const before = event.before === undefined ? '(none)' : shortValue(event.before);
    const after = event.after === undefined ? '(none)' : shortValue(event.after);
    if (!(event.before !== undefined && event.message.includes(shortValue(event.before)))) {
      message += ` (before: ${code(before)}, after: ${code(after)})`;
    }
  }
  return [event.type, event.severity, event.scope ?? '', code(event.subject), message];
}

export function renderMarkdown(result: DiffResult): string {
  const lines: string[] = [];
  const { fail, warn, info, totalScripts, merchantScripts, approved } = result.summary;
  lines.push(`## Tessera diff: ${result.profile} (${result.mode})`);
  lines.push('');
  lines.push(`URL: ${result.url}  `);
  lines.push(`Scanned: ${result.scannedAt}  `);
  lines.push(`Scripts: ${totalScripts} observed (${merchantScripts} merchant), ${approved} approved`);
  lines.push('');
  lines.push(
    `**Result: ${fail} fail, ${warn} warn, ${info} info; exit code ${result.exitCode} (${exitCodeMeaning(result.exitCode)}).**`,
  );
  lines.push('');

  const header = ['Type', 'Severity', 'Scope', 'Subject', 'Message'];
  const findings = result.events.filter((e) => e.severity === 'fail' || e.severity === 'warn');
  const infos = result.events.filter((e) => e.severity === 'info');

  if (findings.length === 0) {
    lines.push(result.events.length === 0 ? 'No findings.' : 'No findings at fail or warn severity.');
  } else {
    lines.push(...table(header, findings.map(eventRow)));
  }
  lines.push('');

  if (result.warnings !== undefined && result.warnings.length > 0) {
    lines.push('Warnings:');
    lines.push('');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  if (infos.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>${infos.length} informational event${infos.length === 1 ? '' : 's'}</summary>`);
    lines.push('');
    lines.push(...table(header, infos.map(eventRow)));
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

export type InventoryStatus = 'approved' | 'unapproved' | 'stale';

/** stale: the approved hash of a strict (sha256) or structural (structuralHash) entry differs. */
export function inventoryStatus(script: ObservedScript, entry: ManifestScript | undefined): InventoryStatus {
  if (!entry) return 'unapproved';
  if (entry.integrity === 'strict' && entry.sha256 !== undefined && entry.sha256 !== script.sha256) return 'stale';
  if (
    entry.integrity === 'structural' &&
    entry.structuralHash !== undefined &&
    entry.structuralHash !== script.structuralHash
  ) {
    return 'stale';
  }
  return 'approved';
}

export function integrityLabel(entry: ManifestScript | undefined): string {
  if (!entry) return 'none';
  if (entry.kind === 'worker') return 'body not captured (url-only)';
  if (entry.integrity === 'track' || entry.integrity === 'url-only') {
    return `not assured (source-tracked) [${entry.integrity}]`;
  }
  return `${entry.integrity} (${entry.integrityMethod})`;
}

interface InventoryRow {
  script: ObservedScript;
  entry: ManifestScript | undefined;
  status: InventoryStatus;
}

export function renderInventoryMarkdown(snapshot: Snapshot, manifest: Manifest): string {
  const lines: string[] = [];
  const scripts = snapshot.scripts.filter((s) => s.scope !== 'harness');
  const rows: InventoryRow[] = scripts.map((script) => {
    const entry = findScriptEntry(manifest, script);
    return { script, entry, status: inventoryStatus(script, entry) };
  });
  const counts = { approved: 0, unapproved: 0, stale: 0 };
  for (const row of rows) counts[row.status] += 1;

  lines.push(`## Tessera inventory: ${snapshot.profile}`);
  lines.push('');
  lines.push(`URL: ${snapshot.url}  `);
  lines.push(`Scanned: ${snapshot.finishedAt} (${snapshot.runs} run${snapshot.runs === 1 ? '' : 's'})  `);
  lines.push(
    `Scripts: ${rows.length} observed, ${counts.approved} approved, ${counts.unapproved} unapproved, ${counts.stale} stale`,
  );
  if (snapshot.blocked) {
    lines.push('');
    lines.push(
      `**Warning: a bot-management challenge page was detected (${snapshot.blocked.vendor}); this inventory is unreliable.**`,
    );
  }
  lines.push('');

  const header = ['Script', 'Kind', 'Status', 'Integrity', 'Entity', 'Loaded by'];
  for (const scope of SCOPE_ORDER) {
    const inScope = rows.filter((r) => r.script.scope === scope);
    if (inScope.length === 0) continue;
    lines.push(`### Scope: ${scope} (${inScope.length} script${inScope.length === 1 ? '' : 's'})`);
    lines.push('');
    const groups = new Map<string, InventoryRow[]>();
    for (const row of inScope) {
      const key = row.entry ? `${row.entry.owner} / ${row.entry.category}` : 'unapproved';
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === 'unapproved') return 1;
      if (b === 'unapproved') return -1;
      return a.localeCompare(b);
    });
    for (const key of keys) {
      const list = (groups.get(key) ?? []).slice().sort((a, b) => a.script.id.localeCompare(b.script.id));
      lines.push(`#### ${key === 'unapproved' ? 'Unapproved' : `Owner / category: ${key}`}`);
      lines.push('');
      lines.push(
        ...table(
          header,
          list.map((row) => [
            code(row.script.id),
            row.script.kind,
            row.status,
            integrityLabel(row.entry),
            row.script.entity ? `${row.script.entity.name} (${row.script.entity.category})` : '',
            row.script.loadedBy ? code(row.script.loadedBy) : '',
          ]),
        ),
      );
      lines.push('');
    }
  }

  const frames = snapshot.frames.filter((f) => !f.isMain && f.crossOrigin);
  if (frames.length > 0) {
    lines.push(`### Cross-origin frames (${frames.length})`);
    lines.push('');
    lines.push(
      ...table(
        ['Frame', 'Scope', 'Status'],
        frames.map((frame) => [frame.url, frame.scope, findFrameEntry(manifest, frame) ? 'approved' : 'unapproved']),
      ),
    );
    lines.push('');
  }

  const present = SECURITY_HEADER_NAMES.filter((name) => snapshot.headers[name] !== undefined);
  lines.push(`### Security headers (policy: ${manifest.headers.policy})`);
  lines.push('');
  if (present.length === 0) {
    lines.push('No security headers observed on the main document.');
  } else {
    lines.push(...table(['Header', 'Value'], present.map((name) => [name, code(snapshot.headers[name] ?? '')])));
  }
  lines.push('');
  return lines.join('\n');
}
