# Agent Note: 按 agent 的工具呈现方式，以及 `ptc` 预设

Status: implemented
Archived: 2026-09-04

[English](2026-08-05-per-agent-tool-presentation.md) | 中文

## 问题

agent preset 已经能按会话组装一个 agent 的工具，却管不了这些工具以何种**形态**抵达模型。PTC mode——一个 `run_code` 工具加一份生成的 TypeScript SDK，用一段程序替代一串调用——此前是宿主 `dsh-tools` 那一行上的部署级 `mode` 字段。一个部署要么所有会话都跑 PTC mode，要么一个都不跑，于是那个显而易见的产品形态（预设选择器里「代码模式」与标准/极简/创造并列）无处安放。

「把 tools 下沉到 agent 平面」这个字面读法行不通。`ctx.tools` 有一批跟不下来的宿主平面消费者：`dsh-agent-loop` 读它私有的调度器 seam，`dsh-apiproxy` 读它的 presenter 来渲染工具卡，每个工具插件都往里注册。按本 stack 自己的规则——只有**所有**消费者一起下沉，服务才能下沉——注册表必须留在原地。

## 决策

把注册表和它的投影拆开。注册表留在宿主平面；**呈现方式**变成它内部按 scope 的状态，与已经住在那里的作用域限制和守卫并列。

`ToolRuntime.presentAs(mode)` 只接受 scoped 上下文，形状照抄 `restrict()`：它通过 `ScopedLayers.effect` 在调用方 scope 的 `ToolLayer` 上写一个单元，因此会随声明它的那个 scope 一起卸载。在随附的 Web 界面里那个 scope 是某个 agent preset 的常驻挂载——`ptc` preset 携带 `tool-presentation` 行——因此一份声明覆盖加入该 preset 的每个 agent，而 `modeFor(scope)` 取作用域链上最近的那份声明。它与 config 的 `mode` 一并解析，后者于是成为「未作声明的 scope」的默认值，而不再是进程级事实。原先决定呈现方式的三处读取——wire schema、可见性视图里的 `run_code` 条目、以及生成的 SDK 段——改为读取该 scope 的模式，而非服务的。

有两个随之而来的结果，且都是承重的：

- **`run_code` 按 scope 追加。** 此前只要传输存在，它就进入每一个视图。按 agent 之后，一个 native agent 不能因为进程里别的 agent 呈现了它、就在自己的分发表里看到 `run_code`——因此这次追加以该 scope 自身的模式为条件，传输也改为首次需要时才构建。
- **保留名现在无条件生效。** `run_code` 此前只在配置了 PTC 模式时才被拒绝注册。如今任何 agent 都可能选择 PTC 模式，因此一个在 native 部署下可以随便占用的名字，会在某个 preset 挂载的那一刻变成冲突。

SDK 提示词段由 PTC 模式的部署全局注册（不变），并由 `presentAs` 额外按 scope 注册一份，后者按名字遮蔽前者。它的正文对 native scope 渲染为空，而提示词渲染器会丢弃空段——正是这一点让「在 PTC 模式部署下选择退出」的 agent 不带 SDK 段。

preset 用一行来表达这个选择：`@deepseek-ai/dsh-agent-tool-presentation`，其全部内容就是一次 `presentAs` 调用。code 类模式通过 `ctx.inject` 等待 `ctx.codeRuntime` 而非假定它存在：运行时在宿主平面，而一个 pending 的行正是 `dsh-agent-presets` 已经会报告的「不可用挂载」并会指名该行——于是在无运行时的部署上选择 PTC mode 的 preset，会在操作者能够动手的地方失败。

## 考虑过的替代方案

**在 preset 的 isolate realm 里再起一个 `ToolRuntime`。** 否决：`dsh-agent-loop` 通过一个私有 symbol 从宿主上下文一次性解析注册表，因此按 agent 的注册表对调度器不可见。把 loop 改成按 agent 解析注册表，远比把一个字段变成 scope 感知的改动大。

**在 preset 自己的 YAML 里加一个顶层键。** 否决，理由与 preset 展示元数据落到独立 `preset.yml` 相同：组装是一个顶层的插件行列表，装不下并列的键。

**把包命名为 `dsh-tool-mode`。** 被一道 gate 否决，而且它是对的。`gen-tool-catalog` 以 `packages/*/tool-*` 通配，并要求每个命中项发布一个面向模型的工具 schema——因为在本仓库里这个前缀就意味着「带工具」。而这一行不带任何工具。

**在构造函数里无条件注册 SDK 段。** 试过之后否决：`renderPrompt` 会丢弃空段，但 `PromptAssembly.sections` 会保留它们，于是每个 native 部署都将携带一个什么也不渲染的 `tools:sdk` 条目，而两处既有断言不得不为此放宽。

**用 include 共享 `standard` 的组装。** 按本 stack 自己的惯例否决：`cordis` 已经复制了一份 `standard`，而 preset 的价值恰在于整份组装能在一个文件里读完。代价——第三份约 240 行、且必须同步演进的副本——是真实的，也正是未来引入 include 机制最有力的论据。

## 后果

同一进程内的两个会话现在可以有不同的呈现方式，因此「模型看到哪些工具」不再能只凭部署配置回答，必须给出 agent。凡是引用模式的诊断信息，现在引用的都是该 scope 的，而不是服务的。

`ctx.tools.schemas(agent)` 仍然是该 agent 的**能力**清单，不受呈现方式影响——坍缩的只是 assembly 里的工具。断言「模型收到什么」的测试必须读 assembly；`web-agent-presets.spec.ts` 对随附的 `ptc` 预设同时断言了这个区分的两侧。

随附的名单变成四个预设（标准/代码/极简/创造），因此任何列出它们的 golden 都会变动。未组装 code 运行时的部署无法组装任何 PTC 模式的 preset；随附的 Web overlay 带了一个，base 组装没有。
