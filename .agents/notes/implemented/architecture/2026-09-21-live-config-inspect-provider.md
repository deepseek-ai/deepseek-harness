# Agent Note: Live plugin Config inspection replaces the Host Builtin provider

Status: implemented

English | [中文](2026-09-21-live-config-inspect-provider.zh.md)

## Problem

Creator mode agents write `config:` rows for installed plugins without any runtime source of Config schemas. The CLI `--dump-config-schema` reference is not reachable from the running session, and the `Builtin` Host inspect provider advertised sandbox symbols for a dynamic Host half the model can no longer define.

## Decision

`@deepseek-ai/dsh-tool-cordis/host` registers a `Config` inspect provider and no `Builtin` provider. `Config.listConfigs` reads the live Loader tree: without input it returns every entry id, plugin name, and Config status; with an entry id it projects that entry's native Schemastery Config through the app-boot projector into one self-contained JSON Schema document. Inactive entries report `inactive` without a schema.

The provider walks `ctx.loader.entries()` and each fiber's runtime Config instead of running the boot-free collector, because a running profile already holds the module-resolution interception that the collector installs and forbids overlapping. App-boot exports the projector, the native-schema check, and the shared `loaderExpression` definition for this use; the CLI dump keeps its profile-composition semantics.

## Alternatives considered

**Re-run `generateConfigSchema` inside the Host.** It would re-import every plugin module under a second interception, which the collector forbids while one is installed, and it describes the profile files rather than the mounted tree.

**Teach the shipped skill to run the CLI dump.** It requires the profile name in the agent's shell and a `dsh` executable on its PATH, neither of which the session guarantees, and its output is unbounded.

## Consequences

Agents can read a mounted plugin's Config schema before authoring a patch. Runtime-created Agent preset trees stay outside the Loader and are not listed. The Client `Builtin` provider is unchanged: Client plugin code still runs in the browser module loader it describes.
