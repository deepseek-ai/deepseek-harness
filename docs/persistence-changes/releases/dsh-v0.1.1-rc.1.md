---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.1-rc.1."
kind: persistence-release
---

# Persistence release: dsh-v0.1.1-rc.1

English | [中文](dsh-v0.1.1-rc.1.zh.md)

## Summary

permission/preset gains optional origin with default, selection, and inferred values. The writer format remains 0.

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
| Source tag | `dsh-v0.1.1-rc.1` |
| Source date | 2026-08-21T06:21:44.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.0-rc.8](dsh-v0.1.0-rc.8.md) |
| Session writer version | 0 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->51 roots / 407 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.1-rc.1.schema.json](dsh-v0.1.1-rc.1.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.1-rc.1
previous: dsh-v0.1.0-rc.8
sessionFormatVersion: 0
changes:
  - root: event:permission/preset
    before: 5c45bf4c544a7211dcd8ba6ba7e5f1bc39b49e7a9df9d5cbdc8e87c22771b37b
    after: 7271e4b771406aaf06014c2269edd6cb68055bb8b8686571730813ce0ababc22
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 1 changed root and 1 structural difference. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:permission/preset.data.origin` | `optional-property-added` | `same-version` |

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
