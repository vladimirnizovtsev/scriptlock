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
npx tessera scan --profile default
npx tessera diff --gate
```

## Output

Paste the relevant terminal output. Run with `--verbose` for more detail. Redact hostnames, tokens and anything else you do not want public.

```
```

## Environment

- tessera-cli version (`npx tessera --version`):
- Node version (`node --version`):
- Operating system:
- Browser channel or executablePath from tessera.config.yaml:
- Running in CI (which provider) or locally:

## Manifest and config excerpts

The relevant profile from `tessera.config.yaml` and, for diff problems, the manifest entry that matched or should have matched. Do not paste the whole manifest if it contains information about your payment page you would rather not publish.

## Checklist

- [ ] I own the page I scanned or have written permission to scan it.
- [ ] This is not a report about a script that Tessera classified but did not judge (Tessera does not decide whether a script is malicious).
- [ ] This is not a security vulnerability in Tessera itself (report those privately, see SECURITY.md).
