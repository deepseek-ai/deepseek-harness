# Agent Note: Inspect recorded PTC source in Trajectory

Status: implemented

English | [中文](2026-09-09-ptc-trajectory-code-inspection.zh.md)

## Problem

PTC programs arrive as JSON string arguments. Escaping makes long programs difficult to read in a generic argument tree, while historical calls may use a different runtime language from the current deployment. Recorded result text can contain both printed output and a returned value without retaining their separation.

## Decision

[Trajectory](../../../../packages/client/ui-trajectory/README.md) identifies calls by their recorded tool name and derives a code inspector from validated `run_code` arguments. The validated program carries the original JSON text; copying preserves source and argument bytes and exposes the original JSON through a separate toggle. Syntax highlighting requires an unambiguous TypeScript or Python hint in that call's recorded parameter description; unknown or conflicting hints leave plain text. Unsupported arguments retain the generic inspector.

The result view preserves recorded text and uses a tree only for complete JSON objects or arrays. Errors retain captured output. Code views sample the shared wrapping preference when opened and keep their own choice while mounted.

The [PTC runtime decision](2026-06-15-ptc.md) still owns execution and settlement; the [client presentation decision](../architecture/2026-08-23-client-derived-tool-presentation.md) still owns deriving UI from recorded facts. This inspector adds no Session events or host presentation fields.

Trajectory thinking opens by default and supports manual disclosure. [Chat disclosure defaults](../bug-fix/2026-09-14-chat-presentation-defaults.md) are a separate presentation decision.

## Alternatives considered

**Keep source inside the argument tree.** JSON escaping obscures program structure and makes copying executable source cumbersome.

**Use the active runtime language or infer it from source.** Either can mislabel a historical program. Recorded schema hints constrain highlighting without changing the recording.

**Split printed output from return values.** Historical rendered text does not establish that distinction; a parser could invent a separation the producer never recorded.

## Consequences

Readers can inspect and copy recorded programs without changing replay data. Schemas with no recognizable language hint receive no syntax highlighting. Component tests cover recorded-name recognition, schema fallback, exact source and argument copying, output states, and independent wrapping. JSON-tree tests cover clipping geometry, missing `ResizeObserver`, clipboard settlement after hover changes or unmount, and value-read counts during hover. Thinking tests cover manual disclosure and switching Trajectory records; the [PTC browser scenario](../../../../apps/web/tests/ptc-round.e2e.ts) pins the assembled inspector and verifies overflow and the original-JSON round trip.
