# Agent Note: Shared base default file editor selection

Status: implemented

English | [中文](2026-09-05-base-default-file-editor.zh.md)

## Problem

The shared base selects both `read`/`write`/`edit` and `str_replace_editor`, which offer overlapping file editing interfaces. [Issue #3599](https://github.com/deepseek-harness/deepseek-harness/issues/3599) requests one default interface for base-backed profiles while preserving the dedicated minimal compositions.

## Decision

The [base patch](../../../../packages/bundle/base/cordis.patch.yml) selects `read`, `write`, and `edit` for file editing. It does not insert `tool-str-replace-editor`; SDK and Web application patches therefore need no disabling override. The editor package remains available to compositions that insert it explicitly.

[Web minimal](../../../../packages/preset/agent-presets/presets/minimal/agent.cordis.yml) inserts its own `str-replace-editor` row in the agent scope. The standalone [sdk-minimal bundle](../../../../packages/bundle/sdk-minimal/cordis.patch.yml) inserts its own row without inheriting base. Both minimal compositions retain their editor.

This refines the shared tool defaults in [one dsh launcher](../architecture/2026-08-22-single-dsh-application-launcher.md). That note remains active for launch ownership, shared services, and patch precedence; no active note is fully superseded.

## Alternatives considered

**Disable the editor separately in each application.** This leaves overlapping defaults in base and requires each consumer to opt out. The base owns the shared choice directly.

**Delete the tool package or remove it from minimal.** The dedicated minimal compositions use this interface for file operations. Keeping the package and their explicit rows preserves that behavior.

## Consequences

Base-backed SDK, headless, ACP, and custom profiles omit the editor schema by default. Web standard also omits it. A profile, home, or invocation patch can add the tool with `insert`; a patch that only sets `disabled: false` requires an existing row and cannot create one. This decision does not make all SDK and Web tools identical.

## Verification

The [SDK process tests](../../../../apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts) capture actual model requests for default file tools, explicit editor insertion, and the standalone minimal roster. The [headless process test](../../../../apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts) checks the shared default through its application. [Web minimal snapshots](../../../../apps/web/tests/minimal-preset.snapshot.ts) exercise the editor through the minimal preset. The [headless](../../../../snapshots/session/headless.snapshot.ts), [SDK](../../../../snapshots/sdk/sdk.snapshot.ts), and [ACP](../../../../snapshots/acp/acp.snapshot.ts) recorded sessions pin the assembled model-visible outputs, including the SDK fixture that explicitly inserts the editor.
