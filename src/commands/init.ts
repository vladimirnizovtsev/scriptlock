/**
 * `tessera init` (DESIGN.md section 8): write an annotated tessera.config.yaml
 * with a single "default" profile into the working directory. The template is
 * validated with the configuration schema before it is written, so `init`
 * never produces a file that `loadConfig` would reject.
 *
 * Limitations: refuses to overwrite an existing tessera.config.yaml or .yml
 * unless `force` is set; the profile URL is the only value taken from the
 * command line.
 */
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE_NAMES, parseConfig } from '../config/load.js';
import { DEFAULT_PROFILE_URL, DEFAULT_SETTLE_MS, DEFAULT_TIMEOUT_MS, DEFAULT_VIEWPORT } from '../config/schema.js';
import { TesseraError } from '../errors.js';
import type { CommandContext } from './scan.js';

export interface InitCommandOptions {
  /** URL of the default profile. */
  url?: string | undefined;
  /** Overwrite an existing configuration file. */
  force?: boolean | undefined;
}

export interface InitCommandResult {
  /** Absolute path of the written configuration. */
  path: string;
  content: string;
}

/** The annotated configuration written by `tessera init`. */
export function configTemplate(url: string = DEFAULT_PROFILE_URL): string {
  return `# Tessera configuration. Documentation: https://github.com/vladimirnizovtsev/tessera#configuration
# Every \${VAR} in a string value is replaced from the environment when the file is loaded;
# a missing variable is a configuration error that names the variable.
version: 1

browser:
  # Playwright channel: "chromium" (the Playwright-managed build, installed with
  # \`npx playwright-core install chromium\`), "chrome" or "msedge". Or set executablePath
  # to a Chromium-based binary; it overrides channel.
  channel: chromium
  headless: true
  viewport: { width: ${DEFAULT_VIEWPORT.width}, height: ${DEFAULT_VIEWPORT.height} }
  # Navigation and step timeout in milliseconds.
  timeoutMs: ${DEFAULT_TIMEOUT_MS}
  # Sent to the profile host and its subdomains only, matched in an allow rule of your bot
  # management. Add extraHeadersHosts (host globs, or "*") to send them to more hosts. No
  # stealth patches. The token is never sent to third-party script hosts or provider iframes.
  # extraHeaders:
  #   X-Scanner-Token: \${TESSERA_SCANNER_TOKEN}
  # extraHeadersHosts: []

identity:
  # Query parameters removed before identity is computed, in addition to the built-in
  # cache busters (v, ver, version, cb, _, t, ts, timestamp, rnd, rand, random, nocache,
  # cache, h, hash, bust, _t, _v).
  stripQuery: []
  # Query parameters kept even if they look like cache busters.
  keepQuery: []
  # Replace hash-like path tokens with [hash]: /assets/app.3f9c2a1b.js -> /assets/app.[hash].js
  collapseHashes: true

scope:
  # Host globs of payment provider frames, added to the built-ins (Stripe, Adyen, PayPal,
  # Braintree, Checkout.com, Klarna, Mollie, Square, Google Pay, Apple Pay and others).
  tpsp: []
  # Host globs of 3-D Secure / ACS frames, added to the built-ins.
  threeds: []

# Integrity policy applied by \`tessera approve\` when --integrity is not given.
integrity:
  firstParty: strict # host equals the main-frame host or a subdomain of it
  thirdParty: track # everything else; body changes are recorded, never fail
  inline: structural # literals are masked, code shape is enforced
  eval: structural

profiles:
  # Manifest: tessera.lock.yaml. Stop at the rendered payment form; never submit a card.
  default:
    url: ${JSON.stringify(url)}
    # Optional flow: a list of steps (goto, click, fill, select, waitFor, wait, press,
    # screenshot) or the path of a module exporting \`default async (page) => void\`.
    # steps:
    #   - goto: /checkout
    #   - waitFor: "#payment-element iframe"
    wait: networkidle # load | domcontentloaded | networkidle | commit
    settleMs: ${DEFAULT_SETTLE_MS} # idle time after the last step, to catch late tags
    runs: 1 # scans unioned per run; absence must hold in all runs
    history: false # keep snapshots and diffs under .tessera/history/default/
`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(ctx: CommandContext, opts: InitCommandOptions = {}): Promise<InitCommandResult> {
  const target = path.join(ctx.cwd, 'tessera.config.yaml');
  if (opts.force !== true) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(ctx.cwd, name);
      if (await exists(candidate)) {
        throw new TesseraError('UNSUPPORTED', `configuration already exists: ${candidate}`, {
          exitCode: 2,
          hint: 'Edit the existing file, or pass --force to overwrite it',
        });
      }
    }
  }
  const content = configTemplate(opts.url ?? DEFAULT_PROFILE_URL);
  // Validate the template with the real schema so a bad URL is reported before anything is written.
  parseConfig(content, { path: target, env: {} });
  await writeFile(target, content, 'utf8');
  ctx.out(
    [
      `wrote ${target}`,
      'Next steps:',
      '  1. Edit the profile URL (and steps) in tessera.config.yaml.',
      '  2. tessera scan                 record every script and header of the page',
      '  3. tessera approve --all-new --owner <team> --category <category> --justification "<why>"',
      '  4. tessera diff --gate          compare a fresh scan with the manifest; exit 0 clean, 1 findings, 2 run error',
    ].join('\n'),
  );
  return { path: target, content };
}
