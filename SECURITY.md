# Security policy

## Reporting a vulnerability

Please report vulnerabilities in Scriptlock privately through GitHub security advisories:

https://github.com/vladimirnizovtsev/scriptlock/security/advisories/new

Do not open a public issue or pull request for a vulnerability. Include the version (`npx scriptlock --version`), a minimal reproduction and the impact you see. You will get an acknowledgement within seven days and a fix or a written assessment as soon as reasonably possible; the advisory is published together with the fixed release. There is no bug bounty. Credit is given in the advisory and the changelog unless you ask otherwise.

## Scope

In scope:

- The `scriptlock` npm package: the CLI, the collector, identity and integrity logic, manifest handling and reporting.
- The composite GitHub Action in `action.yml` and the example workflows.
- Ways to make Scriptlock report a wrong inventory or a clean diff for a page that changed, for example a script that evades collection, an identity collision, a manifest match that is broader than intended, or a `sourceURL` trick that is not flagged as spoofed. These are the bugs that matter most for this project.
- Handling of configuration and environment variables, for example a token from `browser.extraHeaders` leaking into snapshots, history files or reports, reaching a host outside the profile host and `browser.extraHeadersHosts`, or an input of the GitHub Action that would publish a secret into a public job log.

Out of scope:

- Vulnerabilities in websites you scan with Scriptlock. Report those to the site owner.
- Vulnerabilities in Chromium, Playwright or other dependencies. Report those upstream; a dependency bump in Scriptlock is welcome as a pull request.
- The documented limits of synthetic scanning: a skimmer that detects automation and stays dormant, serves different code by geography or session, or appears only for a fraction of visitors, and changes that happen between scheduled runs. These are stated in the README and are not vulnerabilities in Scriptlock.
- Bot management blocking a scan. Scriptlock deliberately ships no stealth patches.
- Findings that require a compromised machine, repository or CI environment to begin with.

## Supported versions

Only the latest release on npm receives fixes. There are no long-term support branches.

## Handling of scan data

Scriptlock runs entirely on the machine that executes it. It does not send snapshots, manifests, headers or script sources anywhere. Snapshots never contain script source text, but they do contain URLs, hashes, headers and the vantage point (user agent, browser build, and the host name of the scanning machine); treat `.scriptlock/` and the run artifacts with the same care as the rest of your build output.

Under the GitHub Action the same description of the page is published three times: to the run artifact (`artifact`), to the job summary and to the job log (`summary`). On a public repository the job summary and the log are readable with no GitHub account, and the artifact by any signed-in GitHub user. No input of the action may carry a secret, because the runner echoes each composite step's `env:` block into the job log; authentication for a scan goes through `browser.extraHeaders` or `browser.storageState` in the configuration, fed from `secrets.*` in the caller's own workflow, which the runner masks.
