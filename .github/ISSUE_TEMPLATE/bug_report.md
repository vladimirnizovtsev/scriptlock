---
name: Bug report
about: A scan, diff, approve or report command did not behave as documented
title: ""
labels: bug
assignees: ""
---

## What happened

A clear description of the behaviour you saw.

## What you expected

## Steps to reproduce

Commands, in order, with the exact flags. If the page is not public, describe it: which script kinds are involved (external, inline, eval, blob, iframe), which payment provider, whether bot management is in front of it.

```sh
npx scriptlock scan --profile default
npx scriptlock diff --gate
```

(Use the runner your project uses: `npx`, `pnpm exec` or `yarn`.)

## Output

Paste the relevant terminal output. Run with `--verbose` for more detail. Redact hostnames, tokens and anything else you do not want public.

```
```

## Environment

- scriptlock version, asked the way your own package manager runs it — `npx scriptlock --version`, `pnpm exec scriptlock --version` or `yarn scriptlock --version` — plus the `scriptlock` line from your `package.json`. In a project with no `node_modules` (Yarn Berry's PnP, or an install that failed), `npx` reports a copy it fetched from the registry rather than the one you have:
- Package manager and version (`npm -v`, `pnpm -v` or `yarn -v`):
- Node version (`node --version`):
- Operating system:
- Browser channel or executablePath from scriptlock.config.yaml:
- Running in CI (which provider) or locally:

## Manifest and config excerpts

The relevant profile from `scriptlock.config.yaml` and, for diff problems, the manifest entry that matched or should have matched. Do not paste the whole manifest if it contains information about your payment page you would rather not publish.

## Checklist

- [ ] I own the page I scanned or have written permission to scan it.
- [ ] This is not a report about a script that Scriptlock classified but did not judge (Scriptlock does not decide whether a script is malicious).
- [ ] This is not a security vulnerability in Scriptlock itself (report those privately, see SECURITY.md).
