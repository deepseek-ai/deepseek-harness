# Agent Note: Web transcript 标出上下文来源、召回与 steering

Status: implemented
Archived: 2026-09-04

[English](2026-08-04-web-context-source-and-steer-marks.md) | 中文

## 问题

生产方向模型侧对话补充的一切内容，进入 Web transcript（文本记录）后只剩两种匿名形态。每一条已记录的非用户 `user/message`——skill（技能）目录、运行时快照、经过对账的 `AGENTS.md` 指令、guard 提示、subagent 汇报、跨会话快照——都塌缩成同一行 `上下文注入`，读者不逐行展开去读原始 JSON 就无从知道究竟注入了什么。steering（中途引导）的情况更糟：它渲染成与开轮提示完全相同的气泡，于是 transcript 无法说明哪一条消息打断了正在运行的轮次。

这些区分本来就是持久事实。每个生产方都必须提供可合并扩展的 `user/message.source` 并在其中注明自己，`agent/inbox/spliced` 则记录有身份的消息进入和离开的是 `next-turn` 还是 `next-step`；把这些事实丢掉的只有呈现层。被这套 Web UI 取代的终端 transcript 本来会写出每张卡片的生产者，因此面对同一份日志，Web 侧是一次倒退。

## 决策

transcript 为非提示消息可能承担的三种角色分别命名：注入上下文、召回会话、steering。

Chat Message Definition 为每个 `ContextMessageNode` 附加一份包含生产者角色和名称的 `provenance` 视图；`contextProvenance()` 仅依据持久来源计算该视图。它返回 `role`（`inject`，跨会话快照则为 `recall`）与命名生产者的 `label`。`ContextInjectionRow` 以角色作为标题，并按 `ToolRow` 摘要的几何在标题旁展示该名称，因此折叠态就已经回答了「注入了什么、由谁注入」；141px 滚动视口与截断上限沿用[已归档的展开项决策](../../archived/feature/2026-07-30-web-context-injection-disclosure.md)，未作改动。视口里渲染什么，则由[上下文形态决策](2026-08-05-context-form-vocabulary.zh.md)引入的、相互独立的形态轴决定。

**名称从日志中读出，绝不来自客户端维护的生产者名称表。** `agent-instructions` 以它对账过的去重指令文件路径命名，`session-reference` 以它读取的会话标题命名，插件来源以其记录的插件 id 命名，其余来源则以自身的 `kind` 命名——这正是可合并扩展联合类型有文档记载的默认分支。没有可读 kind 的来源降级为无名注入。于是新增或重命名的生产者无需客户端发版即可辨识，任何名称都不会相对代码失准，恢复、fork 或来自外部的日志与实时会话的投影结果完全一致。

`recall` 覆盖 `session-reference`，因为它是当前唯一会把另一个会话的材料搬进本会话的已发布来源。没有任何 Web 叶子挂载 `dsh-session-reference`——它此前只有终端宿主——因此该分支的存在是为了日志可移植性，而不是为了某个已打包的生产方，其覆盖来自单元测试而非组装后的 Web 场景。

Chat Inbox 与 Message Definition 会重放持久 `agent/inbox/spliced` 事件；如果一条用户来源的消息以相同身份从 `next-step` 被领取，后续 `user/message` 就投影为 `SteeringMessageNode`。`MessageItem` 为这种持久消息与待处理 steering 气泡加上 `插话` 标注。从排队轮次领取的消息仍是 `UserMessageNode`，非用户来源的 next-step 消息仍是上下文。这推翻了[已归档的取消 steer 入口与插话装饰决策](../../archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md)中的一条结论。当时移除徽章，是因为 composer 无法 steer，标签指向了用户做不到的动作。此后 composer 获得了 Steer 手势，却没有同步修订那份 note；本决策提供了它在「重新引入」条款中要求的产品决策，并订正了其中留下的过时事实。标注是这里唯一的 steering 装饰：composer 模式、Queue dock 的严格 steer 操作、待处理 steering 的生命周期仍归各自的所有者。

## 考虑过的替代方案

**在客户端本地化生产者名称。** 以插件 id 为键的字典读起来确实比 `@deepseek-ai/dsh-system-prompt` 好，但它会在每次重命名时悄悄失准，每新增一个生产者都要改客户端，而且对来自外部的日志根本无法命名。日志已经记录的生产者名称，比客户端自己编造的标签更可靠。

**按来源 kind 注册呈现。** 展开项决策把键控的上下文视图 slot 推迟到出现由来源自有的呈现需求为止。为一行命名并不构成独立呈现，而以「已挂载的生产者」为键的注册表恰恰会在最要紧的地方失效——生产者已不再挂载的恢复日志同样必须渲染出来。

**在 host 侧计算角色与名称。** 那需要为每份事件副本附加一个视图，重复陈述持久来源已经说明的事实，并为每条上下文消息增加一个 wire 字段。改由投影为每个节点计算一次，与 transcript 其他派生事实同处一地。

**给 steering 独立的行而非带标注的气泡。** steering 是一条在轮次中途抵达的用户消息；独立行形会打断右对齐的阅读节奏，并且要为零新增信息重复气泡上的复制与分支操作。

**把同一套名称扩展到 trajectory 表格。** 不在本次范围内：该表格的上下文单元格有自己的文本推导，而 issue 要求的是对话面。

## 测试

- `packages/client/runtime` 单元覆盖钉住每种来源类型、名称字段缺失／为空／类型不符时的回退、来源没有可读 kind 时的无名降级，以及 reset 和实时 append 路径上的 steering 重建。
- `packages/client/ui-conversation` 的 jsdom 覆盖钉住角色标题、标题旁的生产者名称、展开后该名称的留存，以及无角色标题栏。
- 无密钥的组装 Web 预期输出携带带名称的标题栏，因此，这些标识也在组装后的 transcript 中得到验证，而不只经过了组件测试。

## 后果

- **部分被取代。** 决策中的 steering 标注条款已不再描述 master：[标注移除决策](../simplification/2026-08-10-web-remove-steering-interjection-caption.zh.md)删除了 `插话` / `Interjection` 标注，轮次中途的 steer 只能靠它在消息流中的位置辨认。决策中的上下文来源与召回命名仍然有效，`SteeringMessageNode` 投影未变。
- 读者一眼即可归因 transcript 中每一条非提示消息；即便面对本客户端版本从未见过其生产者的日志，标题栏依然如实。
- 只要来源仅携带插件 id，UI 中的生产者名称就呈现为包名形态（`dsh-tool-skill`、`@deepseek-ai/dsh-system-prompt`）。这是拒绝客户端名称表的代价；想要更好标签的生产者必须在来源字段中记录该标签。
- `ContextMessageNode` 增加了一个必填字段，因此每一处构造该节点的代码——包括测试 fixture（测试前置数据）——都必须提供它。
- 即使 agent loop（智能体循环）现在把已经接纳的 steering 记录为 `user/message`，`SteeringMessageNode` 仍是独立的呈现节点；它的身份来自持久 inbox 历史，而不是独立消息事件。
- 在某个宿主挂载 `dsh-session-reference` 之前，`recall` 分支在已发布的 Web 叶子中没有生产者，只能通过别处写入的日志抵达。
