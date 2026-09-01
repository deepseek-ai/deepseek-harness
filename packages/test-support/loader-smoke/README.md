---
description: "Shared subprocess and direct-agent harness for keyless example smoke tests, for test authors booting real Loader compositions."
kind: "package-library"
---

# @deepseek-ai/dsh-loader-smoke

English | [中文](README.zh.md)

## Summary

`dsh-loader-smoke` runs a real application bin and its `cordis.yml` through the Cordis Loader inside an isolated temporary directory, capturing stdout and stderr, so a smoke test exercises the true composition path — plugin loading, service wiring, and the agent loop — rather than a hand-built test context. `runFixtureTurn` drives one task through the composition's single root agent and returns the final assistant text and accumulated token usage. The package also provides the mode-aware launch resolver (`src` under tsx for zero-build dev, built `lib` under plain Node for CI) shared by package-local subprocess harnesses. It is support-tier test infrastructure, not a product API.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package boots an application fixture the way an installed consumer would and lets a test watch the result: choose source or built mode, launch the bin with its config from an isolated cwd, and either wait for a clean exit or drive one task through the root agent.

### Booting an application fixture

`runLoaderSmoke` takes bin and config paths, optional complete bin arguments, environment overrides, stdin, pre-run setup, and pre-cleanup inspection. It owns the isolated cwd, DSH homes, diagnostics, deadline, termination, EOF, and cleanup, and returns both streams after a zero exit or rejects with both streams on failure:

```text
const result = await runLoaderSmoke({
  label: 'acp-agent',
  tempDirPrefix: 'acp-smoke-',
  binScript: '/abs/path/to/src/bin.ts',
  configPath: '/abs/path/to/cordis.yml',
  tsconfigPath: '/abs/path/to/tsconfig.json',
})
```

Set `expectedExitCode` when the scenario pins a designed failure surface — a one-shot turn ending in an error result — and a run that exits any other way, including succeeding, still fails the smoke.

### Testing a shipped profile

Profile integration drivers use the repository-only `tests/fixtures/production-profile.ts` helper. It loads the named shipped profile and its bundle patches through `loadProfile`, reconciles the profile's module fallback, and passes the bundle patches followed by the test's `*.patch.yml` files to the root `cordis:include` mounted by `boot`. Those patches should contain only the test provider or model, isolated persistence paths, and subject-specific changes. Package-level unit tests that need an agent loop without profile integration mount `dsh-agent-loop-testkit` locally instead.

### Driving a fixture turn

`runFixtureTurn(ctx, options)` drives one task through exactly one configured root agent: it waits for the task to reach the durable inbox, forwards canonical events to your observer, flushes the session, and returns the final assistant text plus accumulated usage. Example-local drivers keep configuration, rendering, and assertion ownership.

### Source or built mode

`resolveExampleLaunch` picks the artifact an example bin boots from. `src` mode runs the bin under tsx with `TSX_TSCONFIG_PATH` set, so workspace imports resolve through the tsconfig `paths` map — the zero-build dev path. `lib` mode runs the built `lib/` bin under plain Node, so bare package plugins resolve through real package `exports`, exactly as an installed consumer resolves them. The mode comes from an explicit value or `DSH_EXAMPLE_MODE` (CI sets `lib`, dev leaves it unset); anything else fails loud.

### What can go wrong

- **The process never exits** — the smoke enforces a deadline and reports the captured streams in the failure; a faulty fixture that spawns its own process tree can outlive the smoke and needs external cleanup.
- **Built mode needs a prior build** — run `pnpm run build` before selecting `DSH_EXAMPLE_MODE=lib`; the owning package manifest must also declare every package named by the config.
- **Captured output is bounded by execa's default 100 MB `maxBuffer`** — a runaway child is terminated at that ceiling rather than at a smoke-chosen budget.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the harness; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

The harness is built on one separation: the smoke runs in a child process under an isolated world, and the test process only observes and asserts. `runLoaderSmoke` creates a temporary cwd, prepares world state there, spawns the resolved bin with isolated DSH homes (`DSH_HOME`, `DSH_AGENTS_HOME` under the temp cwd), closes stdin immediately, and awaits a clean exit within the deadline before inspecting and cleaning up on every outcome. `runFixtureTurn` stays in-process: it looks up the composition's single root agent, follows the task from its durable inbox receipt through whole-agent idle, sums per-step usage, and flushes the session before returning.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Mode resolver, `runLoaderSmoke` subprocess harness, options and result types |
| [`src/agent-turn.ts`](src/agent-turn.ts) | `runFixtureTurn` direct-agent driver and result envelope |
| — | No runtime invariant companion is published; this test-support package owns no production event stream or mutable data; consuming test suites exercise its behavior. |
| [`tests/fixtures/production-profile.ts`](tests/fixtures/production-profile.ts) | Repository-only shipped-profile composition helper for integration fixtures |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the harness to the composition it boots and the fixtures it serves.

- [llm-replay](../llm-replay/README.md) — the keyless model fixture smoke compositions mount to run without a provider key.
- [Agent package](../../core/agent/README.md) — the root agent `runFixtureTurn` drives.
- [Testing policy](../../../docs/testing.md) — the keyless snapshot and smoke tiers.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the test harness submits only the consuming test's ordinary user task and delegates prompt and tool composition to the loaded tree.

#### KV Cache effect

None beyond the loaded tree; the helper neither changes the request prefix nor retains state across runs.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the harness needs special care. They are current package constraints, not a task backlog.

- **Built mode requires a prior build** — the owning package manifest must also declare every package named by the config.
- **Captured stdout and stderr are bounded only by execa's default 100 MB `maxBuffer`** — a runaway child is terminated at that ceiling rather than at a smoke-chosen budget.
- **Timeout kills only the direct child** — a process tree spawned by a faulty fixture can outlive the smoke and needs external cleanup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
