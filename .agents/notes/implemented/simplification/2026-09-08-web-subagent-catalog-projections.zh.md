# Agent Note：Web 子代理目录消费共享 projection

Status: implemented

[English](2026-09-08-web-subagent-catalog-projections.md) | 中文

## 问题

父目录 projection 已通过 Session control stream 发布完整成员关系。独立的目录变化事件、重复 RPC 读取与第二份成员缓存重复传递同一数据，并要求协调响应与后续事件。历史 Session 的 projection 缺席时仍需初始加载，父 Agent 可用性也独立于持久成员关系。

## 决策

Client 仅在标准逐 Session projection store 中保留目录成员关系。初始 `session.projections` 读取通过一次 live-preferred Session observation 返回完整 projection 基线。endpoint 接受任意 Session id，不含目录专用依赖或校验。值与序号游标来自同一次 observation。初始基线与实时 control 帧使用 store 既有的序号排序，因此旧响应不能替换新值。该 endpoint 不激活 Agent，也不采样子代理活动状态。打开会话时使用其 follow baseline，不再额外调度一次投影读取；未打开的目录分支仍使用显式读取。

功能消费者从 `projectionsBySession` 中选择 `subagentCatalog`，并从 Session 列表基线与状态事件派生行活动状态。Session 摘要单独报告 Agent 可用性；Agent 创建与销毁重新发布已有摘要事件。完成的子代理在移除后保留摘要与展示 projection。通用 projection 读取拥有加载与错误状态；父 Agent 可用性来自 Session 列表，独立于成员关系。打开已加载目录会复用数据，初始失败可以重试。重连取消此前的读取，并为已请求的目录重新读取。Session 移除会取消其待完成读取并将父 Agent 可用性标为 false；projection 响应不能改变 Agent 可用性。

[父目录决策](../architecture/2026-09-01-parent-owned-subagent-catalog.zh.md) 说明持久创建事实与顺序。本决策取代 [Web 子代理会话](../feature/2026-07-27-web-subagent-conversations.zh.md) 中的专用成员刷新机制；该记录继续保留导航、控制与展示决策。

Host 摘要替换运行状态与可用性；本地 create/fork 占位摘要只补充缺失的元数据。若共用覆盖行为，晚到的本地响应会抹去较新的 Host 状态，并生成虚假的完成提醒。普通 Session 移除后，仅为非空子目录保留 store；空目录没有需要保留的导航关系。面包屑 selector 从 Session 列表快照推导地址，使订阅涵盖全部依赖。

## 考虑过的替代方案

**保留通知驱动的读取。** 不采用，因为共享流已经传递变化后的值。菜单订阅、请求内活动状态回放与尾随成员读取没有提供额外的必要传递能力。

**删除初始读取 endpoint。** 暂缓。Session 列表 projection 是可能缺席的缓存提示；跟随会话还会传输历史并保留 observation 状态。轻量读取保留历史目录访问能力，无需建立会话跟随流。父 Agent 可用性是实时投递提示，而非持久 projection 事实。

## 影响

成员变化使用既有 control stream，无需额外目录通知或读取。对 D 个子级发布完整 projection 值仍需 O(D)；本变更不引入增量传输。初始读取返回 observation 的完整 projection 基线，其中包括目录以外的值，以额外初始载荷换取标准基线语义的复用。Session 序号排序不确立复用 Session id 之间的身份关系。

Manager 测试覆盖成员推送、过时初始响应、按需加载、状态组合、完成元数据保留、重试、空目录移除、晚到的 create/fork 响应与重连取消。Host 测试覆盖共享 control stream 与冷 observation。持久化子代理 Web 场景通过发布应用验证嵌套历史导航与续传。
