/**
 * Public API of scriptlock: the shared types, the error type and the module
 * functions DESIGN.md section 2 names, so the package can be used as a library.
 * The CLI entry point (src/cli.ts) is deliberately not exported because it runs
 * on import.
 *
 * While the package is 0.x this file *is* the supported surface, and it is the
 * list in DESIGN.md section 2 plus the three Zod schemas. Anything reachable
 * only through a deep import (`scriptlock/dist/...`) is internal and may be
 * renamed or removed in any release; the README says the same, so that no
 * semver promise is made by accident. The command functions the CLI runs are
 * deliberately not here: they print through a CommandContext and resolve paths
 * against its cwd, which makes them CLI plumbing rather than a library API.
 */
export * from './types.js';
export { ScriptlockError, isScriptlockError, type ScriptlockErrorCode } from './errors.js';

// config
export { loadConfig } from './config/load.js';
export { configSchema, defaultConfig } from './config/schema.js';

// collector
export { scan } from './collector/collect.js';

// identity
export { normalizeUrl, structuralHash, sha256, deriveId, classifyFrame, lookupEntity, type DeriveIdInput } from './identity/identity.js';

// manifest
export { readManifest, writeManifest, emptyManifest } from './manifest/io.js';
export { manifestSchema } from './manifest/schema.js';
export { findScriptEntry, findFrameEntry, isIgnored, globNarrowness, type GlobProblem } from './manifest/match.js';
export {
  approveScripts,
  approveMatch,
  scriptsMatchingGlob,
  redundantScriptEntries,
  refreshTracked,
  type ApproveMatchOptions,
  type ApproveMeta,
} from './manifest/approve.js';

// diff
export { diff } from './diff/diff.js';

// report
export { renderText, type TextOptions } from './report/text.js';
export { renderMarkdown, renderInventoryMarkdown } from './report/markdown.js';
export { renderJson } from './report/json.js';

// history
export { appendHistory } from './history/store.js';

// snapshot files
export { snapshotSchema } from './commands/snapshot.js';
