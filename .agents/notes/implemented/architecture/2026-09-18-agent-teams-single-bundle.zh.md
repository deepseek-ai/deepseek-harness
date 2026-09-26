# Agent Note: 通过一个组合包启用 Agent Teams

Status: implemented

[English](2026-09-18-agent-teams-single-bundle.md) | 中文

## 问题

独立的 Agent Teams 与 Agent Teams Web 开关要求用户自行发现：工具与浏览器控件需要同时选中两项。包的拆分把组合细节暴露在插件页上，却没有帮助用户选择不同的 Team 能力。

## 决策

`@deepseek-ai/dsh-experimental-agent-team-profile` 在一个可选组合包中携带 Team 服务、工具与浏览器 UI。其 patch 保留 `agent-team`、`tool-agent-team` 与 `ui-agent-team` 配置行 id，因此 profile patch 仍可单独配置各行。UI 包的 Host 入口不执行逻辑；其浏览器入口只在 Web 客户端中挂载，headless 不会启动 Web 服务。

独立的 `@deepseek-ai/dsh-experimental-agent-team-web-profile` 包不在 workspace 与发布系列中。插件页提供一个 Team 选项，默认关闭。

本决策取代[包发布记录](2026-08-18-experimental-agent-teams-packages.zh.md)中的独立 Host/Web 组合方式，以及[可选组合包记录](../process/2026-09-15-shipped-optional-bundles.zh.md)中的两个 Team 选项。两条记录仍负责发布、依赖隔离、promotion 与安装方所有权。[已归档的 Web 控件记录](../../archived/feature/2026-08-06-agent-teams-web.md)记载原始拆分方式，其历史文本保持冻结。

## 曾考虑的替代方案

**保留两个开关并解释依赖关系。** 用户仍须为一个功能选中两项，单独选中任意一项都不能提供完整的浏览器体验。

**在通用 profile loader 或插件管理器中合并入口。** 在这些位置识别 Team 包名会让共用的加载或展示代码负责功能特定的组合。组合包 patch 已能声明所需配置行与依赖。

## 后果

用户同时启用工具与浏览器控件。安装层面不再提供仅选择 Team UI 组合包的入口；自定义 profile 仍能单独控制 patch 配置行。headless 安装包含 UI 依赖图，但不会挂载其浏览器入口。

选中了已移除 Web 组合包的已有 profile 存在升级兼容性缺口：无法解析该包时，启动会失败。组合包本身不会自动改写这些已保存的选择。兼容性处理与本组合决策分开。

## 验证

插件管理器浏览器测试观察一次开关后 Team 控件出现，通过 Remote 读取成员列表与任务看板，并观察关闭组合包后控件移除。Team 面板浏览器测试覆盖只读任务看板；构建后的 headless CLI 测试覆盖无需 Web 服务的委派。这些场景不覆盖仍选中已移除 Web 组合包的 profile 升级。
