# Agent Note: Remove the separate CLI demo

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-08-remove-cli-demo.zh.md)

## Problem

After [`dsh --profile headless`](../architecture/2026-08-06-app-owned-command-line.md) became the product one-shot command, `@deepseek-ai/dsh-cli-demo` remained a second application package for the same job. It carried another executable, argument grammar, app composition, cancellation lifecycle, text/JSON/stream-JSON output contract, built artifact, documentation surface, and test suite. The two entry points also assembled different trees, so a successful demo did not prove the shipped `headless` profile and users had to choose between overlapping commands.

The replay suites still need canonical session events to pin assembled backend behavior. That testing need does not require a published command or compatibility contract.

## Decision

Delete `@deepseek-ai/dsh-cli-demo` completely: its package, bin, parser, app plugin, output formats, tests, workspace references, generated-catalog entries, and active documentation. No alias or compatibility package remains. Source users invoke the product command through `pnpm dsh --profile headless`; it owns final-text stdout, failure diagnostics on stderr, persistence, exit status, and shutdown.

`apps/cli/tests/profiles/headless` loads the shipped `base` and `headless` bundle layers, then applies narrow overlays for replay or mock providers, isolated persistence, and the behavior under test. The support-tier `@deepseek-ai/dsh-loader-smoke` package owns the shipped-profile composition helper, the shared direct-agent turn helper, and the test-only driver; the driver renders canonical events as JSONL without defining a supported product output format.

## Alternatives considered

- **Keep `dsh-cli-demo` as an alias or wrapper around `dsh --profile headless`.** Rejected because a second bin and package would preserve two discoverable owners without adding capability.
- **Move JSON and stream-JSON flags onto `dsh --profile headless`.** Rejected because no current product consumer requires them; adopting the old demo protocol would enlarge the canonical CLI contract solely to save test machinery.
- **Delete the canonical-event snapshots with the package.** Rejected because they pin model-visible assembled behavior that final-text product acceptance cannot observe.
- **Keep the app plugin but delete only its bin.** Rejected because the hidden composition would still duplicate the explicit headless profile and conceal which services the test leaf mounts.

## Consequences

This is intentionally breaking. `dsh-cli-demo`, its `--output-format` choices, and imports from `@deepseek-ai/dsh-cli-demo/src/cli.ts` no longer resolve. There is no public event-stream replacement in this change; callers use `dsh --profile headless` for one-shot execution and must choose an existing protocol API when they need structured automation.

The repository retains backend replay coverage through test-only infrastructure, while product smoke and built-bin acceptance exercise `dsh --profile headless`. A separate one-shot package may return only if it owns a genuinely independent, versioned protocol that cannot belong to the product launcher; a second spelling or output shim is not enough.

## Verification

Focused Loader smokes cover the explicit composition in source and plain-Node built modes, snapshot tests diff its canonical JSONL and persisted logs, product acceptance covers `dsh --profile headless`, and documentation plus generated graph/catalog gates reject live references to the removed package. The frozen Agent Note archive remains historical evidence and is not rewritten.
