# Agent Note: Session 重构常见问题

Status: proposed

[English](2026-09-10-session-refactor-faq.md) | 中文

## Problem

`LogicalSession`、service、storage、projection 与 query 容易被理解成重命名或多余层次。贡献者需要短答案区分临时命名、长期职责和当前 stack 状态。

## Proposal

### 为什么叫 `LogicalSession`？

第一，`Session` 已被现有具体类占用。迁移期使用新名字避免抽象与兼容实现冲突。仓库代码迁到 `LogicalSession`，外部开发者仍可使用 deprecated `Session`；移除兼容入口后，再讨论是否把 `LogicalSession` 改名回 `Session`。这不是当前阶段的前置决定。

第二，`Logical` 命名的是会话的身份、事件、surface 与 append 同「存储、列举或发布该会话」这些物理工作之间的分离。逻辑会话是消费方读取与追加的对象；storage/query 可以在没有 live 逻辑会话时处理 durable session 记录。

### 具体 `Session` 是否立刻禁止？

不是。过渡期不推荐新代码依赖它。阶段 1 明确保留公开类、`Session.create` 与 `Session.fromRestore`，兼容现有外部调用方。仓库生产代码统一使用 `LogicalSession`；专门兼容测试会保护 deprecated 入口，直至后续移除决策具备外部迁移证据与发布边界。

### `SessionService` 与 `SessionStorage` 有何不同？

`SessionService` 是逻辑会话入口和 live identity authority。`SessionStorage` 是物理持久化协议，负责 reader/writer、格式、迁移、租约与 I/O。应用功能向 service 要逻辑会话，不向 storage 要业务对象。

### Projection 在哪里？

`SessionProjectionPort` 观察规范事件并产生 title、summary、统计、列表元数据和搜索文档等读模型。Projection 可重建、不拥有 Session 写入，也不能成为 durable source of truth。service 管理注册、flush 与生命周期，使 live 和 cold 路径共享语义。

### 为什么没有 `SessionSearch` 或 `SessionStats`？

`SessionQuery` 已覆盖精确读取、过滤、trace、全文检索、列表元数据和统计读取。搜索索引与统计聚合是 query 背后的 projection/provider，不需要再增加两个公共服务。

### 普通用户需要迁移吗？

阶段 1–3 不改变磁盘格式或启动方式，用户无需手工迁移。受支持旧格式在首次打开时由 format catalog 迁移；查询索引等派生数据由系统重建。

### 当前完成到哪里？

阶段 1 建立公开逻辑会话接口；阶段 2 集中服务所有权；阶段 3 在阶段 2 的基础上分离存储读取器与写入器。前三个阶段的草稿已齐备，但阶段 4–5 和内存 provider 抽取尚未完成。

### 我怎样参与？

按[开发者迁移规则](2026-09-10-session-developer-transition.zh.md)的阅读顺序熟悉总览、目标协议、当前子系统文档和实现阶段。选择一个明确消费方，把类型和入口迁到抽象，补合约测试，并避免同时改变生命周期或 durable format。

## Alternatives considered

**现在就把 `LogicalSession` 改名为 `Session`。** 拒绝，因为旧具体类仍在过渡期使用，会造成含义冲突并扩大 diff。

**把接口命名为 `SessionRuntime`。** 拒绝，因为[新增包指南](../../../../docs/cookbook/adding-a-package.zh.md)中的包命名表把 `Runtime` 保留给运行实时工作并拥有分发、取消或操作生命周期的组件；该接口只持有一个会话的身份与日志，不运行任何东西，这个名字会被读作运行环境。

**把 FAQ 混入协议正文。** 拒绝，因为快速解释命名与迁移状态会掩盖协议义务；FAQ 只导航到规范 owner。

## Acceptance criteria

- 新贡献者能解释逻辑会话、service、storage、projection 与 query 的不同责任。
- FAQ 清楚说明命名是过渡选择，最终是否改回 `Session` 留待迁移完成后决定。
- 每个答案链接或服从一个规范 owner，不复制完整协议。

## Risks

FAQ 会随 stack 推进过时。每个阶段更新总览状态时必须同步检查本页；实现事实仍以当前 branch 的类型、测试和子系统文档为准。
