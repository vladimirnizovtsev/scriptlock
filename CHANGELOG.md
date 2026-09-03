# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.4.0] - 2026-09-03

A code-quality pass, and one change consumers of the library must read: the package used to export 106 symbols and now exports 39. The CLI, the manifest format, the diff and the Action are untouched, so nothing about scanning or its output changed and no manifest needs regenerating. If you only run the CLI, this is a maintenance release.

### Removed

- The library surface is the list in DESIGN.md section 2 plus the types, `ScriptlockError` and the three Zod schemas. Internal helpers that had leaked into `src/index.ts` are no longer exported: every symbol a 0.x package exports is a promise, and 106 of them was a promise the project could not keep while it still moves. If you imported something that is gone, open an issue and say what for; nothing in the repository imported them, which is why they went.

### Fixed

- A snapshot file carrying a response header that is not one of the ten security headers was accepted, although `Snapshot.headers` is typed as `SecurityHeaders` and the diff both compares and prints those values. A hand-edited or foreign `--snapshot` with `set-cookie` in `headers` produced a `header-added set-cookie` fail event whose report printed the cookie into the CI log or the pull request comment. Such a file is now refused by `parseSnapshot`. Snapshots written by `scriptlock scan` were never affected: the collector already filtered to the security headers.
- A command sent to an out-of-process iframe over CDP could never settle if the target went away between the parent accepting the message and the reply arriving. Nothing rejected those promises on detach or dispose and nothing timed them out, so one torn-down cross-origin iframe could hang the scan for the rest of the run — on the main path, since `diff` awaits the frame refresh. Child commands are now bounded by `browser.timeoutMs` and every pending one is rejected when the target detaches or the capture is disposed.
- `CONTRIBUTING.md`'s release runbook created tag `v0.3` and then force-pushed `v0.2`. Following it left tag-pinned Action consumers on the old ref and force-moved a tag the release never touched. A new guard in `test/unit/docs.test.ts` parses the runbook's shell blocks and fails when a pushed tag is not one the same block created, or when the tagged version is not the one in `package.json`.

### Changed

- The public API (`src/index.ts`) is now exactly the list in DESIGN.md section 2 plus the shared types, `ScriptlockError` and the three Zod schemas. It previously re-exported roughly 180 symbols — command plumbing, package-manager detection, internal helpers — each of which was a rename hazard under semver, justified by a comment claiming the CLI and the tests imported this module. Neither did; both use deep imports, and still do. The CLI is unaffected.
- `npm run typecheck` now also typechecks `test/` and `fixtures/` through a new `tsconfig.test.json`. Those 4,800 lines were excluded from the only typechecking the project ran, and three type errors were live in them — including an unguarded `inline?.structuralHash.slice(...)` in the cross-origin-iframe e2e test that would have thrown a `TypeError` instead of failing an assertion.
- The runtime lists behind `ScriptKind`, `Scope`, `IntegrityPolicy`, `IntegrityMethod`, `ScriptCategory` and `SecurityHeaderName` live in `src/types.ts` and the unions are derived from them, the way `SECURITY_HEADER_NAMES` already was. The hand-written copies in the config schema, the manifest schema, the CLI choice lists and the report orderings are gone: adding a member used to compile clean while both validators silently rejected it.
- `commands/scan.ts` no longer doubles as the shared command runtime. `CommandContext` and profile resolution moved to `commands/context.ts`, the snapshot file layer to `commands/snapshot.ts`, and the inventory model shared by the markdown and JSON reports to `report/inventory.ts` — the two had already drifted on how they group by owner and category. `errors.ts` and the new modules are in the DESIGN.md module map, which claims to list every file and did not list `errors.ts`.
- DESIGN.md section 3.2 described attaching to out-of-process iframes with `newCDPSession(frame)` on `frameattached`. The collector uses non-flattened `Target.setAutoAttach` with `waitForDebuggerOnStart`, which catches those frames before they run; the documented approach races the frame's first scripts. The contract now describes what the code does and why the alternative was rejected. A new section 4.4 documents the `wasm` and `unknown` kinds, which had their own identity rule, hash function and integrity path and appeared nowhere in the contract.

### Added

- Tests for four behaviours that had none: a script authorised only by a hashless `--match` glob stays silent (the clause that makes `approve --match` usable at all could be deleted with every test still green), the identity-collision warning of DESIGN.md 4.1 rule 3 (with two colliding chunks in the fixture site behind `?collide=1`), the 16-character boundary of the alphanumeric hash-token rule, and `bodyNotCaptured` for a script that is not a worker.

## [0.3.0] - 2026-09-03

