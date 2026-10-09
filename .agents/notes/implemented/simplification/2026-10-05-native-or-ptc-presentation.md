# Agent Note: One tool invocation form per agent

Status: implemented

English | [中文](2026-10-05-native-or-ptc-presentation.zh.md)

## Problem

Mixed tool presentation carries direct function schemas and a program SDK for the same capabilities. It adds schema-ordering, admission, configuration, and test combinations without a separate execution capability. The [PTC decision](../feature/2026-06-15-ptc.md) still owns the registry, runtime, and nested-call rules.

## Decision

Each agent selects `native` or `ptc`. Native presentation exposes visible capability schemas. PTC presentation exposes only `run_code` and the generated SDK. The registry rejects `both` in configuration. Presets can select different supported modes in one application.

## Alternatives considered

**Keep mixed presentation.** This lets one agent choose direct calls or programs for each step, but duplicates the advertised capability information and preserves a third admission case. Separate native and PTC agents provide the supported choices.

**Silently map mixed presentation to another mode.** Either mapping changes how existing programs or direct calls execute. Explicit configuration rejection and the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.1/tool-presentation-mode/guide.md) make that choice visible.

## Consequences

An agent cannot alternate between direct end-tool calls and `run_code` through one mixed presentation. Reintroduction requires a concrete need for that behavior and evidence that it warrants the additional interface.

Tests for shared policy, cancellation, nested context, and multimodal results use native or PTC setups. Older Session generations and explicitly retained recordings keep their original bytes and remain readable. The removal changes accepted configuration, not the plugin-author registration API or the guarded execution pipeline.
