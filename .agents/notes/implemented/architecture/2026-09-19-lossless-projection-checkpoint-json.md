# Agent Note: Lossless projection checkpoint JSON

Status: implemented

English | [中文](2026-09-19-lossless-projection-checkpoint-json.zh.md)

## Problem

Projection checkpoints can contain opaque extension data and message metadata. A JSON key named `__proto__` is ordinary recorded data. The Zod JSON parser drops that own key while rebuilding objects, so reopening a valid checkpoint can yield different projection state from replaying the Session log.

## Decision

The checkpoint value schema uses the existing `isJsonValue` predicate from `dsh-util-values`. It enforces the same lossless JSON rules as the checkpoint writer's `snapshotJsonValue` without rebuilding valid objects. Validation still rejects non-JSON and lossy values. Storage-domain table values are immutable borrowed records; the validator does not supply a defensive-copy guarantee.

## Alternatives considered

- **Keep `z.json()`.** Its object reconstruction removes valid own keys, so a successful validation can still change the checkpoint value.
- **Validate and clone with `snapshotJsonValue`.** This preserves keys but copies already immutable stored values. The read-only predicate matches the storage-domain borrowed-value contract.

## Consequences

Domain reads preserve every valid own key in checkpoint values, including nested `__proto__` and `constructor` properties. A projection's `stateSchema` still owns its hydration value; opaque fields must use validation that preserves their keys. The borrowed-value validator does not create an independent copy or project to JSON Schema.

The domain version remains unchanged because the stored JSON representation is unchanged; this corrects its reader. Regression coverage opens a synthetic fixture produced by the real writer, then writes, closes, and reopens it through `StorageDomain`. Session format versions and historical generations do not change. [Predecessor recovery and Session-format binding](2026-09-02-projcache-cross-version-read-compat.md) continue to own cache-version and identity compatibility.
