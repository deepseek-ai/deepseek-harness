# Agent Note: Progressive Office skills with ordinary shell execution

Status: implemented

English | [中文](2026-09-27-progressive-office-skills.zh.md)

## Problem

Combined authoring and rendering instructions spend context on operations unrelated to ordinary editing. Rendering tool activation adds a second discovery path and durable state even though shell tools already own execution permissions and process management. A missing renderer can prevent loading otherwise usable editing guidance.

## Decision


The [Office provider](../../../../packages/skill/skill-office/README.md) lists a compact router and six format-specific authoring or operation skills. The model loads full instructions by name and selects rendering for appearance-focused changes unless the user explicitly skips it. Rendering uses a private, randomly named temporary directory inside the task workspace and removes it after inspection. Skills invoke the shared Python checker and configured LibreOffice Kit CLI through ordinary Bash or PowerShell. SDK and Desktop own their Office composition separately; ordinary Web and the shared base do not mount these plugins.

Carriers own interpreter and resource locations. Operation skills append the configured Node and CLI paths only when their bodies are loaded; authoring skills use the selected Python and shared checker resource. Loading instructions does not prepare engines or authoring payloads. Ordinary shell execution retains its existing permissions and process management.

Office dependency ranges allow patch updates; the root lock records the resolved adapter and engine versions.

## Alternatives considered

**Keep a dedicated renderer tool.** A small typed schema constrains rendering arguments, but requires its own execution configuration, scoped registration, projection, and activation lifecycle. The CLI operation skills accept shell quoting and model-selected arguments in exchange for reusing the existing approval, sandbox, cancellation, and output mechanisms.

**Hide subskills from the catalog.** This requires a generic visibility policy independent of invocation permission. Listing seven short summaries preserves the existing skill API while full instruction bodies remain demand-loaded.

**Automatically inject guides for file extensions.** Extensions do not distinguish text edits, recalculation, conversion, and requested visual checks. Model-selected routing keeps unrelated operations out of context and permits explicit direct invocation.

## Consequences

Instruction loading appends ordinary logged skill results; completion does not erase them. Historical tool records remain readable and existing declaration reconciliation handles resumed sessions without a Session format change or agent-loop modification. A dedicated renderer would need a new independently justified user or security requirement before reintroduction.

Verification covers catalog entries, denied and explicit invocation, authoring without executable paths, native/PTC requests, resume and fork, ordinary and minimal profile composition, resource packaging, context budgets, and real-model operation selection. Rendering failures preserve usable sources and stop visual checks; successful commands alone cannot establish usable images.
