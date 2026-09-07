# Agent Note: Omit runtime invariants from shipped dsh config

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-03-omit-invariants-from-shipped-config.zh.md)

## Problem

`@deepseek-ai/dsh-invariants` and package-owned `./invariant` companions are optional development diagnostics. The shipped TUI mounted the service and four stateful companions while the shipped Web tree omitted them, so the two product surfaces had different diagnostic cost and failure behavior. A relational assertion failure could terminate an ordinary TUI run even though the always-on product boundary remained responsible for session validation and immutable history.

## Decision

The shipped `dsh` configuration trees under `apps/cli/config/` mount neither `@deepseek-ai/dsh-invariants` nor any package-owned `./invariant` companion. The CLI package therefore carries no direct dependency on the invariant service.

Invariant support remains available for focused tests, example bundles, generated SDK compositions, and custom deployments that opt into diagnostics explicitly. Session validation, snapshotting, freezing, and cited source-event validation remain always on and do not depend on the optional service, as defined by the [source-owned immutability decision](../architecture/2026-06-11-dev-invariants-over-deep-readonly.md).

The built CLI config-dump test checks both shipped surfaces and rejects either the service entry or any `@deepseek-ai/dsh-*/invariant` entry.

## Alternatives considered

- **Mount the service with `enabled: false`.** Rejected because the shipped tree and CLI dependency would still carry diagnostics that install no checks.
- **Keep the TUI-only mount.** Rejected because the shipped surfaces would retain different diagnostic and failure behavior.
- **Remove invariant support from the repository.** Rejected because package-owned checks remain useful in tests, examples, generated SDKs, and explicit development compositions; only the default product config is out of scope.

## Consequences

- Ordinary `dsh` TUI and Web runs install no invariant listeners or trace state and cannot fail through `InvariantError`.
- Development and custom compositions retain explicit access to the invariant service and companions.
- The shipped config absence is verified from the built CLI's composed output for both surfaces.
- Always-on session integrity remains unchanged.
