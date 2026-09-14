---
description: "浏览器操作 提供方 注册服务，供一次启用一个浏览器后端的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-browser-use

[English](README.md) | 中文

## 概述

部署可以一次启用一个浏览器操作 提供方。加载另一个 提供方 时会报错并指出已注册的 提供方 名称。各 提供方 提供自己的工具并拥有浏览器会话。本包不添加模型可见工具或浏览器操作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Cordis 组合中，将服务与所选 提供方 一起挂载一次：

```yaml
- name: '@deepseek-ai/dsh-browser-use'
```

服务没有配置。提供方 插件注入 `browserUse` 并调用 `ctx.browserUse.register(BrowserUseProviderName(name))`；品牌类型从 `@deepseek-ai/dsh-browser-use/brand` 导出。返回的 effect 清理器释放该注册。

提供方 在释放注册前停止接收工具调用、关闭资源并等待自己拥有的工作结束。`ctx.browserUse.providerName` 在释放之前持续报告已注册名称。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

一个私有名称拥有该注册位。Cordis effect 在插件卸载时移除贡献；重复调用清理器不能移除后续注册。[源码](src/index.ts) 不包含浏览器对象、操作接口、资源生命周期或 提供方 选择器。

不发布运行时不变量伴随入口：注册表只有一个权威字段，不暴露可能与之偏离的独立维护观测值。所属测试覆盖重复注册拒绝与插件清理。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [浏览器操作](../../../docs/subsystems/browser-use.zh.md) — 提供方 选择与 Session 所有权。
- [Playwright MCP 提供方](../../experimental/browser-use-playwright-mcp/README.zh.md) — Playwright 浏览器工具。
- [Chrome DevTools MCP 提供方](../../experimental/browser-use-chrome-devtools-mcp/README.zh.md) — Chromium 检查与控制。
- [Stagehand 提供方](../../experimental/browser-use-stagehand-native/README.zh.md) — 支持 AI（人工智能）辅助的原生浏览器操作。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此注册表只记录 提供方 名称。

#### KV Cache 影响

注册不改变模型请求。提供方 拥有的工具与指导决定各自对请求前缀的影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

服务在其 Cordis 服务实例内限制注册。

- **浏览器所有权** — 提供方 拥有浏览器资源并实施 Session 隔离；此服务不保存浏览器状态。
- **提供方 选择** — 配置选择 提供方；模型不能在运行时切换已注册后端。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
