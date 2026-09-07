# Agent Note: Owner-local profile tests and runnable guides

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-owner-local-profile-tests-and-guides.zh.md)

## Problem

The top-level `examples/` tree mixed four unrelated roles: redundant application compositions, cross-package profile tests, package-specific Loader fixtures, and runnable user guides. Its umbrella workspace manifest existed primarily to make arbitrary nested Cordis files resolve packages, so test and documentation placement determined dependency resolution and made unsupported demo launchers look like product interfaces.

## Decision

There is no top-level `examples/` tree. Named `dsh` profiles are the only Node application compositions. Cross-package ACP, headless, and SDK profile tests live under `apps/cli/tests/profiles/`; package-specific Loader configs and drivers live under their package's `tests/fixtures/`. Recorded-session tests remain under top-level `snapshots/`, and non-session expected output remains owner-local.

Optional user overlays are shipped assets under `apps/cli/config/examples/`, where their bare plugin names resolve through the CLI application manifest. The GitHub review, Schedule, memory MCP, and runtime Cordis guides live under `docs/user/` and link those assets. The runnable Python SDK program and minimal overlay live under `python/sdk/examples/`.

The `demo:acp` and `demo:cordis` scripts are absent. ACP starts through `dsh --profile acp`; the Cordis guide starts `dsh web` with its explicit overlay. `demo:ptc` remains as a thin wrapper over `dsh --profile headless` with `DSH_TOOLS_MODE=ptc`.

## Alternatives considered

**Keep an examples workspace only for module resolution.** Rejected: a resolver manifest containing the union of unrelated test and guide dependencies hides ownership and lets an arbitrary leaf behave like an application package.

**Move every file under the CLI app.** Rejected: package-specific test compositions evolve with their package, while user instructions belong in the published guide hierarchy and Python examples belong with the SDK.

**Keep compatibility demo commands.** Rejected: the named profiles and explicit overlays already expose the supported launches, and compatibility wrappers would preserve a second application vocabulary.

## Consequences

Paths identify ownership without consulting a verdict table. CLI profile tests resolve from one application manifest; package tests carry their own fixtures; shipped optional overlays are installable with the CLI package; user guides appear in website navigation; the Python example sits beside its SDK. Removing a guide or test no longer changes a global dependency umbrella.
