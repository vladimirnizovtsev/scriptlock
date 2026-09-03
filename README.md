# Scriptlock

Scriptlock is a lockfile for everything that executes in the browser. It opens a page in a real Chromium, records every script the JavaScript engine parsed (static tags, dynamically inserted tags, inline blocks, `eval` and `new Function`, `blob:` and `data:` URLs, scripts inside iframes), writes the result to a manifest that lives in your repository, and fails CI when the page diverges from that manifest. It also records the security-impacting HTTP headers of the main document and diffs them. There is no agent on the page, nothing is injected into real users' sessions, and no data leaves your infrastructure.

It is built for agencies, product teams and development teams that run a custom or embedded (iframe) checkout with a repository and CI, and that need three things from one tool: a script inventory with written justifications, change detection on a schedule, and a gate that blocks a deploy when the payment page picks up code nobody approved.

> Status: 0.1.0, the first release. Every feature described here is implemented and covered by tests, and the
> tool has been run against real storefronts, but it is new and has not yet been used in an assessment.
> Expect the manifest format and the CLI to change before 1.0; breaking changes will be listed in the
> [changelog](CHANGELOG.md).

## Contents

- [Quick start](#quick-start) — install, first inventory, first gate
- [Limits, read this first](#limits-read-this-first) — what a synthetic scan cannot tell you
- [Which requirement applies to you](#which-requirement-applies-to-you) — PCI DSS 6.4.3 and 11.6.1 by integration type
- [How it works](#how-it-works) — [collection](#collection), [identity](#identity), [content-hashed bundles](#content-hashed-bundles), [integrity policies](#integrity-policies), [scope](#scope), [gate versus drift](#gate-versus-drift)
- [Manifest example](#manifest-example) and [configuration](#configuration) — including [flows](#flows) and [scanning behind bot management](#scanning-behind-bot-management)
- [CLI reference](#cli-reference), the [library API](#library-api) and the [GitHub Action](#github-action)
- [Evidence for assessors](#evidence-for-assessors), [comparison](#comparison), [scope and ethics](#scope-and-ethics), [roadmap](#roadmap)

## Quick start

Requirements: Node 22 or later (Node 20 reached end of life on 30 April 2026). Scriptlock depends on `playwright-core` and ships no browser; the Playwright-managed Chromium build is installed once.

```sh
npm install --save-dev scriptlock
npx playwright-core install chromium

# Write scriptlock.config.yaml with a "default" profile, then edit the URL.
npx scriptlock init

# Open the page, record every script and header, write .scriptlock/last.default.json
npx scriptlock scan

# Turn the snapshot into a manifest. Every script without an entry gets one.
npx scriptlock approve --all-new \
  --owner web \
  --category functional \
  --justification "Initial inventory of the checkout page, reviewed in PR #123"

# Re-scan and compare. Exit 0 clean, 1 findings, 2 run error (blocked, navigation failure).
npx scriptlock diff --gate
```

Commit `scriptlock.config.yaml` and `scriptlock.lock.yaml`. From now on every change to the set of scripts on the page is a change to a file in your repository. When branch protection requires review, each such change lands through a reviewed pull request like any other change.

Do not commit `.scriptlock/`. Everything under it is scan output, not evidence you maintain: the snapshot is a full inventory of every script URL on the page including query strings, the final URL and the complete `content-security-policy`, which is exactly the map of your payment page you would rather not publish in a repository. `scriptlock init` adds `.scriptlock/` to an existing `.gitignore` and prints the line to add when there is none. The manifest is the artifact you commit and review.

Then add the weekly run. Copy [examples/workflows/scriptlock-weekly.yml](examples/workflows/scriptlock-weekly.yml) into `.github/workflows/` in your repository:

```yaml
on:
  schedule:
    - cron: "0 6 * * 1" # weekly cadence for 11.6.1; change only with a documented targeted risk analysis
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: vladimirnizovtsev/scriptlock@v0.1.0
        with:
          mode: drift
          history: true
```

Approve a single script later with its id, refine an entry's policy, or refresh tracked hashes:

```sh
npx scriptlock approve "https://cdn.example.com/widget.js" \
  --owner marketing --category marketing \
  --justification "Chat widget, contract 2026-14" \
  --integrity track --integrity-method vendor-attested

npx scriptlock approve --refresh "https://js.stripe.com/v3"
npx scriptlock report --format md --out inventory.md
```

If your build renames every chunk on every deploy, authorise the build output directory with one entry instead of approving the chunks one by one. Read the tradeoff first: [Content-hashed bundles](#content-hashed-bundles).

```sh
npx scriptlock approve --match "https://shop.example.com/_next/static/chunks/*.js" \
  --replace \
  --owner web --category framework \
  --justification "Next.js build output, built from this repository by CI"
```

`--replace` deletes the exact-id entries the glob now covers. Without it they stay in the manifest, and every later diff reports each of them as `removed`; the command prints them either way.

If the first scan reports no scripts at all, the URL is wrong or the page did not load: `approve` refuses to create a manifest that authorises nothing, and a manifest with no entries fails every later `diff`, so a typo cannot produce a green gate.

Before you rely on any of this for an assessment, read [Limits, read this first](#limits-read-this-first) and [Which requirement applies to you](#which-requirement-applies-to-you).

## Limits, read this first

Scriptlock produces evidence artifacts of the kind that PCI SSC testing-procedure guidance lists: inventory records, written justifications, change-detection results and header baselines. It is not an attestation, it is not validated by PCI SSC or any QSA, and it does not determine whether your controls are sufficient. Whether the evidence is enough for your assessment is a decision for you and your assessor. Scriptlock helps you prepare; it does not decide.

Synthetic scans are a sample, not a guarantee:

- A skimmer can detect automation and stay dormant, serve different code by geography or session, or appear for a fraction of visitors. A scan that sees nothing is not proof that nothing is there.
- There is a window between runs. A weekly run can miss code that was present for six days in between.
- Scriptlock does not judge what a script does. It tells you that a script is new, changed, moved or spoofed; a human decides whether that is acceptable.
- Runs can be blocked by bot management. Scriptlock detects challenge pages and fails the run as `blocked` rather than reporting a wrong inventory, but it ships no stealth patches. Allowlisting is your responsibility (see [Scanning behind bot management](#scanning-behind-bot-management)).

Out of scope, cannot be scanned:

- Shopify-hosted checkout. Shopify states that crawler signatures do not grant access to its checkout, and there is no merchant-side allowlist for a scanner.
- Hosted redirect checkouts (Stripe Checkout, PayPal redirect and similar) where the customer leaves your origin. The payment page is not yours to scan, and the requirements discussed below do not apply to the redirecting page.
- Dedicated and service worker bodies (0.1.x records their entry URLs only), and any behaviour that only appears after a real card is submitted. Scriptlock never submits a card.

## Which requirement applies to you

PCI DSS v4.0.1 requirement 6.4.3 asks for an inventory of all payment page scripts with a written business or technical justification, an authorization method and an integrity method for each. Requirement 11.6.1 asks for a mechanism that detects and alerts on unauthorized changes to security-impacting HTTP headers and to script contents as received by the consumer browser, at least once every seven days or at a frequency set by a targeted risk analysis under 12.3.1. Both were best practice until 31 March 2025 and are mandatory after that date for merchants validating with SAQ A-EP, SAQ D or a Report on Compliance.

| Your integration | What applies | Where Scriptlock fits |
|---|---|---|
| Redirect or fully outsourced. The customer is sent to a third-party payment page (HTTP 30x, meta refresh or JavaScript redirect). | 6.4.3 and 11.6.1 do not apply to the redirecting page (FAQ 1588; information supplement, March 2025). | Not needed for PCI. Still useful as a plain script lockfile for your own pages. |
| SAQ A with an embedded payment form or iframe from a PCI DSS compliant third-party service provider (TPSP). | On 30 January 2025 PCI SSC removed 6.4.3, 11.6.1 and 12.3.1 from SAQ A and added an eligibility criterion: the merchant has confirmed that its site is not susceptible to script attacks that could affect its e-commerce systems. FAQ 1588 (February 2025) says the criterion applies only to merchants embedding a TPSP form or iframe and is met either by techniques such as those in 6.4.3 and 11.6.1, performed by the merchant or a third party, or by confirmation from the compliant TPSP that its solution, implemented per its instructions, protects the merchant's page. | The TPSP controls the inside of its iframe; it cannot see the page that embeds it. Scriptlock is a parent-page control: it inventories and diffs the scripts on your page that surround and create the iframe (supplement Table 3 assigns those to the merchant). |
| SAQ A-EP, SAQ D or Report on Compliance. Your page handles or can affect cardholder data (direct post, JavaScript SDKs such as Accept.js, or you simply do not qualify for SAQ A). | 6.4.3 and 11.6.1 in full. FAQ 1331 (updated August 2026) requires that scoping these requirements out with SAQ eligibility criteria is explicitly reviewed and agreed with your compliance-accepting entity (acquirer or brand) before a ROC merchant relies on it. | The manifest is the 6.4.3 inventory with justification, authorization (a reviewed pull request) and integrity method per script. The scheduled `diff --drift` run and its history are 11.6.1 change-detection results. See [Evidence for assessors](#evidence-for-assessors) for what Scriptlock does and does not provide. |

Sources by name: PCI DSS v4.0.1; the PCI SSC blog post of 30 January 2025 announcing the SAQ A changes; PCI SSC FAQ 1588 (February 2025); PCI SSC FAQ 1331 (updated August 2026); the PCI SSC Information Supplement "Payment Page Security and Preventing E-Skimming" (March 2025). SAQ type is determined by how your payment page is built, not by merchant size. When in doubt, ask your acquirer or assessor.

The March 2025 information supplement is non-normative, but it describes the model Scriptlock implements. It defines an agentless monitoring model as a process or service, for example a headless browser, that regularly walks checkout flows and observes loaded scripts, headers and behaviours without adding scripts to real users' sessions; it lists that model's limitations (CAPTCHAs, logins, state-based flows, scheduled rather than constant checks); it names "automated or manual transaction simulations" among example mechanisms for 11.6.1; and it accepts email, SYSLOG and vendor logs as alerting methods. Its Table 3 makes the merchant responsible for scripts on the page that embeds a payment iframe and the TPSP responsible for scripts inside the iframe, which is exactly how Scriptlock assigns scope.

## How it works

### Collection

Scriptlock launches Chromium through `playwright-core`, attaches a Chrome DevTools Protocol session to the page before navigation and enables the `Debugger`, `Runtime` and `Network` domains. Every script V8 parses arrives as a `Debugger.scriptParsed` event: inline blocks, `<script src>` tags whether static or inserted later, module scripts, `eval`, `new Function`, `blob:` and `data:` URLs. The source is fetched immediately and hashed with SHA-256 over its UTF-8 bytes; the engine's own hash field is never stored because it is not an SRI value. Cross-origin iframes get their own CDP session, so the scripts inside a payment provider's frame are recorded too, tagged with their own scope. Scripts injected by the automation harness itself are detected and dropped.

A script can lie about its URL with a `//# sourceURL=` comment. Scriptlock takes the real URL from the engine and the network log, records the claimed one separately as `sourceUrl`, and never uses it for identity. A script whose claimed URL matches a manifest entry while its real URL has none is reported as `spoofed`.

After navigation, the optional flow steps run (a small YAML DSL or a Playwright module, see [Configuration](#configuration)), the page settles for `settleMs`, the main document's status and security headers are extracted, and a challenge-page check runs. A scan can repeat `runs` times; results are unioned so that a tag that only loads sometimes is not reported as removed after a single quiet run.

### Identity

Identity answers "is this the same script as before" independently of body changes.

- URL-addressed scripts (`external`, `blob`, `data`, `worker`) are identified by a normalised URL: lower-case scheme and host, default ports and fragments dropped, hash-like path tokens collapsed to `[hash]` (`/assets/app.3f9c2a1b.js` becomes `/assets/app.[hash].js`), built-in cache-buster query parameters removed, remaining parameters sorted. Values are kept, because `?id=GTM-ABC` is identity-relevant. `blob:` URLs become `blob:<origin>`.
- Inline and eval scripts are identified by `<kind>:<frame origin>:<structural hash prefix>`, so an inserted block above them does not change their identity.
- The structural hash masks string literals, numbers, regular expressions, comments and whitespace before hashing. Framework hydration blocks whose literals change on every request keep a stable structural hash; a change to the code itself changes it.

Manifest entries can also carry a `match` glob for content-hashed bundles.

### Content-hashed bundles

Identity is per file. Next.js, Vite, Nuxt, Astro and webpack builds put a content hash in the file name of every chunk, so a production build renames all of them: `chunks/1ixzeq6_vmaz2.js` becomes `chunks/9c1a4f0b8d2e.js` on the next deploy. Nothing about the page changed, but the diff sees every chunk as `new` and every entry as `removed`, in merchant scope, which fails the gate. If you approve them one by one, the same thing happens on the deploy after that, and the gate gets switched off within a week.

The normaliser does not rescue this on its own. It collapses hash-like tokens (`app.3f9c2a1b.js` becomes `app.[hash].js`), but a whole file name that is itself a hash, with no stable stem next to it, has nothing left to keep. Collapsing those names would be worse than the noise: every chunk in the directory would share one identity, the manifest would hold one entry and all the others would disappear from the inventory. So a stem that is nothing but a hash is kept verbatim. Where collapsing does apply and two files still land on one identity (`app.3f9c2a1b.js` and `app.7d2e1f0a.js` on the same page), the scan records a warning naming both raw URLs rather than dropping one silently.

The fix is one entry for the build output directory:

```bash
npx scriptlock approve \
  --match "https://shop.example.com/_next/static/chunks/*.js" \
  --replace \
  --owner web --category framework \
  --justification "Next.js build output, built from this repository by CI"
```

`scriptlock diff` prints that command for you when three or more new scripts share a directory and differ only in their file names. The entry it writes:

```yaml
  - id: https://shop.example.com/_next/static/chunks/*.js
    match: https://shop.example.com/_next/static/chunks/*.js
    kind: external
    scope: merchant
    integrity: track
    integrityMethod: source-tracked
    owner: web
    category: framework
    justification: Next.js build output, built from this repository by CI
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-03
    coveredAtApproval:
      count: 12
      scannedAt: 2026-09-03T09:41:22.184Z
      ids:
        - https://shop.example.com/_next/static/chunks/1ixzeq6_vmaz2.js
        # ... one line per authorised id, capped at 50
```

The `id` is the glob itself, so the entry is only ever reached through glob matching. Every observed chunk keeps its own identity, its own body hash and its own row in `scriptlock report`: the inventory still lists every file in the directory, and the entry only says that all of them are authorised. `coveredAtApproval` records what the glob authorised on the day it was approved, so the pull request that adds this one line shows how wide it is without anyone rerunning the scan.

Order matters. Run `--match` before `approve --all-new`, or pass `--replace` as above: the exact-id entries for chunk names that will never come back are otherwise left behind, and every later diff reports each of them as `removed`. `scriptlock approve --match` always prints the entries the glob makes redundant; `--replace` deletes them.

The tradeoff, stated plainly: a glob entry authorises anything that matches it. Body integrity for those files comes from your build pipeline, not from Scriptlock. `strict` and `structural` are refused for any glob with a wildcard, because one entry holds one approved hash and it cannot stand for the bodies the glob will match on the next deploy, so a glob entry never carries a `sha256`. Scripts covered by a glob are also exempt from `spoofed` and `moved` detection, since both only fire on scripts with no matching entry. An attacker who can write a new file into that directory gets an authorised script.

So the glob has to stay as narrow as the build output directory, and Scriptlock enforces that rather than asking you to remember it: the text before the wildcard must be an http(s) host plus at least one path segment, the wildcard may not reach past a `/`, and `**`, a leading `!`, `{`, `(` and `|` are refused outright. `/_next/static/chunks/*.js` is accepted; `/*.js`, `<origin>/**` and anything spanning two hosts are not. One glob covers one directory, not its subdirectories: a build that emits `chunks/app/` and `chunks/pages/` needs one entry per directory. A glob that matches scripts in more than one scope is refused too, unless `--scope` names the scope the entry stands for, so a merchant-scope glob cannot quietly authorise a script running inside a provider frame.

Everything outside the glob is unaffected: a script anywhere else, including one directory up, is still reported as `new`, and fails the gate in merchant scope.

### Integrity policies

Each manifest entry has an `integrity` policy and an `integrityMethod`. The policy is what Scriptlock enforces; the method records what actually assures integrity in production, so a report never reads a weak policy as "integrity covered".

| Policy | What Scriptlock checks | Typical use |
|---|---|---|
| `strict` | SHA-256 of the body must equal the approved value. Any change fails. | First-party bundles built from this repository. |
| `structural` | Structural hash must equal the approved value. Literal-only changes are ignored. | Inline blocks that carry per-request state. |
| `track` | Body changes are recorded as `changed` at info severity and never fail. | Evergreen third-party scripts (Stripe.js v3, gtm.js). |
| `url-only` | Only identity is enforced. Body changes are not reported. | Scripts whose integrity is assured elsewhere, for example by SRI or CSP. |

`track` and `url-only` are not integrity assurance. They tell you that the source is controlled and, for `track`, that the body changed; they do not tell you the body is what you approved. Reports render such entries with their `integrityMethod` (`sri`, `csp`, `vendor-attested`, `source-tracked`, `none`) so the gap is visible. Defaults applied by `approve` when `--integrity` is not given: first-party external scripts `strict`, third-party external scripts `track`, inline and eval scripts `structural`; change them in `scriptlock.config.yaml`.

### Scope

Every frame, and every script inside it, gets a scope:

- `merchant`: the main frame and any same-origin frame. These are the scripts on the page that embeds the payment form, and they gate the diff.
- `tpsp`: a cross-origin frame whose host matches a built-in or configured payment provider pattern (Stripe, Adyen, PayPal, Braintree, Checkout.com, Klarna, Mollie, Square, Google Pay, Apple Pay, Authorize.net, Worldpay and others). Collected and tagged, informational by default.
- `threeds`: a cross-origin 3-D Secure or ACS challenge frame. Exempt.
- `embedded`: any other cross-origin frame (chat widgets, ads). Informational by default.

An approved script observed in a different scope raises `scope-changed`.

### Gate versus drift

`scriptlock diff --gate` is meant for deploy pipelines. An unapproved (`new`) script fails only in merchant scope and is informational in tpsp, threeds and embedded scope; `changed`, `moved`, `spoofed` and, under the `strict` headers policy, header changes fail in any scope. `scriptlock diff --drift` is meant for the scheduled weekly run and is broader: new non-merchant scripts and removed frames become warnings. The matrix is data in the code and is shown by `scriptlock diff --help`.

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

Exit code is 2 if any `blocked`, else 1 if any `fail`, else 0.

## Manifest example

`scriptlock.lock.yaml` for the `default` profile, `scriptlock.<profile>.lock.yaml` otherwise. Keys are written in a stable order and entries are sorted by scope and id so pull request diffs stay readable.

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
    sha256: 9f2c1a4d8e7b3f0a2c5d9e8f1b4a7c3d6e9f2b5a8c1d4e7f0a3b6c9d2e5f8a1b
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
    sha256: 41ba7e3c9d2f5a8b1c4e7f0a3d6b9e2c5f8a1d4b7e0c3f6a9d2b5e8c1f4a7d0b
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
    structuralHash: 9f2c1a4d8e7b3f0a2c5d9e8f1b4a7c3d6e9f2b5a8c1d4e7f0a3b6c9d2e5f8a1b
    owner: web
    category: framework
    justification: Framework hydration state; literals change per request
    approvedBy: v.nizovtsev
    approvedAt: 2026-09-02
ignore: []
```

Matching: exact `id` first, then the first entry whose `match` glob matches the observed id. `ignore` takes globs for known noise such as consent-manager preview tags; use it sparingly, because ignored scripts are absent from the evidence.

## Configuration

`scriptlock init` writes `scriptlock.config.yaml`. `loadConfig` looks for `scriptlock.config.yaml`, then `scriptlock.config.yml`, in the current directory; `--config <path>` overrides. A complete annotated example is in [examples/scriptlock.config.yaml](examples/scriptlock.config.yaml).

```yaml
version: 1
browser:
  channel: chromium          # Playwright-managed build; or "chrome", "msedge", or executablePath
  headless: true
  viewport: { width: 1366, height: 900 }
  timeoutMs: 30000
  extraHeaders:
    X-Scanner-Token: ${SCRIPTLOCK_SCANNER_TOKEN}
  storageState: ./auth.json  # Playwright storage state, for a page behind a login
identity:
  stripQuery: []             # query parameters removed before identity, in addition to built-in cache busters
  keepQuery: []              # query parameters kept even if they look like cache busters
  collapseHashes: true       # replace hash-like path tokens with [hash]
scope:
  tpsp: []                   # extra payment provider host globs
  threeds: []                # extra 3DS / ACS host globs
integrity:
  firstParty: strict
  thirdParty: track
  inline: structural
  eval: structural
profiles:
  default:
    url: https://shop.example.com/checkout
    wait: load               # load | domcontentloaded | networkidle | commit
    settleMs: 3000           # idle time after the last step, to catch late tags
    runs: 1                  # runs unioned per scan
    history: false           # persist snapshots and diffs under .scriptlock/history/<profile>/
  preview:
    url: ${PREVIEW_URL}
    manifest: scriptlock.lock.yaml   # several profiles can share one manifest, which is how a
                                     # preview deployment is gated against the production
                                     # inventory. Without it the manifest is
                                     # scriptlock.lock.yaml for "default" and
                                     # scriptlock.<profile>.lock.yaml for any other profile.
```

`${VAR}` in any string value is replaced from the environment. A missing variable is a configuration error that names the variable, so every environment that loads the file must define every variable it references, including profiles that are not being scanned.

Interpolation applies to `url` as well, and the URL is written verbatim to the snapshot, to every report and to the CI artifact. A `fill` step's value is redacted from output because it may be a secret; a URL is not. Keep tokens out of `url` — use `browser.extraHeaders` or `storageState` for authentication instead — or treat the snapshot as carrying that secret.

### Flows

Profiles can walk to the payment form before collecting. Inline steps:

```yaml
profiles:
  checkout:
    url: https://shop.example.com/
    steps:
      - goto: /product/42            # relative to profile.url
      - click: "text=Add to cart"
      - goto: /checkout
      - fill: { selector: "#email", value: "test@example.com" }
      - waitFor: "#payment-element iframe"
      - wait: 2000
```

`wait` defaults to `load`. Avoid `networkidle`: it waits for two seconds of network silence, and a storefront with analytics beacons, long polling or refreshing ads never goes quiet, so the scan times out instead of collecting. When tags arrive late, raise `settleMs` rather than changing `wait`.

Available steps: `goto`, `click`, `fill`, `select`, `waitFor`, `wait`, `press`, `screenshot`. For anything more, `steps: ./checkout-flow.ts` loads a module whose default export is `async (page: Page) => void`; `.js` and `.mjs` are imported directly, `.ts` needs `tsx` installed. See [examples/checkout-flow.ts](examples/checkout-flow.ts). Authenticated flows reuse a Playwright `storageState` file via `browser.storageState`.

Production scans stop at the rendered payment form. Never fill in or submit a card.

### Scanning behind bot management

Bot management (Cloudflare, Akamai, DataDome and others) must allowlist the scanner. Scriptlock ships no stealth patches, deliberately: an evidence tool that hides from your own defences is not one you can explain to an assessor.

- Send a scanner token through `browser.extraHeaders` and match it in a skip or allow rule (Cloudflare Super Bot Fight Mode skip rules or IP Access rules, Akamai custom bot categories, DataDome custom rules). The token is sent only to the profile host, its subdomains and any host listed in `browser.extraHeadersHosts`; it is stripped from requests to third-party script hosts and provider iframes, so it is not disclosed to them. Keep it low-privilege and scoped to the scanner regardless.
- Run the scan from static egress IPs (a self-hosted runner or a fixed NAT) and allowlist those.
- If a run still lands on a challenge page, Scriptlock records it as `blocked` and exits 2 instead of reporting an empty or wrong inventory. Every snapshot records the user agent, browser build and host name so the evidence states its own vantage point.

### CLI reference

```
scriptlock init   [--url <url>] [--force]         write scriptlock.config.yaml with a "default" profile
scriptlock scan   [--profile <name>] [--runs N] [--out <file>] [--config <path>] [--json]
scriptlock diff   [--profile <name>] [--gate|--drift] [--snapshot <file>] [--format text|md|json]
               [--history] [--config <path>] [--out <file>]
scriptlock approve <id...> [--all-new] [--match <glob>] [--replace] --owner <s> --category <c>
               --justification <s>
               [--integrity strict|structural|track|url-only] [--integrity-method <m>]
               [--approved-by <s>] [--scope <s>] [--notes <s>] [--refresh] [--headers]
               [--snapshot <file>] [--profile <name>]
scriptlock report [--profile <name>] [--format md|json] [--snapshot <file>] [--out <file>]
```

Global options: `--config <path>`, `--verbose`, `--no-color`. `scan` writes `.scriptlock/last.<profile>.json` unless `--out` is given. `diff` runs a scan unless `--snapshot` is given, and that scan replaces `.scriptlock/last.<profile>.json` so `approve` can act on what the diff just reported; a blocked scan is written to `.scriptlock/blocked.<profile>.json` instead, so a challenge page cannot destroy the last good snapshot. `approve` reads the last snapshot unless `--snapshot` is given; `--approved-by` defaults to `git config user.name` or `$USER`, and `approvedAt` is today's UTC date. `approve --match <glob>` writes the single glob entry described in [Content-hashed bundles](#content-hashed-bundles), refuses a glob wider than one directory of one host, and lists every observed script it authorises with that script's scope; it writes one entry, so it cannot be combined with script ids, `--all-new` or `--refresh`. `--replace` (only with `--match`) removes the exact-id entries the glob makes redundant. Categories: `payment`, `functional`, `framework`, `tag-manager`, `analytics`, `marketing`, `advertising`, `consent`, `customer-success`, `security`, `ab-testing`, `cdn`, `other`.

Exit codes: 0 clean, 1 findings at fail severity (or no manifest yet), 2 run error — a blocked scan, a navigation failure, an invalid configuration, a missing browser, a usage error, or a Node older than 22. `scriptlock` with no command prints help and exits 2, so a dropped argument in CI is never mistaken for a finding.

### Library API

Scriptlock is a CLI. The package also has an importable entry point, but at 0.1.x only `scan`, `diff`, `readManifest`, `writeManifest`, the Zod schemas and the exported types are treated as public. Everything else `scriptlock` exports is an internal helper that may be renamed or removed in any release without a major version bump.

## GitHub Action

The repository root contains a composite action. It installs Node and `scriptlock`, installs Chromium, runs `scriptlock diff`, writes the markdown report to the job summary, prints the text report to the log, uploads `.scriptlock/` as a run artifact and exits with Scriptlock's exit code.

On a public repository a run artifact is downloadable by anyone, and the snapshot inside it names every script URL on the scanned page, the final URL and the full `content-security-policy`. Set `artifact: "false"` when the page must not be described publicly.

```yaml
- uses: vladimirnizovtsev/scriptlock@v0.1.0
  with:
    profile: default          # profile from scriptlock.config.yaml
    mode: gate                # gate | drift
    config: scriptlock.config.yaml
    node-version: "22"
    version: "0.1.0"          # scriptlock version to install; "latest" is the default
    history: "false"          # also write .scriptlock/history/<profile>/
    working-directory: .
    artifact: "true"          # upload .scriptlock/ as a run artifact
    retention-days: "90"      # clamped to the repository maximum, 90 on public repos
```

Outputs: `exit-code` (0, 1 or 2) and `summary-file` (path to the markdown report). Two copy-paste workflows are in [examples/workflows](examples/workflows):

- [scriptlock-weekly.yml](examples/workflows/scriptlock-weekly.yml): scheduled `drift` run every Monday at 06:00 UTC with history enabled. GitHub emails the person who last edited the cron line when a scheduled workflow fails.
- [scriptlock-deploy-gate.yml](examples/workflows/scriptlock-deploy-gate.yml): `gate` run on every pull request against a preview deployment, with the report posted as a pull request comment.

The action is also usable without GitHub: run the same commands in any CI that can install Node and Chromium.

## Evidence for assessors

What to show:

- `scriptlock.lock.yaml` (or the per-profile manifests): the script inventory, with `justification`, `owner`, `category`, `integrity`, `integrityMethod`, `approvedBy` and `approvedAt` on every entry, plus the header baseline. When branch protection requires review, the git history of that file is the authorization trail: each entry lands through a reviewed pull request.
- `.scriptlock/history/<profile>/` and the uploaded run artifacts: timestamped snapshots and diff results for every run, including the browser build and vantage point. Run artifacts are not a long-term evidence store: GitHub clamps artifact retention to the repository maximum, 90 days on public repositories and the Free plan, and only warns when a workflow asks for more. For a trail that outlives that, run with `history: true` and commit `.scriptlock/history/<profile>/` deliberately (it is otherwise gitignored), or copy the artifacts to your own storage.
- The workflow file with its cron line: the monitored pages (profile URLs and flows) and the cadence.
- `scriptlock report --format md`: the inventory grouped by scope, owner and category with authorization status (approved, unapproved, stale).

What Scriptlock does not provide, and what you still need to document yourself:

- Alert routing beyond CI. Scriptlock alerts through the failing job: GitHub's failure email for scheduled workflows, the red check on a pull request, and the job summary. If your process needs a pager, a ticket or a Slack message, wire that up from the workflow.
- An incident response procedure (PCI DSS 12.10.5). Scriptlock raises the event; who responds, how and within what time is your procedure.
- A targeted risk analysis (12.3.1) if you run less often than every seven days.
- A judgement on sufficiency. See [Limits](#limits-read-this-first).

## Comparison

Scriptlock is not the first tool in this space. Where a tool below does what you need, use it.

| Tool | What it is | How it differs from Scriptlock |
|---|---|---|
| [mr-yum/pci-dss-page-tampering](https://github.com/mr-yum/pci-dss-page-tampering) | Open source (MIT). Puppeteer crawl, git-held script and header inventory with pull request approval, SHA-256, header diff, Slack alerts, GitHub Actions, HTML and JSON auditor reports. | Closest prior art. Shaped for one company's stack: separate inventory repository, git token, Slack, optional SQS-fed RUM. Scriptlock is a single npm CLI with the manifest in your own repository and no external services. |
| [ntoledo319/pci-payment-page-check](https://github.com/ntoledo319/pci-payment-page-check) | Open source GitHub Action that allowlists script hosts found in served HTML. | Does not execute JavaScript, so it cannot see dynamically inserted, eval or iframe scripts, and does not hash bodies. |
| [dennis-wu/checkout-script-monitor](https://github.com/dennis-wu/checkout-script-monitor) | Open source WooCommerce plugin inventorying checkout scripts. | Platform-specific, runs inside WordPress, no repository or CI workflow. |
| [joshlarsen/driftbot](https://github.com/joshlarsen/driftbot) | Open source Puppeteer monitor for script source changes. | Unmaintained since 2022. No manifest, scope model or CI gate. |
| [sampsonc/csp_toolkit](https://github.com/sampsonc/csp_toolkit), [@makerx/csp-analyser](https://www.npmjs.com/package/@makerx/csp-analyser) | Open source CSP tooling: checks, generation, header monitoring. | CSP-focused; no script inventory. Complementary. |
| [changedetection.io](https://github.com/dgtlmoon/changedetection.io) | Open source generic page change monitoring with a browser fetcher. | Detects that a page changed; no script inventory, hashing or CI mode. |
| [cside](https://cside.com/pricing) | Commercial; free plan with a 6.4.3 and 11.6.1 dashboard. | Runtime agent on the page, hosted dashboard. Scriptlock has no agent and keeps data in your infrastructure. |
| [Cloudflare Client-Side Security](https://developers.cloudflare.com/client-side-security/) | Commercial; script monitoring on the Free plan for Cloudflare-proxied sites. | Requires Cloudflare in front of the site; alerting and change detection in paid tiers. Scriptlock works without Cloudflare. |
| [PageCrawl](https://pagecrawl.io/pricing) | Commercial; free tier for page change monitoring with header capture. | Page-level changes, no script-level inventory or hashing. |
| [Feroot](https://feroot.com/free-scanners/), [Jscrambler](https://jscrambler.com/pci-dss-payment-page-analysis) | Commercial; free one-shot scans, runtime agents in the full product. | One-shot scans are not a repeatable, versioned control; full products are agent-based. |
| [Reflectiz](https://www.reflectiz.com/), [SecurityMetrics Shopping Cart Monitor](https://www.securitymetrics.com/shopping-cart-monitor) | Commercial agentless scanning, quote-based. | Same architecture class as Scriptlock, delivered as a service with a hosted history and alerting. |

What Scriptlock does that the others above do not combine: an npm-installable single CLI; the manifest in your own repository, reviewed in pull requests; a CI gate on staging or preview URLs before deploy; CDP-level capture of eval, `new Function`, inline, `blob:` and dynamically inserted scripts, including inside cross-origin iframes; a per-entry integrity policy with an explicit integrity method; no agent on the page; no data leaving your infrastructure; no dependency on Cloudflare or any other proxy.

## Scope and ethics

Only scan properties you own or have written permission to scan. Never point flows at third-party shops. Production scans stop at the rendered payment form and never submit a card; use test cards only on staging or a sandbox, and prefer preview deployments for the gate. Scriptlock identifies itself as a normal Chromium and ships no stealth patches; if a site's bot management blocks it, ask the owner to allowlist the scanner rather than working around the block.

## Roadmap

0.1.x is the inventory, the manifest, the diff and the Action. Later, in rough order: worker script bodies (dedicated and service workers), a CSP draft derived from the manifest, SARIF output for code scanning, alert webhooks, and a history store beyond flat JSON files. No hosted service is planned.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The software is distributed on an "AS IS" basis, without warranties or conditions of any kind; the authors accept no liability for any assessment outcome, breach or loss arising from its use.
