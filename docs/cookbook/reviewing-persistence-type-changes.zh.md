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

阅读报告中的根、路径、变更种类和版本要求。被引用类型可能影响多个事件摘要；检查每个受影响的根。在历史覆盖新 schema 之前，验证会失败。陈旧生成清单也会导致验证失败；记录命令会刷新它。若重排字段或联合类型分支后 `changes` 为空，运行 `pnpm run gen-persistence-catalog` 并重新检查。即使复制的声明或源码位置产生目录 diff，未变的摘要也无需新增确认记录。

<a id="acknowledge"></a>
## 1. 记录变更

编写包含 `en` 和 `zh` 的本地 JSON 文件，两者分别包含 `summary`、`compatibility` 和 `verification` 字符串。以下输入描述一个经过验证的钩子审计字段从必选改为可选的变更。用你所做变更的事实替换说明和测试证据；CLI（命令行界面）不会证明这些声明。

将输入保存为 `.artifacts/persistence-change.prose.json`，必要时创建该被忽略的目录：

```json
{
  "en": {
    "summary": "Makes the persisted hook audit decision optional.",
    "compatibility": "Existing records remain valid. Hook execution consumes HookOutput instead of replaying this audit field. Producers still write decisions, and absence does not imply pass.",
    "verification": "pnpm exec vitest run packages/hooks/hook-protocol/tests/events.spec.ts: 10 tests passed."
  },
  "zh": {
    "summary": "将持久化的钩子审计决策改为可选。",
    "compatibility": "已有记录仍然有效。钩子执行消费 HookOutput，不回放此审计字段。写入方仍然记录决策，缺失不代表 pass。",
    "verification": "pnpm exec vitest run packages/hooks/hook-protocol/tests/events.spec.ts：10 个测试通过。"
  }
}
```

用日期和描述性短名替换示例 id：

```sh
pnpm --silent run persistence-changes --record 2026-09-11-poc-optional --prose .artifacts/persistence-change.prose.json --json
```

命令在写入前验证历史和双语说明、推断最低版本决策，并检查所需的头部版本递增。它生成记录对、完整的变更后 schema、两份目录、机器清单和配对记录。提交前审阅说明及返回的 `changes`、`roots` 和 `files`。省略 `--prose` 会创建未完成草稿，验证将拒绝它们，直到说明补齐。

推断遵循[固定兼容性规则](../persistence-changes/README.zh.md#compatibility-rules)，不会更改源码或放宽规则。需要升版本时，先遵循[添加会话格式版本](adding-a-session-format-version.zh.md)。记录必须包含其自身的 `SessionHeader.version` 递增转换；无关的历史升版本不能授权它。日常变更不创建另一条基线。

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

命令刷新机器声明、schema、目录和配对。没有 `--prose` 时，它保留已有说明。更新会拒绝初始基线和被其他记录依赖的记录。目录本身无法识别哪些记录已获审阅接受：保留已接受历史，并创建后继。

集成产生竞争末端记录时，根据剩余历史更新尚未接受的记录，再重新评估最终差异。无关根的确认无需刷新。[机制决策](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.zh.md)解释为何保留完整快照和逐根前驱。

显式 `--decision` 仍是受检查的断言。若已有属性的值类型发生变化，下面这个故意错误的断言会在写入前失败：

```sh
pnpm --silent run persistence-changes --update 2026-09-11-poc-optional --decision same-version --json
```

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
