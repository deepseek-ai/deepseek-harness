---
kind: upgrade-guide
description: "Custom Python PTC compositions must replace the removed runtime package with the Node provider and use TypeScript programs."
---

# Python PTC runtime removal

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-experimental-ptc-runtime-python` is no longer published or included in this repository. Custom compositions that select it must migrate to [`@deepseek-ai/dsh-ptc-runtime-node`](../../../../packages/ptc-runtime/ptc-runtime-node/README.md). Shipped profiles already select the Node provider.

## Migration

1. In the `cordis.yml` or profile patch that selects the Python provider, replace that row's `name` with `@deepseek-ai/dsh-ptc-runtime-node`. Remove its Python runtime `config`; configure Node limits separately when needed. Node also requires `fs` and `subprocess` alongside `sandbox` and `sandboxPolicy`. Reuse the existing providers; for a local composition missing them, mount `@deepseek-ai/dsh-fs-local` and `@deepseek-ai/dsh-subprocess-local` in the same execution world.
2. Rewrite Python `run_code` programs as TypeScript. For fresh execution per call, set `config.executionMode: per-call`; see the [Node runtime configuration](../../../../packages/ptc-runtime/ptc-runtime-node/README.md).
3. Re-enable `workflow-ptc`, `tool-workflow`, and any previously enabled `tool-ralph` rows that were disabled solely for the Python provider, if those workflows are still wanted.
4. Run the affected profile with `--dump-config` and confirm its PTC runtime row selects `@deepseek-ai/dsh-ptc-runtime-node` with no Python provider row remaining. Run a PTC task and confirm that its TypeScript program completes.
