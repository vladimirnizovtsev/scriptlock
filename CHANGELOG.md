# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `tessera init`: writes `tessera.config.yaml` with a `default` profile.
- `tessera scan`: opens a page in Chromium through `playwright-core`, attaches a CDP session before navigation and records every script V8 parses (external, inline, eval and `new Function`, `blob:`, `data:`, module scripts, dynamically inserted tags, scripts inside same-origin and cross-origin iframes), with SHA-256 over the source bytes, a structural hash, initiator and `loadedBy`, plus the main document's security headers. Writes `.tessera/last.<profile>.json`.
- Identity model: URL normalisation with hash-token collapsing and cache-buster stripping; content-based ids for inline and eval scripts; real URL taken from the engine so `//# sourceURL=` cannot rename a script.
- Scope classification: `merchant`, `tpsp`, `threeds`, `embedded`; harness scripts dropped. Built-in payment provider and 3DS host patterns, extensible from the config.
- Manifest `tessera.lock.yaml` with per-entry integrity policy (`strict`, `structural`, `track`, `url-only`), integrity method, owner, category, written justification, approver and date; frame entries; header baseline with `strict`, `track` or `ignore` policy; `ignore` globs; `match` globs for content-hashed bundles. Stable key order and sorted entries.
- `tessera approve`: adds entries from the last snapshot (`--all-new` or by id) with integrity defaults per script origin and kind (worker entries default to url-only with no body hash); `--refresh` for tracked hashes, `--headers` to record the observed security headers, `--notes` for free-form notes.
- `tessera diff` with `--gate` and `--drift` severity matrices; events `new`, `removed`, `changed`, `moved`, `spoofed`, `scope-changed`, header changes, `new-frame`, `removed-frame`, `blocked`; exit codes 0, 1, 2; text, markdown and JSON output; `--history` to persist snapshots and diffs under `.tessera/history/<profile>/`.
- `tessera report`: inventory grouped by scope, owner and category with authorization status, as markdown or JSON.
- Flow DSL (`goto`, `click`, `fill`, `select`, `waitFor`, `wait`, `press`, `screenshot`) and module flows (`steps: ./flow.ts`).
- Multiple runs per scan unioned by id, so intermittent tags are not reported as removed after one quiet run.
- Bot-management challenge page detection (Cloudflare `cf-mitigated` header and challenge markup, Akamai SEC-CPT and block pages, DataDome, PerimeterX, HTTP 403/428/429/503) reported as `blocked` with exit code 2; `tessera scan` also exits 2 on a blocked page. Vendor sensor snippets on ordinary 200 pages are not treated as blocked.
- Composite GitHub Action (`action.yml`) and example workflows for a weekly drift run and a pull request deploy gate.
- Fixture site and server for e2e tests; unit tests for every rule in the design.
- Documentation: README with limits, requirement mapping, evidence guidance and comparison; CONTRIBUTING, SECURITY.

[Unreleased]: https://github.com/vladimirnizovtsev/tessera/compare/main...HEAD
