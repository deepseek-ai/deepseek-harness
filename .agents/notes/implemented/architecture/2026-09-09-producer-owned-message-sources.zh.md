# Agent Note: V4 边缘上的生产者归属消息源

Status: implemented

[English](2026-09-09-producer-owned-message-sources.md) | 中文

## Problem

已发布 V3 的插件归属使用共享包装 `{ kind: 'plugin', plugin: '<producer>' }` 外加生产者的上下文形态字段，消费方因此必须特殊对待一个合成 kind，而不是直接按生产者身份切换。工具结果成为一等 tool-role 消息、当前世代进入 V4 之后，格式层还必须继续读取仍带包装的已发布 V3 文件。

## Decision

消息源由生产者拥有：`kind` 标识生产者，各方通过 `MessageSourceMap` 提供声明。V3-to-V4 迁移使用固定生产者表：`@deepseek-ai/dsh-system-prompt` 在 system-role 消息上变成 `system-prompt`，否则变成 `runtime-context`；`compact` 变成 `compact-checkpoint`；`tools-code-mode` 与 `tools-ptc` 变成 `ptc-mode`；`dsh-compaction-basic` 变成 `compact-basic`；已知同名生产者保留 kind。未知插件名在完整原名之前添加 `plugin:`，直接 source kind 则保留原名。该前缀将名为 `user` 的插件与人类用户 kind 区分开；本边保持直接归属不变。原上下文形态字段及其他自有 JSON 元数据保留；只有旧包装的身份字段执行指定转换。重命名查找使用自有键，因此 `__proto__` 和 `constructor` 仍是数据。

原生 V4 消息源准入在每个声明的持久化消息槽位拒绝退役的 `kind: 'plugin'` 包装，包括 inbox 和标题请求消息。可恢复扫描丢弃后缀之前就会执行此拒绝。完整消息源槽位校验在格式目录和原生 JSONL 扫描器共用的已知事件校验中执行，先于两者公开恢复产物或句柄。即使生产者未安装，未知的非空归属 kind 及额外 JSON 字段仍原样保留。原生压缩和标题关系校验直接使用生产者 kind；[强制校验决策](2026-09-17-native-v4-read-validation.zh.md)负责通用生命周期规则。

来源重写由 V3 到 V4 迁移 Stage 负责，在历史事件转换为 V4 事件时只执行一次。当前 V4 编解码器只保留已发布的物理分帧和原生 V4 准入；它不会让 V4 行进入已发布 V3 校验器，编码、解码、恢复和行准入路径也没有来源转换视图。

录制的当前 V4 fixtures 与 writer、notification、stream-json 侧车是生产者归属的；已发布的 V2/V3fixtures 与侧车保留 plugin 归属，读取时经迁移转换。[released session-format migrations](2026-08-31-released-session-format-migrations.zh.md)笔记拥有本边所遵循的版本规则。

[消息源归属策略](2026-09-17-persistence-attribution-policy.zh.md)区分持久化 source 声明与仅用于请求的 user 输入，并记录新增归属 kind 的受限兼容性承诺。即使没有活动生产者声明，冻结迁移规则仍保留历史生产者 kind。

## Alternatives considered

**保留 released plugin 包装作为当前形态。** 消费方将继续特殊对待一个合成 kind，生产者身份仍是无类型字符串；当前语义校验器也会保留第二套非发布的消息源词汇。

**只在扫描时重写 released 行而不是迁移它们。** 扫描准入刻意只查形态并拒绝、从不修复；扫描时重写会模糊 released 世代与当前行的界限，使当前产物保留与版本不符的来源身份。

**在 scanner 中把 plugin-kind 行当作普通损坏拒绝。** 这会让过期的 released 行静默截断当前 Session，而不是给出拒绝；也会把完整解码仍需要诊断的行错误分类。

## Consequences

本迁移的记录语料库应用冻结重命名表，而当前代校验器直接消费生产者自有 kind。Web 上下文标签渲染生产者 kind（`runtime-context`）而不是 released plugin 字符串。共享重写器将畸形历史来源报告为 `SessionFormatError`，因此迁移会拒绝它，而不会静默丢失载荷。
