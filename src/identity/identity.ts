/**
 * ObservedScript.id derivation (DESIGN.md section 4) and the identity module's
 * public surface.
 *
 * Owns: `deriveId`, which picks the identity strategy per script kind:
 * - external, blob, data, worker: the normalised real URL (`embedderName`
 *   when present, else `rawUrl`), so a `//# sourceURL=` comment never
 *   influences identity;
 * - inline, eval: `<kind>:<frame origin>:<structural hash prefix 16>`;
 * - wasm: the normalised URL when there is one, else
 *   `wasm:<frame origin>:<sha256 prefix 16>`.
 *
 * Limitation: a URL-addressed kind observed without any URL (should not
 * happen with CDP) falls back to the structural strategy so the id is still
 * deterministic; `unknown` behaves like wasm.
 */
import type { IdentityConfig, ScriptKind } from '../types.js';
import { sha256, sha256Prefix } from './hash.js';
import { normalizeUrl } from './normalize.js';
import { structuralHash } from './structural.js';

export { normalizeUrl, BUILTIN_CACHE_BUSTERS } from './normalize.js';
export { structuralHash } from './structural.js';
export { sha256 } from './hash.js';
export { classifyFrame, isFirstParty, BUILTIN_TPSP_HOSTS, BUILTIN_THREEDS_HOSTS } from './scope.js';
export { lookupEntity } from './entity.js';

export interface DeriveIdInput {
  kind: ScriptKind;
  /** URL as reported by the engine (may be rewritten by a sourceURL comment). */
  rawUrl?: string | undefined;
  /** Real URL from CDP `embedderName`; preferred over rawUrl when present. */
  embedderName?: string | undefined;
  /** Origin of the frame the script executed in, e.g. https://shop.example.com */
  frameOrigin: string;
  /** Script source text. */
  source: string;
}

function realUrl(input: DeriveIdInput): string | undefined {
  const embedder = input.embedderName?.trim();
  if (embedder !== undefined && embedder !== '') return embedder;
  const raw = input.rawUrl?.trim();
  if (raw !== undefined && raw !== '') return raw;
  return undefined;
}

function structuralId(kind: ScriptKind, frameOrigin: string, source: string): string {
  return `${kind}:${frameOrigin}:${structuralHash(source).slice(0, 16)}`;
}

/** Derive the stable Tessera identity of an observed script. */
export function deriveId(input: DeriveIdInput, cfg: IdentityConfig): string {
  const { kind, frameOrigin, source } = input;
  switch (kind) {
    case 'inline':
    case 'eval':
      return structuralId(kind, frameOrigin, source);
    case 'external':
    case 'blob':
    case 'data':
    case 'worker': {
      const url = realUrl(input);
      return url !== undefined ? normalizeUrl(url, cfg) : structuralId(kind, frameOrigin, source);
    }
    case 'wasm':
    case 'unknown': {
      const url = realUrl(input);
      if (url !== undefined) return normalizeUrl(url, cfg);
      return `${kind}:${frameOrigin}:${sha256Prefix(source, 16)}`;
    }
    default: {
      const exhaustive: never = kind;
      return `${String(exhaustive)}:${frameOrigin}:${sha256(source).slice(0, 16)}`;
    }
  }
}
