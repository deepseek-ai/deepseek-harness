# Agent Note: JSONL-only first-party Session persistence

Status: implemented

[English](2026-08-30-jsonl-only-session-persistence.md) | 中文

## Problem

产品交付并实际使用 JSONL 作为权威 Session store，而可选的 SQLite Session persistence provider 用第二种物理格式重复实现同一逻辑服务。因此，每项 Session 约定、event envelope 变更、恢复规则、package graph、平台测试与格式迁移都要承担第二套实现和测试矩阵，即使交付 profile 并不选择它。已发布 Session 格式迁移还需要保持精确逐 Session 源 generation 不变，同时发布具名版本后继；单数据库 provider 需要另一套不可变 generation transaction 设计，却没有服务当前部署。

SQLite 全文 Session-query provider 不是另一种权威 store。它通过 `ctx.sessionPersistence` 观察持久化，并维护独立、可丢弃的派生索引。通用 SQLite domain-KV provider 也与 Session 日志无关。

## Decision

`@deepseek-ai/dsh-session-persistence-jsonl` 是 `ctx.sessionPersistence` 唯一的 first-party 实现。抽象 Service Definition 保持后端无关，使仓库外 provider 仍可实现同一服务，但仓库只拥有并测试一种权威 Session 物理格式。

仓库不再包含 `@deepseek-ai/dsh-session-persistence-sqlite` package、其 schema resource、后端专用测试、配置接口与 Windows differential lane。跨 package 持久化测试使用真实 JSONL provider 或 owner-local fake。`@deepseek-ai/dsh-session-query-sqlite` 继续作为可选 FTS5 query provider 使用独立、可重建的数据库，`@deepseek-ai/dsh-storage-sqlite` 继续作为通用 domain-KV provider。

当前 build 不打开或迁移已删除 provider 写出的现有数据库。需要其中内容的 operator 必须先使用仍包含该 provider 的 build 导出逻辑 Session，再执行升级。

## Alternatives considered

- **保留 SQLite 作为可选 differential backend。** 拒绝，因为未被选择的生产 provider 仍会成倍增加每项 durable format、lifecycle、平台与迁移义务；contract fake 与 JSONL provider 已能覆盖共享服务，无需保留第二种权威格式。
- **保留只读 SQLite import package。** 拒绝，因为在没有实际部署需要时，它仍会保留 package graph 与 schema 维护成本。若真实保留数据库需要恢复，未来可单独设计 recovery tool。
- **把 Session-query SQLite 数据库作为 persistence。** 拒绝，因为该数据库是拥有独立 ownership、schema 与重建语义的可丢弃 projection；把它当作权威来源会合并两种无关的存储职责。

## Consequences

Session persistence 只有一种 first-party 物理格式和一条 first-party durability path。迁移 stack 可以保持逐 Session JSONL generation 的路径、字节与 inode 不变，同时排他发布最终后继，而无需实现并行的数据库 transaction protocol。SQLite search 保持可用，其 integration test 证明它观察 JSONL，而不是共享权威数据库。

删除 provider 是针对其可选数据库文件的明确 compatibility cut。该变更缩小实现与 CI surface，但也移除更强的 database/WAL 存储选项；未来 provider 需要当前 owner、部署需求、完整 shared-contract evidence，以及自身的 format-transition policy。
