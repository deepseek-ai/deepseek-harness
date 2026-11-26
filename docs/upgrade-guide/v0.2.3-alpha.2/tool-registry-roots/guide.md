---
kind: upgrade-guide
description: "Tool executor packages become root tool registries that ctx.tools routes to, and step-time tool conditions are replaced by tools that providers add for each Agent."
---

# Tool executors become root tool registries

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-executor-native` and `-ptc` become `@deepseek-ai/dsh-tool-registry-native` and `-ptc`, with plugin names `native-tool-registry` and `ptc-tool-registry` and Loader rows `tool-registry-native` and `tool-registry-ptc`. Configuration fields are unchanged.

`setExecutor()` and `ToolExecutor { sections?, describe(), execute() }` become `setRoot(registry)` and `ToolRegistry` (`register()`, `include()`, `get()`, `getAll()`), which has no `execute()`. `setRoot()` gives the root each scope's registrations and emits `tools/change`; a root that includes or reads `ctx.tools` fails with `INVALID_TOOL_COMPOSITION`. `ctx.tools.get()` and `getAll()` return the selected root's entries, only `run_code` under a PTC root, and throw `TOOL_REGISTRY_UNAVAILABLE` (formerly `TOOL_EXECUTOR_UNAVAILABLE`) without an available root; nothing on `ctx.tools` lists a PTC root's bindings. `ctx.tools.execute()` runs every model-direct batch, and each `ToolExecution` carries the `definition` the call runs.

`register(tool, { when })`, `resolve()`, `executable()`, `definitions()`, `schemas()`, `ResolvedToolSet`, `ToolActivationContext`, `ToolActivationError`, the PTC `/run-code` entry, `createRunCodeTool()`, and `RunCodeConfig` are removed; `TOOL_ACTIVATION_FAILED` is no longer produced. `ToolDefinition.guidance` holds a tool's prompt section, shown while the tool is callable; `restrict({ deny })` accepts unoffered names. A model-direct call to a program binding fails as `unknown tool "<name>"; tools you can call directly: run_code` before `tools/pre-execute`, approval, guards, and wrappers.

In `@deepseek-ai/dsh-tools/pipeline`, `executeToolBatch(input, pipeline)` drops `maxParallel` for `DEFAULT_MAX_PARALLEL_TOOL_CALLS`, `ToolExecutionSource.get()` is required, and `reject(name, nested)` becomes `reject(exec)` for every call. `ToolNotFoundError(toolName, callable?)` takes callable entry names instead of `reachableFrom`.

This affects `cordis.yml` files and overlays naming the old rows or packages, custom roots, and plugins using removed APIs or reading registered tools through `ctx.tools.get()`. Recorded Sessions remain readable.

## Migration

1. Rename `tool-executor-native` / `'@deepseek-ai/dsh-tool-executor-native'` to `tool-registry-native` / `'@deepseek-ai/dsh-tool-registry-native'` in Cordis configuration and `package.json`, and the PTC row likewise.
2. Replace `setExecutor(executor)` with `ctx.tools.setRoot(new NativeToolRegistry())` or `new PtcToolRegistry(ctx, { name: 'run_code' }).mountRoot()`. A custom executor becomes a [`ToolRegistry`](../../../subsystems/tools.md#tool-registries-roots-and-model-steps) root: `describe()` becomes `get()` and `getAll()` over the registrations its `include()` receives, resolving names with `get()` since a source's `getAll()` can repeat one, `sections` become `ctx.systemPrompt.section()` calls in the effect selecting the root, and `execute()` is dropped because `ctx.tools.execute()` schedules and logs.
3. Replace `register(tool, { when })` with an `AgentToolRegistry` included in `ctx.tools`, calling `set(agent, names)` on `agent/created`, on the condition's input events, on `agent-preset/selected` inside a preset, and for `ctx.agents.list()` at load.
4. Move a section gated by `ctx.tools.get(name, scope)` into the tool's `guidance`; describe new tools in their schema ([why](../../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.md)). Per-Agent providers read their own registry.
5. Replace a policy's `ctx.tools.get(exec.name, exec.agent)` with `exec.definition` and `resolve()` with `ToolStep.capture(ctx.tools, agent)`. `schemas()` and `definitions()` have no replacement: `ctx.tools.getAll()` lists the root's entries, so keep the definitions you registered.
6. Replace `createRunCodeTool(ctx, { name, description, runtime, tools, limits })` with `new PtcToolRegistry(ctx, { name, description, runtime, config: limits })` holding the tools, included in `ctx.tools`; `RunCodeConfig` becomes `PtcToolRegistry.Config`.
7. Update `ToolExecutionPipeline` sources, `executeToolBatch()` calls, and `ToolNotFoundError` constructions to the signatures above.
8. Confirm that `dsh` starts and `ctx.tools.getAll(agent)` lists the expected entries.
