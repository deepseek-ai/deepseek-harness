---
kind: upgrade-guide
description: "Session model choices are fixed at step preparation, and projection types move to their owning package."
---

# Session model selection applies at the next step

English | [中文](guide.zh.md)

## Change

ACP model and reasoning changes take effect at the next model step, including a tool continuation in the current turn. Previously, ACP pinned the selection for the complete prompt turn. A prepared step and its retries retain their captured selection. Image admission checks the route selected when admission begins; a later option change can select a different route before the step starts.

`AgentLoop` owns the durable `modelSelection` projection and constructs an `AgentModel` instance on each Agent’s `model` property. The API Session controller no longer registers it. Programmatic resume restores recorded choices, including unused selections, before falling back to `AgentOptions`. Configured Agent-loop resumes, headless adoption, and SDK resume record their deployment route; an omitted effort preserves saved explicit effort only for the same route.

Plugins must select provider, model, and optional explicit reasoning effort before prompt assembly. `agent/request` is deprecated. Existing listeners still run on each main-loop request attempt and can adjust other controls, but cannot change provider or model, or add, change, or clear reasoning effort. Absent effort still resolves through adapter defaults on each attempt. Auxiliary calls such as compaction do not dispatch this event. `installModelSelection` now installs only the switch-notice listener; its selection argument and `ModelSelectionRef` are removed.

The client projection and Host state types move to `dsh-agent/types`; the API package no longer exports them.

## Migration

1. In custom Cordis compositions, mount `dsh-session-projection` with `dsh-agent-loop`. The loop constructs `agent.model`; consumers need no separate model-selection service.
2. Replace mutable references and selection hooks with `agent.model.select(selection)` after validation. Read with `current()`. Keep `installModelSelection(agentCtx)` in Agent setup for switch notices and remove its old selection argument. Do not add `agent/request` listeners.
3. Set the output cap through `AgentOptions.maxTokens`. Other per-request control overrides have no replacement API; retain an existing listener where that behavior is still required.
4. To override a saved route during programmatic resume, merge the configured selection with the saved explicit effort only when the route is unchanged and the configuration omits effort, then call `agent.model.select(selection)` in the Agent setup callback. Supplying `agentOptions` alone provides only a fallback for a Session without a selection or request.
5. Pass the captured `Readonly<ModelSelection>` in `agent/pre-step.modelSelection`, including explicit effort when selected; `AssembleContext.modelSelection` carries the same selection. Direct `SessionReferenceResolver.prepare()` callers pass the route as the fourth argument, before the optional signal.
6. ACP controllers that require one model throughout a turn must wait for the active prompt to finish before changing its options. Verify that a mid-turn change is recorded as `model/selection`, the next step uses it, and resume retains an unused choice.
7. Import `ModelSelectionProjection` from `@deepseek-ai/dsh-agent/types`, replacing API package aliases. `ModelSelection` remains in `dsh-agent/types`. Import `ModelSelectionProjectionState` from `@deepseek-ai/dsh-agent` only when implementing a driver; ordinary reads use `agent.model.current()`. Effort values use `ReasoningEffortId` from `dsh-llm/brand`.
