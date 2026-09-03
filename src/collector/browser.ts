/**
 * Browser launch via playwright-core (DESIGN.md 3.1).
 *
 * Resolution order: `browser.executablePath`, then `browser.channel`. The
 * default channel "chromium" means the Playwright-managed build: in headless
 * mode Playwright picks the headless shell when no channel is passed, so we
 * launch without a channel first and retry with `channel: "chromium"` (the full
 * build, new headless) when the shell is not installed. Other channels
 * ("chrome", "msedge") are passed through unchanged. No stealth patches, no
 * user agent changes beyond the configured override.
 *
 * Limitations: only Chromium-based browsers are supported (CDP is required);
 * the missing-browser and unsupported-channel detection relies on
 * Playwright's error message wording.
 */
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';
import { TesseraError } from '../errors.js';
import type { BrowserConfig } from '../types.js';

export interface LaunchedBrowser {
  browser: Browser;
  /** Channel or executable path actually used, for Vantage.channel. */
  channel: string;
  /** Distribution label for Vantage.browser, e.g. "headless-shell" or "chromium". */
  distribution: string;
}

const INSTALL_HINT = 'npx playwright-core install chromium';
const CHANNEL_HINT = 'Install that browser on this machine, or set browser.channel to chromium, chrome or msedge (or browser.executablePath to a Chromium-based binary)';

function executablePathHint(executablePath: string): string {
  return `Check browser.executablePath in tessera.config.yaml (${executablePath} does not exist or cannot be launched), or remove it to use the Playwright-managed build`;
}

function looksLikeUnsupportedChannel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported .*channel|unknown .*channel/i.test(message);
}

function looksLikeMissingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /executable|does not exist|doesn't exist|not found|not installed|ENOENT/i.test(message);
}

export async function launchBrowser(cfg: BrowserConfig): Promise<LaunchedBrowser> {
  const base: LaunchOptions = { headless: cfg.headless };

  if (cfg.executablePath !== undefined && cfg.executablePath !== '') {
    const browser = await tryLaunch({ ...base, executablePath: cfg.executablePath }, cfg.executablePath, executablePathHint(cfg.executablePath));
    return { browser, channel: cfg.executablePath, distribution: 'executable' };
  }

  const channel = cfg.channel === undefined || cfg.channel === '' ? 'chromium' : cfg.channel;
  if (channel !== 'chromium') {
    const browser = await tryLaunch({ ...base, channel }, channel, CHANNEL_HINT);
    return { browser, channel, distribution: channel };
  }

  // Playwright-managed build: headless shell (headless) or full build (headed).
  try {
    const browser = await chromium.launch(base);
    return { browser, channel, distribution: cfg.headless ? 'headless-shell' : 'chromium' };
  } catch (error) {
    if (!looksLikeMissingBrowser(error)) throw error;
    const browser = await tryLaunch({ ...base, channel: 'chromium' }, channel, INSTALL_HINT, error);
    return { browser, channel, distribution: 'chromium' };
  }
}

/**
 * Launches with `options`; a missing browser (or an unsupported channel) becomes
 * BROWSER_NOT_FOUND with a hint specific to how the browser was resolved.
 */
async function tryLaunch(options: LaunchOptions, what: string, hint: string, previous?: unknown): Promise<Browser> {
  try {
    return await chromium.launch(options);
  } catch (error) {
    if (looksLikeMissingBrowser(error) || (previous !== undefined && looksLikeMissingBrowser(previous))) {
      throw new TesseraError('BROWSER_NOT_FOUND', `Chromium browser "${what}" was not found`, {
        exitCode: 2,
        hint,
        cause: error,
      });
    }
    if (looksLikeUnsupportedChannel(error)) {
      throw new TesseraError('BROWSER_NOT_FOUND', `browser channel "${what}" is not supported by playwright-core: ${errorMessage(error)}`, {
        exitCode: 2,
        hint: CHANNEL_HINT,
        cause: error,
      });
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}

/** Formats Vantage.browser, e.g. "chromium 151.0.7922.34 (headless-shell)". */
export function describeBrowser(launched: LaunchedBrowser): string {
  const name = launched.browser.browserType().name();
  return `${name} ${launched.browser.version()} (${launched.distribution})`;
}
