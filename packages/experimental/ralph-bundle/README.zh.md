---
description: "使用新智能体执行用户明确要求的循环工作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-ralph-bundle

[English](README.md) | 中文

## 概述

为所有智能体添加实验性 Ralph 全局工具，使用新的子智能体执行用户要求的循环工作。 Web 和 Desktop 随附此功能，默认关闭。在插件页选择它即可启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Web 或 Desktop 中打开插件页，在官方分组启用 **Ralph 循环**。关闭后移除其配置层。

启用或关闭组合包会在运行中的 Host 注册或移除其全局工具，因此所有预设（包括 minimal）中的每个智能体都会在下一次请求时看到变化。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入 Host 组 `optional-ralph`，该组隔离自己的 `workflowEngine`，并在全局工具层注册 `tool-ralph`。后续配置补丁可以按条目 id 替换该工具的配置或禁用它；单独的覆盖不会选中组合包。[配置组合器](../../boot/app-boot/README.zh.md) 负责补丁顺序和错误处理。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[能力实现](../tool-ralph/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过[能力实现](../tool-ralph/README.zh.md) 贡献模型上下文和结果。

#### KV Cache 影响

此配置层不直接添加请求内容；能力实现负责工具目录、提示和结果的缓存影响。切换组合包会改变运行中会话的工具列表，使其已缓存的请求前缀失效一次。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- Ralph 需要用户明确要求执行循环，多轮运行可能消耗大量模型 token。其工作流引擎与其他工作流工具隔离。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
