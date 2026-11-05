# Agent Note: 官方连接器的“连接器”标签页

Status: implemented

[English](2026-11-01-connectors-tab.md) | 中文

## 问题

官方连接器 bundle（飞书、企业微信、钉钉、腾讯会议、Notion、腾讯文档和 Linear）都是单独安装的包。安装前，插件页上看不到任何连接器信息；安装后，连接器和其他已安装的 bundle 混在一起。用户需要一个入口：列出所有官方连接器，能安装未安装的连接器，并能进入连接器自己的详情页，在那里连接账号。关闭这个入口，就关闭所有连接器。

## 决策

实验性可选的 [“连接器”bundle](../../../../packages/experimental/connectors-bundle/README.zh.md) 默认关闭，并声明 `dsh.bundle.listedByDefault: false`，插件页只在它开启后才列出它；它通过 `plugins.tab` 挂载 [“连接器”标签页](../../../../packages/experimental/client-ui-connectors/README.zh.md)。入口做成标签页而不是 bundle 详情页，是因为只有标签页的 owner props 带有 `install`，以及打开后能返回该标签页的 `openPackage`；从另一个 bundle 的详情页打开的页面，插件管理器不保留导航栈。

[`dsh-official-bundles`](../../../../packages/util/official-bundles/README.zh.md) 的 `CONNECTOR_BUNDLES` 按标签页的顺序列出连接器。标签页自带每个连接器在所有随附语言中的名称和简介以及品牌图标，并显示连接器卡片上的那个开关：插件页通过标签页的 owner prop `renderEnableSwitch` 渲染它；打开未安装连接器的开关，会通过插件页的安装对话框安装 `<包名>@<DSH_CLIENT_VERSION>` 并开启它。连接器包保持单独安装，不加入 `ON_DEMAND_BUNDLES`；撤掉实验后，所有连接器仍可用 `dsh plugin add` 安装。

“已安装”标签页的卡片列表始终不显示连接器，它们的详情页从标签页打开。bundle 的 Host 入口提供 `connectors` 服务，每个官方连接器的条目都声明 `inject: [connectors]`，所以 bundle 关闭期间，Loader 让连接器保持等待。无论从插件页、设置还是 CLI 关闭“连接器”，所有连接器都会停止，各自的开关状态保持不变；重新开启后，它们恢复运行。自定义 MCP 服务器仍保存在 MCP 管理器的设置中，不受这个开关影响。

## 考虑过的替代方案

**随标签页撤销的认领。** `pluginNavigation.claim` 只在标签页存在期间把连接器移出卡片列表。关闭“连接器”后，已开启的连接器回到“已安装”并继续运行，这个开关没有让它们停下。

**随 bundle 一起关闭连接器。** 插件页可以在关闭这个 bundle 时一并关闭连接器。但这只覆盖插件页自己的开关，每关一个连接器 Host 都要重新加载一次，还会覆盖每个连接器自己的开关状态。bundle 自己也做不到：那一刻它的代码正在卸载，和重启时一样。

**按 bundle 的选择给条目加条件。** `disabled: !!js` 只在 Loader 决定是否挂载条目时求值，`profileContext.startedBundles` 保存的是启动时的选择，所以条目无法跟随之后的开关。

**把连接器加入官方按需目录。** 目录能离线提供元数据、安装前的详情页和开发环境的 `link:` 安装；但它会让每个连接器都成为必须带图标的官方目录成员，而且除非再额外隐藏，未安装的连接器会出现在插件页自己的分组里。

**在“连接器”bundle 卡片的详情页上展示。** `plugins.bundle.config` 页面无法安装未安装的连接器，从它打开的连接器详情页会返回主列表，而且 bundle 自己的子行和来源区块始终显示在内容下方。

**用现有名单隐藏连接器。** `HIDDEN_BUNDLES` 会连同承载账号区块的详情页一起移除，`listedByDefault: false` 仍会列出已安装的 bundle，`MORE_BUNDLES` 只适用于官方 bundle。

## 后果

从标签页安装要求连接器包已按当前 DSH 版本发布；开发构建改用 `dsh plugin add` 安装连接器。在任何 profile 中，连接器都只在实验性的“连接器”bundle 开启时运行。新增官方连接器时，要把包名加入 `CONNECTOR_BUNDLES`，把名称、简介和图标加入标签页，并在它的条目上声明 `inject: [connectors]`。标签页不显示账号连接状态，连接状态在连接器的详情页查看。
