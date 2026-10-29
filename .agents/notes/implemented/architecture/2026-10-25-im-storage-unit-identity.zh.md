# Agent Note: v4 中的 IM 存储 unit 身份

Status: implemented

[English](2026-10-25-im-storage-unit-identity.md) | 中文

## Problem

如果 v4 消息存储沿用 v3 的 `im` unit 名称并将版本设为 2（表结构改为 `events`/`messages`/`chats`，而非 v3 的 `sessions`/`tasks`/`intake`/`output`），在已有 v3 home 目录上启动 v4 会在服务启动前失败：`StorageError: unit 'im': stored version 1 != expected 2`。unit 名称是其在存储介质上的身份标识，且单文档 unit 仅按精确版本号读取，因此在已有 v3 目录上复用旧 unit 名称且表结构或记录 schema 不兼容时，每次启动都会报错。

存储域层不提供就地迁移或重置机制：[`DomainSpec`](../../../../packages/storage/storage-domain/src/spec.ts) 仅包含名称、版本、布局与记录 schema，[`KvFacet`](../../../../packages/storage/storage/src/backend.ts) 仅提供 `open`/`loadAll`/`putRecord`/`deleteRecord`/`setGlobal`/`close`，不包含转换或销毁原语（见 [`packages/storage/storage-domain/README.zh.md`](../../../../packages/storage/storage-domain/README.zh.md)）。此外，v3 的接收回执与会话记录对 v4 IM 各包并不可复用，v4 的消息、会话、回执与任务记录本身具有不同的数据结构。

## Decision

每个 IM 存储域使用独立的 v4 unit 名称，不再复用 v4 之前的名称：

| 存储域 | unit 名称（v4） | 所属模块 |
|---|---|---|
| 消息存储：事件、消息、聊天 | `im_messages` | `packages/experimental/im/src/state.ts` |
| 托管会话与待处理投递 | `im_sessions` | `packages/experimental/im/src/sessions.ts` |
| 发送回执 | `im_receipts` | `packages/experimental/im/src/send.ts` |

由于每个 v4 存储域均使用全新名称，各自从版本 1 开始。介质上已有的 v3 `im`、`im_conversation` 与 `im_dispatch` unit 保持原样：v4 不读取、不迁移也不删除它们，首次启动 v4 时会自动创建并使用全新的存储单元，无需人工清理步骤。运行过已移除的任务插件的部署，其 `im_tasks` 记录同样保持原样：没有任何 v4 存储域会打开该 unit。

## Alternatives considered

**声明 v1 到 v2 的迁移以丢弃 v3 状态。** `DomainSpec` 与存储后端契约均无迁移、重置或销毁钩子；引入该机制需要先在存储层增加原语（见 [`recovery: 'reset'` 提案](../../proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.zh.md)），而在 IM 包内绕过存储后端直接操作文件会破坏存储抽象。

**保留 `im` 名称并将版本升至 2。** 单文档 unit 要求版本号精确匹配，在版本 1 的介质上以版本 2 打开每次都会因 `version-mismatch` 失败。

**保留旧名称并放宽 schema 以兼容 v3 记录。** v3 与 v4 记录代表不同的数据模型；放宽 schema 会导致 v4 将已废弃的旧路由和接收状态误读为当前记录。

**启动时自动删除 v3 unit。** 存储后端没有删除 unit 的原语，且在启动阶段自动删除用户存储文件不属于 IM 包的职责范围。

## Consequences

升级后的 `$DSH_HOME` 目录会将旧版 `im.json`、`im_conversation.json` 与 `im_dispatch.json` 原样保留在 v4 存储单元旁且不再读取。v4 IM 服务以空的消息、会话与回执存储启动。

今后若在这三个存储域内部进行兼容的 schema 变更，只需递增对应 unit 的版本号，并在旧记录符合新 schema 时声明 `compatibleVersions`。

验证：`packages/experimental/im/tests/store.spec.ts` 在预置了 v3 `im` unit（版本 1）的存储介质上启动消息存储，验证 v4 写入落在 `im_messages` 中且 v3 介质保持不变，同时验证以版本 2 打开 `im` 会因 `version-mismatch` 被拒绝。
