/**
 * Which package manager runs this project, and therefore how a command
 * Scriptlock prints has to be typed (DESIGN.md section 8).
 *
 * Scriptlock is installed as a development dependency, so its binary is on no
 * PATH: `scriptlock scan` is `npx scriptlock scan` under npm, `pnpm exec
 * scriptlock scan` under pnpm and `yarn scriptlock scan` under yarn (classic
 * and Berry alike, because scriptlock is a direct dependency with a bin). A
 * printed command that omits the prefix is `command not found` in all three.
 *
 * Detection order: `npm_config_user_agent`, which npm, pnpm and yarn all set on
 * the process they launch, then the lockfile of the nearest directory that has
 * one, then npm. Only the printed text depends on this; nothing Scriptlock does
 * changes with the answer, so a wrong guess costs a reader one edit and never a
 * wrong result.
 *
 * Limitations: a lockfile probe cannot see a manager that writes none, and the
 * user agent is absent when the binary is invoked directly (node_modules/.bin,
 * or a global install), where the npm answer is the fallback.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/** How each manager runs a binary that belongs to the project's dependencies. */
export const RUNNERS: Record<PackageManager, string> = {
  npm: 'npx',
  pnpm: 'pnpm exec',
  yarn: 'yarn',
};

/** Lockfile of each manager, probed when there is no user agent to read. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** Directories walked upwards from the working directory before giving up. */
const MAX_PARENTS = 32;

function fromUserAgent(agent: string | undefined): PackageManager | undefined {
  if (agent === undefined || agent === '') return undefined;
  // "pnpm/10.15.0 npm/? node/v22.22.0 darwin arm64"; the manager is the first token.
  const name = agent.trim().split(/[/\s]/, 1)[0]?.toLowerCase();
  if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name;
  return undefined;
}

function fromLockfile(cwd: string): PackageManager | undefined {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_PARENTS; depth += 1) {
    for (const [file, manager] of LOCKFILES) {
      if (existsSync(path.join(dir, file))) return manager;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The package manager of the project, or undefined when neither the user agent
 * nor a lockfile says. Callers that have to print something use
 * `runnerPrefix`, which falls back to npm.
 */
export function detectPackageManager(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): PackageManager | undefined {
  return fromUserAgent(env['npm_config_user_agent']) ?? fromLockfile(cwd);
}

/** `npx`, `pnpm exec` or `yarn`: what has to precede a project binary. */
export function runnerPrefix(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  return RUNNERS[detectPackageManager(env, cwd) ?? 'npm'];
}

/**
 * A runnable `scriptlock` command line for the detected manager:
 * `scriptlockCommand('scan')` is `pnpm exec scriptlock scan` under pnpm.
 */
export function scriptlockCommand(args: string = '', env?: Record<string, string | undefined>, cwd?: string): string {
  const prefix = runnerPrefix(env ?? process.env, cwd ?? process.cwd());
  return args === '' ? `${prefix} scriptlock` : `${prefix} scriptlock ${args}`;
}

/**
 * How the detected manager adds a development dependency, for the one hint
 * that asks the reader to install something other than scriptlock itself.
 */
export function addDevDependencyCommand(
  packageName: string,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  switch (detectPackageManager(env, cwd) ?? 'npm') {
    case 'pnpm':
      return `pnpm add -D ${packageName}`;
    case 'yarn':
      return `yarn add -D ${packageName}`;
    default:
      return `npm install --save-dev ${packageName}`;
  }
}
