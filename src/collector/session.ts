/**
 * CDP attach and raw event capture (DESIGN.md 3.2).
 *
 * Owns one Capture per page: a CDP session on the page (before navigation)
 * with Page, Runtime, Debugger and Network enabled. Out-of-process iframes are
 * caught before they run through non-flattened `Target.setAutoAttach`
 * (`waitForDebugger`): each child target is wired over the parent session with
 * `Target.sendMessageToTarget` / `receivedMessageFromTarget` (playwright-core's
 * public CDPSession has no per-sessionId send), enabled, then resumed, so a
 * parser-inserted subresource in a cross-origin frame keeps its network
 * initiator and response headers. Records every Debugger.scriptParsed with its
 * source (fetched immediately, before V8 can evict it), Network requests and
 * responses, frame tree updates and worker entries. Nothing is evaluated in
 * the page: no page.evaluate, no init scripts.
 *
 * Limitations: worker and service worker bodies are not captured (only the
 * entry URL is recorded); such targets are resumed but not wired. In-process
 * iframes share the parent session and are covered without a child session.
 * `Debugger.setSkipAllPauses` keeps a page `debugger` statement from stalling
 * the scan, and every attached target is resumed so a paused one never stalls
 * navigation.
 */
import type { BrowserContext, CDPSession, Page } from 'playwright-core';

export interface RawStackFrame {
  url: string;
  scriptId: string;
  /** 0-based, as reported by CDP. */
  line: number;
  column: number;
}

export interface RawScript {
  /** Session the script was reported on; V8 script ids are unique per session. */
  sessionKey: string;
  scriptId: string;
  /** `Debugger.scriptParsed.url`; rewritten by a sourceURL comment. */
  url: string;
  embedderName: string;
  hasSourceURL: boolean;
  isModule: boolean;
  language: 'JavaScript' | 'WebAssembly';
  startLine: number;
  startColumn: number;
  frameId: string;
  /** URL of the frame at parse time. */
  frameUrl: string;
  /** Security origin of the frame at parse time, when known. */
  frameOrigin: string;
  /** URL of the main frame at parse time. */
  mainUrl: string;
  contextType: string;
  contextIsDefault: boolean;
  stack?: RawStackFrame[];
  source: string;
  /** Base64 WebAssembly bytecode, when the parsed script is a Wasm module. */
  bytecode?: string;
  /** Arrival order, for stable output. */
  order: number;
}

export interface RawInitiator {
  type: string;
  url?: string;
  stack?: RawStackFrame[];
}

export interface RawRequest {
  sessionKey: string;
  requestId: string;
  url: string;
  type: string;
  frameId: string;
  documentUrl: string;
  initiator: RawInitiator;
  order: number;
}

export interface RawResponse {
  requestId: string;
  url: string;
  type: string;
  frameId: string;
  status: number;
  headers: Record<string, string>;
  order: number;
}

export interface RawFrame {
  id: string;
  url: string;
  parentId?: string;
  securityOrigin: string;
}

export interface RawWorker {
  url: string;
  target: 'worker' | 'service_worker';
}

export interface Capture {
  mainFrameId: string;
  scripts: RawScript[];
  requests: RawRequest[];
  responses: RawResponse[];
  frames: Map<string, RawFrame>;
  workers: RawWorker[];
  warnings: string[];
  /** Waits for in-flight source fetches. Call after the settle period. */
  settle(): Promise<void>;
  /** Refreshes the frame map from every session's frame tree and returns the main frame URL. */
  refreshFrames(): Promise<string>;
  /** Outer HTML of the main document via the DOM domain (no script injection). */
  documentHtml(): Promise<string>;
  /** Browser.getVersion over CDP. */
  version(): Promise<{ product: string; userAgent: string }>;
  /** Detaches every session; safe to call more than once. */
  dispose(): Promise<void>;
}

// Minimal structural views of the CDP payloads we consume. Playwright's
// Protocol namespace is not part of its package exports.
interface AuxData {
  frameId?: string;
  type?: string;
  isDefault?: boolean | string;
}
interface CdpStackTrace {
  callFrames: { url: string; scriptId: string; lineNumber: number; columnNumber: number }[];
}
interface CdpFrame {
  id: string;
  parentId?: string;
  url: string;
  securityOrigin: string;
}
interface CdpFrameTree {
  frame: CdpFrame;
  childFrames?: CdpFrameTree[];
}

function toStack(trace: CdpStackTrace | undefined, limit = 8): RawStackFrame[] | undefined {
  if (trace === undefined || trace.callFrames.length === 0) return undefined;
  return trace.callFrames.slice(0, limit).map((frame) => ({
    url: frame.url,
    scriptId: frame.scriptId,
    line: frame.lineNumber,
    column: frame.columnNumber,
  }));
}

interface SessionLike {
  send(method: string, params?: object): Promise<any>;
  on(event: string, handler: (params: any) => void): void;
}

