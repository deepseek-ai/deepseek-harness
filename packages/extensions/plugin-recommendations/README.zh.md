---
description: "针对用户明确表达的需求推荐内置官方插件和官方连接器，并通过会话内卡片启用或安装。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-recommendations

[English](README.md) | 中文

## 概述

用户讨论某个需求、或问 DSH 里某件事怎么做时，可以发现相关的内置插件；任务要用到某个应用时（例如飞书），可以发现这个应用的官方连接器。Agent 先正常回答，再在本轮完成后提供一张卡片：可以打开详情、点击启用或选择暂不需要；profile 里还没有的连接器则提供「安装并启用」。启用会修改整个 profile，并在重启后保留。Agent 在下一次请求时得知结果；点击本身不会开始新的模型轮次。已启用的连接器的卡片提供「连接账号」，点击后打开插件页里它的详情页。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Web 和桌面端组合（[`dsh-web-app`](../../bundle/web-app/README.zh.md)）会挂载本包、共享的[操作卡片服务](../../interaction/action-cards/README.zh.md)及其浏览器端。“设置 → 通用设置 → 个性化推荐”可以关闭新卡片。本插件没有自己的配置项。

「个性化页面」行（`creation-recommendations`）停用后，插件推荐仍可使用，两个包互不依赖。两种卡片合计每轮最多一张：本轮第一个合格的 `action-card` 代码块成为卡片。多个独立需求时，指引优先遵循用户明确的优先级，否则现成插件优先于新建页面；其余需求在回答正文中说明。

### 结果与恢复

代码块所在的轮次结束后，卡片才会出现在回答下方。启用需要修改 profile 的权限。卡片显示时读取插件的目录文本，每次操作之后再读一次；查询被拒绝时显示原因，回复丢失时说明无法读取插件信息，两种情况都提供「暂不需要」和「重试」，不提供启用。用户操作时 Host 会重新检查插件是否在可推荐目录里。已保存的选择可能需要重启。失败的变更可在同一张卡片上重试；插件重载打断启用、结果未能确认时，卡片显示未确认，同样可以重试；那次启用之后生效的，下一次点击卡片会显示「已启用」。已在别处开启的插件会直接记为已启用，不再改动。后续轮次出现新提案时，尚未处理的卡片仍提供「启用」和「暂不需要」。响应丢失时结果暂不确定，Session 投影重连后会恢复；重复点击卡片是幂等的。

如果插件页的「连接器」标签页（随安装提供的一个 bundle）还没开启，「安装并启用」会先开启它；这一步失败只记日志，安装照常继续。之后按当前运行的 DSH 版本安装连接器包，保存确切版本并启用连接器；安装时装上别的包或别的版本会被撤销；这次安装等待期间，如果另一张卡片或插件页已经装好了这个连接器，卡片改为启用已装好的连接器。pnpm 因连接器依赖的安装脚本而停止安装时，卡片列出这些脚本，并提供「允许这些脚本并重试」：在 profile 里只允许列出的这些脚本，然后重新安装。其他原因导致的安装失败，可以在卡片上重试，也可以到插件页的「连接器」里安装；插件重载打断的安装和启用一样显示为未确认。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

Host 入口是函数插件。它的 `apply` 通过 `ctx.plugin` 组装内部的 `pluginRecommendations` Remote service；该 service 为卡片读取目录文本，并为本卡片种类启用插件。它不是可单独配置或替换的 YAML 条目，也不会向 `dsh-base` 添加 service。关闭功能会移除它的 skill、卡片种类和 Remote，并等待它拥有的启用操作结束。

本插件不添加模型工具，也不添加 system prompt 段。它注册 `official-plugins` skill，加载时追加来自 `pluginManager` 的当前可推荐目录，之后是 [`dsh-official-bundles`](../../util/official-bundles/README.zh.md) 里生成的 `OFFICIAL_CONNECTOR_CATALOG` 中的官方连接器，每项带 profile 是否持有（`installed`）和是否选用（`enabled`），分类方式和卡片相同：profile 未持有的连接器两项都是 false，已安装但卡片无法启用的连接器不列出，和不可推荐的插件一样。这个 skill 的目录条目根据一次 `listBundles()` 的结果组成：固定的开头和结尾之间是一个从句，用连接器的英文标题、按连接器目录里的顺序列出卡片此刻能推荐其连接器的应用，即 profile 未持有该连接器，或者已安装、可用但没有开启；没有这样的连接器时不写这个从句。第一次查询组成条目，之后的查询不论工作目录或作用域都沿用它，直到 Plugin Manager 在每次操作后发出的 `plugin-manager/changed` 把它丢弃，并让缓存的目录失效。`listBundles()` 失败的结果不会保留：这次查询不列出这个 skill，skill 注册表会记日志并把这次结果标为不完整，下一次查询重新读取列表。如果某次查询在共享的读取进行中被取消，这次查询会停下，读取本身照常完成，供其他查询使用。加载得到的定义带的是这次查询列出的条目。

