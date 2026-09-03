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
import { errorMessage } from '../errors.js';

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

// ---------------------------------------------------------------------------
// The CDP boundary
// ---------------------------------------------------------------------------
//
// Commands are typed by playwright-core: `CDPSession['send']` is a single
// generic signature over the Protocol namespace, so it can be captured by name
// even though that namespace is not part of the package's exports map.
//
// Events are not: all five `CDPSession` listener methods are overloaded, so the
// payload types cannot be recovered through `Parameters<>`. The shapes below
// are therefore hand-mirrored from the CDP protocol. They cover only the events
// this module consumes and only the fields it reads, which is the point: a
// field the collector has not declared is a compile error rather than a silent
// `undefined` on page-controlled data.

/** Command half of a CDP session, with playwright's own per-method typing. */
type CdpSend = CDPSession['send'];

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

/** The CDP events `wire` subscribes to, and the fields it reads from each. */
interface CdpEvents {
  'Target.attachedToTarget': {
    sessionId?: string;
    targetInfo?: { type?: string; url?: string };
    waitingForDebugger?: boolean;
  };
  'Target.receivedMessageFromTarget': { sessionId?: string; message: string };
  'Target.detachedFromTarget': { sessionId?: string };
  'Page.frameAttached': { frameId: string; parentFrameId: string };
  'Page.frameNavigated': { frame: CdpFrame };
  'Page.navigatedWithinDocument': { frameId: string; url: string };
  'Network.requestWillBeSent': {
    requestId: string;
    request: { url: string };
    type?: string;
    frameId?: string;
    documentURL: string;
    initiator: { type: string; url?: string; stack?: CdpStackTrace };
  };
  'Network.responseReceived': {
    requestId: string;
    type: string;
    frameId?: string;
    response: { url: string; status: number; headers: Record<string, string> };
  };
  'Debugger.scriptParsed': {
    scriptId: string;
    url: string;
    embedderName?: string;
    hasSourceURL?: boolean;
    isModule?: boolean;
    scriptLanguage?: string;
    startLine: number;
    startColumn: number;
    executionContextAuxData?: AuxData;
    stackTrace?: CdpStackTrace;
  };
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
  send: CdpSend;
  on<K extends keyof CdpEvents>(event: K, handler: (params: CdpEvents[K]) => void): void;
}

/** Wraps a Playwright CDPSession as the minimal SessionLike used by `wire`. */
function adapt(session: CDPSession): SessionLike {
  return {
    send: session.send.bind(session),
    // The listener overloads cannot be expressed generically, so the event map
    // is applied here once instead of at every subscription.
    on: (event, handler) => {
      (session.on as unknown as (name: string, listener: (params: never) => void) => void)(event, handler as (params: never) => void);
    },
  };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A non-flattened child target (out-of-process iframe or worker) reached
 * through its parent session: commands go out as `Target.sendMessageToTarget`
 * and replies / events come back as `Target.receivedMessageFromTarget`, fed in
 * through `dispatch`. Each event is registered once, so a single handler per
 * method is enough.
 *
 * Every command is raced against `timeoutMs` and every unanswered command is
 * rejected by `close()`. A child target can go away after the parent accepted
 * `Target.sendMessageToTarget` but before the reply arrives, and the reply is
 * the only thing that settles the promise: without both, one torn-down
 * cross-origin iframe would hang `refreshFrames()` — and with it the whole
 * scan — for ever, since `context.setDefaultTimeout` does not reach raw CDP.
 */
class ChildSession implements SessionLike {
  private nextId = 1;
  private closed: Error | undefined;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly handlers = new Map<string, (params: never) => void>();

  constructor(
    private readonly parent: SessionLike,
    private readonly sessionId: string,
    private readonly timeoutMs: number,
  ) {}

  // The method name is dynamic, which is the whole point of this class, so the
  // one honest cast in this file lives here rather than at every call site.
  readonly send = ((method: string, params: object = {}): Promise<unknown> => this.sendRaw(method, params)) as unknown as CdpSend;

  private sendRaw(method: string, params: object): Promise<unknown> {
    if (this.closed !== undefined) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id)?.reject(new Error(`CDP command ${method} on a child target timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.parent
        .send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) })
        .catch((error: unknown) => {
          this.settle(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /** Removes the command from the pending map and stops its timer, once. */
  private settle(id: number): PendingCommand | undefined {
    const command = this.pending.get(id);
    if (command === undefined) return undefined;
    this.pending.delete(id);
    clearTimeout(command.timer);
    return command;
  }

  on<K extends keyof CdpEvents>(event: K, handler: (params: CdpEvents[K]) => void): void {
    this.handlers.set(event, handler as (params: never) => void);
  }

  dispatch(message: string): void {
    let msg: { id?: number; error?: { message?: string }; result?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(message) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const command = this.settle(msg.id);
      if (command === undefined) return;
      if (msg.error) command.reject(new Error(msg.error.message ?? 'CDP error'));
      else command.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') this.handlers.get(msg.method)?.(msg.params as never);
  }

  /** Rejects every command still waiting for a reply that will never come. */
  close(reason: Error): void {
    this.closed = reason;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(reason);
  }
}


/**
 * Attaches to `page` before navigation and returns the Capture. `timeoutMs`
 * bounds every command sent to a child target; the main session is bounded by
 * Playwright's own context timeout.
 */
export async function attachCapture(context: BrowserContext, page: Page, timeoutMs: number): Promise<Capture> {
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
      if (typeof event.sessionId !== 'string') return;
      const child = childBySessionId.get(event.sessionId);
      childBySessionId.delete(event.sessionId);
      // The reply to an in-flight command can no longer arrive: fail it now, or
      // the next refreshFrames() waits on it for the rest of the scan.
      child?.close(new Error('the child target detached before the command was answered'));
    });

    session.on('Page.frameAttached', (event) => {
      if (!frames.has(event.frameId)) {
        frames.set(event.frameId, { id: event.frameId, url: '', parentId: event.parentFrameId, securityOrigin: '' });
      }
    });
    session.on('Page.frameNavigated', (event) => {
      walkTree({ frame: event.frame });
    });
    session.on('Page.navigatedWithinDocument', (event) => {
      const frame = frames.get(event.frameId);
      if (frame !== undefined) frame.url = event.url;
    });

    session.on('Network.requestWillBeSent', (event) => {
      const initiator: RawInitiator = { type: event.initiator.type };
      if (event.initiator.url !== undefined) initiator.url = event.initiator.url;
      const stack = toStack(event.initiator.stack);
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
      const aux = event.executionContextAuxData ?? {};
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
      const stack = toStack(event.stackTrace);
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
    walkTree(tree.frameTree);
    return;
  };

  let oopifCounter = 0;
  const handleAttached = async (parent: SessionLike, event: { sessionId?: string; targetInfo?: { type?: string; url?: string }; waitingForDebugger?: boolean }): Promise<void> => {
    if (disposed) return;
    const sessionId = event.sessionId;
    if (typeof sessionId !== 'string' || childBySessionId.has(sessionId)) return;
    const targetInfo = event.targetInfo ?? {};
    const child = new ChildSession(parent, sessionId, timeoutMs);
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
          walkTree(tree.frameTree);
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
      for (const child of childBySessionId.values()) child.close(new Error('the capture was disposed'));
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
