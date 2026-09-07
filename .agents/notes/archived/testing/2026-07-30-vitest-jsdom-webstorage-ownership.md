# Agent Note: Keep browser storage owned by jsdom in Vitest

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-vitest-jsdom-webstorage-ownership.zh.md)

## Problem

The supported Node range includes releases that reserve a process-wide `globalThis.localStorage`. Node 26 exposes that property as `undefined` without `--localstorage-file`; Vitest sees the reserved key and does not project jsdom's isolated `Storage` object over it. Component suites then fail before exercising product behavior, while the primary Node 24 coverage lane remains green because that runtime does not reserve the key by default.

## Decision

Vitest workers disable Node's process-wide Web Storage when the runtime advertises the `--webstorage` flag. The configuration passes `--no-webstorage` through each test project's `execArgv`; runtimes without that flag receive no argument. Node-environment suites therefore stay browser-free, and files selecting jsdom through `@vitest-environment jsdom` receive jsdom's isolated `localStorage`.

The Node compatibility aggregate runs a dedicated jsdom smoke on every advertised compatibility line. It asserts both the conditional worker argument and usable storage, so a future Node or Vitest change cannot leave the primary Node 24 suite as the only signal.

## Alternatives considered

- **Set `NODE_OPTIONS=--no-webstorage` in package scripts or CI.** Rejected because it leaks test-runner policy into subprocesses and misses direct `pnpm exec vitest` invocations.
- **Pass `--localstorage-file` to Node.** Rejected because one process-wide persistent store has different ownership and isolation semantics from browser storage created per jsdom environment.
- **Patch `globalThis.localStorage` in setup code or guard every component test.** Rejected because setup would depend on Vitest's private jsdom projection details, while per-test guards hide a broken browser environment and duplicate policy across suites.
- **Pin tests to Node 24.** Rejected because the package engine advertises newer even Node lines and the compatibility matrix exists to expose their runtime changes.

## Consequences

The same `pnpm test` command works on Node releases with and without built-in Web Storage. Test workers deliberately cannot exercise Node's process-wide Web Storage; a future product need for that API requires a separate explicit test configuration rather than weakening jsdom isolation. The compatibility lane adds one focused Vitest process instead of duplicating the complete unit inventory on every Node version.
