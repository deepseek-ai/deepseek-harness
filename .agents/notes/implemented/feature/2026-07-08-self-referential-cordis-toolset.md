# Agent Note: Cordis runtime inspection and runner isolation

Status: implemented

English | [中文](2026-07-08-self-referential-cordis-toolset.zh.md)

## Problem

Runtime API discovery must describe the APIs a plugin can actually call. Process-local generated definitions also need registration validation and complete effect disposal; isolating JavaScript globals alone does not constrain the authority of injected services.

## Decision

`cordis_inspect_list` and `cordis_inspect_query` expose read-only runtime discovery. Generated catalogs retain source-owned declarations and JSDoc, intersected with live providers. The catalog generator rejects freshness drift; detailed queries avoid charging every request for complete API declarations.

The Host and Client runners retain their programmatic lifecycle and browser consumers. A Host definition evaluates in a fresh vm realm and receives a context façade: service access requires declared injection, framework internals are hidden, and registrations belong to the definition's fiber. Tool output normalization crosses back into the Host realm before validation. Disposal awaits the fiber's owned effects. The vm prevents accidental global pollution; injected filesystem, shell, and network services still have real authority, so it is not a security boundary.

Definitions remain process-local. Restart and session resume do not recreate them from historical calls. The [Creator persistent plugin decision](../architecture/2026-09-16-creator-persistent-plugin-management.md) owns agent-authored installation, approval, and profile persistence. Shipped model tools do not create or mutate runner definitions.

## Alternatives considered

**Hand-maintained API tables.** Rejected because they drift independently from service declarations; generated catalogs and freshness checks share one source.

**Treat the vm as a security sandbox.** Rejected because services exposed through the façade can reach the Host's real resources. Restricted globals improve lifecycle correctness, not permission enforcement.

**Recreate definitions from session logs.** Rejected because replaying source would execute historical side effects. Historical cards display persisted source and outcomes without restoring a live definition.

## Consequences

Inspection remains usable without Creator or Plugin Manager. Runner lifecycle tests cover guarded registration, startup failure cleanup, and awaited disposal. Existing browser consumers retain their lifecycle APIs; removing their write-side registry and activation machinery requires a coordinated replacement of those consumers, rather than deleting historical rendering or assuming session data recreates live state.
