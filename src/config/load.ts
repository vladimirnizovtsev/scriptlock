/**
 * Locate, parse, interpolate and validate scriptlock.config.yaml.
 *
 * Owns: `loadConfig()`, `parseConfig()`, `interpolateEnv()`,
 * `manifestPathFor()`, `CONFIG_FILE_NAMES`.
 *
 * `${VAR}` references in every string value (not keys) are replaced from the
 * environment before validation; a missing variable is a CONFIG_INVALID error
 * naming the variable and the YAML path. Limitations: no `${VAR:-default}`
 * syntax and no escape for a literal `${`; only the two documented file names
 * are searched, and only in `cwd` (no parent directory walk).
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ScriptlockError } from '../errors.js';
import type { ProfileConfig, ScriptlockConfig } from '../types.js';
import { configSchema, formatConfigIssues, toScriptlockConfig } from './schema.js';

export const CONFIG_FILE_NAMES: readonly string[] = ['scriptlock.config.yaml', 'scriptlock.config.yml'];

export interface ParseConfigOptions {
  /** File path used in error messages. */
  path?: string;
  /** Environment used for ${VAR} interpolation. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Recursively replaces `${VAR}` in string values with `env[VAR]`. Throws
 * CONFIG_INVALID for the first missing variable, naming it and its location.
 */
export function interpolateEnv(
  value: unknown,
  env: Record<string, string | undefined>,
  location: string = '(root)',
): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REFERENCE, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined) {
        throw new ScriptlockError(
          'CONFIG_INVALID',
          `Configuration value at ${location} references environment variable ${name}, which is not set`,
          { hint: `Export ${name} before running scriptlock, or remove the \${${name}} reference` },
        );
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolateEnv(item, env, `${location}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateEnv(item, env, location === '(root)' ? key : `${location}.${key}`);
    }
    return out;
  }
  return value;
}

/** Parses YAML text into a validated `ScriptlockConfig`. */
export function parseConfig(text: string, options: ParseConfigOptions = {}): ScriptlockConfig {
  const where = options.path ?? 'configuration';
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScriptlockError('CONFIG_INVALID', `Invalid YAML in ${where}: ${detail}`, { cause: error });
  }
  if (raw === null || raw === undefined) {
    throw new ScriptlockError('CONFIG_INVALID', `Configuration file ${where} is empty`, {
      hint: 'Run "scriptlock init" to write a starter configuration',
    });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScriptlockError('CONFIG_INVALID', `Configuration file ${where} must be a YAML mapping`);
  }
  const interpolated = interpolateEnv(raw, options.env ?? process.env);
  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ScriptlockError('CONFIG_INVALID', `Invalid configuration in ${where}:\n${formatConfigIssues(result.error.issues)}`);
  }
  return toScriptlockConfig(result.data);
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
 * Finds and loads the configuration. With `explicitPath` (resolved against
 * `cwd`) only that file is considered; otherwise `scriptlock.config.yaml`, then
 * `scriptlock.config.yml`, in `cwd`.
 */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<{ config: ScriptlockConfig; path: string }> {
  let file: string | undefined;
  if (explicitPath !== undefined) {
    const candidate = path.resolve(cwd, explicitPath);
    if (!(await exists(candidate))) {
      throw new ScriptlockError('CONFIG_NOT_FOUND', `Configuration file not found: ${candidate}`, {
        hint: 'Check the --config path, or run "scriptlock init" to create a configuration',
      });
    }
    file = candidate;
  } else {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.resolve(cwd, name);
      if (await exists(candidate)) {
        file = candidate;
        break;
      }
    }
    if (file === undefined) {
      throw new ScriptlockError('CONFIG_NOT_FOUND', `No ${CONFIG_FILE_NAMES.join(' or ')} found in ${cwd}`, {
        hint: 'Run "scriptlock init" to create one, or pass --config <path>',
      });
    }
  }
  const text = await readFile(file, 'utf8');
  return { config: parseConfig(text, { path: file }), path: file };
}

/**
 * Manifest path for a profile: `profile.manifest` when set, otherwise
 * `scriptlock.lock.yaml` for "default" and `scriptlock.<profile>.lock.yaml` for any
 * other profile. Always absolute, resolved against `cwd`.
 */
export function manifestPathFor(profileName: string, profile: Pick<ProfileConfig, 'manifest'>, cwd: string): string {
  if (profile.manifest !== undefined) return path.resolve(cwd, profile.manifest);
  const name = profileName === 'default' ? 'scriptlock.lock.yaml' : `scriptlock.${profileName}.lock.yaml`;
  return path.resolve(cwd, name);
}
