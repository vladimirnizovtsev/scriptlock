import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDevDependencyCommand, detectPackageManager, RUNNERS, runnerPrefix, scriptlockCommand } from '../../src/runner.js';

/** A directory with none of the lockfiles, so only the user agent can decide. */
function bareDir(): string {
  return mkdtempSync(join(tmpdir(), 'scriptlock-runner-'));
}

function dirWith(...files: string[]): string {
  const dir = bareDir();
  for (const file of files) writeFileSync(join(dir, file), '', 'utf8');
  return dir;
}

// The user agents printed by the three managers on this machine, verbatim.
const NPM_UA = { npm_config_user_agent: 'npm/11.4.2 node/v22.22.0 darwin arm64 workspaces/false' };
const PNPM_UA = { npm_config_user_agent: 'pnpm/10.15.0 npm/? node/v22.22.0 darwin arm64' };
const YARN_UA = { npm_config_user_agent: 'yarn/4.10.3 npm/? node/v22.22.0 darwin arm64' };
const YARN1_UA = { npm_config_user_agent: 'yarn/1.22.18 npm/? node/v22.22.0 darwin arm64' };

describe('detectPackageManager', () => {
  it('reads npm_config_user_agent, which all three managers set', () => {
    const dir = bareDir();
    expect(detectPackageManager(NPM_UA, dir)).toBe('npm');
    expect(detectPackageManager(PNPM_UA, dir)).toBe('pnpm');
    expect(detectPackageManager(YARN_UA, dir)).toBe('yarn');
    expect(detectPackageManager(YARN1_UA, dir)).toBe('yarn');
  });

  it('falls back to the lockfile when the binary was invoked directly', () => {
    expect(detectPackageManager({}, dirWith('pnpm-lock.yaml'))).toBe('pnpm');
    expect(detectPackageManager({}, dirWith('yarn.lock'))).toBe('yarn');
    expect(detectPackageManager({}, dirWith('package-lock.json'))).toBe('npm');
    expect(detectPackageManager({}, dirWith('npm-shrinkwrap.json'))).toBe('npm');
  });

  it('finds the lockfile of a parent directory, for a scan run from a subdirectory', () => {
    const root = dirWith('pnpm-lock.yaml');
    const nested = join(root, 'apps', 'web');
    mkdirSync(nested, { recursive: true });
    expect(detectPackageManager({}, nested)).toBe('pnpm');
  });

  it('prefers the user agent over the lockfile, because the user agent is this run', () => {
    expect(detectPackageManager(PNPM_UA, dirWith('package-lock.json'))).toBe('pnpm');
  });

  it('is undefined when nothing says, and prints npm commands anyway', () => {
    const dir = bareDir();
    expect(detectPackageManager({}, dir)).toBeUndefined();
    expect(runnerPrefix({}, dir)).toBe('npx');
  });

  it('ignores a user agent it does not recognise rather than inventing a runner', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'bun/1.2.0 node/v22.22.0' }, bareDir())).toBeUndefined();
  });
});

describe('scriptlockCommand', () => {
  it('prefixes with the runner each manager actually needs', () => {
    const dir = bareDir();
    expect(scriptlockCommand('scan', NPM_UA, dir)).toBe('npx scriptlock scan');
    expect(scriptlockCommand('scan', PNPM_UA, dir)).toBe('pnpm exec scriptlock scan');
    expect(scriptlockCommand('scan', YARN_UA, dir)).toBe('yarn scriptlock scan');
  });

  it('names the binary alone when there are no arguments', () => {
    expect(scriptlockCommand('', PNPM_UA, bareDir())).toBe('pnpm exec scriptlock');
  });

  it('offers exactly the three runners the install matrix covers', () => {
    expect(RUNNERS).toEqual({ npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn' });
  });
});

describe('addDevDependencyCommand', () => {
  it('uses the add command of each manager', () => {
    const dir = bareDir();
    expect(addDevDependencyCommand('tsx', NPM_UA, dir)).toBe('npm install --save-dev tsx');
    expect(addDevDependencyCommand('tsx', PNPM_UA, dir)).toBe('pnpm add -D tsx');
    expect(addDevDependencyCommand('tsx', YARN_UA, dir)).toBe('yarn add -D tsx');
  });

  it('never tells a pnpm or yarn user to run npm install, which is the bug this release exists for', () => {
    for (const env of [PNPM_UA, YARN_UA]) {
      expect(addDevDependencyCommand('tsx', env, bareDir())).not.toContain('npm install');
    }
  });
});
