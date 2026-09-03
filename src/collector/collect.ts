/**
 * Runs one profile and produces a Snapshot (DESIGN.md 3.3).
 *
 * Owns: `scan(options)`: launch, one context per run, CDP capture, navigation,
 * steps, settle, header and challenge-page extraction, ObservedScript
 * construction (kind, identity, hashes, scope, entity, initiator, loadedBy)
 * and the union across runs. Source text never leaves this module.
 *
 * Kind detection: a script whose real URL equals a document URL (frame URL or
 * a Document request) is `inline`; empty URL with a stack trace is `eval`;
 * blob:/data: by scheme; everything else URL-addressed is `external`. Worker
 * entries come from Playwright worker events and carry no body hash (their
 * bodies are out of scope in v1).
 *
 * Limitations: a forged sourceURL on a script whose `embedderName` is empty
 * cannot be mapped back to its network URL (recorded as eval when it has a
 * stack, dropped otherwise). Frames that were detached before the end of the
 * run keep their last known URL. Worker scope is taken from the first frame
 * whose origin matches the worker URL, else the main frame.
 */
import { hostname } from 'node:os';
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright-core';
import { ScriptlockError } from '../errors.js';
import { lookupEntity } from '../identity/entity.js';
import { sha256, sha256Bytes } from '../identity/hash.js';
import { deriveId } from '../identity/identity.js';
import { normalizeUrl } from '../identity/normalize.js';
import { classifyFrame, hostMatches, isFirstParty } from '../identity/scope.js';
import { structuralHash } from '../identity/structural.js';
import type {
  BrowserConfig,
  FrameInfo,
  ObservedScript,
  ProfileConfig,
  ScanOptions,
  Scope,
  ScriptInitiator,
  ScriptKind,
  SecurityHeaders,
  Snapshot,
  ScriptlockConfig,
  Vantage,
} from '../types.js';
import { detectBlocked, extractTitle } from './blocked.js';
import { describeBrowser, launchBrowser, type LaunchedBrowser } from './browser.js';
import { extractSecurityHeaders, pickScriptResponseHeaders } from './headers.js';
import { attachCapture, type Capture, type RawRequest, type RawScript, type RawStackFrame } from './session.js';
import { runSteps } from './steps.js';

interface RunResult {
  finalUrl: string;
  documentStatus: number;
  headers: SecurityHeaders;
  frames: FrameInfo[];
  scripts: ObservedScript[];
  blocked: Snapshot['blocked'];
  warnings: string[];
  vantage: Vantage;
}

export async function scan(options: ScanOptions): Promise<Snapshot> {
  const { config } = options;
  const profile = config.profiles[options.profile];
  if (profile === undefined) {
    const known = Object.keys(config.profiles).join(', ') || '(none)';
    throw new ScriptlockError('PROFILE_NOT_FOUND', `profile "${options.profile}" is not defined; known profiles: ${known}`, {
      exitCode: 2,
    });
  }
  const runs = Math.max(1, Math.floor(options.runs ?? profile.runs ?? 1));
  const startedAt = new Date().toISOString();
  const progress = options.onProgress;

  const launched = await launchBrowser(config.browser);
  const results: RunResult[] = [];
  try {
    for (let run = 1; run <= runs; run++) {
      progress?.(`run ${run}/${runs}: opening ${profile.url}`);
      results.push(await runOnce(launched, config, profile, run, runs, progress));
    }
  } finally {
    await launched.browser.close().catch(() => undefined);
  }

  const first = results[0];
  if (first === undefined) throw new ScriptlockError('NAVIGATION_FAILED', 'no run completed', { exitCode: 2 });

  const scripts = new Map<string, ObservedScript>();
  const frames = new Map<string, FrameInfo>();
  const warnings = new Set<string>();
  let blocked = first.blocked;
  for (const result of results) {
    for (const script of result.scripts) {
      const existing = scripts.get(script.id);
      if (existing === undefined) {
        scripts.set(script.id, { ...script, observedInRuns: 1 });
      } else {
        existing.observedInRuns += 1;
        // Across runs, keep the strictest scope the id was ever seen in.
        if (SCOPE_PRIORITY[script.scope] < SCOPE_PRIORITY[existing.scope]) {
          existing.scope = script.scope;
          existing.frameId = script.frameId;
          existing.frameUrl = script.frameUrl;
          existing.frameOrigin = script.frameOrigin;
          existing.target = script.target;
        }
      }
    }
    for (const frame of result.frames) {
      const key = frame.isMain ? 'main' : frame.url;
      if (!frames.has(key)) frames.set(key, frame);
    }
    for (const warning of result.warnings) warnings.add(warning);
    if (blocked === undefined && result.blocked !== undefined) blocked = result.blocked;
  }

  const snapshot: Snapshot = {
    version: 1,
    tool: { name: 'scriptlock', version: options.toolVersion },
    profile: options.profile,
    url: profile.url,
    finalUrl: first.finalUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    runs,
    vantage: first.vantage,
    documentStatus: first.documentStatus,
    headers: first.headers,
    frames: [...frames.values()],
    scripts: [...scripts.values()],
    warnings: [...warnings],
  };
  if (blocked !== undefined) snapshot.blocked = blocked;
  return snapshot;
}

