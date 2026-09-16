---
description: "通过统一协调队列热重载插件代码和 profile 配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hmr

[English](README.md) | 中文

## 概述

在应用运行期间重载插件源码和配置。模块替换、Include 刷新与 profile 配置变更共用一个队列。包安装在该队列之外执行。`ctx.hmr` 保留现有 Cordis HMR 的配置和事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启动器提供 `profileContext` 时，base 组合包以 `root: []` 启用 HMR；没有该 profile 上下文的宿主保留此条目为禁用状态。Headless、SDK 和 ACP 组合包在 YAML 中禁用此条目，后续 profile patch 可以重新启用。禁用或省略 HMR 时，更改在重启后生效。如需监听源码模块，在启动前通过 profile patch 配置 base 组合包提供的 `hmr` 条目：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["."]
```

已有配置将模块名 `@deepseek-ai/cordis-plugin-hmr` 替换为 `@deepseek-ai/dsh-hmr`。继续提供 `hmr` 服务键、`baseDir`、`config`、`getLinked()`、`getOuterStack()`、`hmr/change` 和 `hmr/reload`。工作区保留 vendored 包；DSH profile 使用本包。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `base` | Context 的 base URL | 模块监听的基准目录。 |
| `root` | `["."]` | 模块监听目录；`[]` 仅保留显式注册的配置监听。 |
| `ignored` | `["**/node_modules", "**/.*", "cache", "data"]` | 排除的模块路径。 |
| `debounce` | `100` | 合并模块变化的毫秒数。 |

Chokidar 选项（包括轮询）保持原有含义。精确配置监听同时观察新增、删除及初始不存在的父目录。它们默认使用 `awaitWriteFinish: true`：编辑后等待 Chokidar 的 2 秒写入稳定窗口，避免其变化事件节流丢失通知。可通过 `awaitWriteFinish` 调整窗口；禁用它可能漏掉快速连续编辑。直接通过 Plugin Manager 发起的操作无需等待文件事件即可应用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`watchConfig()` 注册会被等待的配置处理器。`runExclusive()` 将配置变更、Loader 更新与自动重载串行化，并拒绝嵌套事务。包安装和删除在该队列之外执行。HMR 不获取包操作写锁；manifest 通知仅在有序的 `dsh.profile.bundles` 列表变化时触发重载。profile 与 home patch 变化也会触发重新组合。配置事务期间收到的文件事件在事务结束后处理。

App-boot 负责 profile 解析和 patch 优先级规则。HMR 读取启动器提供的纯数据 `profileContext`，在初始化时注册 profile manifest 和两份用户 patch 的监听，并等待应用就绪后处理更改。销毁 HMR 时会关闭监听器并取消等待启动的重载。HMR 也负责模块缓存替换和重载调度。配置监听器在当前事务上下文之外启动，使后续通知可以进入队列。不发布 invariant 伴生入口，因为队列和监听注册没有独立的持久投影。

被监听模块的路径沿用 Node ESM 解析所用的 `realpathSync()` 表示，包括 Windows 短目录名，使文件事件与模块缓存匹配。

模块替换实现源自 `@cordisjs/plugin-hmr` 1.0.15，包含 Harness 的 Node loader 和惰性配置修改。保留其 [MIT 许可证](LICENSE)。

</details>

<a id="model-experience"></a>
## 模型体验

### 被重载的插件

#### 模型看到什么

`ctx.hmr` 不添加模型工具或消息。加载后的插件决定后续工具和提示词贡献。

#### Token 影响

没有直接的 token 贡献。

#### KV Cache 影响

重载提供上下文的插件可能改变后续请求前缀；HMR 不改写对话历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 模块替换需要 Node loader 内部接口。框架依赖变化调用宿主提供的 `loader.exit()` 钩子；HMR 本身不重启进程。
- 通过插件管理器替换已安装包版本仍需要重启。浏览器 Client 模块图保留独立的浏览器侧加载机制。

### 开发备注

<a id="dev-note"></a>

无。
