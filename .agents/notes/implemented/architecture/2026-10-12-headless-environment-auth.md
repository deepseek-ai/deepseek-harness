# Agent Note: Headless jobs omit the interactive credential store

Status: implemented

English | [中文](2026-10-12-headless-environment-auth.zh.md)

## Problem

The [stored credential precedence](2026-10-09-stored-credential-precedence.md) decision makes GUI saves effective even when the shell exports a key for another application. A headless job sharing that Harness home can then use the GUI account instead of the key explicitly supplied to the job. Changing reference precedence alone would leave pi-ai provider records and saved grants ahead of the environment.

## Decision

The shipped headless bundle disables the base `credentials`, `authorization` and `deepseek-account` rows. API-key adapters already support compositions without the credentials service and resolve through the launch snapshot: process environment, invocation-directory `.env`, then Harness-home `.env`. The profile does not read, migrate, write or delete `.credentials.yaml`. Dependent authorization and account rows are disabled explicitly so ordinary jobs do not emit pending-service warnings.

This partially supersedes the per-run override policy in stored credential precedence for the shipped headless profile. Other profiles and an explicitly restored headless store retain stored-first resolution. The headless [README](../../../../packages/bundle/headless/README.md#credentials) owns the restoration patch.

## Alternatives considered

**Put the environment first in every profile.** It prevents a GUI save from replacing a key left in the launching environment and restores inconsistent reference and provider-record precedence.

**Disable only the credentials row.** It achieves environment selection but leaves authorization and the account provider pending, producing warnings on every launch.

**Add a second precedence mode to the store.** It introduces configuration and record-handling policy into the shared provider when existing adapter fallbacks and profile overrides already supply the required behavior.

## Consequences

- Headless ignores saved API keys, provider records and grants. A provider requiring stored sign-in or the DeepSeek account route fails until the user restores stored authentication; restoring it also restores saved-first precedence.
- Environment and external provider credential chains remain available. Sessions, settings and tools stay composed; omission of the store does not deny filesystem reads by tools.
- Web, SDK and ACP retain the credential store. Their authentication, login and refresh implementations are unchanged.
- Profile-level process tests cover all three environment layers, named and native pi-ai authentication, missing keys, ignored malformed storage, restoration and preservation of the document. Existing headless transcripts and real-model workspace tests cover the remaining composition.
