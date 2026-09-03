/**
 * Markdown rendering for PR comments and GITHUB_STEP_SUMMARY.
 *
 * `renderMarkdown` renders a DiffResult: a heading, a result line, a table of
 * fail and warn events, the hints (each a sentence followed by its command in
 * an indented code block) and a collapsed <details> block for info events.
 * `renderInventoryMarkdown` renders the script inventory of a snapshot with
 * its authorisation status against the manifest, grouped by scope, then by
 * owner and category. Hashes are shortened to 12 hex characters.
 * Limitation: table cells are single-line; pipes and newlines are escaped or
 * collapsed. A long free-text message cell is truncated, but an inline code
 * span (an id, a header value, a full CSP) is kept whole so the evidence is
 * not cut off; GitHub tables scroll horizontally. Truncation never leaves an
 * unbalanced backtick.
 */
import { SECURITY_HEADER_NAMES, type DiffEvent, type DiffResult, type Manifest, type Snapshot } from '../types.js';
import { buildInventory, integrityLabel } from './inventory.js';
import { eventValues, exitCodeMeaning } from './text.js';

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
  const values = eventValues(event);
  const message = values === undefined ? event.message : `${event.message} (before: ${code(values.before)}, after: ${code(values.after)})`;
  return [event.type, event.severity, event.scope ?? '', code(event.subject), message];
}

export function renderMarkdown(result: DiffResult): string {
  const lines: string[] = [];
  const { fail, warn, info, totalScripts, merchantScripts, approved } = result.summary;
  lines.push(`## Scriptlock diff: ${result.profile} (${result.mode})`);
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

  if (result.hints !== undefined && result.hints.length > 0) {
    lines.push(`### Hints (${result.hints.length})`);
    lines.push('');
    for (const hint of result.hints) {
      const [first = '', ...rest] = hint.split('\n');
      lines.push(flatten(first));
      if (rest.length > 0) {
        lines.push('');
        // Indented code block: renders as code without backticks, so a command
        // containing them cannot unbalance a fence.
        for (const line of rest) lines.push(`    ${line}`);
      }
      lines.push('');
    }
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

export function renderInventoryMarkdown(snapshot: Snapshot, manifest: Manifest): string {
  const inventory = buildInventory(snapshot, manifest);
  const { counts } = inventory;
  const lines: string[] = [];

  lines.push(`## Scriptlock inventory: ${inventory.profile}`);
  lines.push('');
  lines.push(`URL: ${inventory.url}  `);
  lines.push(`Scanned: ${inventory.scannedAt} (${inventory.runs} run${inventory.runs === 1 ? '' : 's'})  `);
  lines.push(
    `Scripts: ${counts.scripts} observed, ${counts.approved} approved, ${counts.unapproved} unapproved, ${counts.stale} stale`,
  );
  if (inventory.blocked) {
    lines.push('');
    lines.push(
      `**Warning: a bot-management challenge page was detected (${inventory.blocked.vendor}); this inventory is unreliable.**`,
    );
  }
  lines.push('');

  const header = ['Script', 'Kind', 'Status', 'Integrity', 'Entity', 'Loaded by'];
  for (const section of inventory.scopes) {
    lines.push(`### Scope: ${section.scope} (${section.count} script${section.count === 1 ? '' : 's'})`);
    lines.push('');
    for (const group of section.groups) {
      lines.push(`#### ${group.owner === null ? 'Unapproved' : `Owner / category: ${group.owner} / ${group.category}`}`);
      lines.push('');
      lines.push(
        ...table(
          header,
          group.rows.map((row) => [
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

  if (inventory.frames.length > 0) {
    lines.push(`### Cross-origin frames (${inventory.frames.length})`);
    lines.push('');
    lines.push(...table(['Frame', 'Scope', 'Status'], inventory.frames.map((frame) => [frame.url, frame.scope, frame.status])));
    lines.push('');
  }

  const present = SECURITY_HEADER_NAMES.filter((name) => inventory.headers.values[name] !== undefined);
  lines.push(`### Security headers (policy: ${inventory.headers.policy})`);
  lines.push('');
  if (present.length === 0) {
    lines.push('No security headers observed on the main document.');
  } else {
    lines.push(...table(['Header', 'Value'], present.map((name) => [name, code(inventory.headers.values[name] ?? '')])));
  }
  lines.push('');
  return lines.join('\n');
}
