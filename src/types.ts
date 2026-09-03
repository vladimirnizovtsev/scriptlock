/**
 * Shared domain types for Tessera.
 *
 * This file is the contract between modules. Keep it dependency-free
 * (no imports from other project modules) so every module can import it
 * without cycles.
 */

// ---------------------------------------------------------------------------
// Scripts observed during a scan
// ---------------------------------------------------------------------------

/** How the script reached the JavaScript engine. */
export type ScriptKind =
  | 'external' // <script src> or dynamically inserted <script src>, any origin
  | 'inline' // <script> block in markup (classic or module)
  | 'eval' // eval(), new Function(), setTimeout(string), javascript: URLs, any anonymous code compiled without a URL
  | 'blob' // blob: URL
  | 'data' // data: URL
  | 'wasm' // WebAssembly module
  | 'worker' // dedicated worker or service worker entry script
  | 'unknown';

/**
 * Who is responsible for the script under the PCI SSC responsibility split
 * (Information Supplement "Payment Page Security and Preventing E-Skimming",
 * March 2025, Table 3).
 *
 * - merchant: scripts on the page that embeds the payment form (parent page)
 *   and any same-origin frames. These gate the diff.
 * - tpsp: scripts inside a payment provider iframe. Collected and tagged;
 *   a merely new tpsp script is informational, but an approved tpsp entry
 *   with a strict or structural policy is still gated on changed, moved and
 *   spoofed like any other entry.
 * - threeds: scripts inside a 3-D Secure / ACS challenge frame. Exempt.
 * - embedded: scripts inside a cross-origin iframe that is neither a known
 *   payment provider nor 3DS (chat widgets, ads). Informational by default.
 * - harness: scripts injected by the automation harness itself (Playwright
 *   utility worlds, page.evaluate). Always dropped from the inventory.
 */
export type Scope = 'merchant' | 'tpsp' | 'threeds' | 'embedded' | 'harness';

export type TargetType = 'page' | 'iframe' | 'worker' | 'service_worker';

export interface FrameInfo {
  /** CDP frame id (stable within a run only). */
  id: string;
  /**
   * Normalised URL for child frames (DESIGN.md 4.1: hash-like path tokens
   * become `[hash]`, cache busters are dropped), so a frame keeps its
   * identity across a provider deploy. The main frame keeps its final URL.
   */
  url: string;
  /** URL exactly as observed, before normalisation. Absent for the main frame. */
  rawUrl?: string;
  origin: string;
  isMain: boolean;
  parentId?: string;
  /** Scope assigned to the frame; scripts inside inherit it unless overridden. */
  scope: Scope;
  /** True when the frame is a cross-origin (out-of-process) iframe. */
  crossOrigin: boolean;
}

export interface ScriptInitiator {
  /** parser: static markup; script: inserted by another script; other: unknown. */
  type: 'parser' | 'script' | 'other';
  /** URL of the document or script that caused the load, when known. */
  url?: string;
  /** Tessera id of the initiating script, when it can be resolved. */
  scriptId?: string;
  /** Top frames of the stack trace, most recent first, as "url:line:col". */
  stack?: string[];
}

export interface ScriptEntity {
  /** Entity name from third-party-web, e.g. "Stripe", "Google Tag Manager". */
  name: string;
  /** Category from third-party-web, e.g. "tag-manager", "analytics". */
  category: string;
}

