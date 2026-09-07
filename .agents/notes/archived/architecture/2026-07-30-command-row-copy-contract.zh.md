# Agent Note: 命令条目文案分别由条目与 handler 负责

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-command-row-copy-contract.md) | 中文

## 问题

Web 命令条目由一对落库的[命令生命周期事件](../../proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)渲染出 `标题 · 摘要`：标题是由 `command/run` 重建的分派命令行（`/permission workspace-write`），摘要是 `command/done` 的原样 `text`（`Permission preset: workspace-write.`）。两半各自成文、互不知情，于是一行里命令名出现两次、参数也出现两次——最糟的一例正是用户每次用 Access chip 切换权限时得到的那一行。

## 决策

命令条目两半的职责互不重叠，各自只按自己那一半来写。

行标题就是裸命令名——没有 `/`，也没有参数。`/` 属于编辑器的输入语法，不属于一条已落定的记录；参数也不该由这一行来报告：摘要已经说清了这条命令做了什么。对于 `command/run` 那一页已滑出客户端窗口的跨窗口节点，`GenericCommandCard` 仍保留 `命令` 兜底标题。

因此，命令 handler 的落定 `text` 绝不用命令自身的名字给自己的值加标签——渲染它的界面已经说过一次了。`/permission` 返回 `preset workspace-write`，裸调用时返回 `current preset workspace-write (available: …)`，参数非法时返回 `unknown preset "bogus" (available: …)`。作为一行读是 `permission · preset workspace-write`；作为独立一句读——TUI 把同一段 text 作为通知追加——它依然说明了当下生效的是哪个预设。

这条规则禁的是*标签*，不是用词。`Permission preset: workspace-write.` 之所以出局，是因为 `Permission preset:` 是给一个值加的题头，而这个题头正是标题本身。恰好含有命令名的领域名词不是题头，因此保留：`/plan` 仍返回 `Plan mode off.` 与 `Plan mode on. Use /plan off to leave.`（`plan · Plan mode off.` 说的是那个模式，句尾是一条指引，不是回声），`/goal` 仍返回 `Goal cleared.`。真正被这条规则拦下的，是 handler 在自己的值前面写出 `<命令名> <名词>：` 的那一类。

日志本身未变：`command/run` 保留结构化的 `name`／`args` 拆分，因此更丰富的已注册命令条目仍可从同一个节点渲染参数，无需第二条数据通道。

## 考虑过的替代方案

**保留分派命令行作标题，只缩短落定文案。** 参数仍会出现在分隔点两侧（`permission workspace-write · preset workspace-write`），而这正是被指出的重复。

**从折叠行中去掉落定文案，而不是去掉参数。** 这颠倒了这一行的价值：持久记录存在的意义就是结果，而错误文案将无处落脚。

**由这一行从落定文案里剥掉开头的命令名。** 呈现层会悄悄改写 handler 写就的文案，而任何换一种措辞表达结果的 handler 都会让这套启发式失效。

**彻底禁止命令名出现在自己的落定文案里，并把 `/plan`、`/goal` 一并改写。** 这种更宽的禁令代价大于收益：无论在行上还是作为独立的 TUI 通知，`Plan mode off.` 与 `Goal cleared.` 都是这些结果最清楚的句子，而满足「禁名字」所需的缩短形式（`off.`、`cleared.`）读起来只是残句。值得去掉的冗余是题头。

## 后果

每一条命令条目都变短了，而且这条规则可扩展：新命令的作者写结果时无需知道由哪个界面渲染，任何界面也都不必再去重。代价是分派参数离开了折叠行——命令仍在执行时，行上只有名字和 `执行中…`——以及「不加题头」这条规则是靠评审执行的约定，而非门禁。`/permission` 的文案由 permission 包的命令测试钉住，装配后的行文案由 [seeded-history](../../../../snapshots/web/seeded-history/command-row.expected.md) web 预期输出钉住：由于 `/permission` 完全在 host 上执行，该预期输出无需密钥即可覆盖一条真实的已落定命令条目。
