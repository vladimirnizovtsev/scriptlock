# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.2.1] - 2026-09-03

Documentation release, with two corrections to what the tool prints about itself.

### Changed

- The README opens with a seven-step walkthrough against a live page, with the real output of each command, and everything that was there before follows as reference. It used to take a third of the document to learn what the tool was or how to run it. Reviewing the new draft by following it literally, rather than reading it, found that it could not be followed: the demo page had drifted into the state the last step describes, so a reader's own scan disagreed with every screenshot. The [demo storefront](https://github.com/vladimirnizovtsev/scriptlock-demo-shop) now serves a second page carrying one extra tag, so that step is a URL change and a rerun rather than a story.

### Fixed

- `scriptlock report` printed `source-tracked` as the integrity method of every `track` and `url-only` entry, ignoring what the entry actually recorded. An entry approved as `vendor-attested` or `sri` was described in the inventory as something else, in the document an assessor reads. It now prints the entry's own `integrityMethod`.
- The error `approve --match` prints when a glob spans two scopes claimed that naming one scope leaves the scripts in the other scopes unapproved. It does not: the glob still authorises them, and each is reported as `scope-changed`. The hint now says so.

## [0.2.0] - 2026-09-03

Numbered 0.2.0 rather than 0.1.1: it began as a one-line fix to the artifact upload, and the audit that followed turned it into added inputs, an added output, an added CLI flag and a change to how the scanner sends `browser.extraHeaders`. Added behaviour is a minor version, and calling it a patch would understate what a reader has to check.

Everything in this release is in `action.yml` and its documentation, plus the two CLI changes the action needed. **To get any of it, change the action reference in your workflow**: `uses: vladimirnizovtsev/scriptlock@v0.2.0`, or re-pin the commit SHA. The `version:` input, which selects the npm package, is not involved — the runner reads `action.yml` from the git ref, never from npm — so bumping `version:` alone leaves the action unchanged.

### Fixed

