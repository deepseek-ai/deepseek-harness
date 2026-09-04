# Agent Note: Bind JSONL session identity before mutation

Status: implemented

English | [中文](2026-07-20-jsonl-storage-identity.zh.md)

## Problem

JSONL lookup selects a physical log from the requested session id across project directories, while the parsed `SessionHeader` supplies the metadata used by later repair and append operations. Without binding those two facts, a log selected for session A can declare session B's id or cwd and redirect a repair or later append to B's path. The project scan also needs a defined result when the same encoded id exists in more than one project directory. A medium that resolves records through one authoritative key may avoid this ambiguity, but the shipped JSONL provider must bind its selected path explicitly.

## Decision

`findLog(id)` is the JSONL provider's single physical resolver. It scans every project directory and requires at most one matching encoded session directory with a transcript. For a supported historical snapshot, the generation operation translates its header in memory, then validates `header.id === id` and that the selected path either equals `logPath(root, header.cwd, header.id)` or filesystem canonicalization resolves both spellings to the same transcript before any write. The fused `loadCurrentStored(id)` decodes the resulting current prefix without another file read; an already-current snapshot takes the no-write fast path and applies the same identity check during that decode. The ordinary current `loadStored(id)` hook retains the identity validation for coordinator fallbacks. `list()` applies the same path validation and rejects duplicate ids across project directories.

The coordinator independently asserts the returned id and compares the stored cwd with a live session's cwd before repair, state publication, or suffix persistence. It keeps a detached copy of validated metadata; JSONL append and repair derive their path from that copy. The `PersistenceBackend<TornMarker>` interface therefore needs neither a scope-specific live lookup nor a storage-locator type.

An existing configured JSONL root must be a readable directory when the plugin loads. An absent root remains valid and is created on first materialization. The backend supports one live writer per session; another backend instance or process must not mutate that session until the owner finishes disposal and all writes stop.

## Alternatives considered

**Flatten storage by session id.** A flat namespace makes duplicate publication collide on one path, but path validation and duplicate rejection close the identity defect without making the check depend on a flat global namespace.

**Carry an opaque storage locator through the coordinator.** A locator binds JSONL mutations directly to a selected path, but JSONL can reproduce that path from metadata it has already validated. Adding another generic and argument to the coordinator, test backends, append, and repair makes every implementation carry a concept only the file backend needs; an out-of-tree provider keeps its medium-specific locator inside its own primitives.

**Coordinate multiple live writers.** A dedicated coordination service, process-global registry, or cross-process lock would define a new deployment topology rather than repair identity validation. The supported topology has one live writer; no-overwrite hard-link publication still arbitrates an initial same-id creation race.

## Consequences

Mismatched, misplaced, and duplicate JSONL logs fail before repair or coordinator state mutation. Lookup remains proportional to the number of project directories, and one-live-writer ownership remains an explicit limitation. Coordinator and JSONL tests pin rejection before repair, unchanged bytes for both affected logs, path validation during listing, duplicate-id rejection, normalized-project collisions and case aliases, and load-time root validation.
