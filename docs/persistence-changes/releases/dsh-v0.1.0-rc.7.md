---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.0-rc.7."
kind: persistence-release
---

# Persistence release: dsh-v0.1.0-rc.7

English | [中文](dsh-v0.1.0-rc.7.zh.md)

## Summary

assistant/chunk replayState changes from unknown to an object with required response and optional blocks. The writer format remains 0.

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
| Source tag | `dsh-v0.1.0-rc.7` |
| Source date | 2026-08-17T11:03:17.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.0-rc.6](dsh-v0.1.0-rc.6.md) |
| Session writer version | 0 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->47 roots / 376 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.0-rc.7.schema.json](dsh-v0.1.0-rc.7.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.0-rc.7
previous: dsh-v0.1.0-rc.6
sessionFormatVersion: 0
changes:
  - root: event:assistant/chunk
    before: 7fd942b2189b8dbf6e1a2c7b026e9ddd1e7dba3fbe5645708a76f4cddabb281d
    after: de04e4ae000cc4422a15fb86dce7c398c8a9970ac963b6f7f785e2276a939e62
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 1 changed root and 1 structural difference. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:assistant/chunk.data.chunk.replayState` | `type-changed` | `version-bump` |

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