本插件向共享的[操作卡片服务](../../interaction/action-cards/README.zh.md)注册 `enable_official_plugin` 种类：`details` 带插件的 `name`，动作 `enable` 和 `approve` 都需要全局 Remote 权限。卡片投影、「暂不需要」、Remote 操作和状态通知都由共享服务负责。本插件通过 Plugin Manager 启用指定插件；profile 未持有的连接器，则用 `installBundle` 按 `<name>@<DSH 版本>` 安装，保存确切版本，装上别的包或版本会被拒绝。之后记录 `enabled`、`already-enabled`、`failed` 或 `unconfirmed`；Plugin Manager 报告变更失败或已取消时记为 `failed`。只有当卡片最近一次决定是记录了 `pendingBuilds` 的失败时，才接受 `approve`；它只允许记录下来的这些脚本并重新安装，不采用浏览器发来的包名；如果这时 profile 已经持有这个连接器，它像 `enable` 一样启用连接器，不允许任何脚本。在连接器卡片上执行 `enable` 或 `approve` 之前，如果「连接器」标签页的 bundle 在列表里、可推荐且没有开启，本插件会先开启它；开启之后和开启之前一样再检查一次：本插件正在卸载时拒绝操作（`closing`），卡片所在的会话已不是活动的根会话时也拒绝（`not-live-root`）。`unconfirmed` 表示插件重载打断了启用或安装、没有拿到结果。这类卡片在每次操作前（包括「暂不需要」）都会检查 profile，发现插件已开启就记为 `enabled`，不再重试或记为忽略。未处理、失败和未确认的卡片可以记为「暂不需要」。

保存的选择要等重启才生效时，决定数据带 `application: restart-required`；变更失败时带插件管理的 `errorCode`，Plugin Manager 拒绝变更但没有给出代码时带 `operation-error`；pnpm 因安装脚本停止安装时（包失败类型为 `build-blocked`），等待允许的安装脚本记在 `pendingBuilds` 里，其他失败不记录，因为任何一次运行失败后，Plugin Manager 都会列出 profile 里所有尚未决定的脚本。状态通知只报告 `application` 和 `errorCode`。

已随安装提供、可选、官方、可读取、可写且无错误的插件可以推荐，列出的连接器也可以：profile 未持有时安装它，已安装的同样要求可读取、可写且无错误。名字在用户操作时检查，而不是在模型提议时。Remote `describe(sessionId, cardId)` 返回卡片对应插件当前的标题、描述和启用状态，已安装的连接器另带 `connector: true`；profile 未持有的连接器返回 `installable`，并带连接器目录里所有随附语言的标题和描述；其他情况返回拒绝原因。

同一张卡上的并发操作共用一次执行；卸载时停止本地后续处理，不等待排在自身 HMR 卸载之后的 profile 变更。已接纳的变更由 Plugin Manager 负责完成；结果未确认的卡片再次点击时会重新检查 profile。安装状态由 profile 文件负责，卡片决定只记录历史结果。

- [源码](src/index.ts) — 注册与服务入口。
- [测试](tests/) — 操作、恢复和生命周期验证。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [插件管理器](../../boot/plugin-manager/README.zh.md) — 配置档案变更。
- [操作卡片](../../interaction/action-cards/README.zh.md) — 卡片代码块、卡片状态和用户操作。
- [推荐卡片](../../client/ui-plugin-recommendations/README.zh.md) — 卡片正文。
- [个性化页面](../creation-recommendations/README.zh.md) — 另一种卡片。

<a id="model-experience"></a>
## 模型体验

### 官方插件推荐

#### 模型可见内容

