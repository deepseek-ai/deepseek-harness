---
description: "通过 Web 侧边栏或 agent 启停 profile 插件，并安装、删除或选择组合包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

[English](README.md) | 中文

## 概述

管理当前 profile 的插件，无需手动编辑配置。启停单个插件条目、选择已安装的组合包，以及安装或删除外部组合包。在 YAML 中启用 HMR 时，配置变化立即生效；未启用 HMR 时，运行中的组合保留到重启。改动影响使用该 profile 的全部会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [失败行为](#failure-behavior)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

基于 base 的 profile 提供管理服务。在 Web 中，侧边栏的**插件**页（[ui-plugin-manager](../../client/ui-plugin-manager/README.zh.md)）管理 profile 的组合包及其能唯一定位的行；设置页的插件列表保持只读。Agent 预设条目保持只读。`plugin_manager` 工具提供相同操作，默认禁用。

在 profile patch 中显式启用工具；使用预设的 Agent 还需要启用该预设中的 `tool-plugin-manager` 条目。

```yaml
- id: tool-plugin-manager
  disabled: false
```

插件开关只更新 profile 的 `cordis.patch.yml` 中最后一条匹配覆盖项的 `disabled`；没有匹配项时追加。匹配依据是条目 id，以及覆盖项声明的模块名称。组合包开关修改 `package.json` 的有序 `dsh.profile.bundles` 列表。关闭保留依赖；开启追加到列表末尾，可能改变配置优先级。安装新组合包默认启用。home 和单次启动 patch 保留更高优先级。

`inspect(spec)` 在任何东西安装之前读出 spec 指向什么：注册表包名通过 `pnpm view` 询问注册表，在 profile 目录中运行，因而与安装使用同样的注册表与代理设置；绝对路径读取其 `package.json`；git 地址或 tarball 只答复自己的形式。答复携带名称、版本、描述以及该包是否声明组合包，否则给出 `problem`：`invalid-spec`、`already-installed`、`not-found`、`not-a-package`、`not-a-bundle`、`network` 或 `unknown`。调用方的 `signal` 或 `inspectTimeoutMs` 会结束查询。

`installBundle` 接受调用方生成的 `requestId`，`plugin-manager/install-log` 在其下流式转发每次 pnpm 运行的输出，`plugin-manager/install-state` 通告 `installing`、`cancelling` 与 `applying`。`cancelInstall(requestId)` 停止运行，只在 pnpm 退出且文件恢复后答复 `cancelled`，组合包已在应用时答复 `too-late`，其他 id 答复 `not-running`；安装调用随后报告 `application: 'cancelled'`。失败、被取消或装入了没有组合包 patch 的包的运行，会把 `package.json` 与 `pnpm-lock.yaml` 恢复原样；`packageResult.kind` 按退出方式与输出对失败运行分类，`bundle` 给出完成的运行新增的包。`listBundles` 携带每个组合包的一句话简介（包的 `description`）、其 patch 声明的行及其存活条目，以及它覆盖的内置行；它列出 profile 自己的组合包、安装提供的组合包，以及被选中却没有组合包 patch 的名字（作为 `not-bundle` 问题），未选中的普通依赖不列出。启动器的 `OPTIONAL_BUNDLES` 点名的组合包是 `optional`：随安装提供、默认关闭、由用户开启，永不可卸载，也不被任何随附模板选中（[理由](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.zh.md)）。每个完成的操作都会发出 `plugin-manager/changed`；在管理器之外应用的一代 patch（HMR 监视到 CLI 或手工编辑后）不发通知，页面要到下一次读取才知道。

pnpm 11 拦下依赖脚本时，失败的安装在 `pendingBuilds` 里报告 profile 中所有待决定的包名，包括先前尝试留下的；失败的运行会恢复 `package.json` 与 `pnpm-lock.yaml`，但有意不恢复 pnpm 记录这些名字的 `pnpm-workspace.yaml`。Web 插件页提供**允许这些脚本并重试**；工具可以在用户于对话中批准这些脚本后，通过 `install_bundle` 的 `approvedBuilds` 代为授权。服务只校验待决定的名字，不核实对话中的批准。授权按包名保存在当前 profile，允许以宿主用户的权限执行命令，并在再次安装失败后保留。只能批准当前未决定的名字；已有的拒绝与通配规则不能通过此操作覆盖。`allowBuilds` 里出现 YAML 锚点或别名时拒绝授权。重试保留原来的启用选择。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pnpmCommand` | `pnpm` | pnpm 可执行文件名或路径，与 `dsh plugin` 命令一样通过 `PATH` 解析。 |
| `inspectTimeoutMs` | `20000` | 单次检查所做注册表查询的上限，单位毫秒。 |
| `outputBytes` | `16384` | 每次操作返回的 pnpm 诊断字节上限；完整输出保留在返回的日志路径中。 |
| `lockWaitMs` | `120000` | 获取 profile 写锁的最长等待毫秒数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务与 `dsh plugin` 共用 [operations.ts](src/operations.ts) 中的包管理操作。启动器提供当前 profile；[DSH HMR](../hmr/README.zh.md) 串行执行模块重载、文件监听和管理写入。每次刷新重新读取组合包选择与 patch 层，更新原有根 Include，并等待已移除插件释放资源及剩余 Loader 树稳定。CLI 与 service 操作共用 profile manifest 写锁，防止并发包操作和 manifest 写入。HMR 不获取该锁。pnpm 在 HMR 队列之外执行；安装在 pnpm 成功后选入组合包，删除则在执行 pnpm 前取消选入并完成卸载。仅依赖字段变化不会触发配置重载。

结果包含最后尝试的阶段、目标、磁盘变化、应用状态和错误码。Web 词典呈现管理文案；pnpm 与 Loader 的诊断保持原样。无关的已有故障作为警告返回；新出现、配置变化后的故障，以及显式启用目标未激活，都会使操作失败。失败或被取消的安装会恢复 pnpm 运行前快照的 manifest 与 lockfile（[理由](../../../.agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.zh.md)）；失败的删除保留部分改动和诊断。安装按 request id 跟踪到调用结束，因此取消只针对一次运行，并且不取 profile 锁就能等待它结束。CLI 继承认证环境和终端描述符；service 使用清理后的环境并捕获输出。管理器直接读取文件和 Loader 状态，不维护第二份目标状态注册表，因此不发布单独的运行时不变式伴生入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [App boot](../app-boot/README.zh.md)——profile 配置层与启动策略。
- [Plugin inventory](../../host/plugin-inventory/README.zh.md)——当前 Loader 和预设状态。
- [插件管理页](../../client/ui-plugin-manager/README.zh.md)——基于本服务的 Web 侧边栏页面。
- [Plugin settings](../../client/ui-settings-plugin-inventory/README.zh.md)——只读的 Web 清单。

<a id="model-experience"></a>
## 模型体验

### 管理工具

#### 模型看到什么

[`plugin_manager` 工具](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plugin-manager) 列出插件条目和组合包，并执行影响整个 profile 的改动。结果包含保存状态变化、应用状态和包管理诊断。管理操作不会向 Agent 注入消息。

#### Token 影响

装配工具消费者时提供工具声明；每次调用追加返回的清单或改动结果。

#### KV Cache 影响

工具结果追加到对话中。启停其他工具可能改变后续工具声明及其缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Web 一次批准显示出来的整组待决定包，没有逐包选择。
- 替换已有包后需要重启进程，以加载新的 JavaScript 模块版本。
- 仅启动时加载的 profile 不能删除当前进程启动时使用的包；停止进程后使用 `dsh plugin`。
- 管理器不能关闭自身所需的管理组件、修改其他 profile 或编辑 agent 预设组合。
- 失败的删除可能留下部分依赖改动，失败或被取消的安装可能在 `node_modules` 或 pnpm 缓存中留下已下载文件。文件缺失的未启用依赖仍可删除。诊断日志保留在 profile 的 `.plugin-manager/logs` 目录中。
- 管理结果描述 Host 激活状态。浏览器同步失败会在设置的插件列表中单独显示。
- Desktop 包管理操作仍由 Desktop shell 负责。

<a id="failure-behavior"></a>
### 失败行为

失败保留已完成步骤，并报告实际残留状态。没有有效组合包声明的 profile 依赖仍可见、可删除，但不能启用。

| 失败操作 | 处理方式 |
|---|---|
| 安装：pnpm 执行或组合包校验失败 | 恢复 pnpm 运行前快照的 `package.json` 与 `pnpm-lock.yaml`；pnpm 已下载的文件可能保留。报告安装失败。 |
| 启用：保存选择项或加载失败 | 保留已安装的依赖和已保存的选择项。报告启用失败，允许修正、停用或卸载。 |
| 卸载：任一步失败 | 停在失败步骤，保留已完成的改动和待重试删除的依赖，报告卸载失败。不重新启用组合包。 |

pnpm 执行和组合包校验成功即完成安装，后续启用失败不撤销安装。卸载依次执行：从 `dsh.profile.bundles` 移除组合包、卸载运行时贡献、执行 `pnpm remove`。任一步失败都不继续执行后续步骤。

恢复只重写这两份快照文件；用户编写的 patch 配置、应用数据、诊断日志以及 pnpm 已下载的文件保持原样，没有 manifest 引用的包由下一次包操作清理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
