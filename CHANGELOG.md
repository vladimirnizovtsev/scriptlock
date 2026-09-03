# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/vladimirnizovtsev/scriptlock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vladimirnizovtsev/scriptlock/releases/tag/v0.1.0
