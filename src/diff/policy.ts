/**
 * Severity matrix for the diff (DESIGN.md section 7), kept as plain data so
 * the CLI can print it in --help and the diff module can look it up.
 *
 * Three tables cover the matrix: SEVERITY for events whose severity depends
 * only on mode and scope class, CHANGED_SEVERITY for `changed` (depends on
 * the entry's integrity policy) and HEADER_SEVERITY for header events
 * (depends on the manifest headers policy). `severityFor` combines them.
 * Limitation: the scope dimension only distinguishes merchant from every
 * other scope, which is all the v1 matrix needs.
 */
import type { DiffEventType, DiffMode, HeaderPolicy, IntegrityPolicy, Scope, Severity } from '../types.js';

/** A matrix cell: a severity, or `none` when the event is not emitted. */
export type PolicySeverity = Severity | 'none';

/** Scope classes the matrix distinguishes. */
export type ScopeClass = 'merchant' | 'other';

export const DIFF_MODES: readonly DiffMode[] = ['gate', 'drift'];

export const DIFF_EVENT_TYPES: readonly DiffEventType[] = [
  'blocked',
  'new',
  'removed',
  'changed',
  'moved',
  'spoofed',
  'scope-changed',
  'header-changed',
  'header-added',
  'header-removed',
  'new-frame',
  'removed-frame',
];

export function scopeClassOf(scope: Scope | undefined): ScopeClass {
  return scope === 'merchant' ? 'merchant' : 'other';
}

type ScopeTable = Record<ScopeClass, PolicySeverity>;

function both(severity: PolicySeverity): ScopeTable {
  return { merchant: severity, other: severity };
}

/**
 * SEVERITY[mode][eventType][scopeClass]. For `changed` and the header events
 * the cell holds the value for the strictest policy (`strict`); the policy
 * specific tables below refine it.
 */
export const SEVERITY: Record<DiffMode, Record<DiffEventType, ScopeTable>> = {
  gate: {
    blocked: both('fail'),
    new: { merchant: 'fail', other: 'info' },
    removed: both('warn'),
    changed: both('fail'),
    moved: both('fail'),
    spoofed: both('fail'),
    'scope-changed': both('warn'),
    'header-changed': both('fail'),
    'header-added': both('fail'),
    'header-removed': both('fail'),
    'new-frame': both('warn'),
    'removed-frame': both('info'),
  },
  drift: {
    blocked: both('fail'),
    new: { merchant: 'fail', other: 'warn' },
    removed: both('warn'),
    changed: both('fail'),
    moved: both('fail'),
    spoofed: both('fail'),
    'scope-changed': both('warn'),
    'header-changed': both('fail'),
    'header-added': both('fail'),
    'header-removed': both('fail'),
    'new-frame': both('warn'),
    'removed-frame': both('warn'),
  },
};

/** Severity of `changed` per integrity policy; `none` means not emitted. */
export const CHANGED_SEVERITY: Record<DiffMode, Record<IntegrityPolicy, PolicySeverity>> = {
  gate: { strict: 'fail', structural: 'fail', track: 'info', 'url-only': 'none' },
  drift: { strict: 'fail', structural: 'fail', track: 'info', 'url-only': 'none' },
};

/** Severity of header-changed / header-added / header-removed per headers policy. */
export const HEADER_SEVERITY: Record<DiffMode, Record<HeaderPolicy, PolicySeverity>> = {
  gate: { strict: 'fail', track: 'info', ignore: 'none' },
  drift: { strict: 'fail', track: 'info', ignore: 'none' },
};

const INTEGRITY_POLICIES: readonly IntegrityPolicy[] = ['strict', 'structural', 'track', 'url-only'];
const HEADER_POLICIES: readonly HeaderPolicy[] = ['strict', 'track', 'ignore'];

function isIntegrityPolicy(value: unknown): value is IntegrityPolicy {
  return typeof value === 'string' && (INTEGRITY_POLICIES as readonly string[]).includes(value);
}

function isHeaderPolicy(value: unknown): value is HeaderPolicy {
  return typeof value === 'string' && (HEADER_POLICIES as readonly string[]).includes(value);
}

