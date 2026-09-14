---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.3-alpha.2."
kind: persistence-release
---

# Persistence release: dsh-v0.1.3-alpha.2

English | [中文](dsh-v0.1.3-alpha.2.zh.md)

## Summary

feedback/message-put and feedback/message-delete are added without changing the existing persistence root digests. The writer format remains 2.

## Table of Contents

- [Release evidence](#evidence)
- [Declaration](#declaration)
- [Structural changes](#changes)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="evidence"></a>
## Release evidence

This approximate backfill supports reading and format validation; it is not a contemporaneous compatibility acknowledgement. See the [archive reference](README.md) for extraction and coverage limits.

| Item | Recorded value |
|---|---|
| Source tag | `dsh-v0.1.3-alpha.2` |
| Source date | 2026-09-07T11:45:35.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.3-alpha.1](dsh-v0.1.3-alpha.1.md) |
| Session writer version | 2 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->56 roots / 435 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.3-alpha.2.schema.json](dsh-v0.1.3-alpha.2.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 2`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.3-alpha.2
previous: dsh-v0.1.3-alpha.1
sessionFormatVersion: 2
changes:
  - root: event:feedback/message-delete
    before: null
    after: 3ee93b06f3a125850337602bcdf155d2538c43a5c944ec55b1b3c365152d6796
  - root: event:feedback/message-put
    before: null
    after: 3b04fde0dc763cf84fbde7b6611b3194dd56d95d0c0bf0204311640468d586e1
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 2 changed roots and 2 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:feedback/message-delete` | `root-added` | `same-version` |
| `event:feedback/message-put` | `root-added` | `same-version` |

<!-- persistence-release-changes:end -->

<a id="verification"></a>
## Verification

Extraction passed canonical-graph, root-digest, and reachable-type-digest validation, permitting the original optional `surfaceOp` only for historical surface events. The in-tree check reconstructs each tag from its predecessor and verifies before/after values, snapshot coverage, and bilingual machine declarations.

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## Dev Note

None.
