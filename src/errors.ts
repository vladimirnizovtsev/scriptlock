/**
 * Error type shared by all modules. The CLI maps `exitCode` to the process
 * exit status: 1 for findings, 2 for run errors (browser missing, navigation
 * failure, invalid configuration, blocked scan).
 */
export type ScriptlockErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'PROFILE_NOT_FOUND'
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_INVALID'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_INVALID'
  | 'BROWSER_NOT_FOUND'
  | 'NAVIGATION_FAILED'
  | 'STEP_FAILED'
  | 'SCAN_BLOCKED'
  | 'UNSUPPORTED';

export class ScriptlockError extends Error {
  readonly code: ScriptlockErrorCode;
  readonly exitCode: 1 | 2;
  /** Optional one-line hint printed after the message, e.g. an install command. */
  readonly hint: string | undefined;

  constructor(code: ScriptlockErrorCode, message: string, options?: { exitCode?: 1 | 2; hint?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ScriptlockError';
    this.code = code;
    this.exitCode = options?.exitCode ?? 2;
    this.hint = options?.hint;
  }
}

export function isScriptlockError(value: unknown): value is ScriptlockError {
  return value instanceof ScriptlockError;
}
