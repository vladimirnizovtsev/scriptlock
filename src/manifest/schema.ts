/**
 * Zod v4 schema for scriptlock.lock.yaml.
 *
 * Owns: `manifestSchema`, `toManifest()` (converts the zod output into the
 * `Manifest` contract type without undefined-valued optional keys),
 * `formatManifestIssues()`.
 *
 * Validation is structural: hashes are checked to be non-empty strings (not
 * strictly 64 hex characters) so hand-edited or abbreviated fixtures still
 * load; `approvedAt` must look like YYYY-MM-DD. Script ids must be unique,
 * strict entries need `sha256` and structural entries need `structuralHash`.
 * Unknown keys are rejected so typos do not silently disable a field.
 */
import { z } from 'zod';
import {
  INTEGRITY_METHODS,
  INTEGRITY_POLICIES,
  SCOPES,
  SCRIPT_CATEGORIES,
  SCRIPT_KINDS,
  SECURITY_HEADER_NAMES,
  type Manifest,
  type ManifestFrame,
  type ManifestScript,
  type SecurityHeaders,
} from '../types.js';

// Every enum below is built from the list in types.ts that also defines the
// union, so a member added there cannot be rejected by this validator.
const scriptKindSchema = z.enum(SCRIPT_KINDS);
const scopeSchema = z.enum(SCOPES);
const integrityPolicySchema = z.enum(INTEGRITY_POLICIES);
const integrityMethodSchema = z.enum(INTEGRITY_METHODS);
const categorySchema = z.enum(SCRIPT_CATEGORIES);
const headerPolicySchema = z.enum(['strict', 'track', 'ignore']);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date (YYYY-MM-DD)');
const hashSchema = z.string().min(1);

const coveredAtApprovalSchema = z.strictObject({
  count: z.int().nonnegative(),
  scannedAt: z.string().min(1),
  ids: z.array(z.string().min(1)).default([]),
});

const scriptSchema = z
  .strictObject({
    id: z.string().min(1),
    match: z.string().min(1).optional(),
    kind: scriptKindSchema,
    scope: scopeSchema,
    integrity: integrityPolicySchema,
    integrityMethod: integrityMethodSchema,
    sha256: hashSchema.optional(),
    structuralHash: hashSchema.optional(),
    owner: z.string().min(1),
    category: categorySchema,
    justification: z.string().min(1),
    approvedBy: z.string().min(1),
    approvedAt: isoDateSchema,
    coveredAtApproval: coveredAtApprovalSchema.optional(),
    notes: z.string().optional(),
    lastSeenSha256: hashSchema.optional(),
  })
  .check((ctx) => {
    const s = ctx.value;
    if (s.integrity === 'strict' && s.sha256 === undefined) {
      ctx.issues.push({ code: 'custom', input: s, path: ['sha256'], message: 'strict integrity requires sha256' });
    }
    if (s.integrity === 'structural' && s.structuralHash === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: s,
        path: ['structuralHash'],
        message: 'structural integrity requires structuralHash',
      });
    }
  });

const frameSchema = z.strictObject({
  match: z.string().min(1),
  scope: scopeSchema,
  owner: z.string().min(1),
  justification: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedAt: isoDateSchema,
});

export const headerNameSchema = z.enum(SECURITY_HEADER_NAMES);

const headersSchema = z.strictObject({
  policy: headerPolicySchema.default('strict'),
  values: z.partialRecord(headerNameSchema, z.string()).default({}),
});

export const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    profile: z.string().min(1),
    url: z.string().min(1),
    headers: headersSchema.prefault({}),
    frames: z.array(frameSchema).default([]),
    scripts: z.array(scriptSchema).default([]),
    ignore: z.array(z.string().min(1)).default([]),
  })
  .check((ctx) => {
    const seen = new Set<string>();
    ctx.value.scripts.forEach((script, index) => {
      if (seen.has(script.id)) {
        ctx.issues.push({
          code: 'custom',
          input: script.id,
          path: ['scripts', index, 'id'],
          message: `duplicate script id ${script.id}`,
        });
      }
      seen.add(script.id);
    });
  });

export type ManifestSchemaOutput = z.output<typeof manifestSchema>;

function toScript(s: ManifestSchemaOutput['scripts'][number]): ManifestScript {
  return {
    id: s.id,
    ...(s.match !== undefined ? { match: s.match } : {}),
    kind: s.kind,
    scope: s.scope,
    integrity: s.integrity,
    integrityMethod: s.integrityMethod,
    ...(s.sha256 !== undefined ? { sha256: s.sha256 } : {}),
    ...(s.structuralHash !== undefined ? { structuralHash: s.structuralHash } : {}),
    owner: s.owner,
    category: s.category,
    justification: s.justification,
    approvedBy: s.approvedBy,
    approvedAt: s.approvedAt,
    ...(s.coveredAtApproval !== undefined
      ? { coveredAtApproval: { count: s.coveredAtApproval.count, scannedAt: s.coveredAtApproval.scannedAt, ids: [...s.coveredAtApproval.ids] } }
      : {}),
    ...(s.notes !== undefined ? { notes: s.notes } : {}),
    ...(s.lastSeenSha256 !== undefined ? { lastSeenSha256: s.lastSeenSha256 } : {}),
  };
}

function toFrame(f: ManifestSchemaOutput['frames'][number]): ManifestFrame {
  return {
    match: f.match,
    scope: f.scope,
    owner: f.owner,
    justification: f.justification,
    approvedBy: f.approvedBy,
    approvedAt: f.approvedAt,
  };
}

/** Converts validated schema output into the `Manifest` contract type. */
export function toManifest(parsed: ManifestSchemaOutput): Manifest {
  const values: SecurityHeaders = {};
  for (const name of SECURITY_HEADER_NAMES) {
    const value = parsed.headers.values[name];
    if (value !== undefined) values[name] = value;
  }
  return {
    version: 1,
    profile: parsed.profile,
    url: parsed.url,
    headers: { policy: parsed.headers.policy, values },
    frames: parsed.frames.map(toFrame),
    scripts: parsed.scripts.map(toScript),
    ignore: [...parsed.ignore],
  };
}

/** Renders zod issues as "  - path: message" lines for error output. */
export function formatManifestIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}
