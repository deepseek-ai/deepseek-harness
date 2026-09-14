---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.0.1-rc.3."
kind: persistence-release
---

# Persistence release: dsh-v0.0.1-rc.3

English | [中文](dsh-v0.0.1-rc.3.zh.md)

## Summary

The four compact/* event keys become compaction/*; user-message source kind workspace-instructions becomes agent-instructions, and hook dialect claude becomes claude-code. These literal and event-key changes occur while the writer format remains 0.

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
| Source tag | `dsh-v0.0.1-rc.3` |
| Source date | 2026-08-12T20:18:26.000Z |
| Release record | Tag only; no release object. |
| Previous release | [dsh-v0.0.1-rc.2](dsh-v0.0.1-rc.2.md) |
| Session writer version | 0 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->47 roots / 374 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.0.1-rc.3.schema.json](dsh-v0.0.1-rc.3.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.0.1-rc.3
previous: dsh-v0.0.1-rc.2
sessionFormatVersion: 0
changes:
  - root: event:agent/inbox/spliced
    before: 6a24f4c3e283ee14edf231b00a97c2f63fb29817712b905064fd37cae26b0add
    after: dea3a1d5640e0306a486f92b725a01b57e69439277978ca09dc246fb40016b90
  - root: event:compact/end
    before: 1b08daf19c0c24537507a3375957706b8d065c5e669ba73715ce3a5fc40325af
    after: null
  - root: event:compact/prune
    before: 575b3d1a943e68b3f44385ea73535e8552f2e277ca1bb5ba1a9d75c0df27ba1c
    after: null
  - root: event:compact/start
    before: e7062526876479d0cc598f76ddcf211bc58219bb9f54533a05019e214d2ecb60
    after: null
  - root: event:compact/summary
    before: 0ff91204e65f029011e2bf7d4a5760147910ef4177082d958a85edef0c92b3e4
    after: null
  - root: event:compaction/end
    before: null
    after: b0127044ab31a702bddfd785d345f5abd7a70876746e895ce443afa3e60ddf2d
  - root: event:compaction/prune
    before: null
    after: 7f7fd5a6b0064f597534b29ff62ef26e786dffccf5e14f654a7d4fcea2c35f04
  - root: event:compaction/start
    before: null
    after: db874d463b0fdec77e9da1c4568f37cb70bd6596781eb93800db44fb8a116965
  - root: event:compaction/summary
    before: null
    after: 67c53a0cdc70f8330a84b9a16481bc6cc45e23d1ae8041485a0b0453c11fc9aa
  - root: event:hook/invoked
    before: 2a37e489dbb3ec4dab76480cf507469b41d3ddcd106aa904b085ee8f8109e3bd
    after: 8a6e1ec9e8db346b0e02f027db73c07a94f067a26d40c1aef1abd09c47ce7ba0
  - root: event:session/title-llm-request
    before: cfb1df08b25e372be1b8625c7015f2a2afbab64a15c9a75bd44b52f464c51c38
    after: 796a77af2c1452392f0cc62b99fba2d404d1c9eb10a8a2510a808fba6053cf24
  - root: event:user/message
    before: e127c29aaca0a742665d4ea9c4d2c241e632552139d06107fb7996c25af7bcdd
    after: 18c8d77777545808f232cd8d7730ce270cb1b737edd3eaa45e0da9436fd37a13
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 12 changed roots and 12 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:agent/inbox/spliced.data.inserted[].source.kind` | `type-changed` | `version-bump` |
| `event:compact/end` | `root-removed` | `version-bump` |
| `event:compact/prune` | `root-removed` | `version-bump` |
| `event:compact/start` | `root-removed` | `version-bump` |
| `event:compact/summary` | `root-removed` | `version-bump` |
| `event:compaction/end` | `root-added` | `same-version` |
| `event:compaction/prune` | `root-added` | `same-version` |
| `event:compaction/start` | `root-added` | `same-version` |
| `event:compaction/summary` | `root-added` | `same-version` |
| `event:hook/invoked.data.dialect` | `type-changed` | `version-bump` |
| `event:session/title-llm-request.data.messages[].source.kind` | `type-changed` | `version-bump` |
| `event:user/message.data.source.kind` | `type-changed` | `version-bump` |

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
