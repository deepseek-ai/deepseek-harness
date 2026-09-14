# Agent Note: Session 历史数据兼容

Status: proposed

[English](2026-09-10-session-data-compatibility.md) | 中文

## Problem

用户关心升级后旧对话是否仍能打开，而不是内部类名。抽象重构不能顺带改变磁盘字节或要求手工搬移会话。当前 `0.1.5-rc.1` checkout 写入 Session format V3，并已包含贯穿 V3 的 released-format migration chain。

## Proposal

### 从 0.1.5-rc.1 / V3 开始

V3 是当前 durable Session format，不是 projection-cache version。`SESSION_FORMAT_VERSION` 是 writer authority；format catalog 拥有 released v0→v1→v2→v3 路径，其中包括独立 V2-to-V3 stage 及其 delivery guards。原生 V3 校验与历史格式进入迁移是两项独立责任。

不得覆盖旧 generation 或自动降级。迁移写入新的 current generation，旧 committed generation 留给检查与恢复；当前 runtime 可通过 catalog 打开已发布旧格式，但不承诺旧 runtime 能读取 V3。

### 对普通用户的影响

阶段 1–3 只重排代码所有权，不改变 V3 Session JSONL bytes、`SESSION_FORMAT_VERSION` 或用户启动方式。普通用户无需因本次 refactor 额外手工迁移或更改配置。首次打开受支持的旧格式时，现有 migration pipeline 会准备并发布 current V3 generation；大日志使用流式 stage，避免 whole-artifact 内存峰值。

升级前仍应保留 `DSH_HOME` 的常规备份。若打开失败，应保留完整 session generation 与错误信息，不要删除旧文件；未来 provider 也必须把 unsupported future version、corruption、ownership conflict 和 migration failure 区分报告。查询索引与其他派生数据由系统重建，用户不需要手工迁移。

### Provider 替换后的不变量

更换内存实现、JSONL provider 或搜索索引不改变逻辑 SessionId、header、事件顺序、fork lineage 和 surface。Storage provider 负责已发布格式读取；search/statistics cache 是派生数据，可从规范 Session 内容重建，不能反向成为恢复权威。

## Alternatives considered

**在 refactor 内重新定义 V3。** 拒绝；已发布数据兼容独立于抽象 stack。本工作必须保留既有 format authority 与 migration evidence，而不是另建平行定义。

**把每个名为 V3 的组件版本都当作 Session V3。** 拒绝；Session log 与 projection-cache 等派生格式有不同 durability 和恢复规则。

## Acceptance criteria

- 既有 V3 catalog、V2-to-V3 stage、native validation 与 released-format fixtures 保持通过。
- 阶段 1–5 与 provider 抽取不改变 V3 磁盘格式；未来格式变化另有版本、迁移、重启和回滚证据。
- 用户不需手工编辑日志；错误保留可恢复数据并给出明确类别。

## Risks

主要风险是把新抽象耦合到 V3 当前 JSONL provider，或把可重建 projection cache 当作规范 Session 数据。替换 provider 必须保持 released-format contract，同时让普通功能代码看不到物理布局。
