---
description: "启用插件页的“连接器”标签，用来列出、安装和打开官方连接器，并管理自定义 MCP 服务器。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-connectors

[English](README.md) | 中文

## 概述

开启“连接器”后，Web 或 Desktop 插件页的“已安装”旁会多出“连接器”标签。标签列出官方连接器及其品牌图标：未安装的可以按当前 DSH 版本安装，已安装的可以开启或关闭，也可以打开它的详情页，在那里连接账号。官方连接器下方列出自定义 MCP 服务器，可以添加、编辑、测试和删除，并显示 OAuth 服务器的账号。自定义服务器就是 profile 的 MCP 服务器行，bundle 关闭时仍会运行。随附的 profile 默认不启用这个 bundle，插件页在“实验性插件”下列出它。

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

profile 运行 [MCP 管理器](../../mcp/mcp-manager/README.zh.md)、[配置编辑器](../../boot/config-editor/README.zh.md)、[插件管理器](../../boot/plugin-manager/README.zh.md)和凭据服务时，官方连接器下方会出现自定义服务器区块。区块列出 profile 组合中的每一个 MCP 服务器行，无论这一行由 profile 补丁添加，还是由 bundle 等其他组合层添加，也无论它是开启还是关闭。连接器注册的服务器没有对应的行，不在列表中。每一行显示默认插件图标、服务器的名称、URL 或命令和开关。已开启且使用 OAuth 的服务器还显示账号状态，已开启但未能启动的服务器显示原因。表单无法读取的行显示**无法识别的条目**，既不能打开也不能开关：它的配置没有 `serverName`，或者指定了 `stdio` 和 `streamable-http` 之外的传输方式，或者含有 `!!js` 表达式。

**添加 MCP 服务器**和区块一同出现，位于标签顶部**官方连接器**标题所在行的末端。它和每一行的**设置**会打开服务器页面，页面取代插件页的标题、标签以及本标签中的列表；上方的**连接器**面包屑回到列表，不保存修改。页面可以编辑远程服务器：填写 URL，选择无认证、Bearer 令牌或 OAuth（可选填 Client ID 和 Scope），并可添加请求头；也可以编辑本地命令：填写启动命令、每行一个参数、环境变量和可选的工作目录。新建的服务器保存为 profile 补丁中的 `mcp-server-<名称>` 行，保存后即为开启状态，名称此后不能更改。保存已有的服务器时，表单所编辑的字段被替换，行的其他字段保持不变；OAuth 服务器还保留 `oauth` 中 Client ID 和 Scope 之外的字段，其中包括其授权的凭据键。行没有写凭据键时，保存会写入 `mcp-client/<名称>`。Bearer 令牌和标为密钥的请求头或环境变量行保存在凭据服务中，行里写入的是 `${credential:MCP_<名称>_<字段>}` 引用，不保存值本身。

本地命令以用户权限在这台电脑上运行，不经过沙箱，所以在它启动之前，标签会先请用户确认：保存本地命令时（服务器处于关闭状态的除外），以及打开本地命令的开关时。保存之后，已开启的服务器必须在运行：它的行用保存的配置无法启动时，Host 恢复 profile 补丁并报告原因。关闭的服务器保存时不会启动，所以其中被 MCP 管理器拒绝的内容，要到开启服务器时才显示。打开开关后未能启动的服务器保持开启状态，并在它的行和页面上显示原因。

已保存服务器的页面在服务器已开启且使用 OAuth 时显示账号区块，其中有**连接**、**退出登录**和**重试**。**测试连接**在服务器开启期间出现；它对已保存的行运行管理器的探测，所以表单有未保存的修改时不可用，结果显示工具数量或失败原因。页面打开期间，它的服务器在别处被删除，或者它的行变成表单无法读取的行时，一条提示会取代表单和其中未保存的修改，面包屑回到标签中的列表。

页面上的**删除**会移除 profile 补丁添加的行，同时删除服务器的 OAuth 授权和为它保存的密钥。其他组合层添加的行可以编辑或关闭，但不能删除。编辑时去掉 OAuth 会先删除授权，每次保存编辑都会删除这一行不再引用的密钥。删除和编辑都不会删除其他行仍在引用的密钥，无论那一行是开启还是关闭。每次保存、删除和开关都由 Host 作为一次操作执行，遇到第一个被拒绝的步骤即停止。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

bundle 补丁插入本包自己的一行。Host 入口提供 `connectors` 服务，浏览器入口把标签注册到 `plugins.tab`。`ConnectorsController` 在标签首次渲染时读取 `pluginManager.listBundles`，收到 `plugin-manager/changed` 和 `connection/reset` 时再次读取，只采用最新一次读取的结果。已安装连接器的开关调用 `pluginManager.setBundleEnabled`，在写入之后的那次读取结束前保持禁用；调用被拒绝或应用结果为 `failed` 时，失败提示会指出该连接器，直到下一次切换开始。**安装**以 `<包名>@<DSH_CLIENT_VERSION>` 调用插件页提供的 `install`；已安装连接器的名称按钮覆盖整行，点击会调用 `openPackage`。每个连接器的品牌图标是其 bundle 所声明 `icon.svg` 的副本，放在 `src/client/assets/` 下。连接器名单以及每个连接器的名称、简介和图标都放在本包中，所以标签能显示 profile 尚未持有的连接器。

