# Agent Note: Web skill tool row

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-web-skill-tool-row.zh.md)

## Problem

The Web transcript renders `skill` calls through the generic fallback row, so a loaded instruction set looks like an unknown tool call even though Skill is a first-class product concept. The generic row also exposes the JSON argument envelope beside the result, adding noise around the one identity users need: the loaded skill name.

## Decision

`ui-skill` registers a component under ui-tool's `tool.call.toolview` keyed slot with key `skill`. The component consumes the public `ToolCallViewProps` owner contract and owns its row chrome without importing ui-tool presentation internals.

The collapsed row uses a 14-pixel document-and-sparkle glyph and the Bash row's neutral hierarchy: tertiary glyph, secondary `Skill` title, caption separator, and tertiary skill name. Running, failed, and interrupted calls retain the transcript's shimmer, error dot and first-line summary, and warning dot semantics. A settled call expands through the whole summary row into a 260-pixel bounded `Instructions` card containing the exact durable result text; the existing trajectory `Inspect` handoff remains available below the card.

The row derives every visible value from a paired call/result slice in the current runtime window. It reads the skill name from the recorded `name` argument and the instructions from durable result content, and never joins the current skill catalog for descriptions or provider metadata. If pagination leaves the call outside the window, the result has no tool identity and remains on the generic fallback rather than extending the history wire contract. The existing ACP `skill-load` recording is seeded through the real Web persistence and composition path for a keyless interaction and accessibility snapshot. The snapshot removes a calendar date only when it immediately precedes the normalized clock and `Ran for` footer; the clock remains, so hosts in different timezones produce the same snapshot at a same-day boundary.

## Alternatives considered

- Keep the generic tool row and add only a `skill` color selector in `ui-conversation`. This leaves the redundant input envelope and generic expanded body in place, and makes the conversation package own a domain-specific visual rule.
- Add a new `skill` value to the host tool render-intent union. The keyed client slot already identifies this tool when its call is in the runtime window, so a new cross-boundary presentation value adds protocol and snapshot surface without enabling another consumer.
- Export the conversation package's private `ToolRow` component for reuse. Client packages intentionally expose contracts rather than cross-package components; exporting it would couple independent feature packages to conversation implementation details.

## Consequences

`ui-skill` now depends on the public conversation toolview contract, locale and primitive packages, and React in addition to its reference-source dependencies. It owns a small copy of the disclosure-row chrome, so future global interaction changes must update this registrant alongside the Bash sample and conversation rows.

Cold replay stays deterministic when the installed skill catalog changes, and the transcript remains compact until instructions are explicitly expanded. A result-only history page intentionally uses the generic fallback; keeping this edge case generic preserves the existing history protocol and confines the feature to client presentation. The dedicated card intentionally shows the tool's complete framed output rather than extracting only `<skill_instructions>`, preserving exactly what reached the model and avoiding a second parser for the skill result format.
