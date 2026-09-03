/**
 * `scriptlock init` (DESIGN.md section 8): write an annotated scriptlock.config.yaml
 * with a single "default" profile into the working directory. The template is
 * validated with the configuration schema before it is written, so `init`
 * never produces a file that `loadConfig` would reject.
 *
 * Also adds `.scriptlock/` to an existing .gitignore (scan output is not a
 * committed artifact) and prints the rule when there is no .gitignore.
 *
 * Limitations: refuses to overwrite an existing scriptlock.config.yaml or .yml
 * unless `force` is set; the profile URL is the only value taken from the
 * command line; a missing .gitignore is never created.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE_NAMES, parseConfig } from '../config/load.js';
import { DEFAULT_PROFILE_URL, DEFAULT_SETTLE_MS, DEFAULT_TIMEOUT_MS, DEFAULT_VIEWPORT } from '../config/schema.js';
import { ScriptlockError } from '../errors.js';
import { scriptlockCommand } from '../runner.js';
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
  /**
   * What happened to `.gitignore`: `appended` when the ignore rule was added to
   * an existing file, `present` when it was already covered, `missing` when
   * there is no `.gitignore` (the rule is printed instead of a file created).
   */
  gitignore: GitignoreOutcome;
}

export type GitignoreOutcome = 'appended' | 'present' | 'missing';

/** The rule that keeps scan output (snapshots, reports, history) out of the repository. */
export const IGNORE_LINE = '.scriptlock/';

/** The annotated configuration written by `scriptlock init`. */
export function configTemplate(url: string = DEFAULT_PROFILE_URL): string {
  return `# Scriptlock configuration. Documentation: https://github.com/vladimirnizovtsev/scriptlock#configuration
# Every \${VAR} in a string value is replaced from the environment when the file is loaded;
# a missing variable is a configuration error that names the variable.
version: 1

browser:
  # Playwright channel: "chromium" (the Playwright-managed build, installed with
  # \`scriptlock install-browser\`), "chrome" or "msedge". Or set executablePath to a
  # Chromium-based binary; it overrides channel.
  channel: chromium
  headless: true
  viewport: { width: ${DEFAULT_VIEWPORT.width}, height: ${DEFAULT_VIEWPORT.height} }
  # Navigation and step timeout in milliseconds.
  timeoutMs: ${DEFAULT_TIMEOUT_MS}
  # Sent to the profile host and its subdomains only, matched in an allow rule of your bot
  # management. Add extraHeadersHosts (host globs, or "*") to send them to more hosts. No
  # stealth patches. The token is never sent to third-party script hosts or provider iframes.
  # extraHeaders:
  #   X-Scanner-Token: \${SCRIPTLOCK_SCANNER_TOKEN}
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

# Integrity policy applied by \`scriptlock approve\` when --integrity is not given.
integrity:
  firstParty: strict # host equals the main-frame host or a subdomain of it
  thirdParty: track # everything else; body changes are recorded, never fail
  inline: structural # literals are masked, code shape is enforced
  eval: structural

profiles:
  # Manifest: scriptlock.lock.yaml. Stop at the rendered payment form; never submit a card.
  default:
    url: ${JSON.stringify(url)}
    # Optional flow: a list of steps (goto, click, fill, select, waitFor, wait, press,
    # screenshot) or the path of a module exporting \`default async (page) => void\`.
    # steps:
    #   - goto: /checkout
    #   - waitFor: "#payment-element iframe"
    # load is the default. networkidle waits for two seconds of network silence, which many
    # real storefronts never reach (analytics beacons, long polling, ads), so it times out.
    # Raise settleMs instead when tags load late.
    wait: load # load | domcontentloaded | networkidle | commit
    settleMs: ${DEFAULT_SETTLE_MS} # idle time after the last step, to catch late tags
    runs: 1 # scans unioned per run; absence must hold in all runs
    history: false # keep snapshots and diffs under .scriptlock/history/default/
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

/**
 * Adds `.scriptlock/` to an existing `.gitignore`. The snapshot is a complete
 * inventory of every script URL on the scanned page, so `git add -A` after a
 * scan would publish it; only the manifest belongs in the repository. A
 * missing `.gitignore` is left alone (creating one is the repository owner's
 * decision) and reported to the caller so the rule can be printed instead.
 */
async function ensureGitignore(cwd: string): Promise<GitignoreOutcome> {
  const file = path.join(cwd, '.gitignore');
  let current: string;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    return 'missing';
  }
  const covered = current
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === IGNORE_LINE || line === '.scriptlock' || line === '/.scriptlock' || line === '/.scriptlock/');
  if (covered) return 'present';
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFile(file, `${current}${separator}\n# Scriptlock scan output (snapshots, reports, history). Commit the manifest, not this.\n${IGNORE_LINE}\n`, 'utf8');
  return 'appended';
}

export async function runInit(ctx: CommandContext, opts: InitCommandOptions = {}): Promise<InitCommandResult> {
  const target = path.join(ctx.cwd, 'scriptlock.config.yaml');
  if (opts.force !== true) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(ctx.cwd, name);
      if (await exists(candidate)) {
        throw new ScriptlockError('UNSUPPORTED', `configuration already exists: ${candidate}`, {
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

  const gitignore = await ensureGitignore(ctx.cwd);
  const lines = [`wrote ${target}`];
  if (gitignore === 'appended') lines.push(`added ${IGNORE_LINE} to .gitignore (scan output is not a committed artifact)`);
  lines.push('Next steps:');
  const steps: string[][] = [];
  // Nothing to edit when the URL came from --url.
  if (opts.url === undefined) steps.push(['Edit the profile URL (and steps) in scriptlock.config.yaml.']);
  if (gitignore === 'missing') {
    steps.push([`Add ${IGNORE_LINE} to your .gitignore: what lands there is scan output, not evidence to commit.`]);
  }
  // Prefixed with the runner of the detected package manager: scriptlock is a
  // development dependency, so a bare `scriptlock scan` is `command not found`
  // under npm, pnpm and yarn alike.
  const run = (args: string): string => scriptlockCommand(args, ctx.env, ctx.cwd);
  steps.push([`${run('scan')} — record every script and header of the page`]);
  // A concrete owner and justification: the placeholder guard refuses "<team>"
  // and "<why ...>", so a printed command has to be one that actually runs.
  steps.push([
    run('approve --all-new --owner web --category functional --justification "Initial inventory of the checkout page, reviewed in PR #123"'),
    'replace the owner, category and justification with your own: they are the 6.4.3 record',
  ]);
  steps.push([`${run('diff --gate')} — compare a fresh scan with the manifest; exit 0 clean, 1 findings, 2 run error`]);
  steps.forEach(([step, note], index) => {
    lines.push(`  ${index + 1}. ${step ?? ''}`);
    if (note !== undefined) lines.push(`     ${note}`);
  });
  lines.push('Commit scriptlock.config.yaml and the manifest (scriptlock.lock.yaml); keep .scriptlock/ out of the repository.');
  ctx.out(lines.join('\n'));
  return { path: target, content, gitignore };
}
