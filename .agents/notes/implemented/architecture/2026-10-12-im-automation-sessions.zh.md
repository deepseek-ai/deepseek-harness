# Agent Note: 通过自动化会话接入 IM

Status: implemented

[English](2026-10-12-im-automation-sessions.md) | 中文

## Problem

IM 同时包含延迟输入、多个参与者、消息引用和平台重投。一项任务可以消费多条消息，而不逐条发布答复。将每条消息作为 GUI 提示词、每条 assistant 回复作为平台答复，会把输入调度与发布耦合。

## Decision

IM 通过现有 agent 工厂、收件箱、预设和持久化 API 托管持久化会话，并由插件决定被接纳的消息进入哪个会话。agent-loop 与核心 Session 类别保持不变。[IM 服务](../../../../packages/experimental/im/README.zh.md) 接纳外部上下文并提供用于读取和发布的[显式工具](../../../../packages/experimental/im/src/tools.ts)；[IM 组合包](../../../../packages/experimental/im-bundle/README.zh.md) 把服务与各适配器作为 Host 条目插入已有的 profile。

来源接纳、写权限、投递模式、模型路由、工作目录和预设均由部署显式配置：`sources` 规则决定哪些聊天可以进入宿主以及其消息如何入库，`defaultDispatch` 组合出所有未被处理且提及机器人的消息都会进入的那个会话。所有聊天共享该会话的历史，因此需要按聊天隔离历史或后台 worker 的部署，改为在 `im/message` 事件链上挂载自己的插件。

传输层使用内置的 Satori 包（`plugin-im-core`、`satori-element`、`plugin-im-adapter-lark` 与 `plugin-im-adapter-qq`）。[vendor 清单](../../../../vendor/im/README.md) 记录准确的上游版本与本地修改。生成的飞书类型声明不提交到 Git，在安装阶段从经过哈希校验的固定源码生成。

## Durability and ownership

每个托管会话由单个服务实例持有对应的活动 `Agent`。`im_sessions` 存储域记录每个托管会话的归属方、组合配置与聊天绑定，并拒绝已在 IM 存储之外存在的会话 id。`im_messages` 在向平台返回 ACK 前记录外部事件摘要与消息记录。确定性的收件箱消息 ID（`deliveryMessageId`）与 Session 日志核对保证了跨重启恢复时不会向收件箱重复写入消息。

带 `operationId` 的发送操作在发出网络请求前先向 `im_receipts` 写入 `pending` 状态，并在收到结果后更新回执。使用相同 `operationId` 重放会直接返回已记录的回执而不会重复发送。平台明确返回未发布的错误码时记录为 `failed`；响应丢失、超时或发出后崩溃则记录为 `uncertain`，绝不自动重发。

`im` 消息来源仅作为归属元数据使用（见[兼容性记录](../../../../docs/persistence-changes/2026-10-28-im-message-source.zh.md)）。权限校验由运行中的 IM 服务负责，现有沙箱与审批策略继续生效。

## Alternatives considered

**通过 Host 控制器增加 GUI 客户端。** 这种方式适合文本记录镜像与类型化交互控件，但会引入自动化不需要的对话策略和输出耦合。IM 直接使用 agent 工厂，并保留现有循环。

**在 IM 与 harness 之间使用 ACP。** ACP 支持持久化程序会话，适合进程隔离。独立 IM 发布仍然需要渠道或工具路径；进程内 Cordis 组合在保留自动化语义的同时避免增加进程。

**按聊天手工配置固定会话。** 手工命名每个会话及其来源意味着每新增一个聊天都要修改配置并重启。由 `sources` 与 `defaultDispatch` 组合出的单个会话即可把访问控制保留在来源规则中，无需逐个聊天配置。

**自动重试不确定的发送。** 响应丢失时无法判断平台是否已经创建了消息。保留 `uncertain` 状态供检查可避免自动重复发送，同时允许通过新的工具调用主动重发。

## Consequences

每组 IM 存储和会话由单个主机进程负责，多主机协调需要独立设计。托管会话在首次使用后常驻内存（标记为 `ephemeral` 的临时会话除外，它们在首轮结束后释放 agent）。有限的保留期（`retentionMs`）限定了事件去重窗口，待处理消息和未决回执不会自动过期。恢复投递时扫描 Session 日志核对收件箱消息 ID 会使恢复耗时随会话历史增长。
