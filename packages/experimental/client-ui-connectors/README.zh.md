---
description: "启用插件页的“连接器”标签，用来列出、安装和打开官方连接器，并管理自定义 MCP 服务器。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-connectors

[English](README.md) | 中文

## 概述

开启“连接器”后，Web 或 Desktop 插件页的“已安装”旁会多出“连接器”标签。标签列出官方连接器及其品牌图标：未安装的可以按当前 DSH 版本安装，已安装的可以开启或关闭，也可以打开它的详情页，在那里连接账号。官方连接器下方列出自定义 MCP 服务器，可以添加、编辑、测试和删除，并显示 OAuth 服务器的账号。自定义服务器保存在 MCP 管理器的设置中，bundle 关闭时仍会运行。随附的 profile 默认不启用这个 bundle，插件页在“实验性插件”下列出它。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开**插件**，在**实验性插件**下启用**连接器**。也可在目标 [profile](../../boot/app-boot/README.zh.md#profiles) 的 `package.json` 中，将 `@deepseek-ai/dsh-client-ui-connectors` 加入 `dsh.profile.bundles`。之后“已安装”旁会出现“连接器”标签；关闭这个 bundle 会移除标签。

每一行以界面语言显示连接器的品牌图标、名称和简介。profile 未持有的连接器显示**安装**，点击后插件页的安装对话框直接进入检查步骤，安装目标是该连接器在当前 DSH 版本的包；安装完成后，对话框提供**立即启用**。构建中没有 DSH 版本时，不显示“安装”。已安装的连接器显示一个开关，连接器已启用时开关为开；这个开关启用或停用该连接器，和它在“已安装”标签中卡片上的开关一样。点这一行的其余位置会打开连接器的详情页，详情页的返回键会回到本标签。Host 未能应用更改时，标题下方会有一行文字指出是哪个连接器，开关显示 Host 报告的状态。已安装的连接器在“已安装”标签中保留自己的卡片和开关，无论这个 bundle 是否开启都会运行。

profile 运行 [MCP 管理器](../../mcp/mcp-manager/README.zh.md)、Settings 和凭据服务时，官方连接器下方会出现自定义服务器区块。每一行显示服务器的名称、URL 或命令和开关；已启用的 OAuth 服务器还显示账号状态。区块标题旁的**添加 MCP 服务器**和每一行的**设置**会打开服务器页面，取代标签中的列表，上方是**返回**。页面可以编辑远程服务器：填写 URL，选择无认证、Bearer 令牌或 OAuth（可选填 Client ID 和 Scope），并可添加请求头；也可以编辑本地命令：填写启动命令、每行一个参数、环境变量和可选的工作目录。新建的服务器保存后即为启用状态。Bearer 令牌和标为密钥的请求头或环境变量行保存在凭据服务中，设置里写入的是 `${credential:MCP_<名称>_<字段>}` 引用，不保存值本身。保存启用的本地命令前，会先请用户确认：它会以用户权限在这台电脑上运行，不经过沙箱。已保存服务器的页面在已启用且使用 OAuth 时显示账号区块，其中有**连接**、**退出登录**和**重试**；**测试连接**对已保存的条目运行管理器的探测，所以表单有未保存的修改时不可用，结果显示工具数量或失败原因。从 profile 组合继承的服务器可以编辑或关闭，但不能删除。页面上的**删除**会退出服务器的 OAuth 登录并删除它的密钥；编辑时去掉 OAuth 会先退出登录，每次保存编辑都会删除条目不再引用的密钥；两者都不会删除其他条目仍在引用的密钥。每次保存、删除和开关都由 Host 作为一次操作执行，遇到第一个被拒绝的步骤即停止。

配置项 `mcpManagerNamespace` 默认为 `mcp-manager`，指定管理器在 Settings 中的命名空间，即管理器那一行的 id。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

bundle 补丁插入本包自己的一行。Host 入口提供 `connectors` 服务，浏览器入口把标签注册到 `plugins.tab`。`ConnectorsController` 在标签首次渲染时读取 `pluginManager.listBundles`，收到 `plugin-manager/changed` 和 `connection/reset` 时再次读取，只采用最新一次读取的结果。已安装连接器的开关调用 `pluginManager.setBundleEnabled`，在写入之后的那次读取结束前保持禁用；调用被拒绝或应用结果为 `failed` 时，失败提示会指出该连接器，直到下一次切换开始。**安装**以 `<包名>@<DSH_CLIENT_VERSION>` 调用插件页提供的 `install`；已安装连接器的名称按钮覆盖整行，点击会调用 `openPackage`。每个连接器的品牌图标是其 bundle 所声明 `icon.svg` 的副本，放在 `src/client/assets/` 下。连接器名单以及每个连接器的名称、简介和图标都放在本包中，所以标签能显示 profile 尚未持有的连接器。

浏览器入口挂载生成的 `connectors` Remote；`remote.connectors` 和 `remote.mcpManager` 都存在后，自定义服务器区块注册到标签的 `connectors.custom` 子 slot。区块显示列表、新服务器的表单还是某个服务器的页面，由标签保存在自己的状态中，所以标签每次重新挂载时视图都从列表开始。标签把视图和设置它的函数作为 owner props 传入，并自己渲染**返回**，所以即使区块消失，**返回**也还在。`CustomServersController` 在区块首次渲染时、以及每次收到 `settings/document-updated` 后，通过 `connectors.listServers()` 读取服务器，并把每次修改作为一次调用发出：`saveServer(draft, revision)`、`removeServer(name, revision)` 或 `setServerEnabled(name, enabled, revision)`。Host 服务对过期的 revision 返回 `connectors/conflict`，区块报告冲突并重新读取；它用表单相同的规则校验草稿，对被去掉或删除的 OAuth 授权经管理器退出登录，经 Settings 写入条目，保存密钥，再删除条目不再引用的密钥，遇到第一个被拒绝的步骤返回 `connectors/refused`；写入被拒绝时不保存任何密钥，条目引用的密钥在写入之后才保存时，管理器会重新连接该条目。MCP 账号服务运行期间，Host 服务把每个配置的 OAuth 服务器以键 `mcp:<名称>` 登记到 `ctx.mcpAccounts`，文案中写出服务器名，并跟随命名空间的变化；每个已启用 OAuth 服务器的行以 `status` 形式渲染 [`ui-connector-account`](../../client/ui-connector-account/README.zh.md) 的 `connector.account` 组件工厂，已保存的 OAuth 服务器的页面以 `section` 形式渲染它。只在大小写、`-` 和 `_` 上不同的服务器名或行名会共用同一个凭据引用，因此会被拒绝；会把值存到同一个引用下的密钥行，以及自身 `MCP_<名称>_` 引用被其他服务器条目使用的保存，同样会被拒绝。

- [bundle 补丁](cordis.patch.yml)
- [Host 源码](src/index.ts)
- [浏览器源码](src/client/index.ts)
- [测试](tests/)

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [插件页](../../client/ui-plugin-manager/README.zh.md) — 页面标签和安装对话框。
- [MCP 管理器](../../mcp/mcp-manager/README.zh.md) — 自定义区块写入的服务器条目和它运行的探测。
- [MCP 账号](../../mcp/mcp-account/README.zh.md) — 使用 OAuth 授权的服务器的账号。
- [连接器账号界面](../../client/ui-connector-account/README.zh.md) — 显示账号区块或状态的组件工厂。

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自“安装”添加的连接器 bundle、开关启用或停用的连接器 bundle，以及保存的自定义 MCP 服务器：每个连接器负责自己面向模型的内容，每个已启用的自定义服务器通过 MCP 管理器提供工具，标签本身不增加工具或提示词。

#### KV Cache 效果

标签不增加模型上下文。安装连接器，或者开启、关闭连接器，会按该连接器的说明改变后续请求。添加、开关或删除自定义服务器会按管理器的说明改变后续请求的工具。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 名单只包含 DSH 发布的连接器；新增连接器时，要在这里加上它的包名、文案和图标。每一行的名称和简介是本包的文案，须跟随连接器自身的显示名称，没有检查比对两者。
- 每一行不显示账号连接状态，连接状态在连接器的详情页查看。选择**立即启用**后，连接器提供的账号引导显示在“已安装”标签中。
- 在本标签中开启连接器时不显示账号引导；更改需要重启才生效时，也不显示重启提示。连接器在“已安装”标签中卡片上的开关会显示这两项。本标签的开关不发送 `plugin_toggle` 分析事件。
- 安装要求连接器包已按当前 DSH 版本发布；开发构建改用 `dsh plugin add` 安装连接器。
- 自定义服务器与某个连接器的服务器同名时，条目存在期间该连接器无法加载，两者也共用 OAuth 授权 `mcp-client/<名称>`。
- 使用 OAuth 授权的服务器，名称只能包含小写字母、数字和 `-`，并以字母开头，因为名称构成其授权的凭据键。
- 本地命令以用户权限在 Host 上运行，不经过沙箱。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
