# Agent Note: CUA program tool for Agents without a preset

Status: implemented

English | [中文](2026-11-12-cua-program-tool-without-presets.zh.md)

## Problem

The SDK, headless, and ACP applications create Agents without joining an Agent preset, and their profiles mount no preset registry. A native CUA provider configured with a preset ID registered no tool for those Agents, so its default configuration and the Computer Use bundle had no effect there. `agentPreset: false` supplied only the raw `cua` tool. A Host whose model calls ordinary tools directly had no configuration that supplied `cua_run_code`.

## Decision

When `agentPreset` is a preset ID, only Agents on that preset receive raw `cua`. Every other Agent receives `cua_run_code`, including Agents without a composed preset and every Agent of a composition without the preset registry. The registry is an optional dependency of the provider: the provider recomputes the tool form of each live Agent when the registry loads or unloads, and without the registry no Agent counts as being on the configured preset. `agentPreset: false` still registers raw `cua` globally and creates no program runtime.

This partially supersedes [CUA programs outside the PTC preset](2026-11-09-cua-program-tool.md), which gave Agents without a composed preset neither tool. That note still owns the program tool's runtime, its initialization, and the choice of one tool form per Agent. It also changes one consequence recorded in [What stays host-plane once presets own the agent plane](2026-08-10-host-plane-ownership-after-presets.md), where an Agent that joined no preset received no tool. That note still owns the rule that entry points join Agents explicitly and that no check rejects an Agent for joining no preset.

## Alternatives considered

**Keeping no tool for Agents without a preset** preserves the earlier default. Its only effect on these Hosts was that enabling Computer Use changed nothing and reported nothing.

**A provider field that selects the tool form for these Agents** leaves the default configuration without effect, requires each such Host to set two fields, and adds a combination that is invalid beside a preset ID.

**Joining a preset in the SDK server** covers one of the three Hosts, changes a non-experimental package, and requires each deployment to declare an empty preset whose ID differs from `agentPreset`.

**Selecting the form from the tool executor** requires the executor interface to identify program executors, which it does not.

**Creating the Agent without the tool and logging a warning while the program services are unavailable** hides the failure on the Hosts this decision serves: an SDK or headless caller would receive a completed run without Computer Use and no error. The provider instead keeps the rule it applies to Agents on other presets: creation waits for the dedicated runtime and rejects while that runtime or the `workingDirectory` service is unavailable, for example after invalid runtime settings or in a composition without `workingDirectory`. This differs from the check that [What stays host-plane once presets own the agent plane](2026-08-10-host-plane-ownership-after-presets.md) rejected. That check would have rejected every Agent that joins no preset, which is how the SDK server, the ACP bridge, and the headless bundle create all of their Agents. The provider rejects only while it cannot supply the tool its configuration selects, and `agentPreset: false` removes the dependency on the program runtime.

## Consequences

Hosts without presets obtain `cua_run_code` from the default configuration; Web and Desktop sessions always join a preset and are unaffected. On a Host without presets, Agent creation waits for the dedicated program runtime and rejects while its services are unavailable. A PTC executor mounted on such a Host exposes `tools.cua_run_code` inside `run_code` unless the provider sets `agentPreset: false`. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.2/cua-agents-without-preset/guide.md) lists the migration. Unit tests cover compositions with and without the registry and the registry's loading and unloading; recorded SDK and headless Sessions cover the assembled request and program execution, the headless one through the PTC tool executor.
