---
description: "在收到新的用户提示时更新会话标题。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-titles-bundle

[English](README.md) | 中文

## 概述

根据对话中符合条件的用户提示生成实验性会话标题。此功能替换首条提示标题提供者，并适用于所有预设。 Web 和 Desktop 随附此功能，默认关闭。在插件页选择它即可启用。

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

在 Web 或 Desktop 中打开插件页，在官方分组启用 **随对话更新的标题**。关闭后移除其配置层。

开关会更改已有和新建 Session 的标题提供方。符合条件的用户提示词或显式刷新会触发标题请求；模型被要求在已有生成标题仍能描述主要主题或任务时逐字保留它。自动更新不会覆盖用户固定的标题。智能体的工具目录保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 Host 上添加提供者。后续配置补丁可以覆盖其设置。[配置组合器](../../boot/app-boot/README.zh.md) 负责补丁顺序和错误处理。 此层禁用 `session-title-llm` 后选择替代提供者；取消选择会恢复默认提供者。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[能力实现](../session-title-all-prompts-llm/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过[能力实现](../session-title-all-prompts-llm/README.zh.md) 贡献模型上下文和结果。

#### KV Cache 影响

此配置层不直接添加请求内容；能力实现负责工具目录、提示和结果的缓存影响。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 自动标题生成失败时保留旧标题。标题输入预算为 4096 字节，包含传入的当前生成标题，超限时拒绝输入而不截断对话历史。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
