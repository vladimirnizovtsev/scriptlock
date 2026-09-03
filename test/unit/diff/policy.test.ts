import { describe, expect, it } from 'vitest';
import {
  CHANGED_SEVERITY,
  DIFF_EVENT_TYPES,
  HEADER_SEVERITY,
  policyRows,
  renderPolicyTable,
  SEVERITY,
  severityFor,
} from '../../../src/diff/policy.js';

describe('severity matrix', () => {
  it('encodes every row of DESIGN.md section 7', () => {
    expect(severityFor('gate', 'blocked')).toBe('fail');
    expect(severityFor('drift', 'blocked')).toBe('fail');
    expect(severityFor('gate', 'new', 'merchant')).toBe('fail');
    expect(severityFor('drift', 'new', 'merchant')).toBe('fail');
    for (const scope of ['tpsp', 'threeds', 'embedded'] as const) {
      expect(severityFor('gate', 'new', scope)).toBe('info');
      expect(severityFor('drift', 'new', scope)).toBe('warn');
    }
    expect(severityFor('gate', 'removed')).toBe('warn');
    expect(severityFor('drift', 'removed')).toBe('warn');
    expect(severityFor('gate', 'changed', 'merchant', 'strict')).toBe('fail');
    expect(severityFor('drift', 'changed', 'merchant', 'strict')).toBe('fail');
    expect(severityFor('gate', 'changed', 'merchant', 'structural')).toBe('fail');
    expect(severityFor('drift', 'changed', 'merchant', 'structural')).toBe('fail');
    expect(severityFor('gate', 'changed', 'merchant', 'track')).toBe('info');
    expect(severityFor('drift', 'changed', 'merchant', 'track')).toBe('info');
    expect(severityFor('gate', 'changed', 'merchant', 'url-only')).toBe('none');
    expect(severityFor('drift', 'changed', 'merchant', 'url-only')).toBe('none');
    expect(severityFor('gate', 'moved')).toBe('fail');
    expect(severityFor('drift', 'moved')).toBe('fail');
    expect(severityFor('gate', 'spoofed')).toBe('fail');
    expect(severityFor('drift', 'spoofed')).toBe('fail');
    expect(severityFor('gate', 'scope-changed')).toBe('warn');
    expect(severityFor('drift', 'scope-changed')).toBe('warn');
    for (const type of ['header-changed', 'header-added', 'header-removed'] as const) {
      expect(severityFor('gate', type, undefined, 'strict')).toBe('fail');
      expect(severityFor('drift', type, undefined, 'strict')).toBe('fail');
      expect(severityFor('gate', type, undefined, 'track')).toBe('info');
      expect(severityFor('drift', type, undefined, 'track')).toBe('info');
      expect(severityFor('gate', type, undefined, 'ignore')).toBe('none');
    }
    expect(severityFor('gate', 'new-frame')).toBe('warn');
    expect(severityFor('drift', 'new-frame')).toBe('warn');
    expect(severityFor('gate', 'removed-frame')).toBe('info');
    expect(severityFor('drift', 'removed-frame')).toBe('warn');
  });

  it('defaults a missing or foreign policy to strict', () => {
    expect(severityFor('gate', 'changed', 'merchant')).toBe('fail');
    expect(severityFor('gate', 'changed', 'merchant', 'ignore')).toBe('fail');
    expect(severityFor('gate', 'header-added')).toBe('fail');
    expect(severityFor('gate', 'header-added', undefined, 'url-only')).toBe('fail');
  });

  it('has a cell for every mode, type and scope class', () => {
    for (const mode of ['gate', 'drift'] as const) {
      for (const type of DIFF_EVENT_TYPES) {
        expect(SEVERITY[mode][type].merchant).toBeDefined();
        expect(SEVERITY[mode][type].other).toBeDefined();
      }
      expect(Object.keys(CHANGED_SEVERITY[mode]).sort()).toEqual(['strict', 'structural', 'track', 'url-only']);
      expect(Object.keys(HEADER_SEVERITY[mode]).sort()).toEqual(['ignore', 'strict', 'track']);
    }
  });

  it('renders a help table that agrees with the lookup', () => {
    const rows = policyRows();
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) {
      expect(row.gate).toBe(severityFor('gate', row.type, row.scope, row.policy));
      expect(row.drift).toBe(severityFor('drift', row.type, row.scope, row.policy));
    }
    const text = renderPolicyTable();
    expect(text).toContain('event');
    expect(text).toContain('gate');
    expect(text).toContain('drift');
    expect(text).toContain('removed-frame');
    expect(text).toContain('not emitted');
    expect(text).toContain('exit code: 2 when blocked');
    expect(text).not.toMatch(/—/);
  });
});
