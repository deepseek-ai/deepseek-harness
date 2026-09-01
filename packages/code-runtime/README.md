---
description: "Package map for the code-execution capability family: what program execution does for you, and which package owns each part."
kind: "package-group"
---

# code-runtime/ — code-execution capability family

English | [中文](README.zh.md)

## Summary

The `code-runtime/` group provides program execution: a model writes one program that calls host-provided functions as ordinary async calls, and a runtime executes it in isolation and returns only what the program printed and returned. One package defines the shared capability (`ctx.codeRuntime`), a second executes TypeScript programs in a fresh Node worker thread, and a third owns the wire protocol between a Node host and a CPython subprocess for the Python backend. Every run is independent — no state carries from one program to the next — and failures come back as part of the result, so the caller can see why a program failed and feed that back to the model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

These three packages together provide program execution; each README describes what its part does.

| Package | Role | ctx key |
|---|---|---|
| [`code-runtime/`](code-runtime/README.md) | Defines what a code runtime does: run one program against host-provided bindings and report what it printed and returned | `ctx.codeRuntime` |
| [`code-runtime-worker-thread/`](code-runtime-worker-thread/README.md) | Executes TypeScript programs, each in a fresh Node worker thread | registers `ctx.codeRuntime` |
| [`experimental/code-runtime-python/`](../experimental/code-runtime-python/README.md) | The experimental Python backend: owns the fd-3 wire protocol between a Node host and a CPython subprocess and the CPython runtime implementation | — |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the service contract, then the PTC mode design that consumes this capability and the capability-seam model it follows.

- [Code runtime subsystem reference](../../docs/subsystems/code-runtime.md) — request/result vocabulary, bindings, and the `ctx.codeRuntime` cordis surface.
- [PTC mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-ptc.md) — how the tool registry presents `run_code` to the model.
- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this family follows.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
