# Agent Note: 通过自动化会话接入 IM

Status: implemented

[English](2026-10-12-im-automation-sessions.md) | 中文

IM 已不再随附专用 profile、按聊天会话、任务 worker、单次命令示例或轮次渲染器：该决策记录在 [IM 以实验性组合包运行一个共享会话](../simplification/2026-10-28-im-shared-session-minimal-plane.zh.md)；下文涉及这些插件的部分描述的是它们当时遵循的设计。

关于当前 `@deepseek-ai/dsh-experimental-im` 与 `session-conversations`、`session-commands`、`session-tasks` 及各输出渲染器之间的宿主与插件拆分，见 [v4 中的 IM 架构](2026-10-25-im-architecture-v4.zh.md)。

## Problem

IM 同时包含延迟输入、多个参与者、消息引用和平台重投。一项任务可以消费多条消息，而不逐条发布答复。将每条消息作为 GUI 提示词、每条 assistant 回复作为平台答复，会把输入调度与发布耦合。

## Decision

IM 通过现有 agent 工厂、收件箱、预设和持久化 API 托管持久化会话，并允许会话将多步骤工作委派给后台任务 worker 会话。agent-loop 与核心 Session 类别保持不变。[IM 服务](../../../../packages/experimental/im/README.zh.md) 接纳外部上下文并提供用于读取和发布的[显式工具](../../../../packages/experimental/im/src/tools.ts)；[IM profile](../../../../packages/experimental/im-bundle/README.zh.md) 通过 `dsh` 启动完整应用。

来源接纳、写权限、投递模式、模型路由、工作目录和预设均由部署显式配置。`dsh-im-session-conversations` 为每个已接纳聊天派生一个会话（`conversation:<chatKey>`），简短问题直接回答，多步骤工作通过 `dsh-im-session-tasks` 委派给后台任务 worker。每个任务创建一个顶层 worker 会话（`task:<id>`），默认继承所属会话的组合配置，并在触发消息所在的聊天（及话题线程）中作答。所属会话使用 `task_list` 和 `task_message` 查看并向任务发送补充指令，worker 以 `done` 或 `failed` 调用 `task_update` 时会向所属会话注入完成或失败通知。

传输层使用内置的 Satori 包（`plugin-im-core`、`satori-element`、`plugin-im-adapter-lark` 与 `plugin-im-adapter-qq`）。[vendor 清单](../../../../vendor/README.md) 记录准确的上游版本与本地修改。生成的飞书类型声明不提交到 Git，在安装阶段从经过哈希校验的固定源码生成。

## Durability and ownership

每个托管会话由单个服务实例持有对应的活动 `Agent`。`im_sessions` 存储域记录每个托管会话的归属方、组合配置与聊天绑定，并拒绝已在 IM 存储之外存在的会话 id。`im_messages` 在向平台返回 ACK 前记录外部事件摘要与消息记录。确定性的收件箱消息 ID（`deliveryMessageId`）与 Session 日志核对保证了跨重启恢复时不会向收件箱重复写入消息。

带 `operationId` 的发送操作在发出网络请求前先向 `im_receipts` 写入 `pending` 状态，并在收到结果后更新回执。使用相同 `operationId` 重放会直接返回已记录的回执而不会重复发送。平台明确返回未发布的错误码时记录为 `failed`；响应丢失、超时或发出后崩溃则记录为 `uncertain`，绝不自动重发。

`im` 消息来源仅作为归属元数据使用（见[兼容性记录](../../../../docs/persistence-changes/2026-10-28-im-message-source.zh.md)）。权限校验由运行中的 IM 服务负责，现有沙箱与审批策略继续生效。

## Alternatives considered

**通过 Host 控制器增加 GUI 客户端。** 这种方式适合文本记录镜像与类型化交互控件，但会引入自动化不需要的对话策略和输出耦合。IM 直接使用 agent 工厂，并保留现有循环。

**在 IM 与 harness 之间使用 ACP。** ACP 支持持久化程序会话，适合进程隔离。独立 IM 发布仍然需要渠道或工具路径；进程内 Cordis 组合在保留自动化语义的同时避免增加进程。

**按聊天手工配置固定会话。** 手工命名每个会话及其来源意味着每新增一个聊天都要修改配置并重启。为每个已接纳聊天自动派生会话可将访问控制保留在来源规则中，无需逐个聊天配置。

**以子智能体作为委派工作的单位。** 子智能体归属于父会话当前轮次的激活周期，其生命周期与结果投递跟随父轮次。聊天中的后台任务需要跨越发起它的轮次持续运行并支持中途补充指令，因此后台任务设计为 IM 托管的顶层会话，拥有独立的任务记录和状态。worker 内部仍可使用子智能体。

**自动重试不确定的发送。** 响应丢失时无法判断平台是否已经创建了消息。保留 `uncertain` 状态供检查可避免自动重复发送，同时允许通过新的工具调用主动重发。

## Consequences

每组 IM 存储和会话由单个主机进程负责，多主机协调需要独立设计。托管会话在首次使用后常驻内存（标记为 `ephemeral` 的临时会话除外，它们在首轮结束后释放 agent）。有限的保留期（`retentionMs`）限定了事件去重窗口，待处理消息和未决回执不会自动过期。恢复投递时扫描 Session 日志核对收件箱消息 ID 会使恢复耗时随会话历史增长。
