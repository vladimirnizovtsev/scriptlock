/**
 * Terminal rendering of a DiffResult with picocolors, and the plain-text
 * building blocks every terminal report shares (DESIGN.md section 2 assigns
 * terminal output to this module).
 *
 * Output: a header line, events grouped by severity (fail, warn, info), any
 * matching warnings, the hints (a suggestion sentence and the command to
 * copy, indented under it) and a one-line summary that explains the exit code.
 * Colour is on by default when the terminal supports it and can be forced
 * either way with `color`.
 *
 * Also owns `renderColumns` (aligned columns for the scan summary and the
 * severity matrix) and `eventValues` (whether an event prints its before/after
 * pair), so the terminal and markdown reports cannot drift apart on that rule.
 * Limitation: no column wrapping; long ids are printed as-is.
 */
import pc from 'picocolors';
import type { DiffEvent, DiffResult, Severity } from '../types.js';

export interface TextOptions {
  /** Force colours on or off. Defaults to picocolors' terminal detection. */
  color?: boolean;
}

const ORDER: readonly Severity[] = ['fail', 'warn', 'info'];

function isHash(value: string): boolean {
  return /^[a-f0-9]{32,}$/i.test(value);
}

/**
 * Shortens hex hashes to 12 characters; other values are returned unchanged.
 * Must agree with `shortHash` in diff/diff.ts on hex input: `eventValues` asks
 * whether an event message already carries the value, and the message was
 * built with that function.
 */
export function shortValue(value: string): string {
  return isHash(value) ? value.slice(0, 12) : value;
}

/**
 * The before/after pair a report prints under an event, or undefined when the
 * event message already states the change and repeating it would be noise.
 * One rule for every renderer: written twice, the text and markdown reports
 * drifted apart on it.
 */
export function eventValues(event: Pick<DiffEvent, 'message' | 'before' | 'after'>): { before: string; after: string } | undefined {
  if (event.before === undefined && event.after === undefined) return undefined;
  if (event.before !== undefined && event.after !== undefined && event.message.includes(shortValue(event.before))) return undefined;
  return {
    before: event.before === undefined ? '(none)' : shortValue(event.before),
    after: event.after === undefined ? '(none)' : shortValue(event.after),
  };
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (text.length >= width) return text;
  const fill = ' '.repeat(width - text.length);
  return align === 'left' ? text + fill : fill + text;
}

/** Renders aligned columns; numeric cells are right-aligned and the last cell is never padded. */
export function renderColumns(header: readonly string[], rows: readonly (readonly string[])[], indent: string = '  '): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[], isHeader: boolean): string =>
    indent +
    cells
      .map((cell, i) => {
        const width = widths[i] ?? cell.length;
        const numeric = !isHeader && /^\d+$/.test(cell);
        return i === cells.length - 1 && !numeric ? cell : pad(cell, width, numeric ? 'right' : 'left');
      })
      .join('  ')
      .trimEnd();
  return [line(header, true), ...rows.map((row) => line(row, false))];
}

export function exitCodeMeaning(code: DiffResult['exitCode']): string {
  switch (code) {
    case 0:
      return 'clean';
    case 1:
      return 'findings at fail severity';
    case 2:
      return 'scan blocked or run error';
    default:
      return 'unknown';
  }
}

export function renderText(result: DiffResult, opts: TextOptions = {}): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const paint: Record<Severity, (s: string) => string> = { fail: c.red, warn: c.yellow, info: c.cyan };
  const lines: string[] = [];

  lines.push(`${c.bold('scriptlock diff')} (${result.mode}) ${result.url}`);
  lines.push(
    c.dim(
      `profile: ${result.profile}, scanned: ${result.scannedAt}, scripts: ${result.summary.totalScripts} (${result.summary.merchantScripts} merchant), approved: ${result.summary.approved}`,
    ),
  );
  lines.push('');

  if (result.events.length === 0) {
    lines.push(c.green('clean: no findings'));
  }

  for (const severity of ORDER) {
    const group = result.events.filter((e) => e.severity === severity);
    if (group.length === 0) continue;
    lines.push(paint[severity](c.bold(`${severity.toUpperCase()} (${group.length})`)));
    for (const event of group) lines.push(...renderEvent(event, paint[severity]));
    lines.push('');
  }

  if (result.warnings !== undefined && result.warnings.length > 0) {
    lines.push(c.yellow(c.bold(`WARNINGS (${result.warnings.length})`)));
    for (const warning of result.warnings) lines.push(`  ${warning}`);
    lines.push('');
  }

  if (result.hints !== undefined && result.hints.length > 0) {
    lines.push(c.cyan(c.bold(`HINTS (${result.hints.length})`)));
    for (const hint of result.hints) {
      const [first = '', ...rest] = hint.split('\n');
      lines.push(`  ${first}`);
      for (const line of rest) lines.push(`    ${c.cyan(line)}`);
    }
    lines.push('');
  }

  const { fail, warn, info } = result.summary;
  const summary = `summary: ${fail} fail, ${warn} warn, ${info} info; exit code ${result.exitCode} (${exitCodeMeaning(result.exitCode)})`;
  lines.push(result.exitCode === 0 ? c.green(summary) : result.exitCode === 1 ? c.red(summary) : c.magenta(summary));
  return lines.join('\n') + '\n';
}

function renderEvent(event: DiffEvent, paint: (s: string) => string): string[] {
  const label = event.type.padEnd(15);
  const scope = event.scope ? ` [${event.scope}]` : '';
  const out = [`  ${paint(label)}${event.subject}${scope}`];
  out.push(`  ${' '.repeat(15)}${event.message}`);
  const values = eventValues(event);
  if (values !== undefined) {
    out.push(`  ${' '.repeat(15)}before: ${values.before}`);
    out.push(`  ${' '.repeat(15)}after:  ${values.after}`);
  }
  return out;
}
