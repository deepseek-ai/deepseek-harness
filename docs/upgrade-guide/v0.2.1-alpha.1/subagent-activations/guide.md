---
kind: upgrade-guide
description: "Managed subagent activations replace foreground and Job-backed delegation, its configuration keys, and the published in-process driver."
---

# Migrate delegation to managed subagent activations

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-subagent` removes `backgroundMode`, `enableRunInBackground`, and the model argument `run_in_background`. Every delegation now returns `{ kind: 'activation', subagentId }` after accepting the child, and the runtime delivers its final answer in a parent completion notice. Foreground results and `{ kind: 'background', jobId }` results are removed; subagents are no longer collected or stopped through `job_output` or `job_kill`.

The published `@deepseek-ai/dsh-subagent-in-process-driver` package is removed. Local providers contribute creation inputs through `prepareContinuable()`; the subagent service owns execution. Spawn and Fork children can receive later messages, including after settlement when persistence and Session query are available. External providers execute once and do not accept follow-up messages.

## Migration

1. Remove `backgroundMode` and `enableRunInBackground` from `tool-subagent` rows in `cordis.yml`, profile patches, and overlays. Keep the provider and remaining configuration. For example:

   ```yaml
   - name: '@deepseek-ai/dsh-tool-subagent'
     config:
       provider: spawn
       toolName: subagent
   ```

   Local tool delegation requires Session persistence. Compose it with the [subagent service and provider](../../../../packages/subagent/subagent/README.md#use-this-package).

2. Remove `run_in_background` from tool calls and update result consumers to read `subagentId`. Collect the completion notice instead of foreground output or a Job result. Use `interrupt_agent` to stop the current execution; use `send_message` only for local children when those control tools are composed.

3. For host code that must await a result, replace `ctx.subagents.start()` or `startContinuable()` with `startActivation()` and caller delivery. Given a composed service and live parent:

   ```ts
   import type { Agent } from '@deepseek-ai/dsh-agent'
   import type SubagentRuntime from '@deepseek-ai/dsh-subagent'

   async function collect(subagents: SubagentRuntime, parent: Agent, signal: AbortSignal) {
     const activation = await subagents.startActivation({
       provider: 'spawn',
       label: 'Review changes',
       request: { parent, prompt: [{ type: 'text', text: 'Review these changes.' }] },
       signal,
       delivery: 'caller',
     })
     const result = await activation.result
     await activation.dispose()
     return result
   }
   ```

   Caller delivery emits no parent completion notice. `result` settles after cleanup and includes `output`, `stopReason`, and optional `structured` and `diagnostic` values; inspect `stopReason` before treating it as success. The startup signal stops owning cancellation after publication: retain the receipt and call `dispose()` to cancel that exact activation. Cleanup failures are reported by `dispose()` separately from the captured result.

4. Remove the driver dependency and imports, including `startInProcessRun`. Mount the existing Spawn or Fork provider and call the service as above. Custom local providers implement `prepareContinuable()` using the [provider API](../../../../docs/subsystems/subagent.md); there is no replacement standalone driver.

   External providers keep `start()`, but each returned `SubagentRun.id` must be unique across parents, providers, and local Sessions in the runtime. Generate a fresh id for each execution instead of using a parent-local counter.

   For `dsh-subagent-dsh-sdk`, update any separately configured `dshBin` runtime to support `session/wait`. For directory configuration, follow the [working-directory migration](../working-directory/guide.md).

5. Confirm a delegation returns the activation result variant, its completion notice contains the final answer, and caller delivery returns the result without adding that notice. Confirm local children remain listed after completion and external children cannot be continued.
