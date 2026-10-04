# Agent Note: Ship experimental capabilities as optional bundles

Status: implemented

English | [中文](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)

## Problem

The Web plugin page offered two optional bundles, Agent Teams and voice input. Auto review and the Inspector were published experimental packages that a person had to install by name or mount through a hand-written profile patch, although both already declared a bundle patch or shipped a mountable overlay.

## Decision

`OPTIONAL_BUNDLES` lists Agent Teams, voice input, Auto review, and the Inspector profile. Every optional bundle declares `icon` and exports `./locale/*.json` with `meta.title` and `meta.description`, so the Official group renders a localized title, description, and image; `verify-default-product-isolation` rejects an optional bundle without them. The Inspector profile owns the package-named bundle patch. The standalone Inspector's `cordis.patch.yml` mounts its local built entry as an explicit repository overlay; [Session Inspector](../feature/2026-09-24-session-inspector.md) owns the inspection behavior and activation choices.

An optional bundle is a runtime dependency of the installation, so its dependency graph is downloaded by every `dsh` install. The list weighs the added installation cost: Auto review reuses the installation's closure, while the Inspector profile adds inspection packages, `serve-static`/`open`/`ws`, and 535 mirrored DevTools resources (about 11.95 MiB uncompressed), without another browser binary. The Inspector profile appears in the default plugin list but remains disabled until selected. The browser-use and computer-use providers stay explicit compositions: Playwright MCP, Chrome DevTools MCP, and the native Cua Driver runtime binaries add about 85 MB and 21 packages to every install whether or not the bundle is enabled, and a shipped Cua Driver MCP switch would offer a capability whose executable the installation does not carry. Those provider packages keep locale display metadata for their component rows. Two more packages stay out for other reasons: `ptc-runtime-python` replaces the PTC runtime, and `workflow-ptc` rejects a non-TypeScript runtime at load while the Web presets carry `workflow-ptc` rows a bundle patch cannot reach; `browser-use-stagehand-native` requires a native model name and API key at schema validation with no configuration form on the page.

## Alternatives considered

**Ship every provider as an optional bundle.** Composes and displays correctly, but grows every install by provider runtimes for a capability most installations never switch on; voice input's `sherpa-onnx-node` is the one accepted precedent.

**Mount the registration-only `computer-use` and `browser-use` services in `dsh-base`.** The shared composition would carry rows that only an optional provider bundle needs; a provider bundle can insert the service row from its own patch and dependencies.

## Consequences

The Official group carries four optional-bundle entries, each tagged experimental by its experimental name. Their runtime dependencies are installed even while the bundles are disabled. A browser-use or computer-use provider still needs its Service Definition and the provider in a profile patch or composition.
