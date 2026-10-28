---
kind: upgrade-guide
description: "Tool declarations come only from step-admitted registrations: `system-prompt/assemble` no longer carries tools, conditional tools need a resolved step set, and `exit_plan_mode` is declared only after a Session first enters plan mode."
---

# Declare conditional tools through step admission

English | [中文](guide.zh.md)

## Change

`ctx.tools.register(definition, { when })` adds a synchronous or asynchronous condition. AgentLoop resolves conditions once per proposed step with `{ agent, modelSelection, signal }`, before prompt assembly and `agent/pre-step`, and uses the resulting `ResolvedToolSet` for tool declarations, Native dispatch, PTC bindings, and nested calls in that step and its retries. A false condition removes the tool from all of them; a thrown condition ends the turn with `TOOL_ACTIVATION_FAILED`.

The `system-prompt/assemble` waterfall now receives sections, contexts, and variables (`PromptPresentation`) without a tool array, and a returned `tools` field is ignored. Plugins that removed or added tool declarations in that waterfall are affected; their removals no longer reach the request, and a listener that reads `assembly.tools` receives `undefined` and fails at runtime.

Model tool calls run only through their step's admitted set. A call to a conditional tool without a resolved set, a call after the set is disposed, and a pending call whose registration was replaced or removed during the step return `UNKNOWN_TOOL` instead of running. Replacement applies to every tool, so a hot reload, MCP reconnect, or skill reload that re-registers a tool mid-step fails that step's unstarted calls of it. Callers that pass no set, such as the experimental `claude-code-mods` `$.tool.call`, cannot call conditional tools.

`exit_plan_mode` is declared from the first step whose selected plan state is active and stays declared for the rest of the Session, so requests of a Session that never entered plan mode no longer list it. Existing Sessions require no format migration.

## Migration

1. Replace tool filtering and reads of `assembly.tools` in `system-prompt/assemble` listeners with a `when` condition on the registration; read the step's provider, model, and reasoning effort from the condition's `modelSelection`. Keep only section, context, and variable changes in the waterfall.
2. Make tool guidance follow the same admission: section callbacks pass `context.toolSet` to `ctx.tools.get()` or `ctx.tools.schemas()`.
3. For programmatic calls of conditional tools, call `ctx.tools.resolve({ agent, modelSelection, signal })`, pass the returned `toolSet` to `assemble()` and the `ctx.tools.execute()` batch, and dispose it after the batch settles. A custom executor that does not use the shared pipeline looks up each call with `ctx.tools.executable(name, agent, toolSet)`.
4. Update expectations that listed `exit_plan_mode` before a Session entered plan mode. Verify that a disabled tool is absent from the request, that calling its name returns `UNKNOWN_TOOL` without reaching the implementation, and that a failing condition ends the turn with `TOOL_ACTIVATION_FAILED`.
