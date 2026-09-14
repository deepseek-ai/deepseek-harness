---
description: "Package map for the PTC execution capability family: what program execution does for you, and which package owns each part."
kind: "package-group"
---

# ptc-runtime/ — PTC execution capability family

English | [中文](README.zh.md)

## Summary

The `ptc-runtime/` group lets a model write one program that calls host-provided functions as ordinary async calls, then returns only the program's printed output and return value. Choose the TypeScript backend for execution in a fresh Node process under the configured sandbox policy, or the experimental Python backend when a CPython process is required. Each run starts without state from earlier programs. Failures are returned as results so callers can diagnose them or provide them to the model.

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
| [`ptc-runtime/`](ptc-runtime/README.md) | Defines what a PTC runtime does: run one program against host-provided bindings and report what it printed and returned | `ctx.ptcRuntime` |
| [`ptc-runtime-node/`](ptc-runtime-node/README.md) | Executes TypeScript in fresh managed Node processes under the resolved sandbox policy | registers `ctx.ptcRuntime` |
| [`experimental/ptc-runtime-python/`](../experimental/ptc-runtime-python/README.md) | The experimental Python backend: owns the fd-3 wire protocol between a Node host and a CPython subprocess and the CPython runtime implementation | — |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the service contract, then the PTC mode design that consumes this capability and the capability-seam model it follows.

- [PTC runtime subsystem reference](../../docs/subsystems/ptc-runtime.md) — request/result vocabulary, bindings, and the `ctx.ptcRuntime` Cordis surface.
- [PTC mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-ptc.md) — how the tool registry presents `run_code` to the model.
- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this family follows.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
