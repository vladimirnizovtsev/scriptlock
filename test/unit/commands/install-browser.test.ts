/**
 * `scriptlock install-browser` resolves the playwright-core that ships inside
 * scriptlock, rather than one found on PATH. That resolution is the whole
 * subcommand: if it points at nothing, or at a different playwright-core than
 * the collector launches, the browser revision installed is not the one the
 * scan needs.
 *
 * Limitation: this asserts the resolution and the argument shape. Whether the
 * install itself works under pnpm and Yarn Berry's PnP is the `install` job in
 * .github/workflows/ci.yml, which runs the command for real.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BROWSERS, installArgs, playwrightCliPath } from '../../../src/commands/install-browser.js';

describe('playwrightCliPath', () => {
  it('resolves to a cli.js that exists', () => {
    const cli = playwrightCliPath();
    expect(cli.endsWith(join('playwright-core', 'cli.js'))).toBe(true);
    expect(existsSync(cli), `${cli} must exist`).toBe(true);
  });

  it('is the same playwright-core the collector imports, so the revision matches', () => {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('playwright-core/package.json');
    expect(playwrightCliPath()).toBe(join(dirname(manifest), 'cli.js'));
  });

  it('goes through package.json, the only package-root path playwright-core exports', () => {
    // `playwright-core/cli.js` is not in that package's `exports` map, so
    // resolving it directly is refused by Node and by Yarn PnP alike.
    const require = createRequire(import.meta.url);
    const exports = (JSON.parse(readFileSync(require.resolve('playwright-core/package.json'), 'utf8')) as { exports?: Record<string, unknown> }).exports ?? {};
    expect(Object.keys(exports)).toContain('./package.json');
    expect(Object.keys(exports)).not.toContain('./cli.js');
  });
});

describe('installArgs', () => {
  it('installs chromium when no browser is named', () => {
    expect(installArgs()).toEqual(['install', 'chromium']);
    expect(installArgs({ browsers: [] })).toEqual(['install', 'chromium']);
    expect(DEFAULT_BROWSERS).toEqual(['chromium']);
  });

  it('passes --with-deps before the browser names, as the playwright CLI expects', () => {
    expect(installArgs({ withDeps: true })).toEqual(['install', '--with-deps', 'chromium']);
  });

  it('passes through the browsers it was given', () => {
    expect(installArgs({ browsers: ['chromium', 'ffmpeg'] })).toEqual(['install', 'chromium', 'ffmpeg']);
  });
});
