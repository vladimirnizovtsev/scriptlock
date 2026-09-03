/**
 * Terminal rendering of a DiffResult with picocolors.
 *
 * Output: a header line, events grouped by severity (fail, warn, info) and a
 * one-line summary that explains the exit code. Colour is on by default when
 * the terminal supports it and can be forced either way with `color`.
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

/** Shortens hex hashes to 12 characters; other values are returned unchanged. */
export function shortValue(value: string): string {
  return isHash(value) ? value.slice(0, 12) : value;
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
  if (event.before !== undefined || event.after !== undefined) {
    const before = event.before === undefined ? '(none)' : shortValue(event.before);
    const after = event.after === undefined ? '(none)' : shortValue(event.after);
    if (!(event.before !== undefined && event.after !== undefined && event.message.includes(shortValue(event.before)))) {
      out.push(`  ${' '.repeat(15)}before: ${before}`);
      out.push(`  ${' '.repeat(15)}after:  ${after}`);
    }
  }
  return out;
}
