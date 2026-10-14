---
description: "在创建 PR 前，本地生成、确认并验证会话持久化类型变更。"
---

# 实操手册：审阅持久化类型变更

[English](reviewing-persistence-type-changes.md) | 中文

## 概述

在已安装依赖的贡献者检出目录中修改会话持久化类型声明后，使用本教程。提供双语兼容性说明，再用一条命令分类变更并生成记录。[记录参考](../persistence-changes/README.zh.md)解释文件和自动规则。所有比较输入都在检出目录中；不需要基线分支或网络访问。

## 目录

- [可选：检查变更](#generate)
- [1. 记录变更](#acknowledge)
- [2. 检查、提交并推送](#verify)
- [更新尚未接受的记录](#competing-records)
- [开发备注](#dev-note)

-----

<a id="generate"></a>
## 可选：检查变更

若需在记录前预览，在仓库根目录运行：

```sh
pnpm --silent run verify-persistence-changes --json
```

消费 JSON 时使用 `--silent`：否则 pnpm 会把生命周期失败文本追加到标准输出。失败命令仍以退出码 1 结束。

阅读报告中的根、路径、变更种类和兼容性评审要求。被引用类型可能影响多个事件摘要；检查每个受影响的根。在历史覆盖新 schema 之前，验证会失败。陈旧生成清单也会导致验证失败；记录命令会刷新它。若重排字段或联合类型分支后 `changes` 为空，运行 `pnpm run gen-persistence-catalog` 并重新检查。即使复制的声明或源码位置产生目录 diff，未变的摘要也无需新增确认记录。

要独立于确认历史评审 PR，先将 base 和 head 的目录保存为本地 JSON 文件，再运行：

```sh
pnpm --silent run persistence-review --before .artifacts/base.schema.json --after docs/persistence-schema.json
```

记录决策不会使转换从此比较中消失。`--check` 仅比较当前源码与已确认历史；记录完成后，它不能替代 base/head 评审，也不能证明人类已评审该变更。

在报告旁记录这些文件对应的 commit。添加 `--json` 可获取结构化输出。此只读比较将共享变更与受影响的根类型归组，使用实际字面量 `kind`/`form` 值代替联合类型位置。无法唯一匹配的候选项保留为独立的新增与删除。兼容性部分复制每个根类型的权威分类结果；结构说明不替代确认检查。当前目录标签和声明名称是描述元数据；结构锚点和指纹标识类型。

当前机器清单在 `roots` 中保存完整图。每个 `types` 条目包含 `digest`、`names` 和 `sources`；若根无法精确重建该图，条目还会保存显式 `schema`。读取器按摘要从根的子图恢复省略的图，并直接验证显式图，保留每个类型及其元数据。历史完整条目仍然可读。`formatVersion` 标识规范化规则；存储压缩不改变根指纹，也不需要确认记录。

<a id="acknowledge"></a>
## 1. 记录变更

先检查[已接受基线](../session-format-status.zh.md#finalization-record)，保留其锁定记录。按[兼容性规则](../persistence-changes/README.zh.md#compatibility-rules)评估两个读取方向。若有安全解释或拒绝的证据，结构差异可以保留同一版本，不会自动要求更高的写入器版本。

编写包含 `en` 和 `zh` 的本地 JSON 文件，两者分别包含 `summary`、`compatibility` 和 `verification` 字符串。以下输入描述一个经过验证的钩子审计字段从必选改为可选的变更。用你所做变更的事实替换说明和测试证据；CLI（命令行界面）不会证明这些声明。

将输入保存为 `.artifacts/persistence-change.prose.json`，必要时创建该被忽略的目录：

```json
{
  "en": {
    "summary": "Makes the persisted hook audit decision optional.",
    "compatibility": "Existing records remain valid. Hook execution consumes HookOutput instead of replaying this audit field. Producers still write decisions, and absence does not imply pass.",
    "verification": "pnpm exec vitest run packages/experimental/hook-protocol/tests/events.spec.ts: 10 tests passed."
  },
  "zh": {
    "summary": "将持久化的钩子审计决策改为可选。",
    "compatibility": "已有记录仍然有效。钩子执行消费 HookOutput，不回放此审计字段。写入方仍然记录决策，缺失不代表 pass。",
    "verification": "pnpm exec vitest run packages/experimental/hook-protocol/tests/events.spec.ts：10 个测试通过。"
  }
}
```

用日期和描述性短名替换示例 id：

```sh
pnpm --silent run persistence-changes --record 2026-09-11-poc-optional --prose .artifacts/persistence-change.prose.json --json
```

命令在写入前验证历史与双语说明、推断已明确允许的同版本决策，并检查显式兼容性决策。它生成记录对、完整的 after schema、两个目录、机器清单与配对记录。提交前检查说明及返回的 `changes`、`roots`、`files`。省略 `--prose` 会生成未完成草稿；说明填写完成前，验证会拒绝它们。

对于标为 `requiresCompatibilityReview` 的变更，在确认记录的兼容性部分说明两个方向的读取器行为，并在验证部分记录已执行的检查。证据支持保持版本时，提供 `--decision same-version`；记录或更新被标记的变更时，若头版本未变且缺少显式决策，会以 `decision-required` 失败。仅凭结构差异不会推断升版本。实际头版本递增可以推断出 `version-bump`。若有效判别信息无法阻止不安全解释，遵循[添加会话格式版本](adding-a-session-format-version.zh.md)，并选择 `--decision version-bump`。该记录必须包含自身的 `SessionHeader.version` 递增转换；无关的历史升版本不能授权它。日常变更不创建另一条基线。

<a id="verify"></a>
## 2. 检查、提交并推送

根据[测试政策](../testing.zh.md)选择变更所属模块的行为检查，再运行文档检查：

```sh
pnpm run doc-sync
```

`doc-sync` 检查持久化清单和目录新鲜度、完整历史及双语配对。记录命令的 `ok: true` 不能替代这些检查，也不能替代所属模块的行为与迁移测试。JSON 失败响应保留 `ok: false`、诊断 `code` 和退出码 1。结构化变更包含稳定种类和逐根的变更前后摘要，自动化无需解析描述文本。

记录生成负责其目录和记录的双语对；包 README 或其他双语页面的编辑仍遵循常规配对流程。审阅并暂存预期差异，然后正常提交和推送。暂存 lint、配对、空白 hooks，以及 pre-push Host/Client 类型检查仍须执行。

<a id="competing-records"></a>
## 更新尚未接受的记录

记录后源码再次变化时，审阅兼容性说明，并刷新同一条尚未接受的末端记录：

```sh
pnpm --silent run persistence-changes --update 2026-09-11-poc-optional --prose .artifacts/persistence-change.prose.json --json
```

命令刷新机器声明、schema、目录和配对。没有 `--prose` 时，它保留已有说明。根据完整转换重新评估说明，并为任何被标记的同版本更新提供 `--decision same-version`。更新会拒绝初始基线、其他记录所依赖的记录，以及已被定稿检查点锁定的记录。定稿检查点之外，目录不会推断审阅接受状态：保留已接受历史，并创建后继。

集成产生竞争末端记录时，根据剩余历史更新尚未接受的记录，再重新评估最终差异。无关根的确认无需刷新。[机制决策](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.zh.md)解释为何保留完整快照和逐根前驱。

若已有属性的值类型变化需要评审，先修改说明文件中的兼容性与验证部分，解释实际的新转换及已执行检查。不要为不同变更复用先前必选改可选的说明。然后使用该说明与显式同版本选择更新记录：

```sh
pnpm --silent run persistence-changes --update 2026-09-11-poc-optional --decision same-version --prose .artifacts/persistence-change.prose.json --json
```

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
