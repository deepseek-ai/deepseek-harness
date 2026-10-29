# Agent Note: Shared preset delegation tools

Status: implemented

English | [中文](2026-10-25-shared-preset-delegation-tools.zh.md)

## Problem

Agents sharing a preset need the same delegation definitions immediately after a preset switch. Installing identical tools separately for each Agent introduces an asynchronous visibility gap and places those definitions in the Agent's own registration layer, which is exempt from inherited-tool restrictions.

## Decision

Each tool-subagent instance registers its definition in its owning composition. Agents sharing a preset revision inherit that registration. Switching presets changes ancestry; it requires no per-Agent installation or tool-change reconciliation. Provider availability and the owning composition's disposal control registration lifetime.

Tool configuration validates its own fields, allowlist consistency, required services and provider capabilities. Candidate preset documents are not read during registration, for either Host-mounted or preset-mounted tools. The delegation executor validates the model's selection against the allowlist; child startup resolves the selected id against the current registry. A later declaration can therefore satisfy a previously unavailable target without reinstalling the tool. Independent selection and restoration retain the [spawn preset semantics](../feature/2026-09-20-spawn-agent-preset-selection.md).

The schema contains preset ids and default or inheritance guidance without candidate descriptions. This keeps shared definitions independent of other presets' declaration order and avoids retaining document text that can become stale. [Awaited Agent initialization](../architecture/2026-09-09-awaited-agent-creation.md) remains necessary for other asynchronous contributions.

## Alternatives considered

**Reinstall tools for each Agent.** Identical definitions gain extra installation, disposal and reconciliation work, and Agent-local ownership prevents inherited-tool restrictions from applying.

**Validate every target at tool registration.** A target declared later is rejected even though it can be available when used. An early successful lookup also cannot guarantee availability after registry changes.

**Retain candidate descriptions in shared schemas.** Reading descriptions during registration makes the result depend on declaration order. Keeping those descriptions current requires additional update coordination; the tool exposes ids instead.

## Consequences

Unknown or unloadable targets fail the selected delegation without leaving a child Agent or Session. An unused invalid reference remains undetected. Agent restrictions and restored historical filters apply to inherited delegation schemas, execution and guidance; sibling Agents retain their tools.

Focused preset-selection tests cover immediate switch visibility, shared ownership and disposal, restrictions, missing targets and retry after declaration. The Web Loader cases cover shipped composition compatibility, and the headless preset snapshot pins model-visible choices. The historical-filter tests exercise child composition directly; they do not establish cold-resume coverage.
