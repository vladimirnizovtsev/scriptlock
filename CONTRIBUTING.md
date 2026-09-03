# Contributing to Scriptlock

Thank you for taking the time. Scriptlock is small and opinionated; the fastest way to get a change merged is to read [DESIGN.md](DESIGN.md) first, because it is the engineering contract that every module follows.

## Development setup

Requirements: Node 22 or later, npm, and a machine that can run Chromium.

```sh
git clone https://github.com/vladimirnizovtsev/scriptlock.git
cd scriptlock
npm ci
npx playwright-core install chromium     # on Linux CI add --with-deps
```

Useful commands:

| Command | What it does |
|---|---|
| `npm run dev -- scan` | Run the CLI from source with tsx (`npm run dev -- <command> [flags]`) |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm test` | All vitest projects: `unit` and `e2e` |
| `npx vitest run --project unit` | Unit tests only (pure functions, no network, no browser) |
| `npm run test:e2e` | E2E tests only, against the fixture server in `fixtures/` with a real Chromium |
| `npm run test:watch` | Vitest in watch mode |
| `npm run build` | tsup bundle plus `tsc --emitDeclarationOnly` into `dist/` |

CI runs typecheck, both test projects and the build on Node 22 and 24 for every push and pull request.

## Where things live

The module map in DESIGN.md section 2 lists every file and what it owns. Modules communicate only through `src/types.ts` and the exported functions named there. If your change alters identity, integrity, scope, diff semantics or the CLI surface, update DESIGN.md and `src/types.ts` in the same pull request; the two must never disagree.

Conventions, in short (DESIGN.md section 11):

- TypeScript strict, ESM, NodeNext resolution: relative imports use the `.js` extension.
- No default exports, except user flow modules.
- Every module file starts with a short comment stating what it owns and its known limitations.
- Errors thrown to the CLI are `ScriptlockError` with a `code` and an `exitCode`.
- Unit tests make no network calls. E2E tests use only the fixture server.
- English everywhere: code, comments, docs, commit messages. No emojis.
- User-facing text never says "ensures compliance", "PCI compliant" or "QSA validated". Scriptlock produces evidence artifacts and helps you prepare. See the README "Limits" section.

## Tests

Add a unit test for pure logic (normalisation, hashing, matching, diff rows, rendering) and an e2e test when the change touches collection or the CLI end to end. The fixture site in `fixtures/` is the place to add a new script kind or page behaviour; do not point tests at real websites.

## Commits and pull requests

- Write imperative English subjects: "Add structural hash for template literals", not "Added" or "Adding". Conventional Commits prefixes are welcome but not required.
- Keep pull requests focused. A refactor and a behaviour change are two pull requests.
- Fill in the pull request template. It asks what changed, why, how it was verified and whether the contract documents were updated.

### Developer Certificate of Origin

Scriptlock uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a Contributor License Agreement. There is no CLA to sign. By adding a `Signed-off-by` line to your commits you certify that you wrote the change or otherwise have the right to submit it under the Apache License 2.0.

```sh
git commit -s -m "Add header policy ignore"
```

The line must carry a real name and a working email address:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Pull requests with unsigned commits will be asked to rebase with `git rebase --signoff`.

## Releasing

Releasing the GitHub Action is a git tag, not an npm publish. The runner reads `action.yml` from the ref in `uses:` and never from the npm tarball, so a release that only bumps the npm version leaves every action consumer on the old `action.yml` — which is exactly how the 0.1.0 artifact defect would have survived 0.2.0.

1. Update `CHANGELOG.md`, `package.json`, the `version` input default in `action.yml` and the `uses:` and `version:` lines in `README.md` and `examples/workflows/`. `test/unit/action.test.ts` fails when the `version` default and `package.json` disagree.
2. `npm run typecheck && npm test && npm run build && npm pack --dry-run`.
3. Tag the exact version and push it, then publish a GitHub release for that tag:

   ```sh
   git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0
   ```

4. Advance the moving tags, so a workflow that pinned a tag rather than a SHA can receive the fix at all. `v0.1` tracks the latest patch of the 0.1 line and `v0` tracks the latest 0.x release; before 1.0 a minor may break, so say so in the changelog when `v0` crosses one.

   ```sh
   git tag -f v0.1 v0.2.0 && git push -f origin v0.1
   git tag -f v0   v0.2.0 && git push -f origin v0
   ```

5. `npm publish` for the CLI. When the release is action-only, say so in the changelog entry: users must change their `uses:` ref, and bumping the `version:` input changes nothing.

## Reporting bugs and vulnerabilities

Bugs: open an issue using the bug report template. Vulnerabilities in Scriptlock itself: do not open an issue; follow [SECURITY.md](SECURITY.md).

## Scope of contributions

Things that fit version 1: collection accuracy, identity and normalisation rules, new payment provider or 3DS host patterns, report formats, documentation and examples. Things on the roadmap that are welcome as proposals first: worker script bodies, a CSP draft, SARIF output, alert webhooks, a history store. Things that will not be merged: stealth or anti-bot-detection patches, an in-page agent, anything that sends scan data to a third party by default, and wording that presents Scriptlock as an attestation of compliance.
