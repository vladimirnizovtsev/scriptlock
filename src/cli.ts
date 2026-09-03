/**
 * Commander entry point (DESIGN.md section 8). Owns argument parsing, the
 * global options (--config, --verbose, --no-color), building the
 * CommandContext for commands/*, ScriptlockError rendering ("error: <message>"
 * plus an optional hint) and the process exit code: 0 clean, 1 findings,
 * 2 run error (blocked, navigation failure, invalid configuration, missing
 * browser, usage error).
 *
 * Limitations: the module runs `main` on import, so it must only be executed
 * as the CLI entry (tests spawn it as a child process); the library surface
 * is src/index.ts.
 */
import { readFileSync } from 'node:fs';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import pc from 'picocolors';
import { renderPolicyTable } from './diff/policy.js';
import { isScriptlockError } from './errors.js';
import { APPROVABLE_SCOPES, INTEGRITY_METHODS, INTEGRITY_POLICIES, runApprove, SCRIPT_CATEGORIES } from './commands/approve.js';
import { DIFF_FORMATS, runDiff, type DiffFormat } from './commands/diff.js';
import { runInit } from './commands/init.js';
import { REPORT_FORMATS, runReport, type ReportFormat } from './commands/report.js';
import { runScan, type CommandContext } from './commands/scan.js';
import type { IntegrityMethod, IntegrityPolicy, Scope, ScriptCategory } from './types.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface GlobalOptions {
  config?: string;
  verbose?: boolean;
  color: boolean;
}

interface CliState {
  exitCode: number;
}

/** Version from package.json (next to dist/ or src/). */
export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

function writeBlock(write: (text: string) => void): (text: string) => void {
  return (text: string) => write(text.endsWith('\n') ? text : `${text}\n`);
}

function indent(text: string, prefix: string = '  '): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : prefix + line))
    .join('\n');
}

