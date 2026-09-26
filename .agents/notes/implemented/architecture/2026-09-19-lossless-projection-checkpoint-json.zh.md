# Agent Note: 无损投影检查点 JSON

Status: implemented

[English](2026-09-19-lossless-projection-checkpoint-json.md) | 中文

## 问题

投影检查点可以包含不透明扩展数据和消息元数据。名为 `__proto__` 的 JSON 键是普通记录数据。Zod JSON 解析器在重建对象时丢弃该自有键，因此重新打开有效检查点可能得到与回放 Session 日志不同的投影状态。

## 决策

检查点值 schema 使用 `dsh-util-values` 中既有的 `isJsonValue` 谓词。它执行与检查点写入器 `snapshotJsonValue` 相同的无损 JSON 规则，不重建有效对象。校验仍拒绝非 JSON 和有损值。Storage-domain 表值是不可变的借用记录；校验器不提供防御性复制保证。

## 备选方案

- **保留 `z.json()`。** 其对象重建会移除有效自有键，因此校验成功仍可能改变检查点值。
- **用 `snapshotJsonValue` 校验并复制。** 这能保留键，但会复制已经不可变的存储值。只读谓词符合 storage-domain 的借用值约定。

## 影响

Domain 读取保留检查点值中的每个有效自有键，包括嵌套的 `__proto__` 和 `constructor` 属性。Projection 的 `stateSchema` 仍拥有其 hydration 值；不透明字段必须使用保留其键的校验器。借用值校验器不生成独立副本，也不投影为 JSON Schema。

存储 JSON 表示未变，因此 domain 版本不变；本修改修正其读取器。回归测试打开真实写入器生成的合成 fixture，再通过 `StorageDomain` 写入、关闭并重新打开。Session 格式版本与历史代际不变。[前代恢复与 Session 格式绑定](2026-09-02-projcache-cross-version-read-compat.zh.md) 继续负责缓存版本与身份兼容性。
