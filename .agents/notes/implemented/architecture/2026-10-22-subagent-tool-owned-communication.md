# Agent Note: Subagent tools own communication guidance

Status: implemented

English | [中文](2026-10-22-subagent-tool-owned-communication.zh.md)

## Problem

The continuation manager inspected a Symbol on the standard messaging tool before adding tool instructions and parent addressing to the initial task. This coupled orchestration to one tool implementation and made result-delivery guidance depend on tool installation. A published internal entry point carried both that marker and a host prompt adapter used only by tests.

## Decision

`tool-subagent-control` owns messaging instructions and parent addressing. Its logged runtime context gives delegated children their direct creator’s name from `ctx.subagents.namesOf()`, explains when to send findings, and states that sending does not finish a turn. The context is emitted only for delegated children when the plugin’s own tool definition is admitted in the current scope and step; roots and ordinary Session forks receive none. Communication guidance follows inherited history without changing the shared system prompt or tool schema.

The manager owns result delivery. Local activations with `delivery: 'parent'` receive automatic-result guidance even without messaging tools; caller-owned activations receive no parent-delivery promise. Settlement timing, recipients, output, and suppression of closing text after a final message to the parent remain unchanged. Tool visibility grants no messaging authority.

This supersedes the Symbol identity and initial-task communication-guidance choices in [adjacent messaging](2026-08-27-adjacent-agent-steer-messaging.md). Its message attribution, fixed Steer delivery, and rejection of a separate report operation remain active. The internal entry point and prompt adapter are removed; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/subagent-user-controls/guide.md) owns caller migration.

## Alternatives considered

**Keep a cross-package marker or add a service hook.** Tool registration already gives its owner the exact definition, and prompt assembly already supplies the current Agent. Another protocol or stored identity has no independent consumer.

**Move all return guidance into the tool.** Automatic parent notification depends on activation delivery, not on messaging capability. The tool must not promise it to caller-owned activations or withhold it from children without tools.

## Consequences

Tests cover visible, hidden and replaced definitions, logged identity, plugin disposal, fork prefix reuse, and parent versus caller result delivery. Recorded-session snapshots cover the assembled prompt and durable runtime context. Tests needing host input use the existing private manager test helper; no production adapter exists solely to expose that helper.
