/**
 * Public API of tessera-cli (DESIGN.md section 2): re-exports the shared
 * types, the error type and the module functions so the package can be used
 * as a library. The CLI entry point (src/cli.ts) is deliberately not exported
 * because it runs on import.
 *
 * Limitations: the command functions (runScan and friends) print through the
 * CommandContext they receive and resolve paths against its cwd; flow modules
 * are still resolved by the collector against process.cwd().
 */
export * from './types.js';
export { TesseraError, isTesseraError, type TesseraErrorCode } from './errors.js';

// config
export { loadConfig, parseConfig, interpolateEnv, manifestPathFor, CONFIG_FILE_NAMES, type ParseConfigOptions } from './config/load.js';
export {
  configSchema,
  defaultConfig,
  defaultProfile,
  formatConfigIssues,
  toTesseraConfig,
  DEFAULT_PROFILE_URL,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
} from './config/schema.js';

// collector
export { scan } from './collector/collect.js';
export { detectBlocked, extractTitle, type BlockedInput } from './collector/blocked.js';

// identity
export {
  normalizeUrl,
  structuralHash,
  sha256,
  deriveId,
  classifyFrame,
  lookupEntity,
  isFirstParty,
  BUILTIN_CACHE_BUSTERS,
  BUILTIN_TPSP_HOSTS,
  BUILTIN_THREEDS_HOSTS,
  type DeriveIdInput,
} from './identity/identity.js';

// manifest
export { readManifest, writeManifest, parseManifest, serialiseManifest, sortManifest, emptyManifest } from './manifest/io.js';
export { manifestSchema, formatManifestIssues, toManifest } from './manifest/schema.js';
export { findScriptEntry, findScriptEntryById, findFrameEntry, isIgnored, matchingScriptEntries } from './manifest/match.js';
export {
  approveScripts,
  approveFrames,
  refreshTracked,
  refreshScripts,
  defaultIntegrityFor,
  defaultIntegrityMethod,
  ALL_NEW,
  type ApproveMeta,
  type ApproveFrameMeta,
  type ApproveHelpers,
} from './manifest/approve.js';

// diff
export { diff, type DiffExtras, type NormalizeUrlFn } from './diff/diff.js';
export {
  severityFor,
  policyRows,
  renderPolicyTable,
  SEVERITY,
  CHANGED_SEVERITY,
  HEADER_SEVERITY,
  DIFF_MODES,
  DIFF_EVENT_TYPES,
  type PolicyRow,
  type PolicySeverity,
} from './diff/policy.js';

// report
export { renderText, type TextOptions } from './report/text.js';
export { renderMarkdown, renderInventoryMarkdown, inventoryStatus, type InventoryStatus } from './report/markdown.js';
export { renderJson, resultToJson } from './report/json.js';

// history
export { appendHistory, historyStem, snapshotToJson } from './history/store.js';

// commands (the same functions the CLI runs, usable in-process)
export {
  runScan,
  loadProfile,
  requireProfile,
  lastSnapshotPath,
  parseSnapshot,
  readSnapshot,
  writeSnapshot,
  renderScanSummary,
  type CommandContext,
  type ScanCommandOptions,
  type ScanCommandResult,
} from './commands/scan.js';
export { runDiff, historyDir, renderReport, type DiffCommandOptions, type DiffCommandResult, type DiffFormat } from './commands/diff.js';
export {
  runApprove,
  detectApprover,
  todayUtc,
  SCRIPT_CATEGORIES,
  INTEGRITY_POLICIES,
  INTEGRITY_METHODS,
  type ApproveCommandOptions,
  type ApproveCommandResult,
} from './commands/approve.js';
export {
  runReport,
  inventoryToJson,
  renderInventoryJson,
  type InventoryJson,
  type ReportCommandOptions,
  type ReportCommandResult,
  type ReportFormat,
} from './commands/report.js';
export { runInit, configTemplate, type InitCommandOptions, type InitCommandResult } from './commands/init.js';
