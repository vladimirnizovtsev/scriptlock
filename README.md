# Tessera

Tessera is a lockfile for everything that executes in the browser. It opens a page in a real Chromium, records every script the JavaScript engine parsed (static tags, dynamically inserted tags, inline blocks, `eval` and `new Function`, `blob:` and `data:` URLs, scripts inside iframes), writes the result to a manifest that lives in your repository, and fails CI when the page diverges from that manifest. It also records the security-impacting HTTP headers of the main document and diffs them. There is no agent on the page, nothing is injected into real users' sessions, and no data leaves your infrastructure.

It is built for agencies, product teams and development teams that run a custom or embedded (iframe) checkout with a repository and CI, and that need three things from one tool: a script inventory with written justifications, change detection on a schedule, and a gate that blocks a deploy when the payment page picks up code nobody approved.

> Status: version 1 is complete and tested, but `tessera-cli` is not published to npm yet and there is no `v1` tag.
> Until the first release, run it from a clone: `npm install && npm run build && node dist/cli.js --help`.
> The npm and Action instructions below describe the released flow.

## Limits, read this first

Tessera produces evidence artifacts of the kind that PCI SSC testing-procedure guidance lists: inventory records, written justifications, change-detection results and header baselines. It is not an attestation, it is not validated by PCI SSC or any QSA, and it does not determine whether your controls are sufficient. Whether the evidence is enough for your assessment is a decision for you and your assessor. Tessera helps you prepare; it does not decide.

Synthetic scans are a sample, not a guarantee:

