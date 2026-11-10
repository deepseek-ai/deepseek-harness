---
kind: upgrade-guide
description: "Agent input methods reject messages once owner or factory disposal begins."
---

# Disposed Agents reject new input

English | [中文](guide.zh.md)

## Change

Plugins retaining an `Agent` handle can no longer append input after its owner or factory starts disposing it. `send`, `followup`, `steer`, and `inject` now throw `AgentInputClosedError` with code `AGENT_INPUT_CLOSED` before changing the inbox. Previously, those calls could append input that the disposed Agent would never process. Calling `cancel({ kind: 'disposed' })` alone does not dispose the handle and retains its existing parked-input behavior.

## Migration

1. Stop producers and release retained Agent handles when their owning scope unloads. Do not use a handle after its owner or factory begins disposal.
2. If a delivery can intentionally race teardown, handle `AgentInputClosedError` from `@deepseek-ai/dsh-agent` and report that the message was not accepted. Stop dependent delivery instead of retrying the same disposed handle.
3. Verify that a teardown-racing send reports the error and creates no inbox entry. Ordinary active-Agent delivery and activity cancellation retain their existing behavior; see the [Agent API](../../../subsystems/core.md).
