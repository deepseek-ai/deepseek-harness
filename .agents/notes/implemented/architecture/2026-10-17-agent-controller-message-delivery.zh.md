# Agent Note：经 Agent 控制器投递来自 Agent 外部的消息

Status: implemented

[English](2026-10-17-agent-controller-message-delivery.md) | 中文

## 问题

插件需要借助 Host 侧的上下文，判断别人发来的一条消息现在能否进入 Session。实验性的 forge 面板必须在第一条消息到达 Agent 之前建好所请求的工作树，并在 Session 的工作树被删除后拦下消息。Host 此前没有做这个判断的位置：`session/prompt` 同步地把提示词追加进 Agent 收件箱，而所有发送方都会经过的唯一扩展点 `agent/pre-step` 运行在收件箱接受消息、客户端已显示为已发送之后。pre-step 拒绝会结束本轮，却不会把消息退回给发送方；排队的消息也要等到它的轮次开始才会到达 pre-step。最初尝试的 Web 输入框闸门拿不到 Host 上下文，其他客户端也都会绕过它。

## 决策

core 包 `dsh-agent-controller` 负责来自 Agent 外部的消息如何进入其收件箱。base 组合包把它挂载为 `ctx.agentController`，因此每个基于 base 的 profile 都能经它投递；`dsh-agent` 与 `agent-loop` 的收件箱方法保持不变。

| 部分 | 约定 |
|---|---|
| 入口 | `ctx.agentController.deliver(agent, { mode, source, signal, prepare, beforeInsert })` 准备内容、构造消息、向 `agent-controller/admission` waterfall 要一个 `AdmissionDecision`，检查发送方是否取消、Agent 是否仍在注册表中，调用 `beforeInsert`，再调用 `followup()` 或 `steer()`，消息进入收件箱后返回消息 id |
| 发送方的工作 | `prepare` 在该 Agent 的投递顺序内把发送方的内容转成持久的消息内容；可选的 `beforeInsert` 紧挨在放入之前同步运行，用于必须先于 Agent 唤醒完成的登记 |
| 监听器 | 按注册顺序运行，按 Agent 作用域过滤，拿到 Agent、消息和一个在发送方取消或控制器停止时中止的信号；返回 `next()` 的决定即放行，在 `next()` 前 await 即暂留，返回 `{ kind: 'reject', reason, message, presented }` 即拒绝且不再询问后面的监听器；只在检查本身执行失败时抛出异常 |
| 投递方式 | 留在发送方，监听器看不到，因为目前没有按投递方式区分的准入策略 |
| 顺序 | 同一个 Agent 的消息按到达顺序逐条准备、决定并放入；在放入之前取消的发送方不会被接纳，并立即结束等待，即使排在被暂留的消息之后；销毁控制器会停止所有尚未进入收件箱的消息，并在这些投递结束后才完成 |
| 失败 | 拒绝时抛出带其 reason 与 `presented` 的 `AgentAdmissionRejected`，它是 code 为 `AGENT_ADMISSION_REJECTED` 的 `HarnessError`；发送方按这个 code 而不是按类识别拒绝，对本包只导入类型；监听器抛出异常时 reason 为 `agent-controller/admission-failed`，Agent 离开注册表时为 `agent-controller/agent-gone`；`prepare`、`beforeInsert`、`followup()` 与 `steer()` 的错误原样抛出；消息进入收件箱之后不再有监听器运行 |

只有代表他人送来工作的发送方调用 `deliver()`。Agent 自身机制产生的消息，例如后台任务结果、goal 轮次、plan 切换和问题答复，继续使用 `followup()`、`steer()` 与 `inject()`：它们属于已经接纳的工作。消息来源无人值守时（例如定时任务或 webhook），监听器不得等待人来处理，只能放行或拒绝。

`presented` 告诉交互式客户端，拒绝它的插件会在自己的界面里给出说明，客户端因此不再追加通用提示。

Web Session Remote 首先接入控制器。`session/prompt` 自己解析或恢复 Agent、确认重复的 `requestId`，再调用投递：`prepare` 按 Session 模型检查图片输入、解析上传凭证并存储附件，`beforeInsert` 把凭证绑定到该请求。它把拒绝映射为带 `reason` 与 `presented` 的 `session/prompt-rejected`。监听器暂留消息期间调用保持未完成，客户端取消会让它停止。SDK 服务端、ACP、headless 运行、定时任务、webhook 与子代理提示词在后续改动中改用 `deliver()`，各自把拒绝映射到自己的协议。在此之前，必须覆盖它们的插件仍保留一个 `agent/pre-step` 检查。

请求去重留在 Session Remote。它同步读取 Session 历史，而[同步读取决策](2026-09-09-deprecate-synchronous-session-event-reads.zh.md)禁止把这类读取复制到新的生产代码；等有投影记录已接收的请求 id 后，控制器才能接管去重。

Web 客户端保留现有的回显方式：Enter 立即清空 composer 并显示消息；拒绝在客户端表现为一次普通的提示词失败，回显撤下，草稿回到 composer，除非期间已经输入了新内容。

## 备选方案

- **在 `dsh-agent` 里加接纳阶段。** `ctx.agents.admit()` 加 `agent/admission` 事件同样能覆盖所有发送方，但它把投递职责和一个新扩展点加进了 Agent 核心，而 Agent 的约定由循环实现。组合在 base 组合包里的独立包能覆盖同样的发送方，又不改变这项约定。
- **Session Remote 自己的事件，或 Session Controller 内部的一层。** 它适合 Web 路径，但 Session Controller 只在 Web profile 中组合，ACP、SDK 与 headless 发送方永远无法使用它。
- **`agent/pre-step`。** 它覆盖所有发送方，但运行在收件箱接受消息、客户端显示为已发送之后；拒绝会丢掉消息而不是退回；排队的消息要到轮次开始才会被检查。
- **让 `followup()` 与 `steer()` 异步并经过闸门。** 每个内部发送方都会经过为外部输入准备的监听器，而它们的调用方依赖同步入队。
- **Web 客户端的输入框闸门。** 它拿不到 Host 上下文，其他客户端和 `ctx.conversation.send` 都会绕过它。
- **在最内层步骤放入消息，并以抛出异常表示拒绝。** 监听器能在 `next()` 返回、消息已进入收件箱之后继续执行，但这项没有监听器使用的能力带来三处特殊处理：放入之后的监听器失败只能记录日志；要把收件箱自身的拒绝与监听器失败区分开；另一个模块副本抛出的错误类需要按结构识别。返回决定让这个阶段和 `agent/pre-step` 一样只做决定；需要对已接纳消息作出反应的插件监听 `agent/inbox/inserted`。

PR #3854 中的 liveshare 方案也引入过一个接纳钩子，用于调用方身份。[Peer principals](2026-10-12-peer-principal-and-remote-access.zh.md) 取代了它；本阶段判断 Agent 现在能否接收一条消息，与发送者是谁无关。

## 影响

- 监听器暂留一条消息时，同一 Agent 之后的消息都要等待；其他 Agent 不受影响。
- 监听器暂留一条 Web 提示词期间，客户端已经显示其回显；随后被拒绝时，回显撤下，草稿回到 composer。
- `prepare` 在决定之前存储附件，因此被拒绝的提示词可能留下一个无人引用的已存附件。
- 图片提示词在 Session Remote 的图片接纳链内投递，因此监听器暂留图片提示词期间，切换模型要等待。
- 在所有外部发送方都改用 `deliver()` 之前，这个阶段还不是完整的强制执行点。