- A skimmer can detect automation and stay dormant, serve different code by geography or session, or appear for a fraction of visitors. A scan that sees nothing is not proof that nothing is there.
- There is a window between runs. A weekly run can miss code that was present for six days in between.
- Tessera does not judge what a script does. It tells you that a script is new, changed, moved or spoofed; a human decides whether that is acceptable.
- Runs can be blocked by bot management. Tessera detects challenge pages and fails the run as `blocked` rather than reporting a wrong inventory, but it ships no stealth patches. Allowlisting is your responsibility (see [Scanning behind bot management](#scanning-behind-bot-management)).

Out of scope, cannot be scanned:

- Shopify-hosted checkout. Shopify states that crawler signatures do not grant access to its checkout, and there is no merchant-side allowlist for a scanner.
- Hosted redirect checkouts (Stripe Checkout, PayPal redirect and similar) where the customer leaves your origin. The payment page is not yours to scan, and the requirements discussed below do not apply to the redirecting page.
- Dedicated and service worker bodies (version 1 records their entry URLs only), and any behaviour that only appears after a real card is submitted. Tessera never submits a card.

## Which requirement applies to you

PCI DSS v4.0.1 requirement 6.4.3 asks for an inventory of all payment page scripts with a written business or technical justification, an authorization method and an integrity method for each. Requirement 11.6.1 asks for a mechanism that detects and alerts on unauthorized changes to security-impacting HTTP headers and to script contents as received by the consumer browser, at least once every seven days or at a frequency set by a targeted risk analysis under 12.3.1. Both were best practice until 31 March 2025 and are mandatory after that date for merchants validating with SAQ A-EP, SAQ D or a Report on Compliance.

| Your integration | What applies | Where Tessera fits |
|---|---|---|
| Redirect or fully outsourced. The customer is sent to a third-party payment page (HTTP 30x, meta refresh or JavaScript redirect). | 6.4.3 and 11.6.1 do not apply to the redirecting page (FAQ 1588; information supplement, March 2025). | Not needed for PCI. Still useful as a plain script lockfile for your own pages. |
| SAQ A with an embedded payment form or iframe from a PCI DSS compliant third-party service provider (TPSP). | On 30 January 2025 PCI SSC removed 6.4.3, 11.6.1 and 12.3.1 from SAQ A and added an eligibility criterion: the merchant has confirmed that its site is not susceptible to script attacks that could affect its e-commerce systems. FAQ 1588 (February 2025) says the criterion applies only to merchants embedding a TPSP form or iframe and is met either by techniques such as those in 6.4.3 and 11.6.1, performed by the merchant or a third party, or by confirmation from the compliant TPSP that its solution, implemented per its instructions, protects the merchant's page. | The TPSP controls the inside of its iframe; it cannot see the page that embeds it. Tessera is a parent-page control: it inventories and diffs the scripts on your page that surround and create the iframe (supplement Table 3 assigns those to the merchant). |
| SAQ A-EP, SAQ D or Report on Compliance. Your page handles or can affect cardholder data (direct post, JavaScript SDKs such as Accept.js, or you simply do not qualify for SAQ A). | 6.4.3 and 11.6.1 in full. FAQ 1331 (updated August 2026) requires that scoping these requirements out with SAQ eligibility criteria is explicitly reviewed and agreed with your compliance-accepting entity (acquirer or brand) before a ROC merchant relies on it. | The manifest is the 6.4.3 inventory with justification, authorization (a reviewed pull request) and integrity method per script. The scheduled `diff --drift` run and its history are 11.6.1 change-detection results. See [Evidence for assessors](#evidence-for-assessors) for what Tessera does and does not provide. |

Sources by name: PCI DSS v4.0.1; the PCI SSC blog post of 30 January 2025 announcing the SAQ A changes; PCI SSC FAQ 1588 (February 2025); PCI SSC FAQ 1331 (updated August 2026); the PCI SSC Information Supplement "Payment Page Security and Preventing E-Skimming" (March 2025). SAQ type is determined by how your payment page is built, not by merchant size. When in doubt, ask your acquirer or assessor.

The March 2025 information supplement is non-normative, but it describes the model Tessera implements. It defines an agentless monitoring model as a process or service, for example a headless browser, that regularly walks checkout flows and observes loaded scripts, headers and behaviours without adding scripts to real users' sessions; it lists that model's limitations (CAPTCHAs, logins, state-based flows, scheduled rather than constant checks); it names "automated or manual transaction simulations" among example mechanisms for 11.6.1; and it accepts email, SYSLOG and vendor logs as alerting methods. Its Table 3 makes the merchant responsible for scripts on the page that embeds a payment iframe and the TPSP responsible for scripts inside the iframe, which is exactly how Tessera assigns scope.

## Quick start

Requirements: Node 20 or later. Tessera depends on `playwright-core` and ships no browser; the Playwright-managed Chromium build is installed once.

```sh
npm install --save-dev tessera-cli
npx playwright-core install chromium

# Write tessera.config.yaml with a "default" profile, then edit the URL.
npx tessera init

# Open the page, record every script and header, write .tessera/last.default.json
npx tessera scan

# Turn the snapshot into a manifest. Every script without an entry gets one.
npx tessera approve --all-new \
  --owner web \
  --category functional \
  --justification "Initial inventory of the checkout page, reviewed in PR #123"

# Re-scan and compare. Exit 0 clean, 1 findings, 2 run error (blocked, navigation failure).
npx tessera diff --gate
```

Commit `tessera.config.yaml` and `tessera.lock.yaml`. From now on every change to the set of scripts on the page is a change to a file in your repository. When branch protection requires review, each such change lands through a reviewed pull request like any other change.

Then add the weekly run. Copy [examples/workflows/tessera-weekly.yml](examples/workflows/tessera-weekly.yml) into `.github/workflows/` in your repository:

```yaml
on:
  schedule:
    - cron: "0 6 * * 1" # weekly cadence for 11.6.1; change only with a documented targeted risk analysis
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: vladimirnizovtsev/tessera@v1
        with:
          mode: drift
          history: true
```

Approve a single script later with its id, refine an entry's policy, or refresh tracked hashes:

```sh
npx tessera approve "https://cdn.example.com/widget.js" \
  --owner marketing --category marketing \
  --justification "Chat widget, contract 2026-14" \
  --integrity track --integrity-method vendor-attested

npx tessera approve --refresh "https://js.stripe.com/v3"
npx tessera report --format md --out inventory.md
```

## How it works

### Collection

Tessera launches Chromium through `playwright-core`, attaches a Chrome DevTools Protocol session to the page before navigation and enables the `Debugger`, `Runtime` and `Network` domains. Every script V8 parses arrives as a `Debugger.scriptParsed` event: inline blocks, `<script src>` tags whether static or inserted later, module scripts, `eval`, `new Function`, `blob:` and `data:` URLs. The source is fetched immediately and hashed with SHA-256 over its UTF-8 bytes; the engine's own hash field is never stored because it is not an SRI value. Cross-origin iframes get their own CDP session, so the scripts inside a payment provider's frame are recorded too, tagged with their own scope. Scripts injected by the automation harness itself are detected and dropped.

A script can lie about its URL with a `//# sourceURL=` comment. Tessera takes the real URL from the engine and the network log, records the claimed one separately as `sourceUrl`, and never uses it for identity. A script whose claimed URL matches a manifest entry while its real URL has none is reported as `spoofed`.

After navigation, the optional flow steps run (a small YAML DSL or a Playwright module, see [Configuration](#configuration)), the page settles for `settleMs`, the main document's status and security headers are extracted, and a challenge-page check runs. A scan can repeat `runs` times; results are unioned so that a tag that only loads sometimes is not reported as removed after a single quiet run.

### Identity

Identity answers "is this the same script as before" independently of body changes.

- URL-addressed scripts (`external`, `blob`, `data`, `worker`) are identified by a normalised URL: lower-case scheme and host, default ports and fragments dropped, hash-like path tokens collapsed to `[hash]` (`/assets/app.3f9c2a1b.js` becomes `/assets/app.[hash].js`), built-in cache-buster query parameters removed, remaining parameters sorted. Values are kept, because `?id=GTM-ABC` is identity-relevant. `blob:` URLs become `blob:<origin>`.
- Inline and eval scripts are identified by `<kind>:<frame origin>:<structural hash prefix>`, so an inserted block above them does not change their identity.
- The structural hash masks string literals, numbers, regular expressions, comments and whitespace before hashing. Framework hydration blocks whose literals change on every request keep a stable structural hash; a change to the code itself changes it.

Manifest entries can also carry a `match` glob for content-hashed bundles.

### Integrity policies

Each manifest entry has an `integrity` policy and an `integrityMethod`. The policy is what Tessera enforces; the method records what actually assures integrity in production, so a report never reads a weak policy as "integrity covered".

| Policy | What Tessera checks | Typical use |
|---|---|---|
| `strict` | SHA-256 of the body must equal the approved value. Any change fails. | First-party bundles built from this repository. |
| `structural` | Structural hash must equal the approved value. Literal-only changes are ignored. | Inline blocks that carry per-request state. |
| `track` | Body changes are recorded as `changed` at info severity and never fail. | Evergreen third-party scripts (Stripe.js v3, gtm.js). |
| `url-only` | Only identity is enforced. Body changes are not reported. | Scripts whose integrity is assured elsewhere, for example by SRI or CSP. |

`track` and `url-only` are not integrity assurance. They tell you that the source is controlled and, for `track`, that the body changed; they do not tell you the body is what you approved. Reports render such entries with their `integrityMethod` (`sri`, `csp`, `vendor-attested`, `source-tracked`, `none`) so the gap is visible. Defaults applied by `approve` when `--integrity` is not given: first-party external scripts `strict`, third-party external scripts `track`, inline and eval scripts `structural`; change them in `tessera.config.yaml`.

### Scope

Every frame, and every script inside it, gets a scope:

- `merchant`: the main frame and any same-origin frame. These are the scripts on the page that embeds the payment form, and they gate the diff.
- `tpsp`: a cross-origin frame whose host matches a built-in or configured payment provider pattern (Stripe, Adyen, PayPal, Braintree, Checkout.com, Klarna, Mollie, Square, Google Pay, Apple Pay, Authorize.net, Worldpay and others). Collected and tagged, informational by default.
- `threeds`: a cross-origin 3-D Secure or ACS challenge frame. Exempt.
- `embedded`: any other cross-origin frame (chat widgets, ads). Informational by default.

An approved script observed in a different scope raises `scope-changed`.

### Gate versus drift

`tessera diff --gate` is meant for deploy pipelines. An unapproved (`new`) script fails only in merchant scope and is informational in tpsp, threeds and embedded scope; `changed`, `moved`, `spoofed` and strict/structural header changes fail in any scope. `tessera diff --drift` is meant for the scheduled weekly run and is broader: new non-merchant scripts and removed frames become warnings. The matrix is data in the code and is shown by `tessera diff --help`.

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

`tessera.lock.yaml` for the `default` profile, `tessera.<profile>.lock.yaml` otherwise. Keys are written in a stable order and entries are sorted by scope and id so pull request diffs stay readable.

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

`tessera init` writes `tessera.config.yaml`. `loadConfig` looks for `tessera.config.yaml`, then `tessera.config.yml`, in the current directory; `--config <path>` overrides. A complete annotated example is in [examples/tessera.config.yaml](examples/tessera.config.yaml).

```yaml
version: 1
browser:
  channel: chromium          # Playwright-managed build; or "chrome", "msedge", or executablePath
  headless: true
  viewport: { width: 1366, height: 900 }
  timeoutMs: 30000
  extraHeaders:
    X-Scanner-Token: ${TESSERA_SCANNER_TOKEN}
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
    wait: networkidle        # load | domcontentloaded | networkidle | commit
    settleMs: 3000           # idle time after the last step, to catch late tags
    runs: 1                  # runs unioned per scan
    history: false           # persist snapshots and diffs under .tessera/history/<profile>/
```

`${VAR}` in any string value is replaced from the environment. A missing variable is a configuration error that names the variable, so every environment that loads the file must define every variable it references, including profiles that are not being scanned.

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

Available steps: `goto`, `click`, `fill`, `select`, `waitFor`, `wait`, `press`, `screenshot`. For anything more, `steps: ./checkout-flow.ts` loads a module whose default export is `async (page: Page) => void`; `.js` and `.mjs` are imported directly, `.ts` needs `tsx` installed. See [examples/checkout-flow.ts](examples/checkout-flow.ts). Authenticated flows reuse a Playwright `storageState` file via `browser.storageState`.

Production scans stop at the rendered payment form. Never fill in or submit a card.

### Scanning behind bot management

Bot management (Cloudflare, Akamai, DataDome and others) must allowlist the scanner. Tessera ships no stealth patches, deliberately: an evidence tool that hides from your own defences is not one you can explain to an assessor.

- Send a scanner token through `browser.extraHeaders` and match it in a skip or allow rule (Cloudflare Super Bot Fight Mode skip rules or IP Access rules, Akamai custom bot categories, DataDome custom rules). The token is sent only to the profile host, its subdomains and any host listed in `browser.extraHeadersHosts`; it is stripped from requests to third-party script hosts and provider iframes, so it is not disclosed to them. Keep it low-privilege and scoped to the scanner regardless.
- Run the scan from static egress IPs (a self-hosted runner or a fixed NAT) and allowlist those.
- If a run still lands on a challenge page, Tessera records it as `blocked` and exits 2 instead of reporting an empty or wrong inventory. Every snapshot records the user agent, browser build and host name so the evidence states its own vantage point.

### CLI reference

```
tessera init   [--url <url>] [--force]         write tessera.config.yaml with a "default" profile
tessera scan   [--profile <name>] [--runs N] [--out <file>] [--config <path>] [--json]
tessera diff   [--profile <name>] [--gate|--drift] [--snapshot <file>] [--format text|md|json]
               [--history] [--config <path>] [--out <file>]
tessera approve <id...> [--all-new] --owner <s> --category <c> --justification <s>
               [--integrity strict|structural|track|url-only] [--integrity-method <m>]
               [--approved-by <s>] [--scope <s>] [--notes <s>] [--refresh] [--headers]
               [--snapshot <file>] [--profile <name>]
tessera report [--profile <name>] [--format md|json] [--snapshot <file>] [--out <file>]
```

Global options: `--config <path>`, `--verbose`, `--no-color`. `scan` writes `.tessera/last.<profile>.json` unless `--out` is given. `diff` runs a scan unless `--snapshot` is given. `approve` reads the last snapshot unless `--snapshot` is given; `--approved-by` defaults to `git config user.name` or `$USER`, and `approvedAt` is today's UTC date. Categories: `payment`, `functional`, `framework`, `tag-manager`, `analytics`, `marketing`, `advertising`, `consent`, `customer-success`, `security`, `ab-testing`, `cdn`, `other`.

## GitHub Action

The repository root contains a composite action. It installs Node and `tessera-cli`, installs Chromium, runs `tessera diff`, writes the markdown report to the job summary, prints the text report to the log, uploads `.tessera/` as a run artifact and exits with Tessera's exit code.

```yaml
- uses: vladimirnizovtsev/tessera@v1
  with:
    profile: default          # profile from tessera.config.yaml
    mode: gate                # gate | drift
    config: tessera.config.yaml
    node-version: "20"
    version: latest           # tessera-cli version to install
    history: "false"          # also write .tessera/history/<profile>/
    working-directory: .
```

Outputs: `exit-code` (0, 1 or 2) and `summary-file` (path to the markdown report). Two copy-paste workflows are in [examples/workflows](examples/workflows):

- [tessera-weekly.yml](examples/workflows/tessera-weekly.yml): scheduled `drift` run every Monday at 06:00 UTC with history enabled. GitHub emails the person who last edited the cron line when a scheduled workflow fails.
- [tessera-deploy-gate.yml](examples/workflows/tessera-deploy-gate.yml): `gate` run on every pull request against a preview deployment, with the report posted as a pull request comment.

The action is also usable without GitHub: run the same commands in any CI that can install Node and Chromium.

## Evidence for assessors

What to show:

- `tessera.lock.yaml` (or the per-profile manifests): the script inventory, with `justification`, `owner`, `category`, `integrity`, `integrityMethod`, `approvedBy` and `approvedAt` on every entry, plus the header baseline. When branch protection requires review, the git history of that file is the authorization trail: each entry lands through a reviewed pull request.
- `.tessera/history/<profile>/` and the uploaded run artifacts: timestamped snapshots and diff results for every run, including the browser build and vantage point.
- The workflow file with its cron line: the monitored pages (profile URLs and flows) and the cadence.
- `tessera report --format md`: the inventory grouped by scope, owner and category with authorization status (approved, unapproved, stale).

What Tessera does not provide, and what you still need to document yourself:

- Alert routing beyond CI. Version 1 alerts through the failing job: GitHub's failure email for scheduled workflows, the red check on a pull request, and the job summary. If your process needs a pager, a ticket or a Slack message, wire that up from the workflow.
- An incident response procedure (PCI DSS 12.10.5). Tessera raises the event; who responds, how and within what time is your procedure.
- A targeted risk analysis (12.3.1) if you run less often than every seven days.
- A judgement on sufficiency. See [Limits](#limits-read-this-first).

## Comparison

Tessera is not the first tool in this space. Where a tool below does what you need, use it.

| Tool | What it is | How it differs from Tessera |
|---|---|---|
| [mr-yum/pci-dss-page-tampering](https://github.com/mr-yum/pci-dss-page-tampering) | Open source (MIT). Puppeteer crawl, git-held script and header inventory with pull request approval, SHA-256, header diff, Slack alerts, GitHub Actions, HTML and JSON auditor reports. | Closest prior art. Shaped for one company's stack: separate inventory repository, git token, Slack, optional SQS-fed RUM. Tessera is a single npm CLI with the manifest in your own repository and no external services. |
| [ntoledo319/pci-payment-page-check](https://github.com/ntoledo319/pci-payment-page-check) | Open source GitHub Action that allowlists script hosts found in served HTML. | Does not execute JavaScript, so it cannot see dynamically inserted, eval or iframe scripts, and does not hash bodies. |
| [dennis-wu/checkout-script-monitor](https://github.com/dennis-wu/checkout-script-monitor) | Open source WooCommerce plugin inventorying checkout scripts. | Platform-specific, runs inside WordPress, no repository or CI workflow. |
| [joshlarsen/driftbot](https://github.com/joshlarsen/driftbot) | Open source Puppeteer monitor for script source changes. | Unmaintained since 2022. No manifest, scope model or CI gate. |
| [sampsonc/csp_toolkit](https://github.com/sampsonc/csp_toolkit), [@makerx/csp-analyser](https://www.npmjs.com/package/@makerx/csp-analyser) | Open source CSP tooling: checks, generation, header monitoring. | CSP-focused; no script inventory. Complementary. |
| [changedetection.io](https://github.com/dgtlmoon/changedetection.io) | Open source generic page change monitoring with a browser fetcher. | Detects that a page changed; no script inventory, hashing or CI mode. |
| [cside](https://cside.com/pricing) | Commercial; free plan with a 6.4.3 and 11.6.1 dashboard. | Runtime agent on the page, hosted dashboard. Tessera has no agent and keeps data in your infrastructure. |
| [Cloudflare Client-Side Security](https://developers.cloudflare.com/client-side-security/) | Commercial; script monitoring on the Free plan for Cloudflare-proxied sites. | Requires Cloudflare in front of the site; alerting and change detection in paid tiers. Tessera works without Cloudflare. |
| [PageCrawl](https://pagecrawl.io/pricing) | Commercial; free tier for page change monitoring with header capture. | Page-level changes, no script-level inventory or hashing. |
| [Feroot](https://feroot.com/free-scanners/), [Jscrambler](https://jscrambler.com/pci-dss-payment-page-analysis) | Commercial; free one-shot scans, runtime agents in the full product. | One-shot scans are not a repeatable, versioned control; full products are agent-based. |
| [Reflectiz](https://www.reflectiz.com/), [SecurityMetrics Shopping Cart Monitor](https://www.securitymetrics.com/shopping-cart-monitor) | Commercial agentless scanning, quote-based. | Same architecture class as Tessera, delivered as a service with a hosted history and alerting. |

What Tessera does that the others above do not combine: an npm-installable single CLI; the manifest in your own repository, reviewed in pull requests; a CI gate on staging or preview URLs before deploy; CDP-level capture of eval, `new Function`, inline, `blob:` and dynamically inserted scripts, including inside cross-origin iframes; a per-entry integrity policy with an explicit integrity method; no agent on the page; no data leaving your infrastructure; no dependency on Cloudflare or any other proxy.

## Scope and ethics

Only scan properties you own or have written permission to scan. Never point flows at third-party shops. Production scans stop at the rendered payment form and never submit a card; use test cards only on staging or a sandbox, and prefer preview deployments for the gate. Tessera identifies itself as a normal Chromium and ships no stealth patches; if a site's bot management blocks it, ask the owner to allowlist the scanner rather than working around the block.

## Roadmap

Version 1 is the inventory, the manifest, the diff and the Action. Later, in rough order: worker script bodies (dedicated and service workers), a CSP draft derived from the manifest, SARIF output for code scanning, alert webhooks, and a history store beyond flat JSON files. No hosted service is planned.

## License

MIT. See [LICENSE](LICENSE). The software is provided as is, without warranty of any kind; the authors accept no liability for any assessment outcome, breach or loss arising from its use.
