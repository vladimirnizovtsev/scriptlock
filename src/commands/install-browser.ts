/**
 * `scriptlock install-browser` (DESIGN.md section 8): install the Chromium build
 * this Scriptlock drives, using the `playwright-core` that ships inside the
 * Scriptlock package rather than one found on PATH.
 *
 * Why this exists as a subcommand. `playwright-core` is a transitive dependency
 * of Scriptlock, and only npm and Yarn 1 hoist a transitive bin into
 * `node_modules/.bin`: under pnpm and under Yarn Berry `playwright-core` is not
 * a command at all, so the documented `pnpm exec playwright-core install
 * chromium` cannot run. Resolving the CLI from Scriptlock's own module graph
 * works under every layout — npm, pnpm's symlinked store, Yarn Berry's PnP —
 * and pins the browser revision to the `playwright-core` that will launch it,
 * which a separately installed `playwright-core` does not.
 *
 * Limitations: the child process inherits stdio, so the progress output is
 * Playwright's own; `--with-deps` installs operating system packages and is
 * Linux-only (a no-op elsewhere) and needs root; the exit code of a failed
 * install is reported as 2 (a run error), not passed through verbatim.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ScriptlockError } from '../errors.js';
import type { CommandContext } from './scan.js';

/** Installed when the command is given no browser names. */
export const DEFAULT_BROWSERS = ['chromium'] as const;

export interface InstallBrowserOptions {
  /** Browsers to install; defaults to `chromium`. */
  browsers?: readonly string[] | undefined;
  /** Also install the operating system dependencies (Linux, needs root). */
  withDeps?: boolean | undefined;
}

export interface InstallBrowserResult {
  /** Absolute path of the playwright-core CLI that was run. */
  cli: string;
  /** Arguments passed to it, after the script path. */
  args: string[];
  /** 0 on success, 2 when the install failed. */
  exitCode: 0 | 2;
}

/**
 * Absolute path of the `cli.js` of the `playwright-core` that Scriptlock
 * launches. Resolved through `playwright-core/package.json`, which is the only
 * entry of that package's `exports` map that leads to the package root:
 * `playwright-core/cli.js` is not exported and would be refused.
 */
export function playwrightCliPath(from: string | URL = import.meta.url): string {
  const require = createRequire(from);
  let manifest: string;
  try {
    manifest = require.resolve('playwright-core/package.json');
  } catch (error) {
    throw new ScriptlockError('UNSUPPORTED', 'playwright-core was not found next to scriptlock', {
      exitCode: 2,
      hint: 'Reinstall scriptlock; playwright-core is one of its dependencies and is not optional',
      cause: error,
    });
  }
  return path.join(path.dirname(manifest), 'cli.js');
}

/** Arguments for the playwright-core CLI, after the script path. */
export function installArgs(opts: InstallBrowserOptions = {}): string[] {
  const browsers = opts.browsers === undefined || opts.browsers.length === 0 ? [...DEFAULT_BROWSERS] : [...opts.browsers];
  return ['install', ...(opts.withDeps === true ? ['--with-deps'] : []), ...browsers];
}

/**
 * Runs the bundled playwright-core CLI as a child of this process. The child
 * inherits the environment, which is what carries Yarn Berry's PnP runtime in
 * `NODE_OPTIONS` when Scriptlock itself was started by `yarn`.
 */
export async function runInstallBrowser(ctx: CommandContext, opts: InstallBrowserOptions = {}): Promise<InstallBrowserResult> {
  const cli = playwrightCliPath();
  const args = installArgs(opts);
  ctx.err(`installing ${args.filter((arg) => !arg.startsWith('-') && arg !== 'install').join(', ')} with ${cli}`);

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (status === null) {
        reject(new Error(`playwright-core install was terminated by ${signal ?? 'a signal'}`));
        return;
      }
      resolve(status);
    });
  }).catch((error: unknown) => {
    throw new ScriptlockError('UNSUPPORTED', `could not run playwright-core install: ${error instanceof Error ? error.message : String(error)}`, {
      exitCode: 2,
      cause: error,
    });
  });

  if (code !== 0) {
    throw new ScriptlockError('BROWSER_NOT_FOUND', `playwright-core install exited with code ${code}`, {
      exitCode: 2,
      hint:
        process.platform === 'linux' && opts.withDeps !== true
          ? 'On Linux the browser also needs system libraries: re-run with --with-deps (as root), or install them from your distribution'
          : 'Check the output above; a proxy or an offline machine needs PLAYWRIGHT_DOWNLOAD_HOST or a pre-seeded PLAYWRIGHT_BROWSERS_PATH',
    });
  }
  ctx.out('browser installed');
  return { cli, args, exitCode: 0 };
}