export interface ObservedScript {
  /**
   * Stable identity used to match the manifest. Derived by the identity module:
   * - external / blob / data / worker: normalised URL (see DESIGN.md "Identity")
   * - inline: `inline:<frame origin>:<structural hash prefix>`
   * - eval: `eval:<frame origin>:<structural hash prefix>`
   */
  id: string;
  kind: ScriptKind;
  scope: Scope;
  /** Normalised URL for URL-addressed scripts. Absent for inline / eval. */
  url?: string;
  /** URL exactly as observed, before normalisation. */
  rawUrl?: string;
  /**
   * The URL the script claims through a `//# sourceURL=` comment. Attacker
   * controlled; never used for identity. Present only when hasSourceURL is true.
   */
  sourceUrl?: string;
  hasSourceURL: boolean;
  /** Frame the script executed in. */
  frameId: string;
  frameUrl: string;
  frameOrigin: string;
  target: TargetType;
  /**
   * Hex SHA-256 over the UTF-8 bytes of the script source as returned by the
   * engine (over the raw bytecode for WebAssembly). Absent when the body was
   * not captured: worker entries in version 1, for which only the entry URL is
   * known.
   */
  sha256?: string;
  /**
   * Hex SHA-256 over the structurally normalised source (string literals,
   * numeric literals and whitespace masked). Used for `structural` integrity
   * and for inline / eval identity. See DESIGN.md "Structural hash". Absent
   * when the body was not captured (see `sha256`).
   */
  structuralHash?: string;
  /** Length of the source in bytes (UTF-8); 0 when the body was not captured. */
  size: number;
  isModule: boolean;
  initiator?: ScriptInitiator;
  /**
   * Tessera id of the script that inserted this one, when it can be resolved
   * from the initiator. Enables "child of GTM" grouping in reports.
   */
  loadedBy?: string;
  entity?: ScriptEntity;
  /** Subset of response headers for URL-addressed scripts. */
  responseHeaders?: {
    contentType?: string;
    cacheControl?: string;
    lastModified?: string;
    etag?: string;
  };
  /** Number of runs (out of Snapshot.runs) in which the script was observed. */
  observedInRuns: number;
  /** Source text, only kept in memory during a scan; never written to the snapshot. */
  source?: string;
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

/**
 * Security-impacting HTTP headers of the main document, lower-case names,
 * raw values. Only headers that were present are set.
 */
export type SecurityHeaderName =
  | 'content-security-policy'
  | 'content-security-policy-report-only'
  | 'strict-transport-security'
  | 'x-frame-options'
  | 'x-content-type-options'
  | 'referrer-policy'
  | 'permissions-policy'
  | 'cross-origin-opener-policy'
  | 'cross-origin-embedder-policy'
  | 'cross-origin-resource-policy';

export const SECURITY_HEADER_NAMES: readonly SecurityHeaderName[] = [
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
];

export type SecurityHeaders = Partial<Record<SecurityHeaderName, string>>;

// ---------------------------------------------------------------------------
// Snapshot: the output of one `tessera scan`
// ---------------------------------------------------------------------------

export interface Vantage {
  userAgent: string;
  /** e.g. "chromium 151.0.7922.34 (headless-shell)" */
  browser: string;
  headless: boolean;
  /** Playwright channel or executable path used. */
  channel?: string;
  /** Host name of the machine that ran the scan. */
  host?: string;
}

export interface BlockedInfo {
  /** Detected bot-management vendor, e.g. "cloudflare", "akamai", "datadome", or "unknown". */
  vendor: string;
  /** Human-readable evidence, e.g. "title contains 'Just a moment...'". */
  evidence: string;
}

export interface Snapshot {
  version: 1;
  tool: { name: 'tessera'; version: string };
  profile: string;
  /** Start URL from the profile. */
  url: string;
  /** URL of the main frame when collection finished. */
  finalUrl: string;
  startedAt: string;
  finishedAt: string;
  /** Number of runs unioned into this snapshot. */
  runs: number;
  vantage: Vantage;
  documentStatus: number;
  headers: SecurityHeaders;
  frames: FrameInfo[];
  scripts: ObservedScript[];
  /** Set when a bot-management challenge page was detected; inventory is then unreliable. */
  blocked?: BlockedInfo;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Manifest: tessera.lock.yaml
// ---------------------------------------------------------------------------

/**
 * How the body of a script is enforced.
 *
 * - strict: sha256 must equal the approved value. Any change is `changed` (fail).
 * - structural: structuralHash must equal the approved value; literal-only
 *   changes are ignored. For inline scripts carrying per-request state.
 * - track: body changes are recorded as `changed` at info severity and
 *   never fail. For evergreen third-party scripts (gtm.js, Stripe.js v3).
 * - url-only: only identity is enforced; body changes are not reported.
 */
export type IntegrityPolicy = 'strict' | 'structural' | 'track' | 'url-only';

/**
 * What actually assures the integrity of the script in production. Reported
 * next to the entry so a `track` or `url-only` policy is never read as
 * "integrity covered". Maps to the 6.4.3.b evidence row.
 */
export type IntegrityMethod =
  | 'hash-strict' // Tessera enforces the body hash on every run
  | 'sri' // the page uses Subresource Integrity for this script
  | 'csp' // a Content Security Policy restricts the source
  | 'vendor-attested' // the vendor provides its own integrity assurance
  | 'source-tracked' // only the source URL is controlled
  | 'none';

export type ScriptCategory =
  | 'payment'
  | 'functional'
  | 'framework'
  | 'tag-manager'
  | 'analytics'
  | 'marketing'
  | 'advertising'
  | 'consent'
  | 'customer-success'
  | 'security'
  | 'ab-testing'
  | 'cdn'
  | 'other';

export interface ManifestScript {
  /** Tessera identity (see ObservedScript.id). Must be unique within the manifest. */
  id: string;
  /**
   * Optional glob (picomatch) matched against ObservedScript.id. When set, an
   * observed script matches this entry if its id equals `id` OR matches `match`.
   * Used for content-hashed bundles: `https://shop.example.com/assets/app.[hash].js`.
   */
  match?: string;
  kind: ScriptKind;
  scope: Scope;
  integrity: IntegrityPolicy;
  integrityMethod: IntegrityMethod;
  /** Approved sha256 (hex). Required for strict, informational otherwise. */
  sha256?: string;
  /** Approved structural hash (hex). Required for structural, informational otherwise. */
  structuralHash?: string;
  owner: string;
  category: ScriptCategory;
  /** Written business or technical justification (PCI DSS 6.4.3). */
  justification: string;
  approvedBy: string;
  /** ISO date (YYYY-MM-DD). */
  approvedAt: string;
  /** Free-form notes. */
  notes?: string;
  /** Last observed body change under `track`, maintained by `tessera approve --refresh`. */
  lastSeenSha256?: string;
}

export interface ManifestFrame {
  /** Normalised iframe URL or glob. */
  match: string;
  scope: Scope;
  owner: string;
  justification: string;
  approvedBy: string;
  approvedAt: string;
}

export type HeaderPolicy = 'strict' | 'track' | 'ignore';

export interface ManifestHeaders {
  /** strict: any change fails; track: changes are info; ignore: not compared. */
  policy: HeaderPolicy;
  values: SecurityHeaders;
}

export interface Manifest {
  version: 1;
  profile: string;
  url: string;
  headers: ManifestHeaders;
  frames: ManifestFrame[];
  scripts: ManifestScript[];
  /**
   * Observed ids to ignore entirely (globs). For known noise such as
   * consent-manager preview tags or A/B tool debug scripts. Use sparingly.
   */
  ignore: string[];
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type DiffEventType =
  | 'new' // observed script has no manifest entry
  | 'removed' // manifest entry not observed in any run
  | 'changed' // body differs from approved hash (severity depends on policy)
  | 'moved' // known script observed from a different source (id differs, body hash equals an approved entry)
  | 'spoofed' // script claims a sourceURL that matches a manifest entry but its real URL does not
  | 'scope-changed' // script observed in a different scope than approved
  | 'header-changed' // security header value differs
  | 'header-added'
  | 'header-removed'
  | 'new-frame' // cross-origin iframe with no manifest entry
  | 'removed-frame'
  | 'blocked'; // challenge page detected, inventory unreliable

export type Severity = 'fail' | 'warn' | 'info';

export interface DiffEvent {
  type: DiffEventType;
  severity: Severity;
  /** Script id, frame match, or header name. */
  subject: string;
  scope?: Scope;
  message: string;
  /** Relevant observed script, when any. */
  observed?: ObservedScript;
  /** Relevant manifest entry, when any. */
  expected?: ManifestScript | ManifestFrame;
  /** For hash and header changes. */
  before?: string;
  after?: string;
}

export type DiffMode = 'gate' | 'drift';

export interface DiffResult {
  mode: DiffMode;
  profile: string;
  url: string;
  scannedAt: string;
  events: DiffEvent[];
  summary: {
    fail: number;
    warn: number;
    info: number;
    /** Scripts observed in merchant scope. */
    merchantScripts: number;
    /** Scripts observed in any scope, excluding harness. */
    totalScripts: number;
    approved: number;
  };
  /** Suggested process exit code: 0 clean, 1 findings at fail severity, 2 run error. */
  exitCode: 0 | 1 | 2;
  /**
   * Non-fatal notes produced while matching, e.g. an observed id that matches
   * several manifest entries (the first in file order was used).
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Configuration: tessera.config.yaml
// ---------------------------------------------------------------------------

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

/** One step of the declarative flow DSL. Exactly one key per step. */
export type FlowStep =
  | { goto: string }
  | { click: string }
  | { fill: { selector: string; value: string } }
  | { select: { selector: string; value: string } }
  | { waitFor: string }
  | { wait: number }
  | { press: string }
  | { screenshot: string };

export interface BrowserConfig {
  /** Playwright channel: "chromium" (default, bundled headless shell), "chrome", "msedge". */
  channel?: string;
  /** Path to a Chromium-based browser binary; overrides channel. */
  executablePath?: string;
  headless: boolean;
  userAgent?: string;
  viewport: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  /**
   * Extra HTTP headers, e.g. a scanner allowlist token. Values support
   * ${ENV_VAR}. Sent only to the profile host, its subdomains and the hosts
   * in `extraHeadersHosts`; requests to every other host (third-party script
   * hosts, provider iframes) are sent without them.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Additional host globs that receive `extraHeaders` (same syntax as
   * `scope.tpsp`; `*` means every host). The profile host and its subdomains
   * always receive them.
   */
  extraHeadersHosts?: string[];
  /** Path to a Playwright storageState JSON for authenticated flows. */
  storageState?: string;
  /** Milliseconds; navigation and step timeout. */
  timeoutMs: number;
}

export interface IdentityConfig {
  /** Query parameters removed before identity is computed (in addition to built-in cache busters). */
  stripQuery: string[];
  /** Query parameters kept even if they look like cache busters. */
  keepQuery: string[];
  /** Replace hex/base64 hash-like path tokens (8+ chars) with `[hash]`. */
  collapseHashes: boolean;
}

export interface ScopeConfig {
  /** Host globs of payment provider frames (added to built-ins). */
  tpsp: string[];
  /** Host globs of 3DS / ACS frames (added to built-ins). */
  threeds: string[];
}

export interface IntegrityDefaults {
  firstParty: IntegrityPolicy;
  thirdParty: IntegrityPolicy;
  inline: IntegrityPolicy;
  eval: IntegrityPolicy;
}

export interface ProfileConfig {
  url: string;
  /** Inline steps, or a path to a .js/.mjs/.ts module exporting `default async (page) => void`. */
  steps?: FlowStep[] | string;
  wait: WaitUntil;
  /** Extra idle time after the last step, to catch late tags. */
  settleMs: number;
  /** Number of runs unioned per scan. */
  runs: number;
  /** Manifest path. Default: tessera.lock.yaml for profile "default", else tessera.<profile>.lock.yaml */
  manifest?: string;
  /** Persist snapshots and diffs under .tessera/history/<profile>/. */
  history: boolean;
}

export interface TesseraConfig {
  version: 1;
  browser: BrowserConfig;
  identity: IdentityConfig;
  scope: ScopeConfig;
  integrity: IntegrityDefaults;
  profiles: Record<string, ProfileConfig>;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

export interface ScanOptions {
  config: TesseraConfig;
  profile: string;
  /** Override runs from the profile. */
  runs?: number;
  /** Progress callback for CLI output. */
  onProgress?: (message: string) => void;
  /** Tool version to stamp into the snapshot. */
  toolVersion: string;
}

export interface DiffOptions {
  snapshot: Snapshot;
  manifest: Manifest;
  mode: DiffMode;
  /** Identity configuration used to normalise a claimed sourceURL for spoof detection. */
  identity?: IdentityConfig;
}
