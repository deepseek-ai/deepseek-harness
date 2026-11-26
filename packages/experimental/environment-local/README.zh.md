---
description: "通过托管的 Node 进程提供本地执行环境。"
kind: "package-reference"
---

# @deepseek-ai/dsh-environment-local

[English](README.md) | 中文

## 概述

在本地 Node 进程中运行环境函数，origin 回调仍在 dsh 中执行。该提供方向共享注册表贡献稳定的环境标识、显示名称和传输实现。文件系统和进程操作使用配置的本地工作目录，以及执行进程的权限。执行进程在首次使用时启动，并复用至连接断开或提供方卸载。该包具有实验性，需要显式组合。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载注册表和提供方，然后将贡献的环境标识传给 `ctx.environments.define` 返回的运行器。多个提供方实例可以贡献不同的本地环境。

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-local'
  config:
    handle: local
    displayName: Local workspace
    cwd: /absolute/workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `handle` | `local` | 由提供方拥有的稳定标识 |
| `displayName` | `Local` | 面向用户的显示名称 |
| `cwd` | 必填 | 执行进程的绝对工作目录 |
| `node` | 当前可执行文件 | 用于启动进程的 Node 可执行文件 |
| `daemon` | 已安装的执行环境打包产物 | 执行守护进程入口的自定义绝对路径 |
| `killGraceMs` | 2000 | 在为 `exec` 进程组预留协商的宽限时间后，终止守护进程的额外宽限时间 |
| `maxStderrBytes` | 64 KiB | 保留的守护进程 stderr 字节数 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-environment-local)提供完整的字段参考。默认守护进程是已安装的 `dsh-environment` 打包产物，需要 Node 24。卸载提供方会移除环境标识并关闭其连接。强制终止守护进程前，提供方预留注册表为 `exec` 进程组协商的宽限时间，再加上本提供方的额外 `killGraceMs`。注册表负责取消、结果校验和 origin 回调，与 SSH 环境一致。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

传输实现每次打开通道时，均通过 `ctx.subprocess` 启动全新的 `daemon.js serve --stdio` 进程；通道保持活跃期间，注册表复用该进程。传输实现负责进程的启动和终止。标准输入和输出承载注册表的通用协议。守护进程提供其自身进程中的文件系统和进程 API，注册表则在 dsh 中分发 origin 回调。提供方保留有大小上限的 stderr，以说明启动和连接失败的原因。将 Electron 可执行文件用作 Node 可执行文件时，会为其设置 `ELECTRON_RUN_AS_NODE=1`。

[`src/index.ts`](src/index.ts) 负责提供方配置、进程创建和注册表登记。

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

- [环境注册表](../environment/README.zh.md)——环境标识、带类型的执行和生命周期。
- [环境子系统](../../../docs/subsystems/environment.zh.md)——公开服务参考。
- [SSH 提供方](../environment-ssh/README.zh.md)——在另一台机器上执行。

-----

<a id="model-experience"></a>
## 模型体验

通过调用环境注册表的工具间接影响模型；这些工具负责 schema、模型可见结果和日志记录。本提供方不添加提示词段、模型工具或 Session 事件。

#### KV Cache 影响

无；本包既不组装也不发送模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 执行进程使用其自身的文件系统权限；本提供方不应用发起调用的 Session 的沙箱策略。
- 即使在本地执行，函数也必须自包含，并通过可结构化克隆的值交换数据。
- 现有工具不会自动选择本提供方，其测试也未覆盖 Windows 行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

源码组合测试显式选择仅含可擦除语法的守护进程入口，因此无需构建产物即可运行。安装路径验证使用打包后的守护进程。

</details>
