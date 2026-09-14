---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.2-alpha.4."
kind: persistence-release
---

# Persistence release: dsh-v0.1.2-alpha.4

English | [中文](dsh-v0.1.2-alpha.4.zh.md)

## Summary

The logical SessionHeader replaces optional seedLength with required isSeeded, while the physical JSONL header still declares seedLength. The subagent-report and coordinator user-message source variants become agent-message. The writer format remains 0.

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
| Source tag | `dsh-v0.1.2-alpha.4` |
| Source date | 2026-09-01T15:37:26.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.2-alpha.3](dsh-v0.1.2-alpha.3.md) |
| Session writer version | 0 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->54 roots / 415 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.2-alpha.4.schema.json](dsh-v0.1.2-alpha.4.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.2-alpha.4
previous: dsh-v0.1.2-alpha.3
sessionFormatVersion: 0
changes:
  - root: SessionHeader
    before: a50373168c4935222b1681223d919a56d095ce37ad45c5ba2c20d75235adf937
    after: 001ed6f66d67fac9cb9594b55f13557db94174fe5d5954789bb5a2d6d5927226
  - root: event:agent/inbox/spliced
    before: ee796690277eafbcda4437478de7a8f01d983424d6238fe472df9b3b0d97a89f
    after: 15cdff6391d58ea00d7e2fe113b663d5479cbb3fd1af26717ad933c770bca081
  - root: event:session/title-llm-request
    before: 61651f4ca07ab9ebef773d82fafbcb74d39190a255c69ecc36084046123a9cb4
    after: 2cfb71f7819bc88a6bccbffa8b7ae5664233af6f6e1dfb068db25e2e17ddd8c7
  - root: event:user/message
    before: e23368db1646a9ac10d2bd4629084fdff583a1db2c83ffaa3f2f201d0c45f3e4
    after: e950c87ba49bd8175b8a670b319a599d5ed14cde996540d5ba91a141fad68781
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 4 changed roots and 5 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `SessionHeader.seedLength` | `property-removed` | `version-bump` |
| `SessionHeader.isSeeded` | `required-property-added` | `version-bump` |
| `event:agent/inbox/spliced.data.inserted[].source` | `union-variants-changed` | `version-bump` |
| `event:session/title-llm-request.data.messages[].source` | `union-variants-changed` | `version-bump` |
| `event:user/message.data.source` | `union-variants-changed` | `version-bump` |

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
