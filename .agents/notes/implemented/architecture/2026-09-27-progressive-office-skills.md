# Agent Note: Progressive Office skills with ordinary shell execution

Status: implemented

English | [中文](2026-09-27-progressive-office-skills.zh.md)

## Problem

Combined authoring and rendering instructions spend context on operations unrelated to ordinary editing. Rendering tool activation adds a second discovery path and durable state even though shell tools already own execution permissions and process management. A missing renderer can prevent loading otherwise usable editing guidance.

## Decision


The [Office provider](../../../../packages/skill/skill-office/README.md) exposes Office guidance as skills that the model loads by name; the host injects no instructions for file extensions. This decision introduced a router, three format-specific authoring skills, and operation skills that ran the shared Python checker and the configured LibreOffice Kit CLI through ordinary Bash or PowerShell, mounted only by SDK and Desktop. [Office skills in every deployment](2026-10-26-cross-deployment-office-kit.md) supersedes the mounting decision; the [on-demand Office tools](2026-10-31-native-office-tool.md) supersede the operation skills, their shell execution, and the renderer-tool rejection; and the [single Office skill](2026-11-06-single-office-skill.md) replaces the router and authoring skills with one `office` skill that carries concise inline guidance.

Carriers own interpreter and resource locations: the composition selects the Python environment named in the `office` body and the asset root that holds the skill. Loading instructions does not prepare engines or authoring payloads. Scripts that the model writes run through the ordinary shell tools, which keep their existing permissions and process management.

LibreOffice Kit dependencies declare one exact version in every manifest; the root lock records the resolved adapter and engine versions.

## Alternatives considered

**Keep a dedicated renderer tool.** A small typed schema constrains rendering arguments, but requires its own execution configuration, scoped registration, projection, and activation lifecycle. The CLI operation skills accept shell quoting and model-selected arguments in exchange for reusing the existing approval, sandbox, cancellation, and output mechanisms.

**Hide subskills from the catalog.** This requires a generic visibility policy independent of invocation permission. The [single Office skill](2026-11-06-single-office-skill.md) removes the subskills instead of hiding them.

**Automatically inject guides for file extensions.** Extensions do not distinguish text edits, recalculation, conversion, and requested visual checks. Model-selected routing keeps unrelated operations out of context and permits explicit direct invocation.

## Consequences

Instruction loading appends ordinary logged skill results; completion does not erase them. Historical tool records remain readable and existing declaration reconciliation handles resumed sessions without a Session format change or agent-loop modification. The [on-demand Office tools](2026-10-31-native-office-tool.md) record the reasons for a dedicated renderer.

Verification covers catalog entries, denied and explicit invocation, authoring without executable paths, native/PTC requests, resume and fork, ordinary and minimal profile composition, resource packaging, context budgets, and real-model operation selection.
