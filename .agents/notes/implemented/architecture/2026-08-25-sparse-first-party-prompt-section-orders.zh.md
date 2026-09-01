# Agent Note: 集中管理稀疏的 first-party 提示词段顺序

Status: implemented

[English](2026-08-25-sparse-first-party-prompt-section-orders.md) | 中文

## 问题

仓库自带的系统提示词段分散在二十多个包中，各自声明互不关联的数字字面量。主要工具序列连续占用 100 到 117，后续插入还使用半步数值。因此，后续更改可能在无法看到完整分配表的情况下与已有段发生冲突。

相同 order 依赖 JavaScript 稳定排序，使插件激活顺序成为实际的平局规则。[Cordis／workflow 提示词顺序修复](../../archived/bug-fix/2026-08-24-system-prompt-section-order-ties.md)表明，完整且有效的组合可能按不同顺序激活同一组插件，进而产生不同的请求 header 和快照结果。局部修复一次冲突，无法阻止另一个包再次使用同一数值。

此外，shell 指导位于文件系统指导之后，但 shell 命令具有最广泛的执行和失败语义。模型应先读到 shell 结果义务，再阅读将文件操作分流到专用工具的更窄指令。

## 决策

`@deepseek-ai/dsh-system-prompt` 持有仓库提示词段与 runtime context 的私有具名分配。每个仓库贡献方通过 `ctx.systemPrompt.getSectionOrder(name)` 或 `getContextOrder(name)` 向活跃服务查询经过类型约束的位置，而不再导入值或声明数字字面量。段的值是互不相同的整数，相邻已分配段值之差至少为十；context 值则在自己的独立序列中保持唯一整数。

除两项有意调整外，该分配保留既有 first-party 顺序：Bash，或 Windows 组合中的 PowerShell，位于逐工具指导的首位；原先共享 order 的段获得明确顺序。分组如下：

| 分组 | 条目 |
|---|---|
| 产品开场 | `harness:identity` −1000、`harness:source` −900、`app:web-surface` −800、`deployment:persona` 0 |
| 工作模式 | `plan:policy` 500、`team:policy` 600 |
| 调用前置说明 | `tools:ptc-only` 800、`context:file-reference` 900 |
| 本地工具 | `tool:bash` 1000、`tool:pwsh` 1010、`tool:read` 1100、`tool:write` 1200、`tool:edit` 1300、`tool:glob` 1400、`tool:grep` 1500、`tool:jobs` 1600、`tool:pty` 1700 |
| 高层工具 | `tool:web_search` 2000、`tool:web_fetch` 2100、`tool:lsp` 2200、`tool:session-query` 2300、`tool:goal` 2400、`tool:cordis` 2500、`tool:workflow` 2600、`tool:ralph` 2700、可继续运行的 subagent 指导 2800 |
| 生成协议 | `tools:sdk` 5000 |
| 最终输出义务 | 可交付文件引用 9000、`tool:structured_output` 9900 |

Runtime-context 分配为 `SANDBOX_POLICY` 110、`APPROVAL_POLICY` 115 与 `SUBAGENT_DELEGATION` 120。

`SystemPrompt.assemble()` 比较 `order` 后，按提示词段名称的代码单元顺序排列同号项。这样无需使用受区域设置影响的比较，也能让第三方冲突产生确定结果。first-party 贡献方仍使用不同 rank，其预期顺序由分配表明确表达，而不依赖兜底规则。

动态 `PromptContext` 顺序与工具 schema 的 `toolOrder` 是独立序列。Prompt context 使用服务持有的独立 context 分配，工具 schema 则继续由 `toolOrder` 管理。带作用域的 `deployment:persona` 仍会在段排序之前按名称遮蔽全局段，并通过服务解析同一个 `DEPLOYMENT_PERSONA` 位置。

## 验证

系统提示词单元测试通过服务解析每个已配置的 section 与 context 名称。它验证数值为整数且互不重复、相邻 section 值至少相差十，并验证顺序相反的两种同号注册排列得到相同的代码单元名称顺序。真实组合快照固定面向模型的顺序，包括 Bash 位于文件系统指导之前，以及 Cordis、workflow、Ralph、subagent 和 report 的明确序列。

## 考虑过的替代方案

**保留包内数字字面量并通过评审人工检查冲突。**未采用，因为贡献方无法在局部看到完整分配表，而且早期修复合入后，触发该修复的同类冲突再次出现。

**继续插入小数值。**未采用，因为小数没有持久的间距规则，难以表达语义分组，也无法阻止无关包选择同一数值。

**只规范化快照比较。**未采用，因为运行时请求 header 和模型提示词仍依赖激活顺序，测试只会隐藏差异。

**同 rank 时保留激活顺序。**未采用，因为激活顺序不是提示词顺序决策，并且会在有效组合之间变化。名称顺序为外部冲突提供确定结果；具名位置负责表达 first-party 意图。

**把动态 context 与工具 schema 放进 section 分配。**未采用，因为运行时独立组装这些序列。Context 使用自己的具名服务分配；把任一序列与 section 合并都会暗示运行时并不执行的跨序列顺序。

## 后果

数字 rank 不会被渲染，因此单纯重新编号不会改变模型文本。Bash 或 PowerShell 会移到其他逐工具指导之前，原先同号的段会获得确定顺序；这些面向模型的变化会更新请求 header 快照，并可能从第一个移动的段落起使提供方前缀复用失效。

外部插件可以为自己的 section 或 context 选择任意有限数字 order。具名 order 查询属于仓库内部位置，而不是扩展 API。外部 section 仍可使用相同 rank，并会按名称获得确定顺序。

系统提示词包现在了解仓库功能的名称和相对位置。这种集中耦合是有意的：注册表本就拥有排序语义，而分散的数字字面量只是让同一关系变得隐式且无法检查。
