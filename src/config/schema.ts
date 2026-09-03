/**
 * Configuration schema (zod v4) and defaults for scriptlock.config.yaml.
 *
 * Owns: `configSchema`, `defaultConfig()`, `toScriptlockConfig()` (converts the
 * zod output into the `ScriptlockConfig` contract type, dropping optional keys
 * whose value is undefined so the result is valid under
 * exactOptionalPropertyTypes), and `formatConfigIssues()`.
 *
 * Limitations: unknown keys are rejected everywhere except inside
 * `browser.extraHeaders` and the `profiles` map itself. Profile names must be
 * a single safe path segment (letters, digits, `.`, `_`, `-`, starting with a
 * letter or digit) because they become file names under `.scriptlock/`. Values
 * are validated for shape only; whether a URL is reachable or a channel is
 * installed is checked by the collector at scan time.
 */
import { z } from 'zod';
import type { BrowserConfig, FlowStep, ProfileConfig, ScriptlockConfig } from '../types.js';

export const DEFAULT_VIEWPORT = { width: 1366, height: 900 } as const;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_SETTLE_MS = 3_000;
export const DEFAULT_PROFILE_URL = 'https://shop.example.com/checkout';

const integrityPolicySchema = z.enum(['strict', 'structural', 'track', 'url-only']);
const waitUntilSchema = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']);

const selectorValueSchema = z.strictObject({
  selector: z.string().min(1),
  value: z.string(),
});

const flowStepSchema = z.union([
  z.strictObject({ goto: z.string().min(1) }),
  z.strictObject({ click: z.string().min(1) }),
  z.strictObject({ fill: selectorValueSchema }),
  z.strictObject({ select: selectorValueSchema }),
  z.strictObject({ waitFor: z.string().min(1) }),
  z.strictObject({ wait: z.number().int().nonnegative() }),
  z.strictObject({ press: z.string().min(1) }),
  z.strictObject({ screenshot: z.string().min(1) }),
]);

const viewportSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const browserSchema = z.strictObject({
  channel: z.string().min(1).default('chromium'),
  executablePath: z.string().min(1).optional(),
  headless: z.boolean().default(true),
  userAgent: z.string().optional(),
  viewport: viewportSchema.default({ ...DEFAULT_VIEWPORT }),
  locale: z.string().optional(),
  timezoneId: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  extraHeadersHosts: z.array(z.string().min(1)).optional(),
  storageState: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
});

const identitySchema = z.strictObject({
  stripQuery: z.array(z.string()).default([]),
  keepQuery: z.array(z.string()).default([]),
  collapseHashes: z.boolean().default(true),
});

const scopeSchema = z.strictObject({
  tpsp: z.array(z.string()).default([]),
  threeds: z.array(z.string()).default([]),
});

const integritySchema = z.strictObject({
  firstParty: integrityPolicySchema.default('strict'),
  thirdParty: integrityPolicySchema.default('track'),
  inline: integrityPolicySchema.default('structural'),
  eval: integrityPolicySchema.default('structural'),
});

/** Profile names become file names (`.scriptlock/last.<profile>.json`, history directories), so they must be one safe path segment. */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const profileNameSchema = z
  .string()
  .min(1)
  .regex(PROFILE_NAME_PATTERN, 'profile names must start with a letter or digit and contain only letters, digits, ".", "_" and "-"');

const profileSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  steps: z.union([z.array(flowStepSchema), z.string().min(1)]).optional(),
  wait: waitUntilSchema.default('networkidle'),
  settleMs: z.number().int().nonnegative().default(DEFAULT_SETTLE_MS),
  runs: z.number().int().positive().default(1),
  manifest: z.string().min(1).optional(),
  history: z.boolean().default(false),
});

/**
 * Schema for the raw (already ${ENV}-interpolated) YAML document. Use
 * `toScriptlockConfig` on the parsed output to obtain the contract type.
 */
export const configSchema = z.strictObject({
  version: z.literal(1),
  browser: browserSchema.prefault({}),
  identity: identitySchema.prefault({}),
  scope: scopeSchema.prefault({}),
  integrity: integritySchema.prefault({}),
  profiles: z.record(profileNameSchema, profileSchema),
});

export type ConfigSchemaOutput = z.output<typeof configSchema>;

function toBrowserConfig(b: ConfigSchemaOutput['browser']): BrowserConfig {
  return {
    channel: b.channel,
    ...(b.executablePath !== undefined ? { executablePath: b.executablePath } : {}),
    headless: b.headless,
    ...(b.userAgent !== undefined ? { userAgent: b.userAgent } : {}),
    viewport: { width: b.viewport.width, height: b.viewport.height },
    ...(b.locale !== undefined ? { locale: b.locale } : {}),
    ...(b.timezoneId !== undefined ? { timezoneId: b.timezoneId } : {}),
    ...(b.extraHeaders !== undefined ? { extraHeaders: { ...b.extraHeaders } } : {}),
    ...(b.extraHeadersHosts !== undefined ? { extraHeadersHosts: [...b.extraHeadersHosts] } : {}),
    ...(b.storageState !== undefined ? { storageState: b.storageState } : {}),
    timeoutMs: b.timeoutMs,
  };
}

function toProfileConfig(p: ConfigSchemaOutput['profiles'][string]): ProfileConfig {
  const steps: FlowStep[] | string | undefined = p.steps;
  return {
    url: p.url,
    ...(steps !== undefined ? { steps } : {}),
    wait: p.wait,
    settleMs: p.settleMs,
    runs: p.runs,
    ...(p.manifest !== undefined ? { manifest: p.manifest } : {}),
    history: p.history,
  };
}

/** Converts validated schema output into the `ScriptlockConfig` contract type. */
export function toScriptlockConfig(parsed: ConfigSchemaOutput): ScriptlockConfig {
  const profiles: Record<string, ProfileConfig> = {};
  for (const name of Object.keys(parsed.profiles).sort()) {
    const profile = parsed.profiles[name];
    if (profile !== undefined) profiles[name] = toProfileConfig(profile);
  }
  return {
    version: 1,
    browser: toBrowserConfig(parsed.browser),
    identity: {
      stripQuery: [...parsed.identity.stripQuery],
      keepQuery: [...parsed.identity.keepQuery],
      collapseHashes: parsed.identity.collapseHashes,
    },
    scope: {
      tpsp: [...parsed.scope.tpsp],
      threeds: [...parsed.scope.threeds],
    },
    integrity: {
      firstParty: parsed.integrity.firstParty,
      thirdParty: parsed.integrity.thirdParty,
      inline: parsed.integrity.inline,
      eval: parsed.integrity.eval,
    },
    profiles,
  };
}

/** The default profile as written by `scriptlock init`. */
export function defaultProfile(url: string = DEFAULT_PROFILE_URL): ProfileConfig {
  return {
    url,
    wait: 'networkidle',
    settleMs: DEFAULT_SETTLE_MS,
    runs: 1,
    history: false,
  };
}

/**
 * A complete configuration with every default from DESIGN.md section 9 and a
 * single "default" profile pointing at `url`.
 */
export function defaultConfig(url: string = DEFAULT_PROFILE_URL): ScriptlockConfig {
  return toScriptlockConfig(configSchema.parse({ version: 1, profiles: { default: { url } } }));
}

/** Renders zod issues as "  - path: message" lines for error output. */
export function formatConfigIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}
