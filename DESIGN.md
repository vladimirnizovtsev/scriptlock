# Scriptlock design

This document is the engineering contract for version 1. It defines module boundaries, the identity and integrity model, diff semantics and the CLI surface. `src/types.ts` is the typed form of the same contract; when the two disagree, fix both.

## 1. Goal and non-goals

Scriptlock is a CLI that opens a page in a real Chromium, records every script the JavaScript engine parsed (static, dynamic, inline, eval, blob, inside iframes), writes the result to a manifest that lives in git, and fails CI when the page diverges from the manifest. It also records security-impacting HTTP headers of the main document and diffs them.

Version 1 does **not** include: an in-page runtime agent, alerting integrations beyond CI, a web UI, a history store beyond flat JSON files, behavioural analysis, CSP generation, or a hosted scanning service.

## 2. Module map and file ownership

Each module owns the files listed. Modules communicate only through `src/types.ts` and the exported functions named below.

```
src/
  types.ts                    shared types (contract; do not add module imports)
  index.ts                    public API re-exports
  cli.ts                      commander entry point; delegates to commands/*
  commands/
    init.ts                   `scriptlock init`
    scan.ts                   `scriptlock scan`
    diff.ts                   `scriptlock diff`
    approve.ts                `scriptlock approve`
    report.ts                 `scriptlock report`
  config/
    schema.ts                 zod schema + defaults for scriptlock.config.yaml
    load.ts                   locate, parse, validate, interpolate ${ENV}
  collector/
    browser.ts                launch Chromium via playwright-core (channel / executablePath)
    session.ts                CDP attach per target; Debugger/Network/Runtime wiring; raw event capture
    collect.ts                run one profile: navigate, steps, settle, N runs, union -> Snapshot
    steps.ts                  flow DSL interpreter + module escape hatch
    headers.ts                extract SecurityHeaders from the main document response
    blocked.ts                bot-management challenge page detection
  identity/
    normalize.ts              URL normaliser
    structural.ts             structural hash of source text
    identity.ts               ObservedScript.id derivation
    scope.ts                  frame and script scope classification
    entity.ts                 third-party-web lookup
    hash.ts                   sha256 helpers
  manifest/
    schema.ts                 zod schema for scriptlock.lock.yaml
    io.ts                     read / write with stable key order and sorted entries
    match.ts                  find the manifest entry for an observed script or frame
    approve.ts                add or refresh entries from a snapshot
  diff/
    diff.ts                   Snapshot + Manifest -> DiffResult
    policy.ts                 severity matrix for gate and drift modes
  report/
    text.ts                   terminal output (picocolors)
    markdown.ts               markdown for PR comments and step summaries
    json.ts                   machine output
  history/
    store.ts                  append snapshot + diff under .scriptlock/history/<profile>/
fixtures/
  site/                       static test site (see section 10)
  server.ts                   two-origin fixture server used by e2e tests
test/
  unit/**                     pure-function tests (vitest project "unit")
  e2e/**                      real browser tests against the fixture server (vitest project "e2e")
action.yml                    composite GitHub Action
examples/workflows/           copy-paste GitHub workflows
```

Public functions (signatures are illustrative; keep names):

```ts
// config
loadConfig(cwd: string, explicitPath?: string): Promise<{ config: ScriptlockConfig; path: string }>
defaultConfig(): ScriptlockConfig

// collector
scan(options: ScanOptions): Promise<Snapshot>

// identity
normalizeUrl(raw: string, cfg: IdentityConfig): string
structuralHash(source: string): string
sha256(source: string): string
deriveId(input: { kind, rawUrl?, embedderName?, frameOrigin, source }, cfg: IdentityConfig): string
classifyFrame(frame: { url; isMain; mainOrigin }, cfg: ScopeConfig): Scope
lookupEntity(url: string): ScriptEntity | undefined

// manifest
readManifest(path: string): Promise<Manifest>
writeManifest(path: string, manifest: Manifest): Promise<void>
emptyManifest(profile: string, url: string): Manifest
findScriptEntry(manifest: Manifest, observed: ObservedScript): ManifestScript | undefined
findFrameEntry(manifest: Manifest, frame: FrameInfo): ManifestFrame | undefined
isIgnored(manifest: Manifest, id: string): boolean
approveScripts(manifest, snapshot, ids: string[], meta: ApproveMeta, defaults: IntegrityDefaults): Manifest
refreshTracked(manifest, snapshot): Manifest

// diff
diff(options: DiffOptions): DiffResult

// report
renderText(result: DiffResult, opts?): string
renderMarkdown(result: DiffResult): string
renderJson(result: DiffResult): string
renderInventoryMarkdown(snapshot: Snapshot, manifest: Manifest): string

// history
appendHistory(dir: string, profile: string, snapshot: Snapshot, result?: DiffResult): Promise<string>
```

