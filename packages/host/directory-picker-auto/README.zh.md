---
description: "目录选择 seam 的自适应选择器：在启动时判定一次 web GUI 宿主的处境，并挂载匹配的原生或浏览后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-auto

[English](README.md) | 中文

## 概述

`dsh-host-directory-picker-auto` 为每次启动选出正确的目录选择交互：它在启动时一次性判定宿主处境，并把匹配的后端——[原生](../directory-picker-native/README.zh.md)或[浏览](../directory-picker-browse/README.zh.md)——连同其 browser 半侧一起，作为真实的 Loader 条目挂进内存根树。判定是一次纯函数的启动时采样：`native` 要求仅回环绑定、非 SSH 启动与可服务的显示会话；任何含糊情形都判定为处处可用的 `browse`。固定某种交互就是直接组合那个后端。挂载的能力在服务生命周期内保持稳定，符合 seam 的要求。

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

当同一份组合必须服务处境不同的宿主时，用本插件代替具体的后端：本地工作站会话里原生选择器可用，远程或无头会话里只有应用内浏览器可用。选择器在启动时检查一次宿主，并挂载匹配的交互。

### 选择是如何作出的

`native` 要求「操作者看得到宿主屏幕、且原生后端能服务它」的全部信号：仅回环的绑定（从注入的 `webServer` 读取；全网卡绑定会接入任何 OS 选择器都触及不到的远程浏览器）；非 SSH 启动（`SSH_CONNECTION`／`SSH_TTY` 未设置或为空）；以及可服务的显示会话——darwin 与 win32 上视为存在；linux 上要求 `DISPLAY`／`WAYLAND_DISPLAY`，外加 `PATH` 上有 zenity 或 kdialog 二进制；其余任何平台上都不成立。任何含糊情形都判定为处处可用的 `browse`。

### 你会得到什么

判定出的交互以普通 Loader 条目的形式到达：后端注册 `ctx.directoryPicker`，其 browser 半侧被 client 模块表发现的方式与配置行完全相同，因此 seam 的「一行同时换两面」不变式依然成立。卸载该选择器会移除该条目，连同两面一起卸载。采样每次启动恰好发生一次，因此挂载的能力在服务生命周期内保持稳定。

### 固定某种交互

固定交互在这里不是配置字段：直接组合 `-native` 或 `-browse` 行来替代本行——那才是 seam 文档化的切换点。同时挂载选择器**和**某个后端行会明确报错（重复的 `directoryPicker` 服务、`single` 类 slot 中的重复 client 流程）。

### 可观察的失败

错误的 `native` 选择会退化为后端既有的可重试失败对话框，而不是坏掉的组合；对探查无法证明其处境的部署，直接组合 `-browse` 即选择安全的交互。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

选择器是一次纯决策加一次挂载：`resolveDirectoryPickerBackend` 在启动时采样宿主事实并返回一个后端类型，`apply` 把匹配的后端与界面包作为真实 Loader 条目挂进内存根树——绝不持久化到配置文件，因为根树的 `write()` 是 no-op。该 effect 的 disposer 会移除两个条目并汇合其 fiber 的拆除，因此卸载只在所挂载交互的两面（及其依赖方）完全停稳后返回。

### 判定表

| 条件 | 后端 |
|---|---|
| 绑定宿主不是 `127.0.0.1` | `browse` |
| 存在 `SSH_CONNECTION` 或 `SSH_TTY` | `browse` |
| darwin 或 win32 | `native` |
| linux 且带选择器二进制与显示 | `native` |
| 其他任何情况 | `browse` |

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`BACKEND_PACKAGES`／`SURFACE_PACKAGES` 映射、`apply` 挂载与卸载 |
| [`src/resolve.ts`](src/resolve.ts) | `resolveDirectoryPickerBackend`——纯函数的启动时决策 |
| [`src/probe.ts`](src/probe.ts) | 宿主探查：`hasLinuxChooserBinary`、`canExecute` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当选择器的约定不够用时阅读以下内容：先看 seam 定义，再看它挂载的两个后端。

- [目录选择 seam](../directory-picker/README.zh.md)——选择器所组合的能力约定。
- [目录选择能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md)——后端为何在交互形态上彼此不同。
- [原生后端](../directory-picker-native/README.zh.md)——为本地操作者挂载的交互。
- [浏览后端](../directory-picker-browse/README.zh.md)——在其他任何地方挂载的交互。

-----

<a id="model-experience"></a>
## 模型体验

无。GUI 宿主的目录选择选择器只挂载一个后端行，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明启动时采样何时会误判宿主。它们是当前包约束，不是任务积压。

- **探测是从启动上下文推断操作者位置，而任何启动侧信号都无法证明这一点**——从 SSH 启动中脱离的 tmux 会话会丢失 `SSH_*` 标记；Aqua 会话之外的 Darwin 进程仍被算作有显示；在工作站本地启动、之后经 `ssh -L` 访问时，请求会从 `127.0.0.1` 到达，系统会判定 `native`，并把选择器弹在无人值守的工作站上。错误的 `native` 选择会退化为后端既有的可重试失败对话框，而对这类部署，直接组合 `-browse` 即选择安全的交互。
- **Linux 选择器探查只读 `PATH`**——以其他途径可用的 zenity／kdialog（shell 别名、未装在 PATH 上）仍判定为 `browse`；把任一二进制装到 `PATH` 上，下次启动即恢复 `native` 资格。
- **仅在启动时判定**——一次判定服务本次启动的所有客户端；按连接自适应（同一台服务器，本地浏览器用 native、远程浏览器用 browse）需要按客户端的能力对象以及 seam 未携带的协议通告，等到出现同时服务两种形态的部署再做。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。唯一 effect 是由插件 fiber 持有的 boot-time Loader-entry mount，store 是权威来源。
