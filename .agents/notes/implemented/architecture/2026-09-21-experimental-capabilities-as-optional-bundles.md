# Agent Note: Ship experimental capabilities as optional bundles

Status: implemented

English | [中文](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)

## Problem

The Web plugin page offered two optional bundles, Agent Teams and voice input. Auto review and the Inspector were published experimental packages that a person had to install by name or mount through a hand-written profile patch, although both already declared a bundle patch or shipped a mountable overlay.

## Decision

`OPTIONAL_BUNDLES` owns the installation's default-off selections, including maintained optional capabilities and experimental capabilities. Every bundle declares `icon` and exports `./locale/*.json` with `meta.title` and `meta.description`; the Official group displays that metadata. A bundle's presentation does not determine its [experimental status](../../../../packages/experimental/README.md#status). The isolation check validates admission and still rejects experimental dependencies of nonexperimental bundles.

An optional bundle's dependencies are downloaded with every `dsh` installation. [Reasoning translation](2026-10-05-anonymous-reasoning-translation.md) uses three experimental packages without adding third-party runtime dependencies. Admission therefore considers installation cost and whether a switch supplies a usable composition without an additional configuration form. Browser and computer providers remain explicit compositions because they add substantial runtimes or require an external executable. Stagehand requires model credentials; Python PTC replaces a core provider and conflicts with TypeScript workflow consumers. Demonstrative hooks, webhooks, and mods stay outside the list. [Session Inspector](../feature/2026-09-24-session-inspector.md) owns the Inspector's distinct activation behavior.

Bundles insert ordinary Host rows; optional model tools register in the global tool layer, so every preset, including minimal, receives them. Plugin management, profile composition, and reload need no bundle-specific behavior. Search, Ralph, and terminals supply their own isolated services in a Host group. Search opens one in-memory index on demand; the Host search policy stays unchanged. Badge skills and title providers act on the Host. Switching a bundle registers or removes its tools for live Agents, and later user patch layers retain precedence. A replacement title provider may register once the previous provider's disposal starts; the previous provider's late results never commit.

Claude Code and Codex install on demand through the separate `ON_DEMAND_BUNDLES` catalog; the [on-demand native-bundle decision](2026-10-05-official-on-demand-bundles.md) owns the cost, version, and offline-discovery trade-offs.

## Alternatives considered

**Ship every provider as an optional bundle.** Composes and displays correctly, but grows every install by provider runtimes for a capability most installations never switch on; voice input's `sherpa-onnx-node` is the one accepted precedent.

**Mount the registration-only `computer-use` and `browser-use` services in `dsh-base`.** The shared composition would carry rows that only an optional provider bundle needs; a provider bundle can insert the service row from its own patch and dependencies.

**Register preset extensions at runtime.** A separate registration path would need its own ordering, module resolution, generation updates, and inspection behavior. Profile patches keep one effective composition for boot, dumps, validation, and user overrides.

**Insert rows into named presets with a `preset` patch operation.** Limiting tools to full presets required a second patch language across profile composition, reload, plugin management, and the plugin page, plus retained-generation removal checks. Global tools reach the same Agents through the existing Host composition.

## Consequences

Official discovery does not imply experimental status or a different plugin lifecycle. Switching a bundle off keeps its installed files; failed activation retains the existing saved-selection behavior. Bundle rows are ordinary Host rows with their usual switches. Individual and combined composition tests cover the Host rows and every preset's tool catalog; live switching and recorded Sessions cover activation and model-visible behavior.