## 3. Collection

### 3.1 Browser

`playwright-core` only; no bundled browser. Resolution order: `browser.executablePath`, then `browser.channel` (default `chromium`, which uses the Playwright-managed build; CI installs it with the CLI's own bundled `playwright-core`, see `action.yml`). The user agent is left as the browser reports it unless overridden; Scriptlock never applies stealth patches. `browser.extraHeaders` is the documented allowlisting mechanism for bot management. The header values are sent only to the profile host, its subdomains and any host in `browser.extraHeadersHosts` (a glob list; `*` means every host); requests to every other host, including third-party script hosts and provider iframes, are sent without them, so a bot-management token is not disclosed to third parties. Even so, keep the token low-privilege and scoped to the scanner.

### 3.2 CDP wiring

Verified empirically against playwright-core 1.62.1 / Chromium 151:

- Attach a CDP session to the page **before navigation** (`context.newCDPSession(page)`), enable `Debugger`, `Runtime`, `Network`. Every script V8 parses in that target arrives as `Debugger.scriptParsed`, including inline blocks, eval, `new Function`, blob:, module scripts and dynamically inserted tags.
- On `frameattached`, try `context.newCDPSession(frame)`. If Playwright answers "This frame does not have a separate CDP session", the frame is in-process and already covered by the parent session. Otherwise it is an out-of-process iframe; enable the same domains on the new session. Dedicated and service workers are out of scope for v1 (Playwright exposes no CDP session for them); record their entry URLs from `Network` events with kind `worker` and no body hash.
- For each `scriptParsed`, fetch the source immediately with `Debugger.getScriptSource` (V8 evicts collected scripts; a late call fails with "No script for id"). Compute our own SHA-256 over the UTF-8 bytes of the returned source. Never store V8's `hash` field: it is computed over decoded UTF-16 and is not an SRI value.
- `scriptParsed.url` is rewritten by an attacker-controlled `//# sourceURL=` comment (`hasSourceURL: true`). Take the real URL from `embedderName`, falling back to the matching `Network.requestWillBeSent` URL. Record the claimed URL in `sourceUrl` and never use it for identity.
- `Network.requestWillBeSent` with `type: Script` provides `initiator` (`parser` with the document URL, or `script` with a stack whose top frame URL is the inserting script). Correlate to `scriptParsed` by URL. Response headers come from `Network.responseReceived`.
- `executionContextAuxData.frameId` on `scriptParsed` maps the script to its frame. Use `Runtime.executionContextCreated` to learn each context's `auxData.type` and name: contexts that are not `default` (Playwright utility worlds) are harness and are dropped. In the default world, a stack trace is **not** a reliable harness signal: `setTimeout(string)`, `setInterval(string)` and `javascript:` URLs compile to a stackless script with no URL, and are page code. Every default-world script is therefore fetched and kept, then the two Playwright helper scripts that appear only when a flow calls `page.evaluate` (the utility bundle, whose source contains `__commonJS`/`module.exports`, and the evaluate wrapper `(utilityScript, ...args) => utilityScript.evaluate(...args)`) are dropped by source signature. Empty-URL page scripts (eval, `new Function`, timer strings, `javascript:`) get an `eval:<origin>:<structural hash>` id whether or not they carry a stack.
- Do not use `addInitScript` / `Page.addScriptToEvaluateOnNewDocument`; the Debugger domain already covers dynamic insertion and init scripts perturb the page.

### 3.3 Run procedure

1. Launch browser, create context (viewport, locale, timezone, storageState, extraHeaders).
2. Create page, attach CDP, register frame handlers.
3. `page.goto(profile.url, { waitUntil: profile.wait })`.
4. Execute `steps` (DSL or module). Steps run with `browser.timeoutMs`.
5. Wait `settleMs`.
6. Extract main document status and security headers from the first main-frame response.
7. Run challenge-page detection (`blocked.ts`) over the main document status, title, HTML and response headers: Cloudflare (`cf-mitigated: challenge` header, "Just a moment" title, `_cf_chl_opt` / `challenge-running` markup), Akamai ("Access Denied" with a reference id, the `bm-verify` block page, the SEC-CPT crypto challenge at `/_sec/cp_challenge/` with HTTP 428), DataDome (`captcha-delivery.com`), PerimeterX (`_pxhc`, `px-captcha`), plus HTTP 403/428/429/503 on the main document. Weak markers that also appear on ordinary 200 pages (the Cloudflare JS-detections loader under `/cdn-cgi/challenge-platform/`, the Turnstile widget, the PerimeterX sensor bootstrap) count only when the status is a challenge status, so a normal page carrying a sensor snippet is not reported blocked. When detected, set `snapshot.blocked` and skip nothing: the inventory is still recorded but the diff emits a `blocked` fail event and exit code 2.
8. Build `ObservedScript[]`: derive identity, structural hash, scope, entity, initiator, `loadedBy`.
9. Repeat for `runs` (default 1). Union by `id`; `observedInRuns` counts runs in which the id appeared; keep the first observation's metadata.
10. Return `Snapshot`. Never include `source` text in the written snapshot.

### 3.4 Flow DSL

```yaml
steps:
  - goto: /product/42            # relative to profile.url
  - click: "text=Add to cart"
  - goto: /checkout
  - fill: { selector: "#email", value: "test@example.com" }
  - waitFor: "#payment-element iframe"
  - wait: 2000
```

`steps: ./flow.ts` loads a module exporting `default async (page: Page) => void`. `.js`/`.mjs` are imported directly; `.ts` is loaded through `tsx` when it is installed, otherwise the CLI errors with an install hint. A flow module is resolved against the working directory and runs with the full privileges of the CI job (no sandbox), so review a `steps:` change like a workflow change. The value of a `fill` step is redacted from progress and error output because it may hold a `${VAR}` secret; other step values (selectors, `goto` targets, screenshot paths) are printed. Production scans stop at the rendered payment form; the README says never to submit a card.

## 4. Identity

Identity answers "is this the same script as before" independently of body changes.

### 4.1 URL-addressed scripts (`external`, `blob`, `data`, `worker`)

`normalizeUrl(raw, cfg)`:

1. Parse. Lower-case scheme and host. Drop default ports. Drop the fragment.
2. `blob:` and `data:` URLs: identity is `blob:<origin>` and `data:<sha256 prefix 16>` respectively; the opaque UUID or payload is not stable.
3. Path: when `collapseHashes` is true, split the path on `.`, `-`, `_`, `/` and replace any token that matches `[A-Fa-f0-9]{8,}` (all hex), or that matches `[A-Za-z0-9]{16,}` and contains at least one digit, with `[hash]`. The digit requirement keeps long lowercase words (`internationalization`) from collapsing. Example: `/assets/app.3f9c2a1b.js` -> `/assets/app.[hash].js`; `/v3/fingerprinted/js/elements-inner-card-0a1b2c3d4e5f.js` -> `/v3/fingerprinted/js/elements-inner-card-[hash].js`. The same normaliser is applied to a non-main frame's URL, so a provider iframe with a fingerprinted path keeps its identity across a deploy and a `[hash]` frame `match` works.
4. Query: remove built-in cache-buster parameters (`v`, `ver`, `version`, `cb`, `_`, `t`, `ts`, `timestamp`, `rnd`, `rand`, `random`, `nocache`, `cache`, `h`, `hash`, `bust`, `_t`, `_v`) plus `cfg.stripQuery`, unless listed in `cfg.keepQuery`. Sort remaining parameters by name. Keep values (`?id=GTM-ABC` is identity-relevant).
5. The identity is the normalised URL string. `ObservedScript.url` holds the same value; `rawUrl` holds the original.

### 4.2 Inline and eval scripts

Position-based ids break when a block is inserted above. Use content structure instead:

`id = "<kind>:<frame origin>:<structuralHash first 16 hex>"`, e.g. `inline:https://shop.example.com:9f2c41ba0d77e1a3`.

### 4.3 Structural hash

`structuralHash(source)` masks everything that changes per request while keeping code shape:

1. Replace string literals (single, double, template without expressions) with `"S"`. Template literals with `${}` keep the expression text and mask the static parts.
2. Replace numeric literals with `0`.
3. Replace regex literals with `/R/`.
4. Strip comments.
5. Collapse whitespace runs to a single space; trim.
6. SHA-256 the result.

A tokenizer that handles the above without a full parser is sufficient; document any known limitation (e.g. regex-vs-division ambiguity) in the module header. Framework hydration blocks such as `self.__next_f.push([1,"..."])` therefore hash stably across requests, while a change in the code itself changes the hash.

## 5. Scope

`classifyFrame`:

- Main frame -> `merchant`.
- Same-origin frame (same scheme, host, port as the main frame) -> `merchant`.
- Cross-origin frame whose host matches a built-in or configured TPSP glob -> `tpsp`. Built-ins include at least: `js.stripe.com`, `*.stripe.com`, `checkoutshopper-live.adyen.com`, `*.adyen.com`, `*.paypal.com`, `*.paypalobjects.com`, `*.braintreegateway.com`, `*.braintree-api.com`, `*.checkout.com`, `*.klarna.com`, `*.klarnaservices.com`, `*.mollie.com`, `*.squareup.com`, `*.squarecdn.com`, `pay.google.com`, `*.apple.com` (Apple Pay), `*.authorize.net`, `*.worldpay.com`, `*.payments.worldpay.com`, `*.nuvei.com`, `*.2checkout.com`, `*.paddle.com`, `*.recurly.com`, `*.chargebee.com`, `*.gocardless.com`.
- Cross-origin frame whose host matches a 3DS glob -> `threeds`. Built-ins: `*.cardinalcommerce.com`, `*.arcot.com`, `*3dsecure*`, `acs.*`, `*.acs.*` (label-anchored so `macs.example.net` is not 3DS), `*.3ds.*`, `*.modirum.com`, `*.netcetera.com`, `*.gpayments.com`.
- Any other cross-origin frame -> `embedded`.

Scripts inherit the scope of their frame. Harness detection (section 3.2) overrides to `harness`, and harness scripts are excluded from `Snapshot.scripts`.

`ManifestScript.scope` records the approved scope; observing an approved script in a different scope raises `scope-changed`.

## 6. Manifest

File: `scriptlock.lock.yaml` for profile `default`, otherwise `scriptlock.<profile>.lock.yaml`, unless `profile.manifest` overrides. Written with stable key order (as declared in `types.ts`) and entries sorted by `scope`, then `id`, so diffs in pull requests are readable.

```yaml
version: 1
profile: checkout
url: https://shop.example.com/
headers:
  policy: strict
  values:
    content-security-policy: "default-src 'self'; script-src 'self' https://js.stripe.com"
    strict-transport-security: max-age=63072000; includeSubDomains
frames:
  - match: https://js.stripe.com/v3/elements-inner-card-[hash].html
    scope: tpsp
    owner: payments
    justification: Stripe Elements card field
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-02
scripts:
  - id: https://shop.example.com/assets/app.[hash].js
    kind: external
    scope: merchant
    integrity: strict
    integrityMethod: hash-strict
    sha256: 9f2c…
    owner: web
    category: functional
    justification: Storefront bundle built from this repository
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-02
  - id: https://js.stripe.com/v3
    kind: external
    scope: merchant
    integrity: track
    integrityMethod: vendor-attested
    sha256: 41ba…
    owner: payments
    category: payment
    justification: Stripe.js loader on the parent page; evergreen, vendor-updated
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-02
  - id: inline:https://shop.example.com:9f2c41ba0d77e1a3
    kind: inline
    scope: merchant
    integrity: structural
    integrityMethod: hash-strict
    structuralHash: 9f2c…
    owner: web
    category: framework
    justification: Framework hydration state; literals change per request
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-02
ignore: []
```

Matching (`findScriptEntry`): exact `id` equality first; then any entry whose `match` glob matches the observed id (picomatch, `{ nocase: true }`). If several match, the first in file order wins and a warning is added.

Integrity defaults applied by `approve` when `--integrity` is not given: first-party external (host equals main-frame host or a subdomain) -> `integrity.firstParty` (default `strict`); third-party external -> `integrity.thirdParty` (default `track`); inline -> `integrity.inline` (default `structural`); eval -> `integrity.eval` (default `structural`); `worker` (and any script whose body was not captured) -> `url-only` with method `none`, regardless of party, because there is no body hash to enforce. `approve` refuses `--integrity strict` or `--integrity structural` for such an entry. `integrityMethod` defaults otherwise: `hash-strict` for strict/structural, `source-tracked` for track/url-only.

## 7. Diff semantics

`diff({ snapshot, manifest, mode })` compares and classifies. Harness scripts are never present. Ignored ids are skipped.

| Event | Condition | gate | drift |
|---|---|---|---|
| `blocked` | `snapshot.blocked` set | fail, exit 2 | fail, exit 2 |
| `new` | observed script, no entry, scope merchant | fail | fail |
| `new` | observed script, no entry, scope tpsp / threeds / embedded | info | warn |
| `removed` | entry not observed in any run (`observedInRuns` = 0 across `runs`) | warn | warn |
| `changed` | policy strict, sha256 differs | fail | fail |
| `changed` | policy structural, structuralHash differs | fail | fail |
| `changed` | policy track, sha256 differs from `sha256` or `lastSeenSha256` | info | info |
| `changed` | policy url-only | not emitted | not emitted |
| `moved` | no entry for id, but sha256 equals a strict/structural entry's approved hash with a different id | fail | fail |
| `spoofed` | `hasSourceURL` and `sourceUrl` normalises to a manifest id while the real id has no entry | fail | fail |
| `scope-changed` | entry scope differs from observed scope | warn | warn |
| `header-changed` / `header-added` / `header-removed` | headers policy strict | fail | fail |
| same | headers policy track | info | info |
| `new-frame` | cross-origin frame with no frame entry | warn | warn |
| `removed-frame` | frame entry not observed | info | warn |

Severity aggregation: `exitCode` is 2 if any `blocked`, else 1 if any `fail`, else 0. `gate` is meant for deploy pipelines: only the `new` event is merchant-gated (a new tpsp/threeds/embedded script is informational), while `changed`, `moved`, `spoofed` and strict/structural header changes fail in any scope. `drift` is meant for the scheduled weekly run (broader: new non-merchant scripts and removed frames become warnings). The matrix above lives in `diff/policy.ts` as data so it can be shown in `--help`.

`moved` detection: build an index of approved sha256 values from strict and structural entries; a `new` script whose sha256 is in the index becomes `moved` instead (message names the original id).

## 8. CLI

```
scriptlock init   [--url <url>] [--force]         write scriptlock.config.yaml with a "default" profile
scriptlock scan   [--profile <name>] [--runs N] [--out <file>] [--config <path>] [--json]
scriptlock diff   [--profile <name>] [--gate|--drift] [--snapshot <file>] [--format text|md|json]
               [--history] [--config <path>] [--out <file>]
scriptlock approve <id...> [--all-new] --owner <s> --category <c> --justification <s>
               [--integrity strict|structural|track|url-only] [--integrity-method <m>]
               [--approved-by <s>] [--scope <s>] [--notes <s>] [--refresh] [--headers]
               [--snapshot <file>] [--profile <name>]
scriptlock report [--profile <name>] [--format md|json] [--snapshot <file>] [--out <file>]
```

- `scan` writes `.scriptlock/last.<profile>.json` (path printed) unless `--out`, and prints a summary table: scripts by scope and kind, third-party hosts, initiator tree depth, headers present.
- `diff` runs a scan unless `--snapshot` is given, compares to the manifest, prints the report, writes history when `--history` or `profile.history`, exits with `result.exitCode`. When no manifest exists it prints instructions to run `approve --all-new` and exits 1.
- `approve` reads the last snapshot (or `--snapshot`), adds entries, writes the manifest. `--all-new` approves every script without an entry. `--refresh` updates `lastSeenSha256` on track entries and `sha256`/`structuralHash` on strict/structural entries listed. `--approved-by` defaults to `git config user.name` or `$USER`. `approvedAt` is today (UTC date).
- `report` renders the inventory with authorisation status (approved / unapproved / stale) grouped by scope, owner and category, as markdown or JSON.
- Global: `--config <path>`, `--verbose`, `--no-color`. Exit codes: 0 clean, 1 findings, 2 error (blocked, navigation failure, config invalid, browser missing with an install hint).

## 9. Configuration

```yaml
version: 1
browser:
  channel: chromium
  headless: true
  viewport: { width: 1366, height: 900 }
  timeoutMs: 30000
  extraHeaders:
    X-Scanner-Token: ${SCRIPTLOCK_SCANNER_TOKEN}
identity:
  stripQuery: []
  keepQuery: []
  collapseHashes: true
scope:
  tpsp: []
  threeds: []
integrity:
  firstParty: strict
  thirdParty: track
  inline: structural
  eval: structural
profiles:
  default:
    url: https://shop.example.com/checkout
    wait: load
    settleMs: 3000
    runs: 1
    history: false
```

`${VAR}` in string values is replaced from `process.env`; a missing variable is a config error naming the variable. `loadConfig` searches `scriptlock.config.yaml`, then `scriptlock.config.yml`, in `cwd`.

## 10. Fixture site and tests

`fixtures/server.ts` starts one HTTP server bound to `127.0.0.1` on a random port and reports two origins for it: `http://127.0.0.1:<port>` (first party) and `http://localhost:<port>` (cross-origin for iframe purposes; the browser treats these as different origins). It serves:

- `/` main page with configurable response headers (CSP, HSTS, XFO, etc.) via a query flag or server option;
- an inline classic script and an inline module script;
- `/app.<hash>.js` first-party bundle where the hash and body can be switched by server option to simulate a deploy;
- `/vendor.js?v=<n>` third-party style script with a cache buster;
- a dynamically inserted `<script src>`, an `eval`, a `new Function`, a blob: script, a late tag inserted after 1500 ms;
- `/spoof.js` whose body ends with `//# sourceURL=https://js.stripe.com/v3`;
- a same-origin iframe with its own inline and external script;
- a cross-origin iframe on the `localhost` origin, configurable to act as `tpsp` (via `scope.tpsp: ["localhost"]` in the test config), containing its own scripts;
- `/challenge` page that mimics a Cloudflare interstitial ("Just a moment...") for the blocked detector;
- an optional dedicated worker entry `/worker.js`.

Unit tests cover normalisation (every rule in section 4.1 with examples), structural hash stability and sensitivity, identity derivation, scope classification incl. configured globs, manifest read/write round trip and stable ordering, matching with globs, approve defaults, every row of the diff matrix, and report rendering snapshots.

E2E tests cover: scan captures every script kind listed above with correct scope, `hasSourceURL` and real URL for the spoofed script, headers captured, `approve --all-new` then `diff` is clean, changing the first-party bundle fails under strict, changing vendor.js under track is info, a new script fails gate, a tag inside the tpsp frame is info in gate and warn in drift, the challenge page yields `blocked` and exit 2, and `runs: 2` unions results.

## 11. Conventions

- TypeScript strict, ESM, Node 22+. No default exports except for user flow modules.
- Errors thrown to the CLI are `ScriptlockError` with a `code` and an `exitCode`; the CLI prints `error: <message>` and exits accordingly.
- No network access in unit tests. E2E tests use only the fixture server.
- Every module file starts with a short comment stating what it owns and its known limitations.
- English everywhere: code, comments, docs, commit messages.
- Wording rules for user-facing text: never "ensures compliance"; the tool "produces evidence artifacts" and "helps prepare". See README "Limits".
