---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.5-alpha.1."
kind: persistence-release
---

# Persistence release: dsh-v0.1.5-alpha.1

English | [中文](dsh-v0.1.5-alpha.1.zh.md)

## Summary

The writer format advances from 2 to 3: system/message is added and EpochHeader removes system. Surface replacement fields change from start/end to startSeq/endSeq, and tool/code-dispatch event keys become tool/ptc-dispatch keys.

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
| Source tag | `dsh-v0.1.5-alpha.1` |
| Source date | 2026-09-08T15:25:45.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.3-alpha.2](dsh-v0.1.3-alpha.2.md) |
| Session writer version | 3 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->57 roots / 443 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.5-alpha.1.schema.json](dsh-v0.1.5-alpha.1.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 3`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.5-alpha.1
previous: dsh-v0.1.3-alpha.2
sessionFormatVersion: 3
changes:
  - root: SessionEventEnvelope
    before: 04184edc061905410cc7e3db8d5c7cf393d739c89eb523ba8bad3831fb23ba95
    after: 5776e5553ff2dfe3f5bc202dbb1e7c9f93e35a531aebb7764c23b2b6153b2ccc
  - root: SessionHeader
    before: 15918d785bdccedf0dba204622c75591bfb833bbf107ae0894bbc44cfbd73c1d
    after: 2a8b114637e66faab5fae1c6e2fba65320db6224c80f5f36c5bf32f937154d03
  - root: event:assistant/message
    before: 83f26c7a856f772e6ffd9a5a144e5aaccf771ac54cef41948f99eed99e1a25a7
    after: a58ca1bed502d425a8b65cac02f59717498cd296de9513c6f81b83b791c20e9b
  - root: event:request/context
    before: f6b733e38d46dde3f8ab1ade2be3362abb6642eb97982a98ee64a57ff60d0c28
    after: 37cbc9cf06d494cfe5c67f078af1605eacb8e4c2c853e9e26455b73de0ee7ccf
  - root: event:request/header
    before: 1de6c9c8764045ea9a1357bae6ccbbd57c19f6f337f8f25697c919c7cc9abf16
    after: 8ea13bcd983eab596dbfd41c5c2b62a0b318b71cd2a987a6fd752c6ced7e4489
  - root: event:system/message
    before: null
    after: 0ae7ccdc1cc5d9d43772ebd5c7357ff509011c3a6ba188d9c274d33df2542c42
  - root: event:tool/code-dispatch
    before: f8dc5624cd0c942a069063ae0d90a61d821b4fddd1d967dcded91cf17933e708
    after: null
  - root: event:tool/code-dispatch-start
    before: 9eb21c10fc675e1fa4184e5eecc9697aa87054ffd836d49428174897f0e64b62
    after: null
  - root: event:tool/ptc-dispatch
    before: null
    after: da807583a19f4ebe2bc9115c9686016e1521e405bdfaced296ae652b91e8e5f6
  - root: event:tool/ptc-dispatch-start
    before: null
    after: ec38b5949af8eacaf00df002f4acbe344f934f8a061e9cdc65a52a48e5f6dd93
  - root: event:tool/result
    before: eacefd48000720582725ccfc6ff7a0ac02755a1a3c57a8f9754125f99aab6c1b
    after: cc3e270ab982cbafff602b753647b6f056decb7fe4fd523afd2f157a65c3d622
  - root: event:user/message
    before: a57a77f18de7b37b724293830a57064696895d69f2afcd2c0264f41cd13ba980
    after: 2e49ede7fb3a592cce8919ebe982f6ca1c1f67abe4def359ffc028c85e6d1ad8
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 12 changed roots and 25 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `SessionEventEnvelope` | `union-variants-changed` | `version-bump` |
| `SessionHeader.version` | `type-changed` | `version-bump` |
| `event:assistant/message.sourceEventSeqs` | `property-removed` | `version-bump` |
| `event:assistant/message.surfaceOp` | `property-made-required` | `version-bump` |
| `event:assistant/message.surfaceOp.end` | `property-removed` | `version-bump` |
| `event:assistant/message.surfaceOp.start` | `property-removed` | `version-bump` |
| `event:assistant/message.surfaceOp.endSeq` | `required-property-added` | `version-bump` |
| `event:assistant/message.surfaceOp.startSeq` | `required-property-added` | `version-bump` |
| `event:request/context.data.systemPromptUpdate` | `optional-property-added` | `same-version` |
| `event:request/header.data.header.system` | `property-removed` | `version-bump` |
| `event:system/message` | `root-added` | `version-bump` |
| `event:tool/code-dispatch` | `root-removed` | `version-bump` |
| `event:tool/code-dispatch-start` | `root-removed` | `version-bump` |
| `event:tool/ptc-dispatch` | `root-added` | `same-version` |
| `event:tool/ptc-dispatch-start` | `root-added` | `same-version` |
| `event:tool/result.surfaceOp` | `property-made-required` | `version-bump` |
| `event:tool/result.surfaceOp.end` | `property-removed` | `version-bump` |
| `event:tool/result.surfaceOp.start` | `property-removed` | `version-bump` |
| `event:tool/result.surfaceOp.endSeq` | `required-property-added` | `version-bump` |
| `event:tool/result.surfaceOp.startSeq` | `required-property-added` | `version-bump` |
| `event:user/message.surfaceOp` | `property-made-required` | `version-bump` |
| `event:user/message.surfaceOp.end` | `property-removed` | `version-bump` |
| `event:user/message.surfaceOp.start` | `property-removed` | `version-bump` |
| `event:user/message.surfaceOp.endSeq` | `required-property-added` | `version-bump` |
| `event:user/message.surfaceOp.startSeq` | `required-property-added` | `version-bump` |

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
