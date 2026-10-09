---
description: "使用同一工具读取 Session 的当前目录，或进入一个现有目录。相对路径变更基于当前目录解析。返回的绝对路径可传给其他工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-working-directory

[English](README.md) | 中文

## 概述

使用同一工具读取 Session 的当前目录，或进入一个现有目录。相对路径变更基于当前目录解析。返回的绝对路径可传给其他工具。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

与 `tools` 和 `workingDirectory` 一起挂载。调用 `working_directory({})` 读取目录，或调用 `working_directory({ cd: "src" })` 改变目录。此工具没有配置字段。

```yaml
- name: '@deepseek-ai/dsh-tool-working-directory'
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

此工具将验证、恢复、持久化和上下文通知委托给目录服务。规范结果包含 `cwd`；原生渲染返回该路径。通用工具卡展示参数和结果，无需独立 GUI 渲染器。

不发布 `./invariant` 伴生模块，因为工具将全部目录状态和变更委托给 `workingDirectory`。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [工作目录](../../../docs/subsystems/working-directory.zh.md) — 共享运行时行为。
- [Session 包组](../README.zh.md) — 持久化 Session 服务。
- [测试](../../../docs/testing.zh.md) — 组合与回放验证。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema 与结果

#### 模型可见内容

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-working-directory) 定义可选的 `cd` 参数与规范 `cwd` 结果。目录通知由 `dsh-working-directory` 拥有。

#### Token 影响

工具可用及被调用时，注册的 schema 和返回路径贡献 token。

#### KV Cache 影响

改变工具可用性会改变其 schema 上下文。工具调用追加普通调用和结果历史，不替换已有消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **需要调用方 Session** — 此工具需要 Agent，不改变已有进程或写权限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作上下文 — 点击展开</summary>

无。

</details>