/** Wraps a Playwright CDPSession as the minimal SessionLike used by `wire`. */
function adapt(session: CDPSession): SessionLike {
  return {
    send: session.send.bind(session) as unknown as (method: string, params?: object) => Promise<any>,
    on: session.on.bind(session) as unknown as (event: string, handler: (params: any) => void) => void,
  };
}

/**
 * A non-flattened child target (out-of-process iframe or worker) reached
 * through its parent session: commands go out as `Target.sendMessageToTarget`
 * and replies / events come back as `Target.receivedMessageFromTarget`, fed in
 * through `dispatch`. Each event is registered once, so a single handler per
 * method is enough.
 */
class ChildSession implements SessionLike {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly handlers = new Map<string, (params: any) => void>();
  constructor(
    private readonly parent: SessionLike,
    private readonly sessionId: string,
  ) {}
  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.parent
        .send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) })
        .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    });
  }
  on(event: string, handler: (params: any) => void): void {
    this.handlers.set(event, handler);
  }
  dispatch(message: string): void {
    let msg: { id?: number; error?: { message?: string }; result?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const callback = this.pending.get(msg.id);
      if (callback === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) callback.reject(new Error(msg.error.message ?? 'CDP error'));
      else callback.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') this.handlers.get(msg.method)?.(msg.params);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}

export async function attachCapture(context: BrowserContext, page: Page): Promise<Capture> {
  const scripts: RawScript[] = [];
  const requests: RawRequest[] = [];
  const responses: RawResponse[] = [];
  const frames = new Map<string, RawFrame>();
  const workers: RawWorker[] = [];
  const warnings: string[] = [];
  const pending = new Set<Promise<void>>();
  const sessions: SessionLike[] = [];
  const childBySessionId = new Map<string, ChildSession>();
  let order = 0;
  let mainFrameId = '';
  let disposed = false;

  const mainUrl = (): string => frames.get(mainFrameId)?.url ?? '';

  const walkTree = (tree: CdpFrameTree): void => {
    const existing = frames.get(tree.frame.id);
    const frame: RawFrame = {
      id: tree.frame.id,
      url: tree.frame.url || existing?.url || '',
      securityOrigin: tree.frame.securityOrigin || existing?.securityOrigin || '',
    };
    const parentId = tree.frame.parentId ?? existing?.parentId;
    if (parentId !== undefined) frame.parentId = parentId;
    frames.set(frame.id, frame);
    for (const child of tree.childFrames ?? []) walkTree(child);
  };

  const wire = async (session: SessionLike, key: string): Promise<void> => {
    sessions.push(session);

    session.on('Target.attachedToTarget', (event) => {
      void handleAttached(session, event);
    });
    session.on('Target.receivedMessageFromTarget', (event) => {
      if (typeof event.sessionId === 'string') childBySessionId.get(event.sessionId)?.dispatch(event.message);
    });
    session.on('Target.detachedFromTarget', (event) => {
      if (typeof event.sessionId === 'string') childBySessionId.delete(event.sessionId);
    });

    session.on('Page.frameAttached', (event) => {
      if (!frames.has(event.frameId)) {
        frames.set(event.frameId, { id: event.frameId, url: '', parentId: event.parentFrameId, securityOrigin: '' });
      }
    });
    session.on('Page.frameNavigated', (event) => {
      walkTree({ frame: event.frame as CdpFrame });
    });
    session.on('Page.navigatedWithinDocument', (event) => {
      const frame = frames.get(event.frameId);
      if (frame !== undefined) frame.url = event.url;
    });

    session.on('Network.requestWillBeSent', (event) => {
      const initiator: RawInitiator = { type: event.initiator.type };
      if (event.initiator.url !== undefined) initiator.url = event.initiator.url;
      const stack = toStack(event.initiator.stack as CdpStackTrace | undefined);
      if (stack !== undefined) initiator.stack = stack;
      requests.push({
        sessionKey: key,
        requestId: event.requestId,
        url: event.request.url,
        type: event.type ?? 'Other',
        frameId: event.frameId ?? '',
        documentUrl: event.documentURL,
        initiator,
        order: order++,
      });
    });
    session.on('Network.responseReceived', (event) => {
      responses.push({
        requestId: event.requestId,
        url: event.response.url,
        type: event.type,
        frameId: event.frameId ?? '',
        status: event.response.status,
        headers: { ...event.response.headers },
        order: order++,
      });
    });

    session.on('Debugger.scriptParsed', (event) => {
      const aux = (event.executionContextAuxData ?? {}) as AuxData;
      const frameId = aux.frameId ?? '';
      const frame = frames.get(frameId);
      const record: RawScript = {
        sessionKey: key,
        scriptId: event.scriptId,
        url: event.url,
        embedderName: event.embedderName ?? '',
        hasSourceURL: event.hasSourceURL === true,
        isModule: event.isModule === true,
        language: event.scriptLanguage === 'WebAssembly' ? 'WebAssembly' : 'JavaScript',
        startLine: event.startLine,
        startColumn: event.startColumn,
        frameId,
        frameUrl: frame?.url ?? '',
        frameOrigin: frame?.securityOrigin ?? '',
        mainUrl: mainUrl(),
        contextType: aux.type ?? 'default',
        contextIsDefault: aux.isDefault === undefined ? true : aux.isDefault === true || aux.isDefault === 'true',
        source: '',
        order: order++,
      };
      const stack = toStack(event.stackTrace as CdpStackTrace | undefined);
      if (stack !== undefined) record.stack = stack;

      // Playwright's isolated utility worlds are harness; skip them here. Every
      // default-world script is fetched and kept, then collect.ts drops the two
      // Playwright helper scripts (utility bundle, evaluate wrapper) by source
      // signature, so page code compiled without a URL (setTimeout / setInterval
      // strings, javascript: URLs) is never dropped for lacking a stack trace.
      if (!record.contextIsDefault || record.contextType !== 'default') return;

      const fetch = session
        .send('Debugger.getScriptSource', { scriptId: event.scriptId })
        .then((result) => {
          record.source = result.scriptSource;
          if (result.bytecode !== undefined) record.bytecode = result.bytecode;
          scripts.push(record);
        })
        .catch((error: unknown) => {
          if (disposed) return;
          const label = record.url !== '' ? record.url : `anonymous script ${event.scriptId}`;
          warnings.push(`could not fetch source for ${label}: ${errorMessage(error)}; script skipped`);
        });
      const tracked = fetch.finally(() => pending.delete(tracked));
      pending.add(tracked);
    });

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Debugger.enable');
    await session.send('Debugger.setSkipAllPauses', { skip: true });
    await session.send('Network.enable');
    // Catch out-of-process iframes before they run. flatten:false is required:
    // playwright-core's CDPSession has no per-sessionId send, so a flattened
    // child could never be resumed. Failures (e.g. on a plain page target) are ignored.
    await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false }).catch(() => undefined);
    const tree = await session.send('Page.getFrameTree');
    walkTree(tree.frameTree as CdpFrameTree);
    return;
  };

  let oopifCounter = 0;
  const handleAttached = async (parent: SessionLike, event: { sessionId?: string; targetInfo?: { type?: string; url?: string }; waitingForDebugger?: boolean }): Promise<void> => {
    if (disposed) return;
    const sessionId = event.sessionId;
    if (typeof sessionId !== 'string' || childBySessionId.has(sessionId)) return;
    const targetInfo = event.targetInfo ?? {};
    const child = new ChildSession(parent, sessionId);
    childBySessionId.set(sessionId, child);
    try {
      if (targetInfo.type === 'iframe' || targetInfo.type === 'page') {
        oopifCounter += 1;
        await wire(child, `oopif-${oopifCounter}`);
      }
    } catch (error) {
      if (!disposed) warnings.push(`could not capture ${targetInfo.type ?? 'child'} target ${targetInfo.url ?? ''}: ${errorMessage(error)}`);
    } finally {
      // Resume every target paused at start, even a worker we did not wire, so it never stalls the page.
      if (event.waitingForDebugger === true) await child.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
    }
  };

  const mainSession = await context.newCDPSession(page);
  await wire(adapt(mainSession), 'main');
  mainFrameId = (await mainSession.send('Page.getFrameTree')).frameTree.frame.id;

  page.on('worker', (worker) => {
    workers.push({ url: worker.url(), target: 'worker' });
  });
  context.on('serviceworker', (worker) => {
    workers.push({ url: worker.url(), target: 'service_worker' });
  });

  return {
    get mainFrameId() {
      return mainFrameId;
    },
    scripts,
    requests,
    responses,
    frames,
    workers,
    warnings,
    async settle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    async refreshFrames() {
      for (const session of sessions) {
        try {
          const tree = await session.send('Page.getFrameTree');
          walkTree(tree.frameTree as CdpFrameTree);
        } catch {
          // Session detached (frame removed); keep what we have.
        }
      }
      return mainUrl() || page.url();
    },
    async documentHtml() {
      try {
        const doc = await mainSession.send('DOM.getDocument', { depth: 0 });
        const html = await mainSession.send('DOM.getOuterHTML', { nodeId: doc.root.nodeId });
        return html.outerHTML;
      } catch (error) {
        warnings.push(`could not read the main document HTML: ${errorMessage(error)}`);
        return '';
      }
    },
    async version() {
      const info = await mainSession.send('Browser.getVersion');
      return { product: info.product, userAgent: info.userAgent };
    },
    async dispose() {
      disposed = true;
      childBySessionId.clear();
      // Only the main session is a real CDPSession; child shims tear down with it.
      try {
        await mainSession.detach();
      } catch {
        // Already closed with the page.
      }
    },
  };
}