Installation, and the commands Scriptlock prints for you to run. Nothing about the scan, the identity model, the diff matrix or the manifest format changed, and no manifest needs regenerating. If Scriptlock is already installed and scanning, there is nothing here to upgrade for; this release exists so that a fresh install under pnpm or yarn reads instructions that work, and so that a reader who gets stuck is handed a command that runs.

### Added

- Documentation for watching more than one page: profiles for several URLs in one configuration, the step list for walking to a payment form that has no URL of its own, the per-profile manifest naming rule, and a CI matrix that gives each page its own check and its own artifact. It also states something the tool did not say anywhere: a profile with steps records every page the flow walks, not only the last one, so a checkout reached through the storefront yields a wider inventory than the same checkout scanned directly.

- `scriptlock install-browser`: installs the Chromium build this Scriptlock drives, using the `playwright-core` bundled inside the package, resolved by path instead of looked up on `PATH`. One command under every package manager — npm, pnpm, Yarn Classic and Yarn Berry's PnP — and one that cannot drift from the browser revision the CLI actually launches, which a separately installed `playwright-core` can. `--with-deps` passes through for the Linux system libraries.

### Fixed

- The install instructions covered npm only, and a reader following them in a pnpm project got a crash inside npm's own dependency resolver. The obvious repair — document `pnpm exec playwright-core install chromium` and `yarn playwright-core install chromium` alongside the npm line — is wrong, and the draft of this release carried it: neither command exists. `playwright-core` is a *transitive* dependency of Scriptlock, and only npm and Yarn Classic hoist a transitive package's binary into `node_modules/.bin`; pnpm and Yarn Berry link none, so there is no `playwright-core` command to run. The README and the missing-browser error now both name `scriptlock install-browser`. Found by a reader installing 0.2.1 into their own pnpm site.
- The missing-browser error printed three commands and asked the reader to pick the one for their package manager. Two were wrong for any given reader, and under pnpm and Yarn Berry the one that looked right was the broken one — the tool misdirected exactly the users it was changed for. It now detects the manager (`npm_config_user_agent`, then the nearest lockfile) and prints one command.
- Every command Scriptlock prints for you to run now carries that manager's runner: `npx scriptlock scan`, `pnpm exec scriptlock scan`, `yarn scriptlock scan`. The numbered next steps from `scriptlock init`, the `approve --all-new` instructions a first `diff` prints, and the `approve --match` bundle hint were bare `scriptlock …`, which is `command not found` in every project the README tells you to create, because Scriptlock is installed as a development dependency and is on no `PATH`.
- The error for a `.ts` flow module without `tsx` hard-coded `npm install --save-dev tsx` — in a pnpm project, the very command that crashed npm in the original report. It names the detected manager's command now, and says that `tsx` has to be a direct dependency of the project that runs the CLI, because pnpm and Yarn Berry expose nothing a project has not declared.
- The GitHub Action installed Chromium through a path hard-coded into npm's global tree (`$(npm root -g)/scriptlock/node_modules/playwright-core/cli.js`). It runs `scriptlock install-browser --with-deps chromium` instead. The `scriptlock --version` line stays in the install step ahead of it, and now says why: on too old a `node-version` it is what produces "scriptlock requires Node 22 or later" rather than an unexplained crash later.

### Changed

- The annotated `scriptlock.config.yaml` that `init` writes points at `scriptlock install-browser` for the Chromium install, and so does `examples/scriptlock.config.yaml`. This text is shipped output, written into every new user's configuration file.
- The README attributes the `Cannot read properties of null (reading 'matches')` crash to what actually causes it — npm reading a `node_modules` tree that pnpm built out of symlinks — gives yarn the problem that applies to yarn instead (a second lockfile and a second tree, drifting apart in silence), and says how to recover if you already ran the wrong install.
- The README's Library API section states that the package is ESM only. `require('scriptlock')` from a CommonJS file such as a `next.config.js` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; `import` and dynamic `import()` work.
- The CLI reference states that `--config` selects the configuration file only, and that the manifest and `.scriptlock/` resolve against the current directory and not against that file — the rule the GitHub Action section already gave for `working-directory`, and a trap in a monorepo.
- The bug report template and `SECURITY.md` ask for the version the way the reporter's own package manager runs it. `npx scriptlock --version` in a project with no `node_modules` — Yarn Berry's PnP, or a project where the install silently failed — reports a registry copy rather than the installed one, with no warning that it did.
- CI installs the packed tarball under npm, pnpm, Yarn Classic and Yarn Berry and runs the documented walkthrough with each, ending with the browser install and a real scan. Nothing in this repository installed Scriptlock the way a reader is told to, which is how an install command that had never been run reached a release twice. That is the defect class of this release.

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

[Unreleased]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vladimirnizovtsev/scriptlock/releases/tag/v0.1.0
