# Agent Note: 现有前端配置读取迁移到配置同步

Status: proposed

[English](2026-11-15-client-config-sync-migration.md) | 中文

## Problem

[前端插件配置同步](../../implemented/architecture/2026-11-15-client-config-sync.zh.md)落地前，浏览器需要 Host 配置的包各自实现了读取方式。这些方式只在页面加载时生效、复制注入代码，或把设置编辑通道当成运行时读取通道。本 Note 盘点这些用法并规划收编；架构落地前不执行。

## Proposal

### 盘点

| 类别 | 用法 | 包 |
|---|---|---|
| A. 页面全局变量下发 Host 配置 | `webserver/index-inject` 写 `window.__DSH_*__`，前端加载时读一次 | `shortcuts`、`ui-sidebar-documentpreview`、`ui-account-notifications`、`ui-settings-models`（引导）、`ui-settings-account`（联系方式）、`connection`（恢复参数） |
| B. 以 `configForms` 读取运行时值 | 前端经设置镜像订阅自身或他人条目的已接受值 | `ui-chat`、`ui-conversation`、`locale`、`ui-theme`、`ui-settings-account`、`ui-settings-general`、`ui-agent-preset`、实验包 `timeline`、`client-ui-cot-translation`、`client-ui-forge`、`cua` |
| C. 只在前端声明的 `Config` | 前端导出 schema，但条目从不收到配置 | 已在架构 PR 中完成：`ui-context-menu` 的 `resolutionTimeoutMs` 与 `ui-conversation` 的 `maxConcurrentFileUploads` 已改为 Host 顶层 volatile 字段，前端 schema 已删除 |
| D. 首屏预注入 | 页面 HTML 预注入以避免首屏闪烁 | `ui-theme` 调色板与字号 |
| E. 设置编辑 | 设置页编辑继承值、覆盖值、修订号、可写性 | 各 `ui-settings-*` 卡片 |

### 收编规则

| 类别 | 处理 |
|---|---|
| A | 字段改为 volatile，`Config` 类型移入 `src/types.ts`；前端改读 `SyncedConfig`；删除对应 `index-inject` 与全局变量。需逐字段确认语义可以变为「运行时可变」；`connection` 恢复参数在 connection 自身激活前就需要，须单独评估 |
| B | 读取自身条目的插件改读 `SyncedConfig`；`configForms` 只保留写入与设置页呈现。读取他人条目的值（例如 `ui-agent-preset` 读 `ui-settings`）可改用只读的 `ctx.config.resolveConfigByPackage(packageName)` |
| C | 前端删除 schema 与 `Config` 导出，类型移入 `src/types.ts`，Host 面声明 volatile schema |
| D | 保持不变；运行时变化部分可另行收编 |
| E | 不在本迁移范围；settings 包与 `configForms` 的调整在配置同步架构稳定后另行讨论 |

### 顺序

1. 架构 Note 实现完成并合入。
2. 类别 C（无行为依赖，验证机制）。
3. 类别 A，逐包进行。
4. 类别 B，先自身读取、后跨插件读取。
5. settings 与 `configForms` 的整体调整另起 Note。

### 未决

- 每个包选择哪些字段改为 volatile。
- 跨插件读取是否升级为按包名声明合并推导类型。
- `connection` 恢复参数与 bootstrap 行的首屏时序。

## Alternatives considered

| Rejected | 理由 |
|---|---|
| 与架构同一 PR 迁移 | 扩大评审面，机制问题与逐包语义问题混在一起 |
| 保留页面全局变量作为长期并行通道 | 维持两套配置来源与重复注入代码 |

## Acceptance criteria

- 类别 A、C 的包不再导出前端 `Config` schema 或读取 Host 配置全局变量。
- 类别 B 中读取自身配置的插件不再依赖 `configForms` 做运行时读取。
- 迁移后 Host 修改对应 volatile 字段无需刷新页面即生效。

## Risks

| 风险 | 说明 |
|---|---|
| 语义变化 | 原本只在加载时生效的值变为运行时可变，插件需支持热更新 |
| 配置钉住 | 字段改为 volatile 会使设置表单把它纳入 profile 行，受[实时配置](../../implemented/architecture/2026-09-19-profile-owned-live-configuration.zh.md)中的钉住规则影响 |
| 首屏时序 | `connection` 在自身激活前就需要恢复参数，早于同步配置能参与的时间点 |