/** Builds the commander program. `state.exitCode` receives the diff exit code. */
export function buildProgram(state: CliState, io: CliIo, version: string = packageVersion()): Command {
  const program = new Command();
  program
    .name('scriptlock')
    .description(
      'Client-side script inventory and change detection for web pages: records every script a page executes, keeps the approved inventory in scriptlock.lock.yaml and fails CI when the page diverges from it.',
    )
    .version(version, '-V, --version', 'print the scriptlock version')
    .helpOption('-h, --help', 'show help')
    .option('--config <path>', 'configuration file (default: scriptlock.config.yaml, then scriptlock.config.yml, in the current directory)')
    .option('--verbose', 'print progress messages and error details')
    .option('--no-color', 'disable coloured output (NO_COLOR is honoured as well)')
    .addHelpText(
      'after',
      '\nExit codes: 0 clean, 1 findings at fail severity (or no manifest yet), 2 run error (blocked scan, navigation failure, invalid configuration, browser missing).',
    )
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError('(use --help for usage)');

  const context = (): CommandContext => {
    const globals = program.opts<GlobalOptions>();
    const ctx: CommandContext = {
      cwd: process.cwd(),
      verbose: globals.verbose === true,
      color: globals.color !== false && pc.isColorSupported,
      toolVersion: version,
      out: writeBlock(io.stdout),
      err: writeBlock(io.stderr),
    };
    if (globals.config !== undefined) ctx.configPath = globals.config;
    return ctx;
  };

  program
    .command('init')
    .description('write scriptlock.config.yaml with a "default" profile')
    .option('--url <url>', 'URL of the default profile', 'https://shop.example.com/checkout')
    .option('--force', 'overwrite an existing configuration file')
    .action(async (options: { url: string; force?: boolean }) => {
      await runInit(context(), { url: options.url, force: options.force === true });
    });

  program
    .command('scan')
    .description('open the page in Chromium, record every script and header, write .scriptlock/last.<profile>.json')
    .option('--profile <name>', 'profile from the configuration', 'default')
    .option('--runs <n>', 'number of runs unioned into the snapshot (overrides the profile)', parsePositiveInt)
    .option('--out <file>', 'snapshot path (default: .scriptlock/last.<profile>.json)')
    .option('--json', 'print the snapshot JSON instead of the summary')
    .action(async (options: { profile: string; runs?: number; out?: string; json?: boolean }) => {
      const outcome = await runScan(context(), { profile: options.profile, runs: options.runs, out: options.out, json: options.json === true });
      state.exitCode = outcome.exitCode;
    });

  program
    .command('diff')
    .description('scan (or load --snapshot), compare with the manifest and report; exits with 0 clean, 1 findings (or no manifest yet), 2 run error')
    .option('--profile <name>', 'profile from the configuration', 'default')
    .option('--gate', 'deploy-gate mode: new scripts fail only in merchant scope; changed, moved, spoofed and strict header changes fail in any scope (default)')
    .addOption(new Option('--drift', 'drift mode for the scheduled run: broader severities').conflicts('gate'))
    .option('--snapshot <file>', 'compare this snapshot instead of scanning')
    .addOption(new Option('--format <format>', 'report format').choices([...DIFF_FORMATS]).default('text'))
    .option('--history', 'append the snapshot and result under .scriptlock/history/<profile>/ (also when profile.history is set)')
    .option('--out <file>', 'write the report to this file instead of standard output')
    .addHelpText('after', `\nSeverity matrix (gate vs drift):\n${indent(renderPolicyTable())}`)
    .action(
      async (options: { profile: string; gate?: boolean; drift?: boolean; snapshot?: string; format: DiffFormat; history?: boolean; out?: string }) => {
        const outcome = await runDiff(context(), {
          profile: options.profile,
          mode: options.drift === true ? 'drift' : 'gate',
          snapshot: options.snapshot,
          format: options.format,
          history: options.history === true,
          out: options.out,
        });
        state.exitCode = outcome.exitCode;
      },
    );

  program
    .command('approve')
    .description('add or refresh manifest entries from the last snapshot (or --snapshot)')
    .argument('[ids...]', 'observed script ids to approve (see "scriptlock scan" output)')
    .option('--all-new', 'approve every script and cross-origin frame without an entry')
    .addOption(
      new Option(
        '--match <glob>',
        'authorise every observed script matching this glob with one entry, for content-hashed build output (e.g. "https://shop.example.com/assets/*.js"); one host and one directory only, integrity is track, so the bodies are not hashed',
      ).conflicts(['allNew', 'refresh']),
    )
    .option('--replace', 'with --match: remove the exact-id entries the glob makes redundant')
    .option('--owner <owner>', 'team or person responsible (required for new entries)')
    .addOption(new Option('--category <category>', 'script category (required for new entries)').choices([...SCRIPT_CATEGORIES]))
    .option('--justification <text>', 'business or technical justification (required for new entries)')
    .addOption(new Option('--integrity <policy>', 'integrity policy (default: from the integrity section of the configuration)').choices([...INTEGRITY_POLICIES]))
    .addOption(new Option('--integrity-method <method>', 'what assures integrity in production (default: hash-strict for strict/structural, source-tracked otherwise)').choices([...INTEGRITY_METHODS]))
    .option('--approved-by <name>', 'approver (default: git config user.name, then $USER)')
    .addOption(new Option('--scope <scope>', 'override the observed scope').choices([...APPROVABLE_SCOPES]))
    .option('--notes <text>', 'free-form notes stored on the entry')
    .option('--refresh', 'refresh lastSeenSha256 on track entries and the approved hashes of the listed entries')
    .option('--headers', 'record the observed security headers as the approved values')
    .option('--snapshot <file>', 'snapshot to approve from (default: .scriptlock/last.<profile>.json)')
    .option('--profile <name>', 'profile from the configuration', 'default')
    .action(
      async (
        ids: string[],
        options: {
          allNew?: boolean;
          match?: string;
          replace?: boolean;
          owner?: string;
          category?: ScriptCategory;
          justification?: string;
          integrity?: IntegrityPolicy;
          integrityMethod?: IntegrityMethod;
          approvedBy?: string;
          scope?: Scope;
          notes?: string;
          refresh?: boolean;
          headers?: boolean;
          snapshot?: string;
          profile: string;
        },
      ) => {
        await runApprove(context(), {
          profile: options.profile,
          ids,
          allNew: options.allNew === true,
          match: options.match,
          replace: options.replace === true,
          owner: options.owner,
          category: options.category,
          justification: options.justification,
          integrity: options.integrity,
          integrityMethod: options.integrityMethod,
          approvedBy: options.approvedBy,
          scope: options.scope,
          notes: options.notes,
          refresh: options.refresh === true,
          headers: options.headers === true,
          snapshot: options.snapshot,
        });
      },
    );

  program
    .command('report')
    .description('render the inventory with authorisation status (approved / unapproved / stale) grouped by scope, owner and category')
    .option('--profile <name>', 'profile from the configuration', 'default')
    .addOption(new Option('--format <format>', 'report format').choices([...REPORT_FORMATS]).default('md'))
    .option('--snapshot <file>', 'snapshot to report on (default: .scriptlock/last.<profile>.json)')
    .option('--out <file>', 'write the report to this file instead of standard output')
    .action(async (options: { profile: string; format: ReportFormat; snapshot?: string; out?: string }) => {
      await runReport(context(), { profile: options.profile, format: options.format, snapshot: options.snapshot, out: options.out });
    });

  return program;
}

/** Parses `argv` (including the node and script entries) and returns the exit code. */
export async function main(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  const state: CliState = { exitCode: 0 };
  const program = buildProgram(state, io);
  const verbose = argv.includes('--verbose');
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are not errors. Help shown because no command was given keeps
      // commander's exit code (1). Usage errors were already printed by commander.
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0;
      if (error.code === 'commander.help') return error.exitCode === 0 ? 0 : 1;
      return 2;
    }
    if (isScriptlockError(error)) {
      io.stderr(`error: ${error.message}\n`);
      if (error.hint !== undefined) io.stderr(`hint: ${error.hint}\n`);
      if (verbose && error.cause !== undefined) io.stderr(`cause: ${describeCause(error.cause)}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${message}\n`);
    if (verbose && error instanceof Error && error.stack !== undefined) io.stderr(`${error.stack}\n`);
    return 2;
  }
  return state.exitCode;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? cause.message;
  return String(cause);
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
