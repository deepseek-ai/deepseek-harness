---
description: "在输入框的模型选择器中为 DeepSeek Flash 显示临时的 1017 角标。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deepseek-model-label-1017

[English](README.md) | 中文

## 概述

本包在输入框模型选择器的 `DeepSeek-V4.1-Flash` 旁显示 `1017`。它覆盖官方 API Key 和账号通道，保留目录名称和请求 ID。停用后恢复纯模型名称。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 包含本插件，桌面端使用该 bundle 时也会加载。本包没有配置字段。

只有提供方为 `deepseek-official` 或 `deepseek-account`、模型 ID 为 `deepseek-flash`，且目录名称恰好为 `DeepSeek-V4.1-Flash` 时才显示角标。其他名称和提供方保留目录文字。输入框按钮、当前模型菜单行和模型选项共用这个角标。

通过 profile patch 停用以下条目即可恢复目录名称：

```yaml
- id: ui-deepseek-model-label-1017
  disabled: true
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>内部实现 — 点击展开</summary>

浏览器入口通过 `ctx.slots.inject()` 向已有的 `conversation.input.model.label` slot 注册组件。组件根据 owner props 派生标签，使用共享 `Tag` 基元，不拥有缓存、订阅、网络请求或模型选择状态。注册和字典随插件卸载。Host 入口仅让 Loader 能加载浏览器包。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下包分别拥有选择器和两个目录来源。

- [模型选择](../ui-model-selection/README.zh.md) — 名称显示位置与选择行为。
- [DeepSeek 传输](../../llm/llm-deepseek/README.zh.md) — 内置模型目录。
- [DeepSeek 账号](../../llm/llm-deepseek-account/README.zh.md) — 账号提供的模型目录。

-----

<a id="model-experience"></a>
## 模型体验

无，本包只装饰浏览器标签，不改变模型请求或 Session 事件。

#### KV Cache effect

无；提供方请求及其缓存前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

固定的版本标记有以下显示限制：

- 设置编辑器、`/model` 命令、触发按钮的无障碍文字及已有提示保留原始目录名称。
- 本包占用 `single` slot。其他模型名称插件若使用相同优先级会冲突，两种展示不会自动组合。
- `1017` 是固定的客户端展示，不是服务端能力声明。结构化版本标签替代它时，移除本包及其 bundle 条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
