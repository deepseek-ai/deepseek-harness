# Agent Note：LiveShare 插件方法目录

Status: implemented

[English](2026-11-02-liveshare-plugin-method-catalog.md) | 中文

## 问题

LiveShare 过去通过声明 API 暴露插件端点。该 API 允许插件声明任意端点，因此目录写错时，viewer 的可达范围会在没有对应 Gateway 校验的情况下被扩大。替代方案需要一个唯一事实来源，明确一条分享可以暴露哪些插件方法。

## 决定

目录在运行时从 Typert 本地注册表枚举。每个 bundle 生成一行，优先使用 bundle 的本地化标题，没有时使用组件包标题；端点说明来自已注册的 Remote descriptor。分享记录只保存方法级策略，Host 在 Gateway 派发前把策略与目录取交集。

目录排除 DSH 核心 bundle。它们的方法仍由原有的 Session 和 Workspace 分享角色控制，而不是插件权限。核心 bundle 名从 `PROFILE_TEMPLATES` 派生，使排除规则跟随实际下发的 profile 组合，而不是再维护一份手写名单。LiveShare 自身的 bundle 也被排除，因为它是分享实现，不是分享可以授予自己的能力。

## 备选方案

保留声明 API 会留下两个事实来源：插件声明的端点和 Gateway 自己的分类。由 LiveShare 维护手写白名单又会与实际下发的 profile 模板漂移。从真实 profile 模板派生排除规则，让目录跟随组合而不需要第二份名单。

## 影响

不在 Typert 本地注册表中的方法无法被插件权限选中或调用。使用 owner-only exact route 的插件不会出现在目录中；viewer 调用该路由时会看到 `owner-route-not-shared` 提示。因此新增可分享方法是插件侧的注册决定，而不是修改 LiveShare 目录。
