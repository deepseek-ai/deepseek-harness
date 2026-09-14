---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.2-alpha.5."
kind: persistence-release
---

# Persistence release: dsh-v0.1.2-alpha.5

English | [中文](dsh-v0.1.2-alpha.5.zh.md)

## Summary

All reconstructed persistence root digests match the preceding alpha/rc tag. The writer format remains 0.

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
| Source tag | `dsh-v0.1.2-alpha.5` |
| Source date | 2026-09-02T07:57:43.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.2-alpha.4](dsh-v0.1.2-alpha.4.md) |
| Session writer version | 0 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->54 roots / 415 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.2-alpha.5.schema.json](dsh-v0.1.2-alpha.5.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.2-alpha.5
previous: dsh-v0.1.2-alpha.4
sessionFormatVersion: 0
changes: []
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Normalized root types and their transitive digests are unchanged from the preceding tag.

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
