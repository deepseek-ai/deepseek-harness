# Agent Note: Compact Tool Details from Recorded Results

Status: implemented

English | [中文](2026-09-10-compact-tool-details.zh.md)

## Problem

Goal, todo, and schedule results contain a small set of user-facing facts that take more effort to read as JSON. Dedicated expanded bodies need to fit the existing conversation rows without adding a second presentation registry or live state to historical calls.

## Decision

The `ui-tool` package registers goal and schedule toolviews through the existing keyed slot and shares one package-internal fields/list component with the todo view. Successful, recognized results display recorded values; incomplete calls, errors, malformed values, and unsupported result formats retain generic input/output. Schedule domain errors, including uncertain persistence and an unknown deletion target, retain their original result.

Tool rows keep their disclosure and Inspect interaction. Checklist marks are static and have accessible status labels. Schedule times use absolute dates with the viewer's time zone; states come from the recorded result. Goal details distinguish an active goal awaiting continuation from an armed goal. These display values do not subscribe to the current goal, todo, or schedule projection.

Todo changes compare each root or nested call with its preceding durable `todo/write`, so later writes cannot alter an earlier card. The conversation assembler repairs predecessors when older history loads. Until the predecessor is known, the card shows the submitted list without inferred additions or removals.

This scoped visual change is an exception to the visual-equivalence requirement in [Client-derived tool presentation](2026-08-23-client-derived-tool-presentation.md). Its raw-event ownership, generic fallback, and single keyed registry remain authoritative.

## Alternatives considered

**A shared presenter framework:** the existing keyed slot already dispatches tools. Reusing only the detail body keeps the abstraction local until another package needs it.

**A dashboard inside each card:** interactive controls, progress graphics, and live states add visual weight and can misrepresent what a historical call returned. Compact read-only fields and lists preserve the conversation's hierarchy.

## Consequences

Registered tools gain readable details without changing Host tools, Session events, or public Client exports. Tool-specific adapters interpret recorded JSON and text; unrecognized formats retain generic output. The authored tool-details Session replay covers their assembled rendering.
