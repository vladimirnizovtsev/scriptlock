/**
 * Guards over the commands the documentation and the CLI tell a reader to run.
 *
 * The defect class: 0.2.1 shipped an install section that assumed npm, and the
 * draft of this release "fixed" it with `pnpm exec playwright-core install chromium`
 * and `yarn playwright-core install chromium`, neither of which exists —
 * playwright-core is a transitive dependency, and pnpm and Yarn Berry link no
 * bin for one. Both shipped green, because nothing here ever executed a
 * documented command.
 *
 * These assertions are the cheap half: every command in the README's install
 * blocks, and every command the CLI prints for the reader to run, must be one
 * of a small set of forms. The expensive half — actually running them under
 * npm, pnpm, Yarn Classic and Yarn Berry — is the `install` job in
 * .github/workflows/ci.yml, and that is the one that proves the set is right.
 *
 * Limitation: an allowlist can only reject a form nobody verified. It cannot
 * tell that a listed form stopped working.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installHint } from '../../src/collector/browser.js';
import { configTemplate } from '../../src/commands/init.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const exampleConfig = readFileSync(join(repoRoot, 'examples', 'scriptlock.config.yaml'), 'utf8');

/**
 * Every install command this project may print, verified end to end by the
 * `install` job in CI. Adding a line here without adding it there is how the
 * draft happened.
 */
const VERIFIED_INSTALL_COMMANDS = new Set([
  'npm install --save-dev scriptlock',
  'pnpm add -D scriptlock',
  'yarn add -D scriptlock',
  'npx scriptlock install-browser',
  'pnpm exec scriptlock install-browser',
  'yarn scriptlock install-browser',
]);

const PNPM_UA = { npm_config_user_agent: 'pnpm/10.15.0 npm/? node/v22.22.0' };
const YARN_UA = { npm_config_user_agent: 'yarn/4.10.3 npm/? node/v22.22.0' };
const NPM_UA = { npm_config_user_agent: 'npm/11.4.2 node/v22.22.0' };

/** The fenced ```sh blocks of the README's "1. Install" step. */
function installBlocks(): string[] {
  const start = readme.indexOf('### 1. Install');
  const end = readme.indexOf('### 2. ', start);
  expect(start, 'the README needs its install step').toBeGreaterThan(-1);
  expect(end, 'the install step needs a following step').toBeGreaterThan(start);
  const section = readme.slice(start, end);
  return [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

describe('README install instructions', () => {
  const blocks = installBlocks();

  it('shows a block per package manager', () => {
    expect(blocks.length).toBe(3);
  });

  it('gives only commands the install matrix in CI actually runs', () => {
    const commands = blocks.flatMap((block) => block.split('\n').map((line) => line.trim()).filter((line) => line !== ''));
    expect(commands.length).toBe(6);
    for (const command of commands) {
      expect(VERIFIED_INSTALL_COMMANDS.has(command), `${command} is not a verified install command`).toBe(true);
    }
  });

  it('never asks pnpm or yarn to run playwright-core, which is not a command there', () => {
    // The exact regression this release exists to prevent: playwright-core is a
    // transitive dependency, so only npm and Yarn Classic put a bin on the path.
    const docs = [readme, exampleConfig, configTemplate(), readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8')];
    for (const text of docs) {
      const offenders = [...text.matchAll(/^.*\b(?:pnpm exec|pnpm dlx|yarn|yarn dlx)\s+playwright-core\b.*$/gm)].map((m) => m[0]);
      expect(offenders).toEqual([]);
    }
  });

  it('covers every command with the runner prefix the walkthrough promises', () => {
    for (const prefix of ['npx scriptlock', 'pnpm exec scriptlock', 'yarn scriptlock']) {
      expect(readme, `the walkthrough must say how ${prefix} is typed`).toContain(prefix);
    }
  });
});

describe('the missing-browser hint', () => {
  it('names one command, correct for the detected manager', () => {
    expect(installHint(NPM_UA, repoRoot)).toBe('Install it with "npx scriptlock install-browser"');
    expect(installHint(PNPM_UA, repoRoot)).toBe('Install it with "pnpm exec scriptlock install-browser"');
    expect(installHint(YARN_UA, repoRoot)).toBe('Install it with "yarn scriptlock install-browser"');
  });

  it('prints a command the install matrix verified, and no other', () => {
    for (const env of [NPM_UA, PNPM_UA, YARN_UA]) {
      const command = /"([^"]+)"/.exec(installHint(env, repoRoot))?.[1];
      expect(command, 'the hint must quote exactly one command').toBeDefined();
      expect(VERIFIED_INSTALL_COMMANDS.has(command as string), `${String(command)} is not verified`).toBe(true);
    }
  });

  it('does not send the reader back to playwright-core', () => {
    for (const env of [NPM_UA, PNPM_UA, YARN_UA]) {
      expect(installHint(env, repoRoot)).not.toContain('playwright-core');
    }
  });
});

describe('the annotated configuration', () => {
  it('names the same browser install command in the template and in the example', () => {
    // Two copies of the same sentence drifted apart once already: the template
    // was updated and examples/scriptlock.config.yaml was not, while
    // the README points readers at the example as the complete annotated one.
    const command = /`([^`]*install-browser[^`]*)`/.exec(configTemplate())?.[1];
    expect(command, 'the init template must name the browser install command').toBeDefined();
    expect(exampleConfig).toContain(`\`${String(command)}\``);
  });
});
