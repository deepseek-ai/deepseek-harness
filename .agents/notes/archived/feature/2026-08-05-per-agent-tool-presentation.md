# Agent Note: Per-agent tool presentation, and the `ptc` preset

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-per-agent-tool-presentation.zh.md)

## Problem

Agent presets compose an agent's tools per session, but not the FORM those tools reach the model in. PTC mode — one `run_code` tool plus a generated TypeScript SDK, replacing a call sequence with one program — was a deployment-wide `mode` field on the host's `dsh-tools` row. A deployment either ran every session in PTC mode or none, so the obvious product shape ("代码模式" beside 标准/极简/创造 in the preset picker) had nothing to hang on.

The naive reading of "move tools down to the agent plane" does not work. `ctx.tools` has host-plane consumers that cannot follow it: `dsh-agent-loop` reads the registry's private scheduler seam, `dsh-apiproxy` reads its presenters to render tool cards, and every tool plugin registers into it. By the stack's own rule — a service moves into a preset only when ALL of its consumers move with it — the registry stays where it is.

## Decision

Split the registry from its projection. The registry stays host-plane; the **presentation** becomes scope state inside it, alongside the scoped restrictions and guards that already live there.

`ToolRuntime.presentAs(mode)` is scoped-only and mirrors `restrict()`: it writes one cell on the calling scope's `ToolLayer` through `ScopedLayers.effect`, so it unwinds with the scope that declared it. In the shipped Web surface that scope is an agent preset's standing mount — the `ptc` preset carries the `tool-presentation` row — so one declaration covers every agent joined to that preset, and `modeFor(scope)` takes the nearest declaration on the chain. It resolves against the config `mode`, which becomes the default for scopes declaring nothing rather than a process-wide fact. The three reads that decided presentation — the wire schemas, the `run_code` entry in the visibility view, and the generated SDK section — take the scope's mode instead of the service's.

Two consequences fell out and are load-bearing:

- **`run_code` is appended per scope.** Previously the transport entered every view whenever the transport existed. Per-agent, a native agent must not find `run_code` in its dispatch table because some other agent in the process presents it — so the append is conditional on that scope's own mode, and the transport is built lazily on first need.
- **The reserved name is now unconditional.** `run_code` was rejected as a registration only while a PTC mode was configured. Any agent may now select a PTC mode, so a name that was free to take under a native deployment would become a collision the moment a preset mounted.

The SDK prompt section is registered globally by a ptc deployment (unchanged) and additionally per scope by `presentAs`, where it shadows by name. Its body renders empty for a native scope, which the prompt renderer drops — that is what keeps an agent opting OUT of a ptc deployment free of an SDK section.

The preset expresses the choice through one row, `@deepseek-ai/dsh-agent-tool-presentation`, whose whole body is a `presentAs` call. A PTC mode waits for `ctx.codeRuntime` through `ctx.inject` rather than assuming it: the runtime is host-plane, and a pending row is what `dsh-agent-presets` already reports as an unusable mount, naming the row — so a preset selecting PTC mode against a runtime-less deployment fails where an operator can act.

## Alternatives considered

**A second `ToolRuntime` inside the preset's isolate realm.** Rejected: `dsh-agent-loop` resolves the registry once from the host context through a private symbol, so a per-agent registry would be invisible to the scheduler. Making the loop registry-per-agent is a far larger change than making one field scope-aware.

**A top-level key in the preset's own YAML.** Rejected for the reason preset display metadata went to a separate `preset.yml`: the composition is a top-level list of plugin rows and cannot carry sibling keys.

**Naming the package `dsh-tool-mode`.** Rejected by a gate, correctly. `gen-tool-catalog` globs `packages/*/tool-*` and requires every match to publish a model-facing tool schema, because that prefix means "ships a tool" in this repo. This row ships none.

**Registering the SDK section unconditionally from the constructor.** Rejected after trying it: `renderPrompt` drops empty sections but `PromptAssembly.sections` retains them, so every native deployment would carry a `tools:sdk` entry rendering nothing, and two existing assertions on that list would have had to be weakened to accommodate it.

**Sharing `standard`'s composition by include.** Rejected per the stack's own convention: `cordis` already duplicates `standard`, and a preset's value is that its whole composition is readable in one file. The cost — a third copy of ~240 lines that must move together — is real and is the strongest argument for a future include mechanism.

## Consequences

Two sessions in one process can now present differently, so "which tools does the model see" is no longer answerable from the deployment config alone; it requires the agent. Every diagnostic that quotes a mode now quotes the scope's, not the service's.

`ctx.tools.schemas(agent)` remains the agent's CAPABILITY catalog and is unchanged by presentation — only the assembly's tools collapse. Tests asserting what the model receives must read the assembly; `web-agent-presets.spec.ts` asserts both sides of that distinction for the shipped `ptc` preset.

The shipped roster is four presets (标准/代码/极简/创造), so any golden listing them moves. A deployment that composes no code runtime can compose no ptc preset; the shipped Web overlay carries one, the base composition does not.
