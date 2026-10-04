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

`watchConfig()` 注册会被等待的配置处理器。`runExclusive()` 将配置变更、Loader 更新与自动重载串行化，并拒绝嵌套事务。包安装和删除在该队列之外执行。HMR 不获取包操作写锁；manifest 通知仅在有序的 `dsh.profile.bundles` 列表变化时触发重载。profile 与 home patch 变化也会触发重新组合。配置事务期间收到的文件事件在事务结束后处理。 Include 刷新和 profile 重载都通过普通的 Loader 条目更新到达插件；仅 volatile 变化由 Loader 就地提交。

App-boot 负责 profile 解析和 patch 优先级规则。HMR 读取启动器提供的纯数据 `profileContext`，在初始化时注册 profile manifest 和两份用户 patch 的监听，并等待应用就绪后处理更改。销毁 HMR 时会关闭监听器并取消等待启动的重载。配置监听器在当前事务上下文之外启动，使后续通知可以进入队列。

`node_modules` 之外的 `package.json` 变化使该包的配置缓存失效。仅作为配置的 manifest 不触发模块重载；作为 JSON 模块导入的 manifest 保留依赖驱动重载，位于宿主依赖图中的 manifest 保留宿主重载。专属配置监听保留原有归属。新包入口在 Loader entry 重启时生效。

Loader entry 保留原始导入结果。HMR 为每个 entry 名称与配置树 base URL 保留所有不同的已导入命名空间；尚未初始化的 entry 不会覆盖其他 entry 的命名空间。HMR 将这些对象与缓存中 ModuleJob 的模块命名空间按对象身份匹配，不再重新解析 entry 名称。没有已导入命名空间的名称和 `cordis:` 内置入口仍按名称解析。因此 `exports` 或 `main` 改变后，源码重载仍使用已加载模块。

共享同一运行时的 entry 一起替换，每个 entry 使用其自身模块对应的实现。同一模块的重复 entry 仍保有各自的插件实例。替换失败时，HMR 清理已部分激活的替换实例，并恢复原来的模块和插件实现。重载成功后更新所有匹配的 entry 记录，包括已停用的 entry；替换失败时这些记录保持不变。从未加载过的 entry 仍保持未初始化状态。

[package-manifest.ts](src/package-manifest.ts) 封装 package 读取、scope、type 和最近 manifest 查询所需的 Node internal 接口。每个 HMR 实例拥有自己的配置缓存，销毁时恢复它安装的 hook。manifest 失效会清空 ESM `ResolveCache` 和 CommonJS `_pathCache`：它们都不记录查询过的全部 manifest，入口也可能指向包目录之外。CommonJS 加载先用 Node 默认 resolver 解析请求，再进入原生 loader，绕过旧请求别名并保留已求值模块。同步 resolve hook 收到的是解析后的文件名。普通模块替换仍由 HMR 独立处理。

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
- 通过插件管理器替换已安装包版本仍需要重启；`node_modules` 之下的 manifest 保留 Node 缓存的配置。浏览器 Client 模块图保留独立的浏览器侧加载机制。
- TSX loader 和普通应用自行创建的 Worker 不在包缓存刷新支持范围内。
- CommonJS 请求必须能由 Node 默认 resolver 解析。同步 hook 可以像 Desktop 的 Office resolver 一样处理解析后的文件名；依赖原始请求名或引入虚拟请求的 hook 不受支持。内置模块保留 Node 原有的加载行为。
- 后续工作：跨 HMR 销毁和替换保留包配置失效状态。恢复原生 reader 后，其旧配置缓存可能重新可见。
- 如果共享运行时的替换模块具有不同的插件回调，没有 Loader entry 的实例就无法确定应使用哪一个。HMR 会报告歧义错误并回滚此次重载。
- `watchConfig()` 在 Chokidar 报告就绪时 resolve。darwin 上 libuv 随后才在自己的线程启动 FSEvents 流，因此注册后数毫秒内落地的写入要等到该目录的下一个事件才会被报告；启动之后的编辑不受影响。

### 开发备注

<a id="dev-note"></a>

无。
