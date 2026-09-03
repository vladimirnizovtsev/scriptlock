/**
 * What every command shares (DESIGN.md section 2).
 *
 * Owns: `CommandContext` — the working directory, the global flags and the two
 * output sinks the CLI builds and tests construct in process — plus profile
 * resolution (`loadProfile`, `requireProfile`) and the `plural` helper the
 * command summaries print with.
 *
 * Nothing here runs a command: this module exists so that `commands/scan.ts`
 * owns `scriptlock scan` and nothing else, and so a reader looking for
 * `CommandContext` finds it under its own name.
 *
 * Limitations: `cwd` is the directory the configuration, the manifest and
 * `.scriptlock/` resolve against, but flow modules named in `steps` are
 * resolved by the collector against `process.cwd()`.
 */
import { loadConfig } from '../config/load.js';
import { ScriptlockError } from '../errors.js';
import type { ProfileConfig, ScriptlockConfig } from '../types.js';

export interface CommandContext {
  /** Directory the configuration, manifest and `.scriptlock/` are resolved against. */
  cwd: string;
  /** `--config <path>` (relative to cwd); undefined means the default lookup. */
  configPath?: string | undefined;
  verbose: boolean;
  /** Whether terminal output may use colour. */
  color: boolean;
  /** Version stamped into snapshots. */
  toolVersion: string;
  /** Writes a block of text to standard output; a newline is appended unless present. */
  out: (text: string) => void;
  /** Writes a block of text to standard error (progress, warnings, instructions). */
  err: (text: string) => void;
  /** Environment used for defaults such as the approver name. Defaults to process.env. */
  env?: Record<string, string | undefined> | undefined;
}

export interface LoadedProfile {
  config: ScriptlockConfig;
  configPath: string;
  name: string;
  profile: ProfileConfig;
}

export function requireProfile(config: ScriptlockConfig, name: string): ProfileConfig {
  const profile = config.profiles[name];
  if (profile === undefined) {
    const known = Object.keys(config.profiles).join(', ') || '(none)';
    throw new ScriptlockError('PROFILE_NOT_FOUND', `profile "${name}" is not defined in the configuration; known profiles: ${known}`, {
      exitCode: 2,
      hint: 'Pass --profile <name> with one of the profiles listed above, or add the profile to scriptlock.config.yaml',
    });
  }
  return profile;
}

/** Loads the configuration for `ctx` and resolves one profile. */
export async function loadProfile(ctx: CommandContext, name: string): Promise<LoadedProfile> {
  const { config, path: configPath } = await loadConfig(ctx.cwd, ctx.configPath);
  return { config, configPath, name, profile: requireProfile(config, name) };
}

export function plural(count: number, word: string, pluralWord: string = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}