async function runOnce(
  launched: LaunchedBrowser,
  config: ScriptlockConfig,
  profile: ProfileConfig,
  run: number,
  runs: number,
  progress: ScanOptions['onProgress'],
): Promise<RunResult> {
  const browserCfg = config.browser;
  const contextOptions: BrowserContextOptions = { viewport: browserCfg.viewport };
  if (browserCfg.userAgent !== undefined) contextOptions.userAgent = browserCfg.userAgent;
  if (browserCfg.locale !== undefined) contextOptions.locale = browserCfg.locale;
  if (browserCfg.timezoneId !== undefined) contextOptions.timezoneId = browserCfg.timezoneId;
  if (browserCfg.storageState !== undefined) contextOptions.storageState = browserCfg.storageState;
  if (browserCfg.extraHeaders !== undefined && Object.keys(browserCfg.extraHeaders).length > 0) {
    contextOptions.extraHTTPHeaders = browserCfg.extraHeaders;
  }

  const context = await launched.browser.newContext(contextOptions);
  context.setDefaultTimeout(browserCfg.timeoutMs);
  context.setDefaultNavigationTimeout(browserCfg.timeoutMs);
  await restrictExtraHeaders(context, browserCfg, profile.url);
  let capture: Capture | undefined;
  try {
    const page: Page = await context.newPage();
    capture = await attachCapture(context, page);
    const version = await capture.version();

    try {
      await page.goto(profile.url, { waitUntil: profile.wait, timeout: browserCfg.timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
      throw new ScriptlockError('NAVIGATION_FAILED', `navigation to ${profile.url} failed: ${message}`, { exitCode: 2, cause: error });
    }

    await runSteps(page, profile.steps, {
      baseUrl: profile.url,
      timeoutMs: browserCfg.timeoutMs,
      waitUntil: profile.wait,
      cwd: process.cwd(),
      onProgress: progress === undefined ? undefined : (message) => progress(`run ${run}/${runs}: ${message}`),
    });

    if (profile.settleMs > 0) {
      progress?.(`run ${run}/${runs}: settling ${profile.settleMs} ms`);
      await page.waitForTimeout(profile.settleMs);
    }
    await capture.settle();
    const finalUrl = await capture.refreshFrames();
    const html = await capture.documentHtml();
    await capture.settle();

    const vantage: Vantage = {
      userAgent: browserCfg.userAgent ?? version.userAgent,
      browser: describeBrowser(launched),
      headless: browserCfg.headless,
      channel: launched.channel,
      host: hostname(),
    };

    return buildRun(capture, config, finalUrl, html, vantage);
  } finally {
    await capture?.dispose();
    await context.close().catch(() => undefined);
  }
}

/**
 * Keeps `browser.extraHeaders` from leaking to third parties: the headers are
 * set on the context (so CDP capture is unaffected), and this route strips
 * them from every request whose host is not the profile host, a subdomain of
 * it, or listed in `browser.extraHeadersHosts` (DESIGN.md 3.1).
 */
async function restrictExtraHeaders(context: BrowserContext, cfg: BrowserConfig, profileUrl: string): Promise<void> {
  const extra = cfg.extraHeaders;
  if (extra === undefined || Object.keys(extra).length === 0) return;
  const names = Object.keys(extra).map((name) => name.toLowerCase());
  const allowHosts = cfg.extraHeadersHosts ?? [];
  const profileOrigin = originOf(profileUrl);
  await context.route('**/*', (route) => {
    const reqUrl = route.request().url();
    let allowed = false;
    try {
      const host = new URL(reqUrl).hostname;
      allowed = isFirstParty(reqUrl, profileOrigin) || (host !== '' && hostMatches(host, allowHosts));
    } catch {
      allowed = false;
    }
    if (allowed) {
      void route.continue();
      return;
    }
    const headers = { ...route.request().headers() };
    for (const key of Object.keys(headers)) {
      if (names.includes(key.toLowerCase())) delete headers[key];
    }
    void route.continue({ headers });
  });
}

/** Scope precedence for the same identity seen in two frames: merchant is strictest. */
const SCOPE_PRIORITY: Record<Scope, number> = { merchant: 0, tpsp: 1, threeds: 1, embedded: 2, harness: 3 };

/** True for Playwright's own default-world helper scripts (utility bundle, evaluate wrapper). */
function isHarnessSource(source: string): boolean {
  return source.includes('utilityScript.evaluate') || (source.includes('__commonJS') && source.includes('module.exports'));
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

function stripFragment(url: string): string {
  const index = url.indexOf('#');
  return index === -1 ? url : url.slice(0, index);
}

function isBlankUrl(url: string): boolean {
  return url === '' || url === 'about:blank' || url === 'about:srcdoc';
}

function formatStack(stack: RawStackFrame[]): string[] {
  return stack.map((frame) => `${frame.url}:${frame.line + 1}:${frame.column + 1}`);
}

function buildRun(capture: Capture, config: ScriptlockConfig, finalUrl: string, html: string, vantage: Vantage): RunResult {
  const warnings = [...capture.warnings];
  const mainFrameId = capture.mainFrameId;
  const mainOrigin = originOf(finalUrl);

  // Resolve blank frames (about:blank, srcdoc) to their nearest navigated ancestor.
  const effectiveFrameUrl = (frameId: string): string => {
    let current = capture.frames.get(frameId);
    let hops = 0;
    while (current !== undefined && isBlankUrl(current.url) && current.parentId !== undefined && hops < 32) {
      current = capture.frames.get(current.parentId);
      hops += 1;
    }
    return current?.url ?? '';
  };

  // Frames.
  const frames: FrameInfo[] = [];
  for (const raw of capture.frames.values()) {
    const isMain = raw.id === mainFrameId;
    if (!isMain && isBlankUrl(raw.url)) continue; // genuinely blank child frame (about:blank / srcdoc) is not a real frame
    const rawUrl = isMain ? finalUrl : effectiveFrameUrl(raw.id);
    if (!isMain && isBlankUrl(rawUrl)) continue;
    const origin = raw.securityOrigin !== '' && !isBlankUrl(raw.url) ? raw.securityOrigin : originOf(rawUrl);
    // FrameInfo.url is normalised so a provider frame keeps its identity across a
    // deploy (DESIGN.md 4.1); scope and origin are computed from the raw URL.
    const url = isMain ? finalUrl : normalizeUrl(rawUrl, config.identity);
    const frame: FrameInfo = {
      id: raw.id,
      url,
      origin,
      isMain,
      scope: classifyFrame({ url: rawUrl, isMain, mainOrigin }, config.scope),
      crossOrigin: !isMain && origin !== mainOrigin,
    };
    if (!isMain && rawUrl !== url) frame.rawUrl = rawUrl;
    if (raw.parentId !== undefined) frame.parentId = raw.parentId;
    frames.push(frame);
  }
  const frameById = new Map(frames.map((frame) => [frame.id, frame]));

  // Main document response: first Document response for the main frame.
  const mainDoc = [...capture.responses].sort((a, b) => a.order - b.order).find((r) => r.type === 'Document' && r.frameId === mainFrameId);
  const documentStatus = mainDoc?.status ?? 0;
  const headers = mainDoc === undefined ? {} : extractSecurityHeaders(mainDoc.headers);
  if (mainDoc === undefined) warnings.push('no main document response was observed; status and headers are unknown');
  else if (documentStatus < 200 || documentStatus > 299) {
    // A typo in profile.url or a page that is temporarily down otherwise yields
    // an empty but perfectly "clean" inventory (DESIGN.md 3.3).
    warnings.push(
      `the main document ${finalUrl} returned HTTP ${documentStatus}; this is probably an error page, so the inventory is not the page you meant to scan`,
    );
  }

  // Network indexes by URL (first request wins).
  const requestByUrl = new Map<string, RawRequest>();
  const documentUrls = new Set<string>();
  for (const request of [...capture.requests].sort((a, b) => a.order - b.order)) {
    if (request.type === 'Document') documentUrls.add(stripFragment(request.url));
    if (!requestByUrl.has(request.url)) requestByUrl.set(request.url, request);
  }
  const responseByUrl = new Map<string, Record<string, string>>();
  for (const response of [...capture.responses].sort((a, b) => a.order - b.order)) {
    if (!responseByUrl.has(response.url)) responseByUrl.set(response.url, response.headers);
  }
  for (const frame of capture.frames.values()) if (!isBlankUrl(frame.url)) documentUrls.add(stripFragment(frame.url));

  // Scripts.
  const scripts: ObservedScript[] = [];
  const idByRawKey = new Map<string, string>();
  const idByUrl = new Map<string, string>();
  const pendingInitiators: { script: ObservedScript; stack: RawStackFrame[] | undefined; sessionKey: string }[] = [];

  for (const raw of [...capture.scripts].sort((a, b) => a.order - b.order)) {
    const realUrl = raw.hasSourceURL ? raw.embedderName : raw.url;
    const kind = classifyKind(raw, realUrl, documentUrls, requestByUrl);
    if (kind === undefined) continue; // harness artefact

    const frameUrl = !isBlankUrl(raw.frameUrl) ? raw.frameUrl : effectiveFrameUrl(raw.frameId);
    const isMain = raw.frameId === mainFrameId;
    const frameOrigin = raw.frameOrigin !== '' && !isBlankUrl(raw.frameUrl) ? raw.frameOrigin : originOf(frameUrl);
    const scriptMainOrigin = raw.mainUrl !== '' ? originOf(raw.mainUrl) : mainOrigin;
    const scope: Scope = classifyFrame({ url: frameUrl, isMain, mainOrigin: scriptMainOrigin }, config.scope);

    // Body hashes: WebAssembly is hashed over its raw bytecode (its source text is
    // empty), everything else over the UTF-8 source.
    const isWasm = kind === 'wasm';
    const bodyBytes = isWasm && raw.bytecode !== undefined ? Buffer.from(raw.bytecode, 'base64') : undefined;
    const scriptSha = bodyBytes !== undefined ? sha256Bytes(bodyBytes) : sha256(raw.source);
    const scriptStruct = isWasm ? scriptSha : structuralHash(raw.source);
    const scriptSize = bodyBytes !== undefined ? bodyBytes.length : Buffer.byteLength(raw.source, 'utf8');

    const urlAddressed = kind !== 'inline' && kind !== 'eval';
    const id = deriveId(
      {
        kind,
        rawUrl: urlAddressed && realUrl !== '' ? realUrl : undefined,
        embedderName: urlAddressed && raw.embedderName !== '' ? raw.embedderName : undefined,
        frameOrigin,
        source: isWasm ? scriptSha : raw.source,
      },
      config.identity,
    );

    const script: ObservedScript = {
      id,
      kind,
      scope,
      hasSourceURL: raw.hasSourceURL,
      frameId: raw.frameId,
      frameUrl,
      frameOrigin,
      target: isMain ? 'page' : 'iframe',
      sha256: scriptSha,
      structuralHash: scriptStruct,
      size: scriptSize,
      isModule: raw.isModule,
      observedInRuns: 1,
    };
    if (urlAddressed && realUrl !== '') {
      script.url = id;
      script.rawUrl = realUrl;
      const entity = lookupEntity(realUrl);
      if (entity !== undefined) script.entity = entity;
      const responseHeaders = responseByUrl.get(realUrl);
      const picked = responseHeaders === undefined ? undefined : pickScriptResponseHeaders(responseHeaders);
      if (picked !== undefined) script.responseHeaders = picked;
    }
    if (raw.hasSourceURL && raw.url !== '') script.sourceUrl = raw.url;

    // Initiator: network initiator for URL-addressed scripts, parse-time stack otherwise.
    const request = urlAddressed && realUrl !== '' ? requestByUrl.get(realUrl) : undefined;
    let stack: RawStackFrame[] | undefined;
    let sessionKey = raw.sessionKey;
    if (request !== undefined) {
      const initiator: ScriptInitiator = { type: mapInitiatorType(request.initiator.type) };
      if (request.initiator.stack !== undefined && request.initiator.stack.length > 0) {
        initiator.type = 'script';
        initiator.url = request.initiator.stack[0]?.url ?? '';
        initiator.stack = formatStack(request.initiator.stack);
        stack = request.initiator.stack;
        sessionKey = request.sessionKey;
      } else if (request.initiator.url !== undefined) {
        initiator.url = request.initiator.url;
      }
      script.initiator = initiator;
    } else if (raw.stack !== undefined && raw.stack.length > 0) {
      script.initiator = { type: 'script', url: raw.stack[0]?.url ?? '', stack: formatStack(raw.stack) };
      stack = raw.stack;
    } else if (kind === 'inline') {
      script.initiator = { type: 'parser', url: frameUrl };
    } else if (kind === 'eval') {
      script.initiator = { type: 'other' };
    }

    const rawKey = `${raw.sessionKey}:${raw.scriptId}`;
    if (!idByRawKey.has(rawKey)) idByRawKey.set(rawKey, id);
    if (script.rawUrl !== undefined && !idByUrl.has(script.rawUrl)) idByUrl.set(script.rawUrl, id);
    const duplicate = scripts.find((existing) => existing.id === id);
    if (duplicate !== undefined) {
      if (script.rawUrl !== undefined && duplicate.rawUrl !== undefined && script.rawUrl !== duplicate.rawUrl) {
        // Two different files normalised to one identity, so only the first is
        // in the inventory. Never silent: an executed script must not vanish.
        warnings.push(
          `${duplicate.rawUrl} and ${script.rawUrl} normalise to the same identity ${id}; only the first is recorded, so the inventory is missing one script (set identity.collapseHashes to false, or keepQuery the parameter that distinguishes them)`,
        );
      }
      // Same identity in two frames of one run: keep the strictest scope so a
      // script that also runs in the merchant frame still gates (DESIGN.md 5).
      if (SCOPE_PRIORITY[script.scope] < SCOPE_PRIORITY[duplicate.scope]) {
        warnings.push(
          `script ${id} runs in both ${duplicate.scope} (${duplicate.frameUrl}) and ${script.scope} (${frameUrl}); recording it in ${script.scope} scope`,
        );
        duplicate.scope = script.scope;
        duplicate.frameId = script.frameId;
        duplicate.frameUrl = script.frameUrl;
        duplicate.frameOrigin = script.frameOrigin;
        duplicate.target = script.target;
      }
      continue;
    }
    scripts.push(script);
    pendingInitiators.push({ script, stack, sessionKey });
  }

  // Second pass: resolve initiating script ids now that every id is known.
  for (const { script, stack, sessionKey } of pendingInitiators) {
    if (script.initiator === undefined || stack === undefined) continue;
    const top = stack[0];
    if (top === undefined) continue;
    const resolved = idByRawKey.get(`${sessionKey}:${top.scriptId}`) ?? idByUrl.get(top.url);
    if (resolved !== undefined && resolved !== script.id) {
      script.initiator.scriptId = resolved;
      script.loadedBy = resolved;
    }
  }

  // Worker entries: URL only, no body.
  const seenWorkers = new Set<string>();
  for (const worker of capture.workers) {
    if (seenWorkers.has(worker.url)) continue;
    seenWorkers.add(worker.url);
    const workerOrigin = originOf(worker.url);
    const frame = frames.find((f) => f.origin === workerOrigin) ?? frameById.get(mainFrameId);
    const frameUrl = frame?.url ?? finalUrl;
    const frameOrigin = frame?.origin ?? mainOrigin;
    const id = deriveId({ kind: 'worker', rawUrl: worker.url, frameOrigin, source: '' }, config.identity);
    if (scripts.some((existing) => existing.id === id)) continue;
    const script: ObservedScript = {
      id,
      kind: 'worker',
      scope: frame?.scope ?? 'merchant',
      url: id,
      rawUrl: worker.url,
      hasSourceURL: false,
      frameId: frame?.id ?? mainFrameId,
      frameUrl,
      frameOrigin,
      target: worker.target,
      size: 0,
      isModule: false,
      observedInRuns: 1,
    };
    const entity = lookupEntity(worker.url);
    if (entity !== undefined) script.entity = entity;
    const request = requestByUrl.get(worker.url);
    if (request !== undefined) {
      const initiator: ScriptInitiator = { type: mapInitiatorType(request.initiator.type) };
      if (request.initiator.url !== undefined) initiator.url = request.initiator.url;
      script.initiator = initiator;
      const responseHeaders = responseByUrl.get(worker.url);
      const picked = responseHeaders === undefined ? undefined : pickScriptResponseHeaders(responseHeaders);
      if (picked !== undefined) script.responseHeaders = picked;
    }
    scripts.push(script);
    warnings.push(`worker ${worker.url}: body not captured (worker bodies are out of scope in v1); recorded with url-only integrity and no body hash`);
  }

  const title = extractTitle(html);
  const blocked = detectBlocked({ status: documentStatus, title, html, url: finalUrl, ...(mainDoc !== undefined ? { headers: mainDoc.headers } : {}) });

  const result: RunResult = { finalUrl, documentStatus, headers, frames, scripts, blocked: undefined, warnings, vantage };
  if (blocked !== undefined) result.blocked = blocked;
  return result;
}

function classifyKind(
  raw: RawScript,
  realUrl: string,
  documentUrls: Set<string>,
  requestByUrl: Map<string, RawRequest>,
): ScriptKind | undefined {
  if (raw.language === 'WebAssembly') return 'wasm';
  if (realUrl === '') {
    // Default-world script with no URL. Playwright's own helpers (the utility
    // bundle and the evaluate wrapper) are dropped by source signature; every
    // other anonymous script, stackless or not, is page code: eval, new
    // Function, a setTimeout / setInterval string, or a javascript: URL.
    if (isHarnessSource(raw.source)) return undefined;
    return 'eval';
  }
  if (realUrl.startsWith('blob:')) return 'blob';
  if (realUrl.startsWith('data:')) return 'data';
  const bare = stripFragment(realUrl);
  if (bare === stripFragment(raw.frameUrl) || documentUrls.has(bare)) return 'inline';
  const request = requestByUrl.get(realUrl);
  if (request !== undefined && request.type === 'Script') return 'external';
  if (request !== undefined && request.type === 'Document') return 'inline';
  if (request === undefined && (raw.startLine > 0 || raw.startColumn > 0)) return 'inline';
  return 'external';
}

function mapInitiatorType(type: string): ScriptInitiator['type'] {
  if (type === 'parser') return 'parser';
  if (type === 'script') return 'script';
  return 'other';
}
