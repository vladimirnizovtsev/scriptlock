import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interpolateEnv, loadConfig, manifestPathFor, parseConfig } from '../../../src/config/load.js';
import { ScriptlockError } from '../../../src/errors.js';

const MINIMAL = `version: 1\nprofiles:\n  default:\n    url: https://shop.example.com/checkout\n`;

function expectScriptlockError(fn: () => unknown, code: string, messagePart?: string | RegExp): ScriptlockError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ScriptlockError);
  const err = caught as ScriptlockError;
  expect(err.code).toBe(code);
  if (messagePart !== undefined) expect(err.message).toMatch(messagePart);
  return err;
}

describe('env interpolation', () => {
  it('replaces ${VAR} in every string value, including nested maps and arrays', () => {
    const out = interpolateEnv(
      { a: 'x-${ONE}-y', b: { c: ['${TWO}', 7, true], d: null }, e: '${ONE}${TWO}' },
      { ONE: '1', TWO: '2' },
    );
    expect(out).toEqual({ a: 'x-1-y', b: { c: ['2', 7, true], d: null }, e: '12' });
  });

  it('leaves keys alone and does not touch strings without references', () => {
    const out = interpolateEnv({ '${KEY}': 'plain $NOTREF ${}' }, {});
    expect(out).toEqual({ '${KEY}': 'plain $NOTREF ${}' });
  });

  it('names the missing variable and the location', () => {
    const text = `${MINIMAL}browser:\n  extraHeaders:\n    X-Scanner-Token: \${SCRIPTLOCK_SCANNER_TOKEN}\n`;
    const err = expectScriptlockError(() => parseConfig(text, { env: {} }), 'CONFIG_INVALID', /SCRIPTLOCK_SCANNER_TOKEN/);
    expect(err.message).toContain('browser.extraHeaders.X-Scanner-Token');
    expect(err.exitCode).toBe(2);
    expect(err.hint).toContain('SCRIPTLOCK_SCANNER_TOKEN');
  });

  it('substitutes from the given environment before validation', () => {
    const text = `${MINIMAL}browser:\n  extraHeaders:\n    X-Scanner-Token: \${SCRIPTLOCK_SCANNER_TOKEN}\n`;
    const config = parseConfig(text, { env: { SCRIPTLOCK_SCANNER_TOKEN: 'secret' } });
    expect(config.browser.extraHeaders).toEqual({ 'X-Scanner-Token': 'secret' });
  });

  it('uses process.env by default', () => {
    const key = 'SCRIPTLOCK_TEST_INTERPOLATION_VAR';
    process.env[key] = 'https://from-env.example.com/';
    try {
      const config = parseConfig(`version: 1\nprofiles:\n  default:\n    url: \${${key}}\n`);
      expect(config.profiles['default']?.url).toBe('https://from-env.example.com/');
    } finally {
      delete process.env[key];
    }
  });
});

describe('invalid configuration messages', () => {
  it('reports the YAML path and reason for schema violations', () => {
    const text = `version: 1\nbrowser:\n  timeoutMs: soon\nprofiles:\n  default:\n    url: https://shop.example.com/\n    wait: whenever\n`;
    const err = expectScriptlockError(() => parseConfig(text, { path: 'scriptlock.config.yaml' }), 'CONFIG_INVALID');
    expect(err.message).toContain('Invalid configuration in scriptlock.config.yaml');
    expect(err.message).toContain('browser.timeoutMs');
    expect(err.message).toContain('profiles.default.wait');
  });

  it('reports unknown keys', () => {
    const err = expectScriptlockError(() => parseConfig(`${MINIMAL}identitty: {}\n`), 'CONFIG_INVALID');
    expect(err.message).toMatch(/identitty/);
  });

  it('reports malformed YAML, empty files and non-mapping documents', () => {
    expectScriptlockError(() => parseConfig('version: [1', { path: 'x.yaml' }), 'CONFIG_INVALID', /Invalid YAML in x.yaml/);
    expectScriptlockError(() => parseConfig('', { path: 'x.yaml' }), 'CONFIG_INVALID', /empty/);
    expectScriptlockError(() => parseConfig('- 1\n- 2\n'), 'CONFIG_INVALID', /mapping/);
  });

  it('reports a wrong version', () => {
    expectScriptlockError(() => parseConfig('version: 2\nprofiles: {}\n'), 'CONFIG_INVALID', /version/);
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'scriptlock-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws CONFIG_NOT_FOUND with an init hint when nothing exists', async () => {
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
      hint: expect.stringContaining('scriptlock init'),
    });
  });

  it('finds scriptlock.config.yml when .yaml is absent', async () => {
    await writeFile(path.join(dir, 'scriptlock.config.yml'), MINIMAL);
    const { config, path: found } = await loadConfig(dir);
    expect(found).toBe(path.join(dir, 'scriptlock.config.yml'));
    expect(config.profiles['default']?.url).toBe('https://shop.example.com/checkout');
  });

  it('prefers scriptlock.config.yaml over .yml', async () => {
    await writeFile(path.join(dir, 'scriptlock.config.yml'), MINIMAL.replace('checkout', 'yml'));
    await writeFile(path.join(dir, 'scriptlock.config.yaml'), MINIMAL.replace('checkout', 'yaml'));
    const { config, path: found } = await loadConfig(dir);
    expect(found).toBe(path.join(dir, 'scriptlock.config.yaml'));
    expect(config.profiles['default']?.url).toBe('https://shop.example.com/yaml');
  });

  it('honours an explicit path resolved against cwd', async () => {
    await mkdir(path.join(dir, 'conf'));
    await writeFile(path.join(dir, 'conf', 'custom.yaml'), MINIMAL);
    const { path: found } = await loadConfig(dir, 'conf/custom.yaml');
    expect(found).toBe(path.join(dir, 'conf', 'custom.yaml'));
    await expect(loadConfig(dir, 'conf/missing.yaml')).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });

  it('surfaces validation errors with the file path', async () => {
    await writeFile(path.join(dir, 'scriptlock.config.yaml'), 'version: 1\nprofiles:\n  default:\n    url: 42\n');
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining(path.join(dir, 'scriptlock.config.yaml')),
    });
  });
});

describe('manifestPathFor', () => {
  const cwd = path.resolve('/work/site');
  it('uses scriptlock.lock.yaml for the default profile', () => {
    expect(manifestPathFor('default', {}, cwd)).toBe(path.join(cwd, 'scriptlock.lock.yaml'));
  });
  it('uses scriptlock.<profile>.lock.yaml for other profiles', () => {
    expect(manifestPathFor('checkout', {}, cwd)).toBe(path.join(cwd, 'scriptlock.checkout.lock.yaml'));
  });
  it('honours profile.manifest, relative to cwd or absolute', () => {
    expect(manifestPathFor('checkout', { manifest: 'locks/co.yaml' }, cwd)).toBe(path.join(cwd, 'locks', 'co.yaml'));
    const absolute = path.resolve('/elsewhere/lock.yaml');
    expect(manifestPathFor('default', { manifest: absolute }, cwd)).toBe(absolute);
  });
});
