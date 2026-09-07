# Agent Note: `/feedback` 命令

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-feedback-command.md) | 中文

## 问题

用户在会话中途发现问题时，没有地方记下这个观察。告诉模型会浪费一个轮次、改变用户原本进行的对话，并把这条评论埋进派生历史，使后续读者无法找到它。写到会话之外则会丢失让它有意义的上下文：属于哪个会话、处于哪个时点、针对哪项工作。

采集接口必须能在用户产生不满的那一刻使用，因此任何需要用户离开交互式客户端的方案都不可行；它还不能扰动正在进行的运行：不消耗模型 token、不产生工作轮次、不改变用户正在等待的请求。

## 决策

位于 `packages/feedback/command-feedback/` 的 `@deepseek-ai/dsh-command-feedback` 通过 `ctx.commands` 注册一个全局 `feedback` 命令。`/feedback <text>` 在确认文本中包含接收反馈的会话 id 与 harness home 的共享匿名用户 id；空输入或仅含空白的输入返回直接用法错误。处理器是同步的，只注入 `commands`，且没有任何配置。[共享 id 决策](../architecture/2026-08-07-shared-feedback-telemetry-user-id.zh.md)说明了反馈与 OpenTelemetry 为何使用同一个 `$DSH_HOME/.anonymous-user-id` 值。

本包声明仅写入日志的 `feedback/record { text }` 会话事件，并导出 `recordFeedback(session, text)`，作为不依赖命令的生产方。该生产方丢弃前后空白，拒绝空结果，并且恰好追加一个事件。`/feedback` 委托给它，因此其他 UI、钩子或 host 集成无需构造斜杠命令也能记录同一个领域事实。

`dsh-commands` 仍会围绕 `/feedback` 写入 `command/run` / `command/done` 生命周期配对，但该命令设置了 `recordInput: false`。因此，它的 `command/run` 携带命令标识与来源，但不携带 `args`；反馈文本只存在于 `feedback/record` 中，而 `command/done` 携带确认结果。三个记录都仅写入日志且非 surface。它们的追加会进入持久化的常规有界写入路径；没有任何环节强制 flush，因此确认文本报告的是反馈已进入日志，而非已经落盘。

采集对正在运行的 agent（智能体）与模型仍不产生后续动作。可选的 OTel 遥测包后续增加了一个基础设施消费方：它在 `FEEDBACK_ONLY` 模式下将 `feedback/record` 作为释放触发器，在 `DISABLED` 模式下将其作为仅限本地的警告触发器，且不改变反馈事件或命令路径。见[反馈门控的会话遥测](2026-08-05-feedback-gated-session-telemetry.zh.md)与[确认文本中的共享披露](2026-08-07-feedback-acknowledgement-sharing-disclosure.zh.md)。

### 为何反馈拥有自己的事件

反馈是领域事实，而 `/feedback` 是一种触发方式。只把载荷保存在 `feedback/record` 中，既让后续触发方式可以使用同一个事件，也让消费方无需依赖命令名或解析命令生命周期记录即可筛选反馈。在该定义中省略 `command/run.args`，可避免同一条人类评价出现两个看起来都具有权威性的副本。

### 为何模型永不看到它

反馈是关于会话的，而不是会话的输入。将其作为 user 消息注入会改变下一次模型请求，与「记录不得扰动运行」的要求相冲突，也会让该评论成为它所评论的那段对话的一部分。`command/run` 与 `command/done` 不属于 `SurfaceEventType`，因此即便出错也无法获得 `surfaceOp` 或进入派生历史。

### 原样文本

前后空白会被丢弃，但除此之外不做解析。`/feedback /plan felt slow` 记录 `/plan felt slow`；开头的 `/plan` 是内容，而非嵌套命令。若采用 `/goal` 那样的控制词语法，对应的字面反馈将无法表达，这与采集接口的目的正好相反。

### 一个新的分组

`packages/feedback/` 是新分组，因为现有分组都不拥有此职责：`goal/` 负责目标状态，`session-title/` 负责标题，`core/` 是产品主干。该分组只包含一个生产方包；跨领域的消费方留在各自所属的分组，而不是迫使这个分组不断膨胀。

## 考虑过的替代方案

**使用 `command/run` 作为反馈记录。** 已否决，因为这会将反馈与一种触发方式耦合，消费方还必须通过命令名识别领域事实。非命令生产方若不伪装成执行命令，就无法创建相同记录。

**同时在 `feedback/record` 与 `command/run.args` 中存储文本。** 已否决，因为同一行为会产生两个没有实质区别的载荷副本。`recordInput: false` 保留通用生命周期，同时让领域事件保持权威性。

**通过 `agent.inject()` 将反馈作为 user 消息注入。** 无需新增事件类型，并复用 `/goal` 变更所走的路径。已否决：它会让反馈对模型可见，从而进入下一次请求、改变正被评论的那次运行并消耗 token——与「不得扰动」要求的三个方面全部冲突。

**让 `/feedback` 成为真正的空操作，什么都不记录。** 这是对「什么都不做」最字面的理解。已否决：这会使命令失去意义——明确的要求是让这条评论进入会话日志。

**在现有包中注册该命令**，例如 `packages/interaction/commands`。可省去新分组及其双语 README。已否决：`ctx.commands` 是注册表，而不是任意命令实现的归属地；且请求者明确要求独立的包。

**从文本中解析结构**（类别前缀、严重程度标记）。已否决，属于投机设计：没有消费方需要该结构，而任何控制词语法都会让对应的字面反馈无法记录。原样文本是未来消费方可以收窄的最宽接口；而已被解析的接口无法事后放宽。

**改为提供面向模型的工具。** 已否决：反馈是人类的直接观察。经由模型会消耗一个轮次、让模型改写用户的原话，并使记录取决于模型是否选择调用该工具。

## 后果

随附的 `dsh` 基础组合无条件挂载该命令：没有配置，也不依赖 goal 栈。Web 客户端通过命令适配器暴露该命令。无头模式、ACP（Agent Client Protocol）和 JSON-RPC 不提供命令适配器，因此 `/feedback` 在那里不可用。对于某个 harness home，首次接受反馈时可能创建 `$DSH_HOME/.anonymous-user-id`；被拒绝的空输入不会获取或创建 id。

本包拥有一个独立的仅追加事件，不存在跨事件关系或可变数据关系可供不变式伴生插件检查。该事件遵循会话日志现有的回放、fork、持久化和崩溃尾部行为。

延期事项：没有产品或模型消费方；没有结构化字段；不支持修改或撤回，因为日志仅追加且本包不新增 tombstone；且没有显式持久化屏障，因此紧临崩溃前记录的条目可能与其他未 flush 的尾部一同丢失。可选的遥测消费方只将该事件作为导出策略触发器。

本次变更按请求者的明确指示不附带无密钥 transcript（文本记录）快照。包测试、基于 `cordis.yml` 的真实 Loader 组合测试，以及随附的 Web 组合测试覆盖注册、采集、模型排除和产品组装。
