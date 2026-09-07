# Agent Note: Standalone sdk-minimal profile under dsh

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-standalone-sdk-minimal-profile.zh.md)

## Problem

A minimal SDK agent needs an explicit plugin roster. Expressing it as an overlay on the full `sdk` profile leaves every `dsh-base` service mounted and makes exclusion depend on filters and disable entries spread across unrelated plugins. A later base row can change runtime behavior even when the model-facing tools remain filtered.

A complete caller-supplied Cordis tree gives an exact roster but bypasses profile initialization, bundle resolution, persistent plugin management, home and invocation patch layers, and the `dsh`-owned process lifecycle. The minimal mode needs composition-level exclusion without creating another launcher or Python-owned application.

## Decision

### Launch and ownership

`dsh --profile sdk-minimal` is a shipped startup-only profile. Its manifest lists only `@deepseek-ai/dsh-sdk-minimal`; it does not list `@deepseek-ai/dsh-base`. The bundle inserts the complete Cordis tree over the launcher's empty profile root, while the profile patch, home patch, and ordered invocation patches retain their ordinary precedence above it.

The `dsh` CLI remains the only application launcher. The Python example selects `sdk-minimal` through the public `profile` field and an explicit Harness home. Python exposes no complete-config or arbitrary-argv path. The full Python and TypeScript SDK defaults remain `sdk`.

The bundle reuses `@deepseek-ai/dsh-sdk-app` for command help, stdin EOF, and bounded shutdown. The startup provider accepts a profile-name config so both SDK profiles render their actual command without duplicating process lifecycle code.

### Explicit composition

The bundle owns one DeepSeek adapter, SDK JSON-RPC serving, the explicit agent core, local subprocess and unrestricted filesystem providers, a platform-selected persistent shell, the string-replace editor, and uncompressed JSONL sessions under `$DSH_HOME/sessions`. Linux and macOS mount Bash; Windows mounts PowerShell. The SDK initialization request owns the model id; `DSH_CONTEXT_WINDOW` supplies fallback capacity for models outside the adapter's advisory catalog. The persona comes from `DSH_SYSTEM_PROMPT`, and the credential from `DEEPSEEK_API_KEY`.

Harness identity, runtime context, workspace instructions, skills, model-facing job controls, compaction, settings, managed credentials, telemetry, Web tools, subagents, and every other base row are absent rather than hidden. The profile pins `danger-full-access`, `maxTokensAsSuccess: false`, and startup-only patch loading.

### Customization and Web

`dsh plugin --profile sdk-minimal add <package>` installs persistent dependencies and bundle layers. The profile's `cordis.patch.yml`, the home patch, and Python `patches` provide persistent, machine-local, and invocation-specific row changes. Customization can expand or replace the explicit tree, but it still passes through the same launcher and profile resolution.

The Python runtime continues to package `dsh-web-app` and the frontend assets. `dsh web` starts that separate browser application from the installed wheel; a Python SDK client cannot select `web` because it contains no JSON-RPC server row.

## Existing decisions and supersession

This decision partially supersedes the base-first and standalone-tree rejection in [one dsh launcher for application profiles](2026-08-22-single-dsh-application-launcher.md). Repository-owned, versioned standalone profile bundles are allowed when an explicit roster is the product behavior; caller-supplied complete trees and alternate executables remain rejected.

It also supersedes the minimal-overlay realization in [Python SDK runtime through the dsh profile launcher](2026-08-23-python-sdk-dsh-profile-runtime.md) and the base-first default-profile statement in [profile plugin bundles](2026-08-05-profile-plugin-bundles.md). Those notes retain independent authority for launcher ownership, Python packaging and home requirements, general profile layering, and plugin management. No active note is fully superseded or eligible for archival.

## Verification

The bundle test pins the exact row and dependency roster. Profile-template and config-dump tests pin the one-bundle manifest, startup-only lifecycle, absence of `dsh-base`, and absence of module HMR. The keyless source test boots the real `dsh --profile sdk-minimal` process, completes a turn, and asserts the generated manifest. The installed-wheel minimal scenario owns the complete system prompt and two advertised tools in its committed model-visible snapshot while exercising persistent shell state, editor effects, and JSONL persistence through the packaged executable.

## Alternatives considered

**Keep the minimal mode as an overlay on `sdk`.** Rejected because filtering model-visible tools does not remove base services, prompt contributors, persistence choices, or later runtime behavior. It also required root-tool filtering in the shared SDK server and a complete-persona shortcut in the system-prompt config; neither shared interface carries those composition controls.

**Restore a Python `cordis` argument or environment-selected complete config.** Rejected because it recreates a Python-owned application composition and bypasses profile plugin management and launcher lifecycle.

**Create a second minimal SDK startup plugin.** Rejected because profile-aware help is the only variation; the SDK startup provider can own that config while keeping EOF and shutdown behavior local.

**Remove Web packages from the Python runtime closure.** Rejected because the wheel distributes the ordinary `dsh` application and Python deployments may also need `dsh web`; profile selection, not packaging divergence, separates those applications.

## Consequences

The minimal model and runtime roster changes only when its owning bundle changes or a trusted higher patch expands it. The price is deliberate duplication of a small complete application tree and omission of shared settings, credentials, policy controls, telemetry, and Web capabilities from that profile. Users choose the full `sdk` profile when they need those services, while both choices keep one launcher, one profile vocabulary, and one packaged runtime.
