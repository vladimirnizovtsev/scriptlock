/**
 * Flow DSL interpreter and module escape hatch (DESIGN.md 3.4).
 *
 * Steps: goto (relative to the profile URL), click, fill, select, waitFor,
 * wait, press, screenshot. A string value is a path to a module exporting
 * `default async (page) => void`; .js/.mjs are imported directly, .ts through
 * tsx (`tsx/esm/api`) when it is installed. Every step runs with the
 * configured browser timeout and a failure is reported as STEP_FAILED
 * (exit code 2).
 *
 * Limitations: Playwright actions evaluate helper code in its isolated
 * utility world; those scripts are dropped by the harness filter in
 * collect.ts. Flow modules run arbitrary code with no sandbox and with the
 * full privileges of the process, resolved against the working directory.
 * Step values other than `fill.value` (selectors, goto targets, screenshot
 * paths) appear in progress and error messages; `fill.value` is redacted.
 */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import { ScriptlockError } from '../errors.js';
import { addDevDependencyCommand } from '../runner.js';
import type { FlowStep, WaitUntil } from '../types.js';

export interface StepContext {
  /** Profile URL; `goto` targets are resolved against it. */
  baseUrl: string;
  timeoutMs: number;
  waitUntil: WaitUntil;
  /** Directory that module paths and screenshot paths are resolved from. */
  cwd: string;
  onProgress?: ((message: string) => void) | undefined;
}

export type FlowModule = (page: Page) => Promise<void> | void;

/** Label for progress and error messages. The value of a `fill` step is never printed: it may be a secret from `${VAR}`. */
export function stepLabel(step: FlowStep): string {
  if ('fill' in step) return `fill: ${step.fill.selector}`;
  const key = Object.keys(step)[0] ?? '?';
  const value = (step as Record<string, unknown>)[key];
  return `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
}

function fail(message: string, cause?: unknown): ScriptlockError {
  return new ScriptlockError('STEP_FAILED', message, { exitCode: 2, cause });
}

export async function runSteps(page: Page, steps: FlowStep[] | string | undefined, ctx: StepContext): Promise<void> {
  if (steps === undefined) return;
  if (typeof steps === 'string') {
    const flow = await loadFlowModule(steps, ctx.cwd);
    ctx.onProgress?.(`running flow module ${steps}`);
    page.setDefaultTimeout(ctx.timeoutMs);
    page.setDefaultNavigationTimeout(ctx.timeoutMs);
    try {
      await flow(page);
    } catch (error) {
      throw fail(`flow module ${steps} failed: ${errorMessage(error)}`, error);
    }
    return;
  }
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step === undefined) continue;
    ctx.onProgress?.(`step ${index + 1}/${steps.length}: ${stepLabel(step)}`);
    try {
      await runStep(page, step, ctx);
    } catch (error) {
      if (error instanceof ScriptlockError) throw error;
      throw fail(`step ${index + 1} (${stepLabel(step)}) failed: ${errorMessage(error)}`, error);
    }
  }
}

async function runStep(page: Page, step: FlowStep, ctx: StepContext): Promise<void> {
  const keys = Object.keys(step);
  if (keys.length !== 1) throw fail(`step must have exactly one key, got ${JSON.stringify(step)}`);
  const timeout = ctx.timeoutMs;
  if ('goto' in step) {
    const target = new URL(step.goto, ctx.baseUrl).href;
    await page.goto(target, { waitUntil: ctx.waitUntil, timeout });
    return;
  }
  if ('click' in step) {
    await page.click(step.click, { timeout });
    return;
  }
  if ('fill' in step) {
    await page.fill(step.fill.selector, step.fill.value, { timeout });
    return;
  }
  if ('select' in step) {
    await page.selectOption(step.select.selector, step.select.value, { timeout });
    return;
  }
  if ('waitFor' in step) {
    await page.waitForSelector(step.waitFor, { timeout });
    return;
  }
  if ('wait' in step) {
    if (typeof step.wait !== 'number' || !Number.isFinite(step.wait) || step.wait < 0) {
      throw fail(`wait expects a non-negative number of milliseconds, got ${String(step.wait)}`);
    }
    await page.waitForTimeout(step.wait);
    return;
  }
  if ('press' in step) {
    await page.keyboard.press(step.press);
    return;
  }
  if ('screenshot' in step) {
    const path = isAbsolute(step.screenshot) ? step.screenshot : resolve(ctx.cwd, step.screenshot);
    await page.screenshot({ path, fullPage: true, timeout });
    return;
  }
  throw fail(`unknown step ${JSON.stringify(step)}`);
}

/** Loads a flow module and returns its default export. */
export async function loadFlowModule(modulePath: string, cwd: string): Promise<FlowModule> {
  const absolute = isAbsolute(modulePath) ? modulePath : resolve(cwd, modulePath);
  const href = pathToFileURL(absolute).href;
  let loaded: unknown;
  if (/\.(ts|mts|cts)$/i.test(absolute)) {
    loaded = await importWithTsx(href, modulePath);
  } else if (/\.(js|mjs|cjs)$/i.test(absolute)) {
    try {
      loaded = await import(href);
    } catch (error) {
      throw fail(`could not load flow module ${modulePath}: ${errorMessage(error)}`, error);
    }
  } else {
    throw new ScriptlockError('UNSUPPORTED', `flow module ${modulePath} must be a .js, .mjs or .ts file`, { exitCode: 2 });
  }
  let flow = (loaded as { default?: unknown }).default;
  // CommonJS interop: a .ts file outside an ESM package compiles to module.exports.default.
  if (typeof flow !== 'function' && flow !== null && typeof flow === 'object' && 'default' in flow) {
    flow = (flow as { default?: unknown }).default;
  }
  if (typeof flow !== 'function') {
    throw fail(`flow module ${modulePath} must export a default async function (page) => void`);
  }
  return flow as FlowModule;
}

interface TsxApi {
  tsImport: (specifier: string, parent: string) => Promise<unknown>;
}

async function importWithTsx(href: string, modulePath: string): Promise<unknown> {
  let api: TsxApi;
  try {
    // Non-literal specifier so bundlers do not try to resolve the optional dependency.
    const specifier = 'tsx/esm/api';
    api = (await import(specifier)) as TsxApi;
  } catch (error) {
    // tsx has to be a direct dependency of the project that runs scriptlock:
    // it is resolved from the working directory upwards, and pnpm and Yarn
    // Berry expose nothing that is not declared in the project's package.json.
    throw new ScriptlockError('UNSUPPORTED', `flow module ${modulePath} is TypeScript but tsx is not installed`, {
      exitCode: 2,
      hint: `${addDevDependencyCommand('tsx')} (a direct dependency of this project, not a transitive one)`,
      cause: error,
    });
  }
  try {
    return await api.tsImport(href, import.meta.url);
  } catch (error) {
    throw fail(`could not load flow module ${modulePath}: ${errorMessage(error)}`, error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}
