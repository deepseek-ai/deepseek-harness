---
description: "回溯 dsh-v0.1.2-alpha.1 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯: dsh-v0.1.2-alpha.1

[English](dsh-v0.1.2-alpha.1.md) | 中文

## 概述

事件信封删除 ignorable，request/header 新增可选字段 startsSeries 及原因值 series，并新增模型选择、子 Agent 模型策略和投递确认事件。尽管存在这些结构变化，写入格式仍为 0。

## 目录

- [发行来源](#evidence)
- [声明](#declaration)
- [结构变化](#changes)
- [校验](#verification)
- [开发备注](#dev-note)

-----

<a id="evidence"></a>
## 发行来源

这是供阅读和格式校验的近似回填，不是当时的兼容性确认。提取方法和覆盖限制见[归档说明](README.zh.md)。

| 项目 | 记录值 |
|---|---|
| 源码 tag | `dsh-v0.1.2-alpha.1` |
| 源码日期 | 2026-08-27T16:57:43.000Z |
| 发行记录 | 有 release 对象。 |
| 前一版本 | [dsh-v0.1.1-rc.2](dsh-v0.1.1-rc.2.zh.md) |
| Session 写入版本 | 0 |
| 完整重建清单 | <!-- persistence-release-inventory:start -->54 个根类型 / 417 种类型<!-- persistence-release-inventory:end --> |
| 本条快照 | [dsh-v0.1.2-alpha.1.schema.json](dsh-v0.1.2-alpha.1.schema.json) |

写入版本常量在该 tag 中的源码证据：

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.2-alpha.1
previous: dsh-v0.1.1-rc.2
sessionFormatVersion: 0
changes:
  - root: SessionEventEnvelope
    before: 04184edc061905410cc7e3db8d5c7cf393d739c89eb523ba8bad3831fb23ba95
    after: 75af2f6612424c13f0e4e215925c3520923c85f2774c1c505490cff6c4747bc2
  - root: event:agent-preset/selected
    before: a10c17474eaf2ddab7095a099e0fe3d046fc18e56c3e344fc8894c05ff9ef97b
    after: dcfce00f7b4db0ec0d652c4f4a4cdfe00b728da9ce132efefb1393c3943782f7
  - root: event:agent/inbox/spliced
    before: 402ee62cd1447d03340e206138fb107d865a3452ea73c15c22fb6bc48fdf181a
    after: 48710fdd647f5ab880cc156ca12c40e9ad4d0cc7717775fef5cf324857662d10
  - root: event:approval/asked
    before: 3bfeb47b58606f4661904bc723da612782214c463d01e6d61cd6d6193d7374e1
    after: 976f2c5f972f5af8f96c4e8ab19383bd64ef4bb8b14bcf8c8d94f4df1e762e9c
  - root: event:approval/decided
    before: bb1ab3d08f49a9f3b265f844cd78d5c49813062a7b34b54904b426f85d0ff6e3
    after: 1bf7832b6c2b95f3555dac19d34065fae19999c81d25f7d6cf04fe9c77552b48
  - root: event:approval/policy
    before: 26718e15e7e395bce9642dba5bbe09b3b1a4ce2213d20d566cd9207d7fc5fb78
    after: cce8f654f2885f425de9f235c1a03794b5ff4937d1ad304f7721a97e364cc601
  - root: event:assistant/chunk
    before: 51045f351a56e61da8be1dd5bba8080ac5e8ac2ff3d62a308a7f3e710b7cb18b
    after: 30393482a7e1a756ef676bf938691fc9b9ce978397028f9546c656a2c3f349b6
  - root: event:assistant/message
    before: 395d04e6fd6f40eae4099cfaf3793fb710cee646fac53378433bc2d74bebd386
    after: f8c6ad603f7f85c63684825615b916d32d67aff7c8f578b62a1350482b1caef3
  - root: event:command/done
    before: 15196447222782e773eb943c92b18316ce96b9af0f0cfddb6e57ba8274ecc5ff
    after: ef2a4328b90be1b415bcce88b7abd27e6d2e18f4a6f2fe0f4e7ee5542a7674be
  - root: event:command/run
    before: 37184378c6439257d105c4e2022d80fc9c3a3f7c7f6ac661b00bc9f18d871006
    after: 83bc42948e1c7da398e1b596a0fab808e2b410457498b90a47466a73ad5299d5
  - root: event:compaction/end
    before: b0127044ab31a702bddfd785d345f5abd7a70876746e895ce443afa3e60ddf2d
    after: 8cf364e7b2d954904ce1d0dd82d6ca410eb2a9912f84f3d468307db0b128d0da
  - root: event:compaction/prune
    before: 7f7fd5a6b0064f597534b29ff62ef26e786dffccf5e14f654a7d4fcea2c35f04
    after: d3a9b64bf88e4b2c96693aeae00c70276ab310b0fa4f1fde22ec661b2e93be9b
  - root: event:compaction/start
    before: db874d463b0fdec77e9da1c4568f37cb70bd6596781eb93800db44fb8a116965
    after: 9f1127bcdaccb571f215e3690548c7b7bb45010cf870576d50db4cc49f1c1bd9
  - root: event:compaction/summary
    before: 80316c3b92f42f246ab57d649dc546a8adeb11b96db3b11361ea32709b6bdc35
    after: d052d16d5443ab450111a5e13fb7ab76ada7d8368a70394c33c78e7d0a9e5bb3
  - root: event:feedback/record
    before: fb9df8180a202f3c845d5aa6a81697b2f7213f6735abc17535a55656be60a575
    after: d342dd39f6eab7565340782afccb4c66dea52744f17e9d3b267f7666319ece63
  - root: event:goal/change
    before: 763c8a20af487263a0080548274f7437ef4a86e0ba8769127d1ced10a72c664d
    after: 7e0b8a5bf14c5709d8645c9022fb1835fb9de915ff94b3c7276ac86a03912ab0
  - root: event:hook/invoked
    before: 8a6e1ec9e8db346b0e02f027db73c07a94f067a26d40c1aef1abd09c47ce7ba0
    after: 7dc7bbad5062335268afd664d630a1b9263d82f72e114a6df1fe791118d0f6fe
  - root: event:hook/result
    before: e75916628f3f10c2d50658bd143052a46285fbf1a9a700ba54947614603d26b4
    after: c50ce5176c069912b904fcc832153e3db0c95545d1eb015bd45222eb84f8c664
  - root: event:llm/retry
    before: 91c397f8f870e812e1dc5ac69c2745f9f105be9dc97dadc980d19ef415a65145
    after: 562f0f8138cfdf4b6f7c7d23c95d4c0b30f1a4ccb4db118c2978d8828fb42eb7
  - root: event:llm/retry-started
    before: 48e5c9861f16ac07e78cb7b5ae9dabdf7bb85c58baed5a51b4ad275050ea58e3
    after: c2d00a5b35a0a648f97f14d855ca23af9feec1a4d1e5e05548adc0352ba234b5
  - root: event:model/selection
    before: null
    after: 6bf2058085609a70b4845432a2db645859f90ed3519ff5accf9020da3b7d85f8
  - root: event:permission/preset
    before: 5c45bf4c544a7211dcd8ba6ba7e5f1bc39b49e7a9df9d5cbdc8e87c22771b37b
    after: d2a5c0f253863c7fa956d483f71d6c013862f91c1458bbc741417c597230478b
  - root: event:plan/mode
    before: a7cf43ce7c2a4c038feed1885cd7a00d5c6ee2d90a7e0d56b46f78a3e1ca327f
    after: 67cc5900f3194024998a4f65f7fb50e6c8b30c3393d52e545dbca89c731dc096
  - root: event:request/context
    before: f6b733e38d46dde3f8ab1ade2be3362abb6642eb97982a98ee64a57ff60d0c28
    after: af86fda2262cdb5e047091edb5f402c2e66eb06c8c68783654e6da987feae05c
  - root: event:request/header
    before: 60734ea3a9e20046f6f4e8bf6579e95d65c5490c483f5dbeb4398e8ca9cc65d8
    after: d6c68556cf482b3c24c3ea2737a7dbd69a21e36246334eb17f329caa838dcee7
  - root: event:sandbox/mode
    before: 516da4cdd6d2f1e5ce488e648578ca51f40e458f707b803e5b24de870e799415
    after: e0d0bdff25ad9be31aee94770baf1d83c8950110f80d8cb0dfd8a143465fe290
  - root: event:schedule/change
    before: 2a7f86849ae54b3398ee49661a757c4fcb59a6192b7036ee2ff514617e13fb42
    after: 19b014756dd1882e2708c7b1ec02d5eef60fea523cf5b0c59cb320177bc4136c
  - root: event:session-log-deepseek/delivery-accepted
    before: null
    after: 15fc803b92d6a4b340991f978cf74b530f7cee6a36e565038e7ceff51a708258
  - root: event:session/end-seed
    before: 669846d6f47138d4b8897717b0f08476805437a4b3195c82551b527035d90bc6
    after: ed81f8c485d16e2717a65c7b6feab7b6552bd79a6634ea9e7deb2bd958940320
  - root: event:session/title
    before: 1b912703e2d64f91c99c675b8f805b01076c8325b905c1218ad81ef0b24909d5
    after: a0c63e3dcf542a4a8bef65f90e015178933a13eb63cfb838d59399081f635ce1
  - root: event:session/title-llm-request
    before: 9d5c0dabeec05f0ba9edd8ca24754de13dc2d3af5c302ff44eda04fb1a602257
    after: 168298ef5828c8a52edfaeb4680d8e0d8624a671a85d1180b2bd6a59bef9a1f9
  - root: event:step/end
    before: e0a787e6ec76c7c94fecbc501b489164ab0293db05bc947914077ad01e674f05
    after: 0168132589f5214805264d9d2eb016047562c262925d8f3cec3587e9327c27b8
  - root: event:step/start
    before: 4513e088d43e6c68425be30451b9f961cc264fe7318ca62681c41d4d78615986
    after: 5d4bdc47d480625d4b36ce563dcbdf5e1cf69a5f2126cc21104f78e057a954d0
  - root: event:subagent/descriptor
    before: c97ea3d3be9afa96b5275cbeb0ada7aa3bc5cfc8ebac33b3271f567e57fb235b
    after: 34846366019c2dc6a2f67d20a4ee43f19ff35c2b7b927916bae2b9ab4e318cb8
  - root: event:subagent/model-selection-policy
    before: null
    after: 1abc47cf4161756f5011c616aaf3b9adaf65119dc6f179340d7e613c72072b1f
  - root: event:team/member
    before: 31d13edbb5fe2f8b7a38056320a8a06275ee4426e0abf12d4741818beda5a9c9
    after: 8e0b3aa8bd2b8561c94d73ae9a725076f917e78d28373ae54f01d4f71d971a63
  - root: event:team/message/delivered
    before: c53bff743470c8bf11be698ced047072744ef088cce663a774b456d7a8982516
    after: 27cf82973621e683712e75620a723d24ca190f7facb6ecf9413942fd5919ce30
  - root: event:team/message/queued
    before: a6a26c92459c96e4f342e58d7e41c71956e7e62c9280e30e260df58409a3012c
    after: a06bce8602088cf02297355955ee4589fc02b19a56dfbc511174587d41c66c46
  - root: event:team/task
    before: 1688a2451eef9da19eaf45f12c8a27df07b1a6e56fa57ba603118f5201bb435b
    after: 0d7df3fad5a54cf556ec916aa1a5a57a25a2c1be1f7272db3b158aae700ec97e
  - root: event:todo/write
    before: b978cff734e62143eb56c9125423ec275405eda969802d42aaf73ecb987d3b26
    after: bb8e5c7b55601a8ce4b2e83768cb1ea2a6bd406d5a4b803802ff1d99a232d984
  - root: event:tool-workflow/agent-end
    before: babf9ee4d1af62bf6c3a8103737f7a5e4e78ce179be835ce05a38803e15884b7
    after: 7457fdada66b6d1d4f473122a4bc1cf295b7e9e04e720448058b32b81d630b17
  - root: event:tool-workflow/agent-start
    before: 5f26a6c20b37632f8f57729d171c671def4683d994ac6257a8dffcd855101627
    after: c3ffa0abe114f54a9a35a071aca5121b36430197fb41632d977e0f0c69f017f7
  - root: event:tool-workflow/run-end
    before: 42e0916e0dda5f6d1e7bb05d8514717147c036a79c9f36085683469516c1fd3f
    after: a00375ea5583542b61152eb6dbc478f5c4423272865500d9d11847d22902a9ae
  - root: event:tool-workflow/run-start
    before: c1f9e0405de6d18cabb9ee70782a027f9bbdc57e5abec9dcccdd56119e2e9058
    after: 325c47f7099664660aac905ffbe9ccbe8d2552d864a6b9da3836a1a2e7082eb1
  - root: event:tool/call
    before: 3b1be838223869fe0a08210db85bf773796ed3f2373ac16555dff227cade0c48
    after: 0442fcc4f0ed6a21c9b68206e7e2728ca8f0ff4da0e5d8cf18a7dd73dca9258e
  - root: event:tool/code-dispatch
    before: c14c2fdd439461cfc85105c6f620b0f62f799e3a69fb48196e938ec045aa0390
    after: 0f937e14fa6a174f7e2a903916510664dda97e1a9d05bc1c5059dc33d00b6eac
  - root: event:tool/code-dispatch-start
    before: 9eb21c10fc675e1fa4184e5eecc9697aa87054ffd836d49428174897f0e64b62
    after: 151dda92d52dfe13512e9c84717b8f65e031287f0a64893f08bc915cf7ecf101
  - root: event:tool/result
    before: a79feb023a08a8b73d254e29e78f13045b6773ce377b0c4156fcdf1368c146ab
    after: 0c4d6665523ad36e3895e2c6b1352ea3894fb5efcb5a9fdefc5092dc51578874
  - root: event:turn/end
    before: 84c24f1209fc3e0153de6ac85d58fd6968b851f955e0e761b92321053956609e
    after: 2a844951f204be73862c15fe3cf82c074ad718f12b9aa8a0e7d3efdd23c20530
  - root: event:turn/start
    before: aa0957eca50aeb28bcd2e6930b95809926edacb550c8c340ba526ba6b861b3d8
    after: 5aee351286dccded87a8af1af1678ef38f407617cf12d2dc754ed8a61b9a7d09
  - root: event:user/message
    before: 70a39b3639ca6c2eeabf1e2c8ef4cbc23e24c947e72bf0c28754e7c2f713be26
    after: de7d01b9a4bd2fbdcab0a901dbd221086ee5e3a4a7bc123496b5c4e45b6c5384
  - root: event:web/deepseek-search-llm-request
    before: cf6e3aaf1e2de6480aa0157730a41b9a492108a55304100b0f7e112711dd4331
    after: 0c5c79711e02bd8faed288bb89a39c77af15ad28010a0ee3d5c98adb1e5c3fe5
```

<a id="changes"></a>
## 结构变化

<!-- persistence-release-changes:start -->

检测到 52 个根类型变化、61 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。

| 路径 | 变化 | 当前最低要求 |
|---|---|---|
| `SessionEventEnvelope` | `union-variants-changed` | `version-bump` |
| `event:agent-preset/selected.ignorable` | `property-removed` | `version-bump` |
| `event:agent/inbox/spliced.data.inserted[].source` | `union-variants-changed` | `version-bump` |
| `event:agent/inbox/spliced.ignorable` | `property-removed` | `version-bump` |
| `event:approval/asked.ignorable` | `property-removed` | `version-bump` |
| `event:approval/decided.ignorable` | `property-removed` | `version-bump` |
| `event:approval/policy.ignorable` | `property-removed` | `version-bump` |
| `event:assistant/chunk.data.chunk.usage.totalTokens` | `optional-property-added` | `same-version` |
| `event:assistant/chunk.ignorable` | `property-removed` | `version-bump` |
| `event:assistant/message.data.usage.totalTokens` | `optional-property-added` | `same-version` |
| `event:assistant/message.ignorable` | `property-removed` | `version-bump` |
| `event:command/done.ignorable` | `property-removed` | `version-bump` |
| `event:command/run.ignorable` | `property-removed` | `version-bump` |
| `event:compaction/end.ignorable` | `property-removed` | `version-bump` |
| `event:compaction/prune.ignorable` | `property-removed` | `version-bump` |
| `event:compaction/start.ignorable` | `property-removed` | `version-bump` |
| `event:compaction/summary.data.usage.totalTokens` | `optional-property-added` | `same-version` |
| `event:compaction/summary.ignorable` | `property-removed` | `version-bump` |
| `event:feedback/record.ignorable` | `property-removed` | `version-bump` |
| `event:goal/change.ignorable` | `property-removed` | `version-bump` |
| `event:hook/invoked.ignorable` | `property-removed` | `version-bump` |
| `event:hook/result.ignorable` | `property-removed` | `version-bump` |
| `event:llm/retry.ignorable` | `property-removed` | `version-bump` |
| `event:llm/retry-started.ignorable` | `property-removed` | `version-bump` |
| `event:model/selection` | `root-added` | `same-version` |
| `event:permission/preset.ignorable` | `property-removed` | `version-bump` |
| `event:plan/mode.ignorable` | `property-removed` | `version-bump` |
| `event:request/context.ignorable` | `property-removed` | `version-bump` |
| `event:request/header.data.reason` | `union-variants-changed` | `version-bump` |
| `event:request/header.data.startsSeries` | `optional-property-added` | `same-version` |
| `event:request/header.ignorable` | `property-removed` | `version-bump` |
| `event:sandbox/mode.ignorable` | `property-removed` | `version-bump` |
| `event:schedule/change.ignorable` | `property-removed` | `version-bump` |
| `event:session-log-deepseek/delivery-accepted` | `root-added` | `same-version` |
| `event:session/end-seed.ignorable` | `property-removed` | `version-bump` |
| `event:session/title.ignorable` | `property-removed` | `version-bump` |
| `event:session/title-llm-request.data.messages[].source` | `union-variants-changed` | `version-bump` |
| `event:session/title-llm-request.ignorable` | `property-removed` | `version-bump` |
| `event:step/end.ignorable` | `property-removed` | `version-bump` |
| `event:step/start.ignorable` | `property-removed` | `version-bump` |
| `event:subagent/descriptor.data.agentReasoningEffort` | `optional-property-added` | `same-version` |
| `event:subagent/descriptor.ignorable` | `property-removed` | `version-bump` |
| `event:subagent/model-selection-policy` | `root-added` | `same-version` |
| `event:team/member.ignorable` | `property-removed` | `version-bump` |
| `event:team/message/delivered.ignorable` | `property-removed` | `version-bump` |
| `event:team/message/queued.ignorable` | `property-removed` | `version-bump` |
| `event:team/task.ignorable` | `property-removed` | `version-bump` |
| `event:todo/write.ignorable` | `property-removed` | `version-bump` |
| `event:tool-workflow/agent-end.ignorable` | `property-removed` | `version-bump` |
| `event:tool-workflow/agent-start.ignorable` | `property-removed` | `version-bump` |
| `event:tool-workflow/run-end.ignorable` | `property-removed` | `version-bump` |
| `event:tool-workflow/run-start.ignorable` | `property-removed` | `version-bump` |
| `event:tool/call.ignorable` | `property-removed` | `version-bump` |
| `event:tool/code-dispatch.ignorable` | `property-removed` | `version-bump` |
| `event:tool/code-dispatch-start.ignorable` | `property-removed` | `version-bump` |
| `event:tool/result.ignorable` | `property-removed` | `version-bump` |
| `event:turn/end.ignorable` | `property-removed` | `version-bump` |
| `event:turn/start.ignorable` | `property-removed` | `version-bump` |
| `event:user/message.data.source` | `union-variants-changed` | `version-bump` |
| `event:user/message.ignorable` | `property-removed` | `version-bump` |
| `event:web/deepseek-search-llm-request.ignorable` | `property-removed` | `version-bump` |

<!-- persistence-release-changes:end -->

<a id="verification"></a>
## 校验

提取结果已通过规范图、根摘要和全部可达类型摘要校验；仅对历史 surface 事件允许源码原有的可选 `surfaceOp`。仓库内检查从前驱重建每个 tag，核对 before/after、快照覆盖和双语机器声明。

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## 开发备注

无。
