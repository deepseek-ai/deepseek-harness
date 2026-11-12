---
kind: upgrade-guide
description: "Python PTC runtime packages, external providers, SDK renderers and Python-specific binding APIs are removed; migrate to TypeScript PTC."
---

# Python PTC removal

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-experimental-ptc-runtime-python` is no longer published or included in this repository. Custom compositions that select it must migrate to [`@deepseek-ai/dsh-ptc-runtime-node`](../../../../packages/ptc-runtime/ptc-runtime-node/README.md). Shipped profiles already select the Node provider. `dsh-tool-executor-ptc` also removes support for external `PtcRuntime` providers reporting `language: 'python'`: prompt assembly or execution through the selected executor, or creation of a `/run-code` tool with a non-TypeScript provider, fails with `ToolContextUnavailableError` / `TOOL_CONTEXT_UNAVAILABLE`. The package no longer exports `jsonSchemaToPy` or `renderToolsSdkPy`.

## Migration

1. In the `cordis.yml` or profile patch that selects the Python provider, replace that row's `name` with `@deepseek-ai/dsh-ptc-runtime-node`. Remove its Python runtime `config`; configure Node limits separately when needed. Node also requires `fs` and `subprocess` alongside `sandbox` and `sandboxPolicy`. Reuse the existing providers; for a local composition missing them, mount `@deepseek-ai/dsh-fs-local` and `@deepseek-ai/dsh-subprocess-local` in the same execution world.
2. Replace any external Python PTC provider and remove imports of `jsonSchemaToPy` and `renderToolsSdkPy`. Use the TypeScript `renderToolsSdk` API where SDK rendering is needed. `dsh-ptc-runtime` replaces `PORTABLE_RESERVED_WORDS` with `RESERVED_BINDING_WORDS` and removes `DUNDER_MEMBER`; remove Python-specific binding-name checks.
3. Rewrite Python `run_code` programs as TypeScript. For fresh execution per call, set `config.executionMode: per-call`; see the [Node runtime configuration](../../../../packages/ptc-runtime/ptc-runtime-node/README.md).
4. Re-enable `workflow-ptc`, `tool-workflow`, and any previously enabled `tool-ralph` rows that were disabled solely for the Python provider, if those workflows are still wanted.
5. Run the affected profile with `--dump-config` and confirm its PTC runtime row selects `@deepseek-ai/dsh-ptc-runtime-node` with no Python provider row remaining. Run a PTC task and confirm that its TypeScript program completes.

The Harness Python client in `python/sdk`, its packaged runtime wheel, and Python environments used by other tools are unaffected. Existing Session logs retain their recorded output.
