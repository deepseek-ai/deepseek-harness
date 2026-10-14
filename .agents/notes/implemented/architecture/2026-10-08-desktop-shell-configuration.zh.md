# Agent Note: Desktop 壳层配置独立于 Host

Status: implemented

[English](2026-10-08-desktop-shell-configuration.md) | 中文

## Problem

Desktop 更新和原生恢复可以在 Host 启动前或不可用时运行。依赖 Host 配置会使这些功能无法在需要时解析偏好。统一设置页面不能决定每项偏好由哪个进程负责。

## Decision

Electron 主进程负责 `userData/desktop/settings.json`，不依赖 Host 启动或 Cordis 求值。测试鉴权弹窗开关使用此文件；[Desktop 参考文档](../../../../apps/desktop/README.zh.md#local-desktop-settings)统一说明字段和行为。

配置归属按运行依赖划分：由 Electron 负责且需要在 Host 启动前或不可用时读取配置的功能，使用壳层配置。Host 插件设置，包括 Web/Desktop 共用偏好，继续使用 Cordis。仅仅展示在 Desktop 中，不构成归属壳层的理由。统一设置界面可以使用不同的存储归属。

`desktop` 子目录集中存放壳层配置，不迁移已有文件。[快捷键决策](2026-09-20-device-local-shortcut-preferences.zh.md)继续负责 `userData/keybindings.json` 及其持久化语义。[共享 Web 应用决策](2026-09-10-desktop-web-wrapper.zh.md)仍约束 Host 组合和 profile 配置。

## Alternatives considered

**所有偏好都放入 Cordis。** 这需要可用的 Host。由 Electron 直接读取 `cordis.patch.yml` 会重复实现配置求值；单独的 patch 不包含插件默认值和其他配置层。

**迁移所有在 Desktop 展示的设置。** 界面位置不意味着需要独立于 Host。这会拆分 Web/Desktop 共用偏好，并让配置脱离实际使用它的插件。

## Consequences

壳层与 Host 配置分别有自己的归属。每项设置需说明归属和生效时机。独立壳层配置支持更多不依赖 Host 的功能，但不引入第二套应用后端。

现有设置在功能调整或需要独立于 Host 使用时，可逐项评估。这是评估方向，不是已排期的迁移计划或预设清单。实际迁移需明确唯一配置来源、迁移已有值并定义生效时机，避免两套存储间存在含糊的优先级。共用的 Host 设置在归属要求不变时继续使用 Cordis。
