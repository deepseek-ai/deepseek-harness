# Agent Note: Publish experimental packages with explicit private exceptions

Status: implemented

English | [中文](2026-09-12-experimental-publication-denylist.zh.md)

## Problem

An allowlist for public experimental packages requires a policy edit whenever a new installable prototype joins the repository. Experimental status describes compatibility and support expectations, but internal-only prototypes still need an explicit publication exclusion.

## Decision

The local npm baseline publisher and the public dsh release family discover experimental packages by default. [`PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`](../../../../scripts/experimental-package-policy.ts) owns explicit private exclusions. The [complete experimental publication decision](2026-09-12-publish-all-experimental-packages.md) leaves this denylist empty; all current experimental packages publish.

Every experimental directory outside the denylist is public by default. Workspace constraints require public packages to omit `private` and set `publishConfig.access: public`; all experimental packages retain the `@deepseek-ai/dsh-experimental-*` npm prefix. Adding a private prototype requires a denylist entry as well as its private manifest.

This decision supersedes the private publication default in the [Agent Teams package decision](../architecture/2026-08-18-experimental-agent-teams-packages.md). Its dependency isolation, opt-in composition, engineering requirements, and promotion rules remain active. Publication grants neither stability nor a support promise.

## Alternatives considered

**Retain a public allowlist.** Every new public experimental package needs another policy entry, even though the default publication path can discover it.

**Publish every experimental package immediately.** This would expose the existing internal-only prototypes. An explicit private denylist changes the default for new packages while preserving their current publication status. The [complete publication decision](2026-09-12-publish-all-experimental-packages.md) records their separate publication.

## Consequences

New experimental packages join both npm publication paths without an allowlist edit. Private exceptions have one shared owner, and workspace validation rejects manifests that disagree with it.
