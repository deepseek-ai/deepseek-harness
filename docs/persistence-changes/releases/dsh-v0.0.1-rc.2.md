---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.0.1-rc.2."
kind: persistence-release
---

# Persistence release: dsh-v0.0.1-rc.2

English | [中文](dsh-v0.0.1-rc.2.zh.md)

## Summary

The event envelope gains optional ignorable, and schedule/change plus four tool-workflow events are added. The writer format remains 0.

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
| Source tag | `dsh-v0.0.1-rc.2` |
| Source date | 2026-08-11T15:04:55.000Z |
| Release record | Tag only; no release object. |
| Previous release | [dsh-v0.0.1-rc.1](dsh-v0.0.1-rc.1.md) |
| Session writer version | 0 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->47 roots / 374 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.0.1-rc.2.schema.json](dsh-v0.0.1-rc.2.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.0.1-rc.2
previous: dsh-v0.0.1-rc.1
sessionFormatVersion: 0
changes:
  - root: SessionEventEnvelope
    before: 75af2f6612424c13f0e4e215925c3520923c85f2774c1c505490cff6c4747bc2
    after: 04184edc061905410cc7e3db8d5c7cf393d739c89eb523ba8bad3831fb23ba95
  - root: event:agent-preset/selected
    before: dcfce00f7b4db0ec0d652c4f4a4cdfe00b728da9ce132efefb1393c3943782f7
    after: a10c17474eaf2ddab7095a099e0fe3d046fc18e56c3e344fc8894c05ff9ef97b
  - root: event:agent/inbox/spliced
    before: 264e11c61f93de1be14d4c515b517ca4d201eb539d5148c7e2973f26a50c7e23
    after: 6a24f4c3e283ee14edf231b00a97c2f63fb29817712b905064fd37cae26b0add
  - root: event:approval/asked
    before: 976f2c5f972f5af8f96c4e8ab19383bd64ef4bb8b14bcf8c8d94f4df1e762e9c
    after: 3bfeb47b58606f4661904bc723da612782214c463d01e6d61cd6d6193d7374e1
  - root: event:approval/decided
    before: 1bf7832b6c2b95f3555dac19d34065fae19999c81d25f7d6cf04fe9c77552b48
    after: bb1ab3d08f49a9f3b265f844cd78d5c49813062a7b34b54904b426f85d0ff6e3
  - root: event:approval/policy
    before: cce8f654f2885f425de9f235c1a03794b5ff4937d1ad304f7721a97e364cc601
    after: 26718e15e7e395bce9642dba5bbe09b3b1a4ce2213d20d566cd9207d7fc5fb78
  - root: event:assistant/chunk
    before: 6941f6ed08c5a5e296852ce6d3661bf063fb8923ab3b7f1614bcafd7aa11b15d
    after: 7fd942b2189b8dbf6e1a2c7b026e9ddd1e7dba3fbe5645708a76f4cddabb281d
  - root: event:assistant/message
    before: ed8be09ea84f4ae65e1f90b54b16f571f221d8591780ea02c86fb47a326a2ea9
    after: 390aeb83383643633a1935f09f84fe19d2aee8d4f500a8de70f88d388562cc50
  - root: event:command/done
    before: ef2a4328b90be1b415bcce88b7abd27e6d2e18f4a6f2fe0f4e7ee5542a7674be
    after: 15196447222782e773eb943c92b18316ce96b9af0f0cfddb6e57ba8274ecc5ff
  - root: event:command/run
    before: 83bc42948e1c7da398e1b596a0fab808e2b410457498b90a47466a73ad5299d5
    after: 37184378c6439257d105c4e2022d80fc9c3a3f7c7f6ac661b00bc9f18d871006
  - root: event:compact/end
    before: 2d716a572add9ecf56c7ddcaaf38e919f562ff9dd3f01889c44594635152d84e
    after: 1b08daf19c0c24537507a3375957706b8d065c5e669ba73715ce3a5fc40325af
  - root: event:compact/prune
    before: b489c09d9067a6312a1b61f955f0d86aabbd4a103bf6a10fe145e3c75ad65a9c
    after: 575b3d1a943e68b3f44385ea73535e8552f2e277ca1bb5ba1a9d75c0df27ba1c
  - root: event:compact/start
    before: 3bec49e3d40a344b64b6a0d445d2e19f179b7d0ad23b5f00d90612fa260d6b27
    after: e7062526876479d0cc598f76ddcf211bc58219bb9f54533a05019e214d2ecb60
  - root: event:compact/summary
    before: 0a3551284c84ff0f8b1040698ece64513c136a4c1b504d13192057a083e523b3
    after: 0ff91204e65f029011e2bf7d4a5760147910ef4177082d958a85edef0c92b3e4
  - root: event:feedback/record
    before: d342dd39f6eab7565340782afccb4c66dea52744f17e9d3b267f7666319ece63
    after: fb9df8180a202f3c845d5aa6a81697b2f7213f6735abc17535a55656be60a575
  - root: event:goal/change
    before: 7e0b8a5bf14c5709d8645c9022fb1835fb9de915ff94b3c7276ac86a03912ab0
    after: 763c8a20af487263a0080548274f7437ef4a86e0ba8769127d1ced10a72c664d
  - root: event:hook/invoked
    before: 47aba122c2eba565fca03e4433586b00b75edc7c9c15cc970419d261b75ec748
    after: 2a37e489dbb3ec4dab76480cf507469b41d3ddcd106aa904b085ee8f8109e3bd
  - root: event:hook/result
    before: c50ce5176c069912b904fcc832153e3db0c95545d1eb015bd45222eb84f8c664
    after: e75916628f3f10c2d50658bd143052a46285fbf1a9a700ba54947614603d26b4
  - root: event:llm/retry
    before: 562f0f8138cfdf4b6f7c7d23c95d4c0b30f1a4ccb4db118c2978d8828fb42eb7
    after: 91c397f8f870e812e1dc5ac69c2745f9f105be9dc97dadc980d19ef415a65145
  - root: event:llm/retry-started
    before: c2d00a5b35a0a648f97f14d855ca23af9feec1a4d1e5e05548adc0352ba234b5
    after: 48e5c9861f16ac07e78cb7b5ae9dabdf7bb85c58baed5a51b4ad275050ea58e3
  - root: event:permission/preset
    before: d2a5c0f253863c7fa956d483f71d6c013862f91c1458bbc741417c597230478b
    after: 5c45bf4c544a7211dcd8ba6ba7e5f1bc39b49e7a9df9d5cbdc8e87c22771b37b
  - root: event:plan/mode
    before: 67cc5900f3194024998a4f65f7fb50e6c8b30c3393d52e545dbca89c731dc096
    after: a7cf43ce7c2a4c038feed1885cd7a00d5c6ee2d90a7e0d56b46f78a3e1ca327f
  - root: event:request/context
    before: af86fda2262cdb5e047091edb5f402c2e66eb06c8c68783654e6da987feae05c
    after: f6b733e38d46dde3f8ab1ade2be3362abb6642eb97982a98ee64a57ff60d0c28
  - root: event:request/header
    before: d075d9d331ec389bd1a2796f87348556f15ee799b60d4307712b06ec0bd50daa
    after: 60734ea3a9e20046f6f4e8bf6579e95d65c5490c483f5dbeb4398e8ca9cc65d8
  - root: event:sandbox/mode
    before: e0d0bdff25ad9be31aee94770baf1d83c8950110f80d8cb0dfd8a143465fe290
    after: 516da4cdd6d2f1e5ce488e648578ca51f40e458f707b803e5b24de870e799415
  - root: event:schedule/change
    before: null
    after: 2a7f86849ae54b3398ee49661a757c4fcb59a6192b7036ee2ff514617e13fb42
  - root: event:session/end-seed
    before: ed81f8c485d16e2717a65c7b6feab7b6552bd79a6634ea9e7deb2bd958940320
    after: 669846d6f47138d4b8897717b0f08476805437a4b3195c82551b527035d90bc6
  - root: event:session/title
    before: a0c63e3dcf542a4a8bef65f90e015178933a13eb63cfb838d59399081f635ce1
    after: 1b912703e2d64f91c99c675b8f805b01076c8325b905c1218ad81ef0b24909d5
  - root: event:session/title-llm-request
    before: a968ab9ddc4489b5c84f9302c58b5070b1379dd98b9aff8d22e076d55c707647
    after: cfb1df08b25e372be1b8625c7015f2a2afbab64a15c9a75bd44b52f464c51c38
  - root: event:step/end
    before: 0168132589f5214805264d9d2eb016047562c262925d8f3cec3587e9327c27b8
    after: e0a787e6ec76c7c94fecbc501b489164ab0293db05bc947914077ad01e674f05
  - root: event:step/start
    before: 5d4bdc47d480625d4b36ce563dcbdf5e1cf69a5f2126cc21104f78e057a954d0
    after: 4513e088d43e6c68425be30451b9f961cc264fe7318ca62681c41d4d78615986
  - root: event:subagent/descriptor
    before: 10a830802d3a4128b275c72e4752f371398a8f235b4f6d9695b473895566df06
    after: c97ea3d3be9afa96b5275cbeb0ada7aa3bc5cfc8ebac33b3271f567e57fb235b
  - root: event:todo/write
    before: bb8e5c7b55601a8ce4b2e83768cb1ea2a6bd406d5a4b803802ff1d99a232d984
    after: b978cff734e62143eb56c9125423ec275405eda969802d42aaf73ecb987d3b26
  - root: event:tool-workflow/agent-end
    before: null
    after: babf9ee4d1af62bf6c3a8103737f7a5e4e78ce179be835ce05a38803e15884b7
  - root: event:tool-workflow/agent-start
    before: null
    after: 5f26a6c20b37632f8f57729d171c671def4683d994ac6257a8dffcd855101627
  - root: event:tool-workflow/run-end
    before: null
    after: 42e0916e0dda5f6d1e7bb05d8514717147c036a79c9f36085683469516c1fd3f
  - root: event:tool-workflow/run-start
    before: null
    after: c1f9e0405de6d18cabb9ee70782a027f9bbdc57e5abec9dcccdd56119e2e9058
  - root: event:tool/call
    before: 0442fcc4f0ed6a21c9b68206e7e2728ca8f0ff4da0e5d8cf18a7dd73dca9258e
    after: 3b1be838223869fe0a08210db85bf773796ed3f2373ac16555dff227cade0c48
  - root: event:tool/code-dispatch
    before: 3a992ae57f950015c1269216c186c1c57ce0ebecf4d3296a09864ae9395d0cec
    after: c39526f02abfb7a3b47a7e4f12da2125d4025bf588286e16a0d22baedbb1a83b
  - root: event:tool/code-dispatch-start
    before: 151dda92d52dfe13512e9c84717b8f65e031287f0a64893f08bc915cf7ecf101
    after: 9eb21c10fc675e1fa4184e5eecc9697aa87054ffd836d49428174897f0e64b62
  - root: event:tool/result
    before: 356b0c7f439cdc3d5cba9873c8dbe472bead730b8cde27481be094004a4f1327
    after: 3b8a618295a9388a612e8de2e0997c6e59d0e82d034419317bf616a496ae593c
  - root: event:turn/end
    before: 2a844951f204be73862c15fe3cf82c074ad718f12b9aa8a0e7d3efdd23c20530
    after: 84c24f1209fc3e0153de6ac85d58fd6968b851f955e0e761b92321053956609e
  - root: event:turn/start
    before: 5aee351286dccded87a8af1af1678ef38f407617cf12d2dc754ed8a61b9a7d09
    after: aa0957eca50aeb28bcd2e6930b95809926edacb550c8c340ba526ba6b861b3d8
  - root: event:user/message
    before: c4b5e355b7c7ce538ccb1210b5c042d4bbfe33dd57a910ccd34c7afa11cde648
    after: e127c29aaca0a742665d4ea9c4d2c241e632552139d06107fb7996c25af7bcdd
  - root: event:web/deepseek-search-llm-request
    before: 0c5c79711e02bd8faed288bb89a39c77af15ad28010a0ee3d5c98adb1e5c3fe5
    after: cf6e3aaf1e2de6480aa0157730a41b9a492108a55304100b0f7e112711dd4331
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 45 changed roots and 48 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `SessionEventEnvelope` | `union-variants-changed` | `version-bump` |
| `event:agent-preset/selected.ignorable` | `optional-property-added` | `version-bump` |
| `event:agent/inbox/spliced.data.inserted[].source` | `union-variants-changed` | `version-bump` |
| `event:agent/inbox/spliced.ignorable` | `optional-property-added` | `version-bump` |
| `event:approval/asked.ignorable` | `optional-property-added` | `version-bump` |
| `event:approval/decided.ignorable` | `optional-property-added` | `version-bump` |
| `event:approval/policy.ignorable` | `optional-property-added` | `version-bump` |
| `event:assistant/chunk.ignorable` | `optional-property-added` | `version-bump` |
| `event:assistant/message.ignorable` | `optional-property-added` | `version-bump` |
| `event:command/done.ignorable` | `optional-property-added` | `version-bump` |
| `event:command/run.ignorable` | `optional-property-added` | `version-bump` |
| `event:compact/end.ignorable` | `optional-property-added` | `version-bump` |
| `event:compact/prune.ignorable` | `optional-property-added` | `version-bump` |
| `event:compact/start.ignorable` | `optional-property-added` | `version-bump` |
| `event:compact/summary.ignorable` | `optional-property-added` | `version-bump` |
| `event:feedback/record.ignorable` | `optional-property-added` | `version-bump` |
| `event:goal/change.ignorable` | `optional-property-added` | `version-bump` |
| `event:hook/invoked.ignorable` | `optional-property-added` | `version-bump` |
| `event:hook/result.ignorable` | `optional-property-added` | `version-bump` |
| `event:llm/retry.ignorable` | `optional-property-added` | `version-bump` |
| `event:llm/retry-started.ignorable` | `optional-property-added` | `version-bump` |
| `event:permission/preset.ignorable` | `optional-property-added` | `version-bump` |
| `event:plan/mode.ignorable` | `optional-property-added` | `version-bump` |
| `event:request/context.ignorable` | `optional-property-added` | `version-bump` |
| `event:request/header.ignorable` | `optional-property-added` | `version-bump` |
| `event:sandbox/mode.ignorable` | `optional-property-added` | `version-bump` |
| `event:schedule/change` | `root-added` | `same-version` |
| `event:session/end-seed.ignorable` | `optional-property-added` | `version-bump` |
| `event:session/title.ignorable` | `optional-property-added` | `version-bump` |
| `event:session/title-llm-request.data.messages[].source` | `union-variants-changed` | `version-bump` |
| `event:session/title-llm-request.ignorable` | `optional-property-added` | `version-bump` |
| `event:step/end.ignorable` | `optional-property-added` | `version-bump` |
| `event:step/start.ignorable` | `optional-property-added` | `version-bump` |
| `event:subagent/descriptor.ignorable` | `optional-property-added` | `version-bump` |
| `event:todo/write.ignorable` | `optional-property-added` | `version-bump` |
| `event:tool-workflow/agent-end` | `root-added` | `same-version` |
| `event:tool-workflow/agent-start` | `root-added` | `same-version` |
| `event:tool-workflow/run-end` | `root-added` | `same-version` |
| `event:tool-workflow/run-start` | `root-added` | `same-version` |
| `event:tool/call.ignorable` | `optional-property-added` | `version-bump` |
| `event:tool/code-dispatch.ignorable` | `optional-property-added` | `version-bump` |
| `event:tool/code-dispatch-start.ignorable` | `optional-property-added` | `version-bump` |
| `event:tool/result.ignorable` | `optional-property-added` | `version-bump` |
| `event:turn/end.ignorable` | `optional-property-added` | `version-bump` |
| `event:turn/start.ignorable` | `optional-property-added` | `version-bump` |
| `event:user/message.data.source` | `union-variants-changed` | `version-bump` |
| `event:user/message.ignorable` | `optional-property-added` | `version-bump` |
| `event:web/deepseek-search-llm-request.ignorable` | `optional-property-added` | `version-bump` |

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
