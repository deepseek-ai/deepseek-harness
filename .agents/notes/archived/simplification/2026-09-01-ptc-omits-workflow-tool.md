# Agent Note: PTC preset omits the general workflow tool

Status: implemented
Archived: 2026-09-04

English | [中文](2026-09-01-ptc-omits-workflow-tool.zh.md)

## Problem

The shipped Web `ptc` preset exposed the general `workflow` tool through its generated SDK. PTC mode already makes `run_code` the model-authored composition interface, so `workflow` added a second orchestration language with different execution semantics. The preset description also claimed complete parity with Standard mode and could not state this intentional difference.

## Decision

The shipped Web `ptc` preset disables its `tool-workflow` row. Its generated PTC mode SDK therefore omits the `workflow` binding, while the model-facing wire contract remains the single `run_code` tool.

The preset retains `workflow-worker-thread` in its isolated workflow realm because `tool-ralph` consumes the same engine. `ralph` remains available through the PTC mode SDK. The Standard and Creator presets continue to expose `workflow`, and a user-authored preset may mount the tool explicitly.

The workflow package and its durable Session event types remain installed. Existing workflow records continue to render; this default composition change only prevents new top-level workflow calls from agents using the shipped `ptc` preset.

## Alternatives considered

**Disable the complete workflow realm in PTC mode.** Rejected because that also removes the provider required by `ralph`, even though Ralph's fixed fresh-agent loop is not a second model-authored workflow language.

**Hide `workflow` only in the generated SDK.** Rejected because presentation-only filtering would leave executable tool lookup and the declared preset composition out of agreement. Disabling the consumer row removes the binding from registration, lookup, and presentation together.

**Keep `workflow` until `run_code` has feature parity.** Rejected because the shipped PTC default is intended to make `run_code` its composition interface. Users who require declarative workflow semantics can select Standard mode or an explicit custom preset while capability gaps are evaluated independently.

## Consequences

The PTC picker description states the exception instead of promising full Standard parity. A real Web Loader composition test pins the `run_code` wire catalog, the absent `workflow` SDK binding, and the retained `ralph` binding. The keyless recorded Web PTC session owns the assembled prompt evidence, while preset tests pin that Standard and Creator remain unchanged.