浏览器入口挂载生成的 `connectors` Remote。`remote.connectors` 和 `remote.mcpManager` 都存在后，它把自定义服务器区块注册到标签的 `connectors.custom` 子 slot，把**添加 MCP 服务器**注册到标签的 `connectors.actions` 子 slot，两者读取同一个 `CustomServersController`。`connectors.actions` 是 list slot，标签显示列表时把它渲染在第一个标题所在行的末端。区块的视图是列表、新服务器的表单或某个服务器的页面。表单和服务器页面是标签在插件页上自己的页面：标签用插件页提供的 `openPage` 以 `new` 或 `server:<行 id>` 为 key 打开它们，用 `closePage` 回到列表，并从收到的 `page` 得出视图。因此面包屑由插件页绘制，即使区块消失也还在；用户离开**插件**后，视图从列表开始。标签把视图和设置它的函数作为 owner props 传给区块，把设置函数传给每个操作。`CustomServersController` 在区块首次渲染时打开 Remote 的 `watchServers` 流，并把每次修改作为一次调用发出，调用中带上这次修改所依据的列表 revision：`saveServer(draft, revision, id?)`、`removeServer(id, revision)` 或 `setServerEnabled(id, enabled, revision)`。流失败后保持关闭，直到用户点击**重试**。

Host 服务从 [`ctx.configEditor.configuration()`](../../boot/config-editor/README.zh.md) 读取行：模块为 `@deepseek-ai/dsh-mcp-manager/server` 的每一行，连同它是否关闭、是否在运行或为什么没有运行、是否由 profile 补丁添加，以及表单能读取时它按原样写出的配置。`watchServers` 在订阅时发送列表，并在每次 `app-boot/config-reload`、每次 `plugin-manager/changed` 以及每次经本服务做出的修改之后再次发送。列表的 revision 是一个摘要，涵盖各行的 id、配置和开关，以及哪些行由 profile 补丁添加。配置编辑器、插件管理器、凭据服务或 MCP 管理器缺失期间，服务返回 `{ available: false }`，区块不渲染任何内容。

Host 服务一次只执行一个修改。它对过期的 revision 返回 `connectors/conflict`，区块报告冲突后重新打开流；遇到第一个被拒绝的步骤时返回 `connectors/refused`。保存时，服务用表单自己的规则和行插件的 `Config` 校验草稿，删除被去掉的 OAuth 授权，用编辑器的 `insert()` 或 `editRow()` 写入行，保存密钥，再删除这一行不再使用的密钥。写入被拒绝时不保存任何密钥；行引用的密钥保存之后，管理器会重新连接已写入的行。删除时，服务删除授权，调用编辑器的 `remove()`，再删除服务器的密钥。开关调用 `pluginManager.setPluginEnabled`，由它把开关写入 profile 补丁；`applied` 之外的任何结果都是拒绝。已开启的服务器的授权通过 `mcpManager.signOut` 删除。对于关闭或未能启动的服务器，服务从凭据服务中删除它的 `oauth.credentialKey` 所指的记录，除非另一个服务器行指向同一条记录，或者管理器中某个服务器的名称构成了这条记录的键：连接器的服务器把授权保存在 `mcp-client/<名称>` 下。

MCP 账号服务和配置编辑器运行期间，Host 服务把每个已开启的 OAuth 服务器行以键 `mcp:<名称>` 登记到 `ctx.mcpAccounts`，文案中写出服务器名，并跟随与流相同的变化。每个这样的行以 `status` 形式渲染 [`ui-connector-account`](../../client/ui-connector-account/README.zh.md) 的 `connector.account` 组件工厂，它的页面以 `section` 形式渲染。只在大小写、`-` 和 `_` 上不同的服务器名会共用同一个凭据引用，因此会被拒绝；同一个服务器中对应到同一个引用的请求头名或环境变量名同样会被拒绝。以下情况的保存也会被拒绝：其中两个密钥行会把值存到同一个引用下；另一个行使用了它自身的某个 `MCP_<名称>_` 引用；草稿把一个已保存的密钥留在保存后的行不使用的引用下；或者某个请求头或环境变量行名为 `__jsExpr`，Loader 会把它当作 `!!js` 表达式求值。

- [bundle 补丁](cordis.patch.yml)
- [Host 源码](src/index.ts)
- [浏览器源码](src/client/index.ts)
- [测试](tests/)

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [插件页](../../client/ui-plugin-manager/README.zh.md) — 页面标签和安装对话框。
- [MCP 管理器](../../mcp/mcp-manager/README.zh.md) — 自定义区块写入的服务器行和它运行的探测。
- [配置编辑器](../../boot/config-editor/README.zh.md) — 写入 profile 补丁的行操作。
- [插件管理器](../../boot/plugin-manager/README.zh.md) — 行的开关，以及 profile 如何应用它。
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
- 自定义服务器不能与已加载连接器注册的服务器同名，因为管理器拒绝同一个名称的第二次注册：以这个名称保存会被拒绝；这样的连接器与已有的自定义服务器一同加载时，两者中后注册的那个无法启动。两者的 OAuth 授权也都会保存在 `mcp-client/<名称>` 下。
- 区块按原样显示行的配置，所以组合文件中以明文而不是凭据引用保存的密钥会出现在表单中。
- 配置被 home 补丁或命令行覆盖文件覆盖的行无法保存；由这类组合层决定的开关也不会改变。
- 在没有启用热重载（HMR）的 profile 中，开关保存到 profile 补丁，下次启动时生效；标签会报告这一点，并继续显示运行中的状态。
- 服务器页面保留打开时的值：页面打开期间这一行在别处发生变化时，保存会用页面上的值替换表单所编辑的字段。
- 在标签之外做出的修改（例如手工编辑 profile 补丁）引入了无法启动的行时，Host 会应用这次修改，但不发送列表，因为 `app-boot/config-reload` 只在没有引入失败行的重新组合之后发出。已打开的标签要到下一次列表才显示这次修改。
- 行没有写凭据键的 OAuth 服务器，名称只能包含小写字母、数字和 `-`，并以字母开头，因为这时名称构成其授权的凭据键。
- 本地命令以用户权限在 Host 上运行，不经过沙箱。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