export function isHeaderEvent(type: DiffEventType): boolean {
  return type === 'header-changed' || type === 'header-added' || type === 'header-removed';
}

/**
 * Looks up the severity of an event. `policy` is the entry's integrity policy
 * for `changed` and the manifest headers policy for header events; it is
 * ignored for every other type. A missing policy defaults to `strict`.
 */
export function severityFor(
  mode: DiffMode,
  type: DiffEventType,
  scope?: Scope,
  policy?: IntegrityPolicy | HeaderPolicy,
): PolicySeverity {
  if (type === 'changed') {
    return CHANGED_SEVERITY[mode][isIntegrityPolicy(policy) ? policy : 'strict'];
  }
  if (isHeaderEvent(type)) {
    return HEADER_SEVERITY[mode][isHeaderPolicy(policy) ? policy : 'strict'];
  }
  return SEVERITY[mode][type][scopeClassOf(scope)];
}

/** One human-readable row of the matrix, resolved against the tables above. */
export interface PolicyRow {
  type: DiffEventType;
  condition: string;
  scope?: Scope;
  policy?: IntegrityPolicy | HeaderPolicy;
  gate: PolicySeverity;
  drift: PolicySeverity;
}

interface RowSpec {
  type: DiffEventType;
  condition: string;
  scope?: Scope;
  policy?: IntegrityPolicy | HeaderPolicy;
}

const ROW_SPECS: readonly RowSpec[] = [
  { type: 'blocked', condition: 'challenge page detected (exit code 2)' },
  { type: 'new', condition: 'no entry, scope merchant', scope: 'merchant' },
  { type: 'new', condition: 'no entry, scope tpsp / threeds / embedded', scope: 'tpsp' },
  { type: 'removed', condition: 'entry not observed in any run' },
  { type: 'changed', condition: 'policy strict, sha256 differs', policy: 'strict' },
  { type: 'changed', condition: 'policy structural, structuralHash differs', policy: 'structural' },
  { type: 'changed', condition: 'policy track, sha256 differs from approved and last seen', policy: 'track' },
  { type: 'changed', condition: 'policy url-only', policy: 'url-only' },
  { type: 'moved', condition: 'no entry for id, body hash equals an approved strict/structural entry' },
  { type: 'spoofed', condition: 'sourceURL claims a manifest id, real id has no entry' },
  { type: 'scope-changed', condition: 'entry scope differs from observed scope' },
  { type: 'header-changed', condition: 'headers policy strict (also header-added, header-removed)', policy: 'strict' },
  { type: 'header-changed', condition: 'headers policy track (also header-added, header-removed)', policy: 'track' },
  { type: 'header-changed', condition: 'headers policy ignore', policy: 'ignore' },
  { type: 'new-frame', condition: 'cross-origin frame with no frame entry' },
  { type: 'removed-frame', condition: 'frame entry not observed' },
];

export function policyRows(): PolicyRow[] {
  return ROW_SPECS.map((spec) => {
    const row: PolicyRow = {
      type: spec.type,
      condition: spec.condition,
      gate: severityFor('gate', spec.type, spec.scope, spec.policy),
      drift: severityFor('drift', spec.type, spec.scope, spec.policy),
    };
    if (spec.scope !== undefined) row.scope = spec.scope;
    if (spec.policy !== undefined) row.policy = spec.policy;
    return row;
  });
}

function cell(value: PolicySeverity): string {
  return value === 'none' ? 'not emitted' : value;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Plain-text table of the matrix for `--help`. */
export function renderPolicyTable(): string {
  const rows = policyRows();
  const header = ['event', 'condition', 'gate', 'drift'];
  const table = rows.map((row) => [row.type, row.condition, cell(row.gate), cell(row.drift)]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] ?? c.length))).join('  ');
  const out = [line(header), ...table.map(line)];
  out.push('');
  out.push('exit code: 2 when blocked, 1 when any event is fail, 0 otherwise.');
  out.push('gate is meant for deploy pipelines; drift for the scheduled run (broader).');
  return out.join('\n');
}
