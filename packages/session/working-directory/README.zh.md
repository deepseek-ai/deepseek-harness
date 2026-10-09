---
description: "改变一个 Session 的工作目录，同时保留已有进程各自的目录。所选目录可通过回放恢复，并出现在用户上下文中。当前目录消失时，只要原始项目仍然存在，就恢复到原始项目。"
kind: "package-reference"
---

# @deepseek-ai/dsh-working-directory

[English](README.md) | 中文

## 概述

改变一个 Session 的工作目录，同时保留已有进程各自的目录。所选目录可通过回放恢复，并出现在用户上下文中。当前目录消失时，只要原始项目仍然存在，就恢复到原始项目。

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

与 `fs`、`sessionProjections` 和 `systemPrompt` 一起挂载。`defaultDirectory` 为没有原始目录的 Session 指定绝对回退目录；省略时使用启动目录。参见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-working-directory)。

```yaml
- name: '@deepseek-ai/dsh-working-directory'
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Session 投影拥有当前目录，并通过 Session observation 暴露它，因此冷态读取方无需激活 Agent 即可使用；header 继续标识原始项目。每个 Session 的变更串行执行，通过文件系统 provider 验证，并检查取消状态与 Agent 生命周期，提交事件后排入用户上下文通知。若提交后通知入队失败，操作仍返回已提交的目录并记录警告；下一次请求或恢复仍会收到必需的目录上下文。提示词组装在发布必需的上下文条目前验证当前目录。已有进程与沙箱授权继续由各自的服务拥有。[服务实现](src/index.ts) 定义 API。

不发布 `./invariant` 伴生模块，因为服务从 Session 投影读取唯一的目录状态，并在使用时检查文件系统有效性。

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

### 工作目录上下文

#### 模型可见内容

当前值为 `Current working directory: <JSON-quoted absolute path>.` 每次已提交变更（包括自动恢复）都会尝试通过普通 Agent 收件箱排入用户上下文通知。取消或销毁可能丢弃尚未进入请求的通知；持久化目录仍可供下一次请求使用。目录上下文不进入系统提示词，即使可选运行时上下文被禁用，也仍然保留。

#### Token 影响

初始快照与变更值增加用户上下文 token；未变化的快照不会重复。

#### KV Cache 影响

目录变更追加上下文，不替换稳定的系统提示词前缀。目录变化或恢复在保留的历史之后生成新上下文。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **原始项目缺失** — 当前目录与原始项目均不可用时，提示词组装会拒绝每个模型轮次，包括纯聊天轮次。服务不会另选或重建仓库。请先恢复原始目录，或通过 SDK 的 `setWorkingDirectory`（Python 中为 `set_working_directory`）或 `ctx.workingDirectory.set` 选择现有的绝对目录，再重试。已有 shell 保留各自进程的目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作上下文 — 点击展开</summary>

无。

</details>
