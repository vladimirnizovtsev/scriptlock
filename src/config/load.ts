/**
 * Locate, parse, interpolate and validate tessera.config.yaml.
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
import { TesseraError } from '../errors.js';
import type { ProfileConfig, TesseraConfig } from '../types.js';
import { configSchema, formatConfigIssues, toTesseraConfig } from './schema.js';

export const CONFIG_FILE_NAMES: readonly string[] = ['tessera.config.yaml', 'tessera.config.yml'];

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
        throw new TesseraError(
          'CONFIG_INVALID',
          `Configuration value at ${location} references environment variable ${name}, which is not set`,
          { hint: `Export ${name} before running tessera, or remove the \${${name}} reference` },
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

/** Parses YAML text into a validated `TesseraConfig`. */
export function parseConfig(text: string, options: ParseConfigOptions = {}): TesseraConfig {
  const where = options.path ?? 'configuration';
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TesseraError('CONFIG_INVALID', `Invalid YAML in ${where}: ${detail}`, { cause: error });
  }
  if (raw === null || raw === undefined) {
    throw new TesseraError('CONFIG_INVALID', `Configuration file ${where} is empty`, {
      hint: 'Run "tessera init" to write a starter configuration',
    });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TesseraError('CONFIG_INVALID', `Configuration file ${where} must be a YAML mapping`);
  }
  const interpolated = interpolateEnv(raw, options.env ?? process.env);
  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    throw new TesseraError('CONFIG_INVALID', `Invalid configuration in ${where}:\n${formatConfigIssues(result.error.issues)}`);
  }
  return toTesseraConfig(result.data);
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
 * `cwd`) only that file is considered; otherwise `tessera.config.yaml`, then
 * `tessera.config.yml`, in `cwd`.
 */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<{ config: TesseraConfig; path: string }> {
  let file: string | undefined;
  if (explicitPath !== undefined) {
    const candidate = path.resolve(cwd, explicitPath);
    if (!(await exists(candidate))) {
      throw new TesseraError('CONFIG_NOT_FOUND', `Configuration file not found: ${candidate}`, {
        hint: 'Check the --config path, or run "tessera init" to create a configuration',
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
      throw new TesseraError('CONFIG_NOT_FOUND', `No ${CONFIG_FILE_NAMES.join(' or ')} found in ${cwd}`, {
        hint: 'Run "tessera init" to create one, or pass --config <path>',
      });
    }
  }
  const text = await readFile(file, 'utf8');
  return { config: parseConfig(text, { path: file }), path: file };
}

/**
 * Manifest path for a profile: `profile.manifest` when set, otherwise
 * `tessera.lock.yaml` for "default" and `tessera.<profile>.lock.yaml` for any
 * other profile. Always absolute, resolved against `cwd`.
 */
export function manifestPathFor(profileName: string, profile: Pick<ProfileConfig, 'manifest'>, cwd: string): string {
  if (profile.manifest !== undefined) return path.resolve(cwd, profile.manifest);
  const name = profileName === 'default' ? 'tessera.lock.yaml' : `tessera.${profileName}.lock.yaml`;
  return path.resolve(cwd, name);
}
