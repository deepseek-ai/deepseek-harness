---
kind: upgrade-guide
description: "Tool execution modes move from dsh-tools configuration into explicit executor plugins."
---

# Mount a tool executor

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tools` keeps tool registration and executor selection, but rejects the removed `mode` and `maxParallelSubCalls` configuration fields at load time. Native and PTC execution require `@deepseek-ai/dsh-tool-executor-native` or `@deepseek-ai/dsh-tool-executor-ptc`. Shipped profiles mount an executor; custom compositions must add one. The existing `dsh-agent-tool-presentation` selector remains supported but is deprecated. Enabled `tool-executor-native` and `tool-executor-ptc` rows are required at startup; invalid executor configuration now stops startup. Web, headless, and SDK no longer read `DSH_TOOLS_MODE`; all inherit native execution from base.

## Migration

1. Keep the `dsh-tools` row and remove its execution configuration. Mount one native or PTC executor in the intended deployment or preset scope. For shipped profile patches, target the executor row instead of the `tools` row.
2. Move `maxParallelSubCalls` to the PTC executor configuration and mount a compatible `ctx.ptcRuntime` provider. The executor declares this service as a required injection; a missing runtime stops startup, and unloading the runtime withdraws the executor. `agent-loop.maxParallelToolCalls` and saved overrides stay in place with default `10`. The loop forwards the current limit to each batch; live edits apply to the next batch instead of the next tool group.
3. Custom executors implement `describe` and `execute`. Programmatic callers pass raw `calls` and `signal`, optional `agent`, and optional `log: { turn, step }`; read single-call outcomes from `results`. Omit `log` outside a committed model step.
4. Import PTC SDK renderers and `CodeRunFailedError` from `@deepseek-ai/dsh-tool-executor-ptc`. Run a task with the selected interaction mode and confirm its tool results appear in the Session.
5. Import `ToolExecutionPipeline` and `executeToolBatch` from `@deepseek-ai/dsh-tools/pipeline`. Complete calls, including single calls, use batches; custom schedulers call `prepare`, `dispatch`, and `complete` directly. Add `@deepseek-ai/dsh-tool-testkit` as a development dependency for tool fixtures and import them from that package. Neither is exported by the tool registry entry.
6. Import shared dispatch events and the `ptc-mode` message-source declaration from `@deepseek-ai/dsh-tool-executor-ptc/types`; Client code uses its `/client` re-export. Host policy extensions use `import type` from `@deepseek-ai/dsh-tool-executor-ptc` for `PtcDispatchLog` and `tools/ptc-dispatch-log`.

7. Remove `DSH_TOOLS_MODE` from launch environments. For PTC, save the following as `ptc.yml` and pass it with `--patch`; native execution needs no overlay. The same patch works with `--profile web` and `--profile sdk`; TypeScript and Python SDK clients pass its path through `patches`. Confirm that the model receives only `run_code` in PTC mode.

```yaml
- id: tool-executor-native
  disabled: true

- id: tool-executor-ptc
  disabled: false
```

```bash
dsh --profile headless --patch ./ptc.yml "task"
```