- The GitHub Action uploaded no run artifact. `actions/upload-artifact` has skipped hidden files by default since v4.4, and the uploaded path `.scriptlock` starts with a dot, so every run logged "No files were found with the provided path" and the snapshot and diff history that the action exists to preserve were silently discarded. Found by running the action against the [demo storefront](https://github.com/vladimirnizovtsev/scriptlock-demo-shop).

  Detection was never affected. The gate and drift verdicts and the exit code come from the diff, not from the upload, so no 0.1.0 run reported a wrong result and there is nothing to re-audit. What was lost is the evidence artifact, and it cannot be recovered: GitHub cannot attach artifacts to a finished run, and re-running today produces today's evidence, not the dated evidence of that run. `history: true` did not preserve it either — `.scriptlock/history/` is gitignored and neither example workflow commits it, so those files existed only inside the artifact that was never uploaded. Treat the 0.1.0 window as a gap in the artifact trail, and re-run on 0.2.0 to start producing artifacts again.

- The action ran `scriptlock scan` before `scriptlock diff`, which silently disabled the blocked-snapshot guard: `scan --out` honours its path unconditionally, so a bot-management challenge page overwrote `.scriptlock/last.<profile>.json` with a one-script challenge inventory, and the run then aborted before writing any report. The action now runs `scriptlock diff` once and lets the diff perform the scan, which is where the guard lives — a challenge page is written to `.scriptlock/blocked.<profile>.json`, the last good snapshot is left alone, the `blocked` event is reported and the report is still published. The page is also scanned once instead of twice.

- The action wrote two history entries per run whenever the profile set `history: true`, so `.scriptlock/history/<profile>/index.jsonl` double-counted every run: it invoked `diff` twice and the CLI ORed `--history` with the profile setting. The action now runs one diff, and its `history` input is authoritative in both directions (see `--no-history` below).

- `exit-code` and `summary-file` are no longer empty when the run fails before the diff (an invalid input, a failed install, a blocked scan under the old pre-scan step). `exit-code` is now always 0, 1 or 2 — 2 when the diff did not run, which is a run error — and `summary-file` is set only when the report file exists, with a new `report-written` output saying so.

- A first run with no manifest yet no longer produces a job summary consisting of one content-free line. The diff's stderr — the `scriptlock approve --all-new …` instructions — is now included in the job summary, where it is actually read.

- `action.yml` documentation corrections: `exit-code` no longer names three run-error cases the output could not carry, `summary-file` no longer claims a report that may not exist, and the `config` input states that the manifest and `.scriptlock/` resolve against `working-directory`, not against the configuration file.

### Added

- `scriptlock diff --no-history`: suppresses history even when the profile sets `history: true`. `--history` / `--no-history` / neither is a tri-state, with the profile setting as the default, so a caller that diffs twice over one scan can keep exactly one history entry.
- Action input `summary` (default `"true"`): with `"false"` the job summary and the job log carry only the counts and the exit code, not the report. The report names the scanned URL, every script URL and, on a header event, the full `content-security-policy`; on a public repository the job summary and the log are readable with no GitHub account at all, which `artifact: "false"` never affected.
- Action input `artifact-name` (default the previous `scriptlock-<profile>-<job id>`): a matrix that varies anything other than the profile produced two legs with the same artifact name, and the second upload failed with a conflict.
- Action output `report-written`.
- `.github/dependabot.yml` for the `github-actions` and `npm` ecosystems, so the pinned SHAs below are maintained rather than left to rot.
- A unit test over `action.yml` and every workflow in `.github/workflows` and `examples/workflows`: it asserts the artifact upload sets `include-hidden-files`, that every declared input is used, that the `version` default matches `package.json`, that outputs come from a step that always runs, and that every `uses:` is pinned to a full commit SHA. That is the defect class of this release; end-to-end behaviour of the action is still verified only by running it against a live deployment.

### Changed

- The action installs with `npm install -g --ignore-scripts`, so no lifecycle script of the package or its dependencies runs in a job that may hold secrets. Nothing in the tree needs one; the browser is installed by the explicit Chromium step.
- The `version` input defaults to `0.2.0` instead of `latest`. A scheduled control that produces evidence must not silently change what it runs between two weekly reports; `latest` still works and is documented as non-reproducible.
- The action validates its inputs before installing anything, and now also rejects a `profile` that is not a safe file-name segment, a multi-line `config`, `working-directory` or `artifact-name` (both are interpolated into shell and into upload-artifact's newline-separated path patterns), and a non-numeric `retention-days`.
- The artifact upload uses `if-no-files-found: error`. The default `warn` is what let this release's own defect ship green.
- The action's `uses:` references, both example workflows and the repository's own CI are pinned to full commit SHAs. A consumer who pins `vladimirnizovtsev/scriptlock` by SHA still executed whatever `actions/upload-artifact@v7` pointed at that day, so the pin bought less than it appeared to.
- `actions/checkout` runs with `persist-credentials: false` in the examples and in CI, so the job token is not left in `.git/config` inside a directory that gets uploaded.
- `action.yml` is no longer in the npm package's `files`. The runner reads it from the git ref; in the tarball it could never be executed and only suggested that the npm version carried the action.

### Security

- `browser.extraHeaders` is no longer set as `extraHTTPHeaders` on the browser context. The headers were previously put on every request and stripped again by a route handler, which does not see requests made by a Service Worker — so a service worker on the scanned page could have carried the scanner token to a third-party host. The headers are now added by that same route handler, and only for the profile host, its subdomains and `browser.extraHeadersHosts`, so a request the router never sees carries no token. Externally visible behaviour is unchanged.
- The `artifact` input's disclosure warning covered only the artifact. It now covers the job summary and the job log, and `summary: "false"` turns those off. The README's "downloadable by anyone" is corrected: the artifact zip needs a signed-in GitHub account, while its name, size and digest — and the run page with the job summary — are readable anonymously.
- `action.yml` and the README state that no input of this action may carry a secret: the runner echoes each composite step's `env:` block into the job log, and inputs are passed through it. Authentication belongs in `browser.extraHeaders` / `browser.storageState`, fed from `secrets.*` in the caller's own `env:`.
- The deploy-gate example documents that it targets same-repository pull requests and guards its comment step accordingly: on a fork pull request GitHub issues a read-only token regardless of the declared `permissions:`, so the comment step would 403 and fail the job after a clean gate.

## [0.1.0] - 2026-09-03

First release.

### Added

- `scriptlock init`: writes `scriptlock.config.yaml` with a `default` profile.
- `scriptlock scan`: opens a page in Chromium through `playwright-core`, attaches a CDP session before navigation and records every script V8 parses (external, inline, eval and `new Function`, `blob:`, `data:`, module scripts, dynamically inserted tags, scripts inside same-origin and cross-origin iframes), with SHA-256 over the source bytes, a structural hash, initiator and `loadedBy`, plus the main document's security headers. Writes `.scriptlock/last.<profile>.json`.
- Identity model: URL normalisation with hash-token collapsing and cache-buster stripping; content-based ids for inline and eval scripts; real URL taken from the engine so `//# sourceURL=` cannot rename a script.
- Scope classification: `merchant`, `tpsp`, `threeds`, `embedded`; harness scripts dropped. Built-in payment provider and 3DS host patterns, extensible from the config.
- Manifest `scriptlock.lock.yaml` with per-entry integrity policy (`strict`, `structural`, `track`, `url-only`), integrity method, owner, category, written justification, approver and date; frame entries; header baseline with `strict`, `track` or `ignore` policy; `ignore` globs; `match` globs for content-hashed bundles. Stable key order and sorted entries.
- `scriptlock approve`: adds entries from the last snapshot (`--all-new` or by id) with integrity defaults per script origin and kind (worker entries default to url-only with no body hash); `--refresh` for tracked hashes, `--headers` to record the observed security headers, `--notes` for free-form notes.
- `scriptlock approve --match <glob>`: one manifest entry that authorises a whole directory of content-hashed build output (Next.js, Vite, Nuxt, Astro, webpack), whose chunk names change on every deploy. The entry's `id` and `match` are the glob, every observed script keeps its own identity and body hash in the inventory, and integrity is `track` because a glob covers many bodies. The glob is bounded to one directory of one host (`**`, a leading `!`, `{`, `(`, `|`, a wildcard in the host and a glob covering the root of an origin are refused), `strict` / `structural` are refused for any glob, a glob spanning scopes is refused unless `--scope` names one, the command lists every id it authorises with that id's scope, and `coveredAtApproval` records that coverage in the lockfile as evidence.
- `scriptlock approve --match --replace`: removes the exact-id entries the glob makes redundant, so the chunk entries left behind by an earlier `approve --all-new` stop being reported as `removed` on every deploy. Without the flag the same entries are listed with the advice to re-run with it.
- Placeholder guard: `approve` refuses an owner or justification that is still the placeholder from a printed command (`...`, `<team>`, `<why ...>`), so the manifest never records `justification: ...` as evidence.
- `scriptlock diff` with `--gate` and `--drift` severity matrices; events `new`, `removed`, `changed`, `moved`, `spoofed`, `scope-changed`, header changes, `new-frame`, `removed-frame`, `blocked`; exit codes 0, 1, 2; text, markdown and JSON output; `--history` to persist snapshots and diffs under `.scriptlock/history/<profile>/`.
- Diff hints (`DiffResult.hints`, shown by the text, markdown and JSON reports): when three or more new scripts share a directory and differ only in their file names, the report prints the ready-to-paste `scriptlock approve --match` command for that directory, with quoted placeholders so the line survives a copy into bash or zsh, with glob metacharacters in the directory escaped, and only when the composed glob is one `approve --match` accepts. Advisory only: hints never change a severity, the summary or the exit code.
- `scriptlock report`: inventory grouped by scope, owner and category with authorization status, as markdown or JSON.
- Flow DSL (`goto`, `click`, `fill`, `select`, `waitFor`, `wait`, `press`, `screenshot`) and module flows (`steps: ./flow.ts`).
- Multiple runs per scan unioned by id, so intermittent tags are not reported as removed after one quiet run.
- Bot-management challenge page detection (Cloudflare `cf-mitigated` header and challenge markup, Akamai SEC-CPT and block pages, DataDome, PerimeterX, HTTP 403/428/429/503) reported as `blocked` with exit code 2; `scriptlock scan` also exits 2 on a blocked page. Vendor sensor snippets on ordinary 200 pages are not treated as blocked.
- Guards against a green pipeline built on nothing: a main document outside 200-299 is recorded in `snapshot.warnings` and printed in red by `scriptlock scan`; `scriptlock approve` refuses to create a manifest from a snapshot with no scripts and no security headers; `scriptlock diff` reports a manifest with no script entry as an `empty-manifest` fail in both modes. A typo'd or temporarily unreachable profile URL can no longer produce a passing gate.
- URL normalisation keeps a file name whose whole stem is a hash (`chunks/9c1a4f0b8d2e.js`), so sibling chunks do not collapse into one identity; when two observed URLs still normalise to the same id, the scan records a warning naming both rather than dropping one silently.
- `scriptlock init` adds `.scriptlock/` to an existing `.gitignore` and prints the line when there is none: the snapshot is a full inventory of every script URL on the scanned page and is not a committed artifact.
- `scriptlock diff` writes a blocked scan to `.scriptlock/blocked.<profile>.json` instead of `.scriptlock/last.<profile>.json`, so a challenge page cannot destroy the last good snapshot that `approve` and `report` read.
- The `approve --match` command printed as a diff hint carries the `--profile` and `--config` of the run that printed it, so a pasted command cannot land on another profile's manifest.
- `scriptlock` refuses to run on a Node older than `engines.node` with a message naming the version, and printing help because no command was given exits 2 (usage error) rather than 1 (findings).
- Composite GitHub Action (`action.yml`) and example workflows for a weekly drift run and a pull request deploy gate. The artifact upload is opt-out (`artifact: "false"`) and its retention is an input defaulting to 90 days, the maximum GitHub allows on public repositories and the Free plan.
- Fixture site and server for e2e tests; unit tests for every rule in the design.
- Documentation: README with limits, requirement mapping, evidence guidance and comparison; CONTRIBUTING, SECURITY.

[Unreleased]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vladimirnizovtsev/scriptlock/releases/tag/v0.1.0