用户问 DSH 里某件事怎么做、DSH 能不能做某件事，或者说缺少某种能力、希望它换一种工作方式时，例如输入方式、思考内容或标题的显示、搜索会话、终端、工作树、桌面操作、自动化、访问权限、授权确认、输出徽章或签名、插件源，或者任务要用到某个应用、而卡片能推荐这个应用的连接器时，现有的 `skill` 工具会加载 `official-plugins`。目录条目根据 profile 的状态组成：在飞书、企业微信、钉钉、腾讯会议、Notion、腾讯文档和 Linear 之中，只列出 profile 未持有其连接器、或者持有但没有开启的应用，所以任务要用到的应用的连接器已经启用时，不会加载这个 skill。目录条目告诉 Agent 这类问题不是要开发 DSH，并要求在读取文件之前先加载它。加载结果包含匹配规则、提交方式，以及当前目录中的名称、英文标题和描述，以及启用状态；连接器条目还带 `installed`。已启用的插件只说明用法、不出卡，已启用但账号没有连接的连接器除外；只覆盖部分需求时说明限制。用户本轮自己的请求要用到某个应用、而 Agent 用不了这个应用时，普通任务也会推荐它的连接器：连接器没有启用，或者已经启用但账号没有连接；后一种情况下，卡片上的「连接账号」会打开连接器的详情页。回答里用一句话说明连接账号之后可以继续这项任务；如果 Agent 已有某个工具属于这个应用，例如它的 MCP 服务器，就不推荐，而是直接用那个工具。其他任务、引用中的愿望、只讨论和明确不要推荐的请求不出卡。提案是写在最终回答末尾的一个 [`action-card` 代码块](../../interaction/action-cards/README.zh.md#model-experience)：`action: "enable_official_plugin"`、插件在目录中的 `title`、一句用户语言的 `brief`，以及带目录 `name` 的 `details`；代码块本身就是提交，用户看不到它，点击启用前什么都不会改变。卡片只显示插件在目录中的标题和描述，所以代码块之前的回答要用用户的语言、一句话说明这个插件如何满足需求；`brief` 就是这同一句话。代码块之前紧挨着最多一句简短的邀请，请用户点击下方的启用（profile 未持有的连接器则是「安装并启用」，已启用的连接器则是「连接账号」），并且不把没有开启的插件说成已经开启。点击后的下一次请求会带共享的状态通知和本种类的说明：它是事实，不是继续工作的要求；启用一个插件也不授权该插件之外的任何事；已启用的连接器要等用户连接账号后才能使用。

#### Token 影响

推荐开启时，Skill 目录包含一条根据 profile 状态组成的摘要：没有可推荐的连接器时为 408 字符，7 个应用全部列出时最多 498 字符，低于 500 字符的上限。条目变化时（例如启用连接器之后），会追加一条替换目录，见 [tool-skill](../../skill/tool-skill/README.zh.md#model-experience)。创造模式会排除这一项。一次 skill 加载追加约 10.4K 字符的正文：4,258 字符的规则，加上目录；在 macOS 上，18 个可推荐插件和 7 个连接器（标题和描述仅保留英文）的目录约 6.2K 字符，其中连接器约 1.3K，目录随插件数量增长。一次推荐需要加载一次 skill，最终回答里的 `action-card` 代码块是回答的一部分；回放中的代码块为 237 字符，按每 4 字符 1 个 token 计约 59 个 token。状态变化的卡片会在下一次请求追加一条简短通知。

#### KV Cache 影响

Skill 内容和提案代码块追加到对话记录；公共 system prompt 和工具声明都不变，见[操作卡片](../../interaction/action-cards/README.zh.md#model-experience)。启用被推荐的插件或安装连接器，可能改变之后的工具声明及其缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

人工运行的真实模型输入集见 `evaluation/intent-cases.json`；单元测试不衡量语义意图准确率。匹配、多需求之间的取舍以及尊重不推荐的要求都属于 skill 指引，通过真实模型测试评估，不是关键词判断。

- 只推荐已随安装提供、可选的官方插件和 7 个官方连接器；第三方注册源不在范围内。
- 只要连接器包已按当前运行的 DSH 版本发布到 npm，就能从卡片安装；运行版本没有发布的构建无法从卡片安装连接器。
- 账号在插件页里连接器的详情页连接；卡片只负责打开这个页面，不显示连接状态。
- 组成 skill 的目录条目要读取插件管理器的列表，在装有 28 个 bundle 的安装上需要 65–70 毫秒，每次启动和每次 Plugin Manager 变更后各读一次。不经过 Plugin Manager 的 profile 修改（例如手动编辑或 CLI 补丁）不会发出通知，所以条目要等下一次 Plugin Manager 变更或重启之后才跟上。
- 连接器目录编译进安装，所以新增的连接器要等新的 DSH 版本发布后才会出现在卡片上。连接器包不在目录里时有测试会失败，直到 `CONNECTOR_BUNDLES` 列出它并重新生成目录。
- 推荐需要会话的精确在线 Agent 实例，且 `origin` 不是 `subagent`；不会主动寻找推荐机会。
- 历史决定不会持续跟踪之后在插件页做的修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
