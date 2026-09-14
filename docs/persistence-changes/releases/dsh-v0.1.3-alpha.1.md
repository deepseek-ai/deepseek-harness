---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.3-alpha.1."
kind: persistence-release
---

# Persistence release: dsh-v0.1.3-alpha.1

English | [中文](dsh-v0.1.3-alpha.1.zh.md)

## Summary

The writer format advances from 0 to 2 across these tags: the JSONL header replaces seedLength with required isSeeded, and session/end-seed gains optional inherited. assistant/chunk is removed, assistant/attempt is added, and assistant/message gains a required stream array. Team event payload versions advance from 1 to 2, alongside changes to shared content types and optional capturedFormatVersion/sessionFormatVersion metadata.

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
| Source tag | `dsh-v0.1.3-alpha.1` |
| Source date | 2026-09-04T09:16:23.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.2-rc.1](dsh-v0.1.2-rc.1.md) |
| Session writer version | 2 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->54 roots / 425 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.3-alpha.1.schema.json](dsh-v0.1.3-alpha.1.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 2`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.3-alpha.1
previous: dsh-v0.1.2-rc.1
sessionFormatVersion: 2
changes:
  - root: JsonlHeaderLine
    before: 63496702a393356d64638beb7939468c1ba039ba3b5492327b2fe074d6cdac93
    after: 18ee62b8900a4c3d046700f05d7a4d49d6cab2a660a020c87481d1603dd8bd4f
  - root: SessionHeader
    before: 001ed6f66d67fac9cb9594b55f13557db94174fe5d5954789bb5a2d6d5927226
    after: 15918d785bdccedf0dba204622c75591bfb833bbf107ae0894bbc44cfbd73c1d
  - root: event:agent/inbox/spliced
    before: 15cdff6391d58ea00d7e2fe113b663d5479cbb3fd1af26717ad933c770bca081
    after: f757322e25914d63799c6235af4ed4b4f36d7d083fef40d6873a45e94fe6ad65
  - root: event:assistant/attempt
    before: null
    after: 3516f54b427775f483febe8e938e4e10f9afd3583610861547bbe2999ed4d8d9
  - root: event:assistant/chunk
    before: be6b0aa5cd6a279facb1c29589f92e24a0eb30d60a5869ae17acbcf6c3d12821
    after: null
  - root: event:assistant/message
    before: 6ac50e8b7feeb6a718cf502a4d32aa5430d68c01c23e6f4903db07f884b6cfe6
    after: 83f26c7a856f772e6ffd9a5a144e5aaccf771ac54cef41948f99eed99e1a25a7
  - root: event:compaction/summary
    before: 85c28ce3efec5863a9bf4b22ae57a50a03ec5337b965ee95ff77c9b9d137fa22
    after: eb1d32dcd3d76833392f351e039dcbd40686a1ab24b252a7a5003426f9cf4c89
  - root: event:session-log-deepseek/delivery-accepted
    before: 9c413656ca5600ea33812d43c4e7923a541cfb6ab8b5bc98e415f295f44e40da
    after: d63b8b8ffad9c02fd80c43a17df4f240c1fe8118ecca9de34f9d5871838ab5b9
  - root: event:session/end-seed
    before: 669846d6f47138d4b8897717b0f08476805437a4b3195c82551b527035d90bc6
    after: 5e6db6e24948d4a853c71cb9fabd252ad051ce93d4672c1266cf837c1c17b84e
  - root: event:session/title-llm-request
    before: 2cfb71f7819bc88a6bccbffa8b7ae5664233af6f6e1dfb068db25e2e17ddd8c7
    after: 6091f64d426ada2adc646094a6fe662a1b81d9ee5770929fe76800524e2c89a8
  - root: event:team/member
    before: 31d13edbb5fe2f8b7a38056320a8a06275ee4426e0abf12d4741818beda5a9c9
    after: 4fb59762612c3e3ac3a3bd4f84c9c148d3c3893bd422ba2b201cc039fabd49bc
  - root: event:team/message/delivered
    before: c53bff743470c8bf11be698ced047072744ef088cce663a774b456d7a8982516
    after: 48f9c19417a1abbedfa59f4667bba36b93ac2db407adf5e84cb3ba0de30942cb
  - root: event:team/message/queued
    before: a6a26c92459c96e4f342e58d7e41c71956e7e62c9280e30e260df58409a3012c
    after: 2ffcad547cb840f462eb1849fa5f6cb0e17eb93f5d07cc88b61d749b1b78d632
  - root: event:team/task
    before: 1688a2451eef9da19eaf45f12c8a27df07b1a6e56fa57ba603118f5201bb435b
    after: d595ec73b32b016a6055333c67a5d646032b22e672da1d4a09c5b1ae398a093a
  - root: event:tool/code-dispatch
    before: c14c2fdd439461cfc85105c6f620b0f62f799e3a69fb48196e938ec045aa0390
    after: f8dc5624cd0c942a069063ae0d90a61d821b4fddd1d967dcded91cf17933e708
  - root: event:tool/result
    before: a79feb023a08a8b73d254e29e78f13045b6773ce377b0c4156fcdf1368c146ab
    after: eacefd48000720582725ccfc6ff7a0ac02755a1a3c57a8f9754125f99aab6c1b
  - root: event:user/message
    before: e950c87ba49bd8175b8a670b319a599d5ed14cde996540d5ba91a141fad68781
    after: a57a77f18de7b37b724293830a57064696895d69f2afcd2c0264f41cd13ba980
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 17 changed roots and 25 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `JsonlHeaderLine.seedLength` | `property-removed` | `version-bump` |
| `JsonlHeaderLine.isSeeded` | `required-property-added` | `version-bump` |
| `SessionHeader.version` | `type-changed` | `version-bump` |
| `event:agent/inbox/spliced.data.inserted[].content[]` | `union-variants-changed` | `version-bump` |
| `event:agent/inbox/spliced.data.inserted[].source.references[].capturedFormatVersion` | `optional-property-added` | `same-version` |
| `event:assistant/attempt` | `root-added` | `same-version` |
| `event:assistant/chunk` | `root-removed` | `version-bump` |
| `event:assistant/message.data.message.content[]` | `union-variants-changed` | `version-bump` |
| `event:assistant/message.data.stream` | `required-property-added` | `version-bump` |
| `event:compaction/summary.data` | `union-variants-changed` | `version-bump` |
| `event:session-log-deepseek/delivery-accepted.data.sessionFormatVersion` | `optional-property-added` | `same-version` |
| `event:session/end-seed.data.inherited` | `optional-property-added` | `same-version` |
| `event:session/end-seed.data` | `index-signature-changed` | `version-bump` |
| `event:session/title-llm-request.data.messages[].content[]` | `union-variants-changed` | `version-bump` |
| `event:session/title-llm-request.data.messages[].source.references[].capturedFormatVersion` | `optional-property-added` | `same-version` |
| `event:team/member.data.version` | `type-changed` | `version-bump` |
| `event:team/message/delivered.data.version` | `type-changed` | `version-bump` |
| `event:team/message/queued.data.message.content[]` | `union-variants-changed` | `version-bump` |
| `event:team/message/queued.data.message.delivery` | `property-removed` | `version-bump` |
| `event:team/message/queued.data.version` | `type-changed` | `version-bump` |
| `event:team/task.data.version` | `type-changed` | `version-bump` |
| `event:tool/code-dispatch.data.content[]` | `union-variants-changed` | `version-bump` |
| `event:tool/result.data.message.content[0].content[]` | `union-variants-changed` | `version-bump` |
| `event:user/message.data.content[]` | `union-variants-changed` | `version-bump` |
| `event:user/message.data.source.references[].capturedFormatVersion` | `optional-property-added` | `same-version` |

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
