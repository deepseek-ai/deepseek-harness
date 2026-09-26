---
description: "设置领域底座插件：共享配置表单、schema 服务，以及 dsh Web 客户端的规范设置 slot 类型约定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings

[English](README.md) | 中文

## 概述

本包使 Web 客户端功能能够公开由宿主设置文档支持的可编辑偏好设置，而无需自行实现传输或 schema 处理。每项功能都可按命名空间读写、原子更新多个字段、校验 schema，并避免静默覆盖并发更改。它还为设置界面框架、页面、标题栏操作、插件标签页和引导流程提供标准扩展点，但自身不渲染任何界面。任何持有偏好设置的功能都可在不依赖呈现包的情况下使用它；设置外壳由单独的包提供。

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

功能插件用本包存储与编辑自己的偏好设置，而无需重新实现传输层或 schema 处理。每个组合挂载一次即可；它注入 `remote` 服务及其 `settings` 命名空间，并持有浏览器中唯一的 `settings.describe` 读取方。

### 配置表单

`ctx.configForms.developerTools` 管理代码工作工具开关与 Web 和桌面端共享的偏好 `ui-settings.enabled`，默认为 `true`。其 `enabled` 可观察值发布已接受的选择，`setEnabled` 使用相同的有序设置写入。桌面端和回环 Web 将设置持久化到 Host 文档；远程 Web 将此选择保存在单个浏览器本地可观察值中，刷新后重置，不发送 Host 写入。此设置控制界面展示和 HTML 预览权限，不控制 Host 授权或 Session 记录。 使用 Host 偏好的客户端在首个经过 schema 解析并接受的值到达前保持开发者功能关闭；首次响应缺失或失败不会启用它们。后续刷新保留已接受的选择。

功能适配器使用 `ctx.configForms.get(entryId)` 获取该 Host 条目所有编辑器共享的已接受值和写入队列。快照包含解析后的 `value`、继承 `base`、原始 `user`、修订号、可写性和持久化模式。`set` 与 `unset` 提交单个操作，`mutate` 提交一个原子操作列表。暂存编辑器传入编辑前读取的修订号；冲突时保留草稿。清除操作移除覆盖并恢复继承。

### 跟随被服务的命名空间

编辑另一个插件所拥有命名空间的页面通过 `ctx.configForms.whileServed(namespaces, register)` 注册：只要所列命名空间中的任一个进入共享镜像，`register` 就运行一次，收到 Host 当前服务的命名空间集合，并返回该注册的 disposer；当它们全都不再被服务，或 `whileServed` 返回的 disposer 被调用时，这个 disposer 就运行。调用方持有返回的 disposer 并把它包进 `ctx.effect`；与 `get` 不同，服务不会在调用方的 context 上注册任何东西。因此从未组合过所有者的部署看不到该页面的任何痕迹，Host 停止服务的命名空间会撤下它。插件页上的四个官方页面各自通过一个伴生包走这条路径。

### 填充设置 slot

设置界面会注册进本包声明的 slot 类型。外壳（`sidebar.settings` 占位方、导航、界面框架）位于 ui-settings-general；功能页面注册 `settings.section` 贡献；「插件」分区承载 `settings.plugins.tab` 页面；首次使用引导步骤注册 `settings.onboarding`。跨命名空间的表面（schema 内省、已服务命名空间目录、`hasDocument`）通过 `ctx.configForms.describe()` 读同一面镜像。

### 可观察的成功与失败

已提交的写入将应答合入共享镜像。被拒绝的写入刷新最新 Host 值。浏览器使用序列化的 Config schema 校验；Host 校验完整配置，包括无法序列化的检查。

-----

<a id="understand-the-implementation"></a>
## 理解实现

可选的 `settings.launcher` 贡献接收侧栏布局、设置面板是否覆盖侧栏、设置导航回调，以及有效的设置键位标签和无障碍组合。命令未绑定时，外壳不传快捷键展示信息；未注册入口时，外壳保留普通设置按钮。

<details>
<summary>实现细节——点击展开</summary>

本包实现一条归属规则：浏览器保留设置文档的一面共享镜像，每个派生表面都读这同一真源，因此任一时刻看到的都是同一份文档 revision。

### Describe 镜像

`ui-settings` 条目的 Host Config 声明默认开启的 `enabled` 偏好。Client 插件注入 `remote` 及其 `settings` 命名空间，从固定的 `remote.$host` 事实一次性解析 Host 持久化模式，并持有浏览器中唯一的 `settings.describe` 读取方：一面共享镜像，在每次转发的 `settings/document-updated` 事件与 `connection/reset` 时刷新（首次连接也包含在内，关闭「提交落在急切读取与 SSE 订阅之间」的窗口）。跨命名空间表面通过 `ctx.configForms.describe()` 读它，这是一个读取/折叠面（`getSnapshot`/`subscribe`/`ensure`，另有把写应答折入的 `acceptView`）。

### 共享条目写入

提供者为每个 Host 条目持有一个控制器，包括其订阅和写入队列；重复调用 `get(entryId)` 返回同一表单。消费者释放自己的视图订阅。不创建调用方作用域的配置绑定。启动 RPC 预算覆盖共享的 describe 读取。

### Schema 服务

`ctx.settingsSchema` 重建 schema、校验草稿并编辑嵌套值。无效的线路值不会替换已接受值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置界面家族及其背后的持久化 seam。

- [ui-settings-general](../ui-settings-general/README.zh.md)——设置外壳：触发控件、导航、「通用」分区、引导投影。
- [ui-settings-plugins](../ui-settings-plugins/README.zh.md)——围绕清单标签页的「内置插件」分区壳。
- [ui-settings-shell](../ui-settings-shell/README.zh.md)、[ui-settings-agent-loop](../ui-settings-agent-loop/README.zh.md)、[ui-settings-subagent](../ui-settings-subagent/README.zh.md)、[ui-settings-web-search](../ui-settings-web-search/README.zh.md)——插件页上的官方配置页，各自通过 `whileServed` 跟随其命名空间。
- [ui-settings-models](../ui-settings-models/README.zh.md)——建立在本底座之上的 Models 页面与 DeepSeek 引导。
- [settings](../../settings/README.zh.md)——持久化用户设置 seam 及其文件提供方。
- [ui-sidebar](../ui-sidebar/README.zh.md)——底部席位承载设置触发控件的侧边栏外壳。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明设置传输层够不到的地方；它们是当前包约束。

- **非 loopback 页面没有持久化设置**：本 Client 在那里禁用 Host 持久化，因此 表单以 `unavailable` 起步且从不跨线路；尽管 Connection 认证覆盖 API，表单写入仍在那里无效。共享的代码工作工具偏好单独提供浏览器本地变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只把 `settings.section` ledger 投影为导航，不发出 Cordis 事件，也不持有跨插件可变关系；slot core 会在加载时拒绝冲突。
