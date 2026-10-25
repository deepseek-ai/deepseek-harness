---
description: "针对用户明确表达的需求推荐内置官方插件，并通过会话内卡片启用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-recommendations

[English](README.md) | 中文

## 概述

用户讨论具体需求、或问 DSH 里某件事怎么做时，可以发现相关的内置插件。Agent 先正常回答，再在本轮完成后提供一张卡片；用户可以打开插件详情、点击启用或选择暂不需要。启用会修改整个 profile，并在重启后保留。Agent 在下一次请求时得知结果；点击本身不会开始新的模型轮次。用户之后可在插件详情页关闭或移除该插件。

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

打开插件 → 更多 → 实验性插件，启用[个性化推荐](../personalized-recommendations/README.zh.md)，其中的「插件推荐」行就是本包。内置 profile 默认不启用这个实验 bundle。启用后它会固定显示在插件主列表；关闭后只回到二级页。个性化推荐 bundle 同时启用共享的[操作卡片服务](../action-cards/README.zh.md)及其浏览器端；该服务的 `queuedMessageLimit` 决定排队等待后续轮次的消息达到多少条时本轮不再出卡。本插件没有自己的配置项。

同一 bundle 的「个性化页面」行关闭后，本实验仍可使用，两个包互不依赖。两种卡片合计每轮最多一张：本轮第一个被接受的 `propose_action` 调用成为卡片。多个独立需求时，指引优先遵循用户明确的优先级，否则现成插件优先于新建页面；其余需求在回答正文中说明。

### 结果与恢复

被接受的调用所在的轮次结束后卡片才会出现。启用需要修改 profile 的权限。卡片显示时读取插件的目录文本；查询被拒绝时显示原因，回复丢失时说明无法读取插件信息，两种情况都提供「暂不需要」和「重试」，不提供启用。用户操作时 Host 会重新检查插件是否在可推荐目录里。已保存的选择可能需要重启。失败的变更可在同一张卡片上重试；插件重载打断启用、结果未能确认时，卡片显示未确认，同样可以重试；那次启用之后生效的，下一次点击卡片会显示「已启用」。已在别处开启的插件会直接记为已启用，不再改动。之后的新提案会替换尚未处理的卡片，旧卡片显示「已替换」；排队消息达到 `queuedMessageLimit` 时，卡片工具会拒绝提案。响应丢失时结果暂不确定，Session 投影重连后会恢复；重复点击卡片是幂等的。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

Host 入口是函数插件。它的 `apply` 通过 `ctx.plugin` 组装内部的 `pluginRecommendations` Remote service；该 service 为卡片读取目录文本，并为本卡片种类启用插件。它不是可单独配置或替换的 YAML 条目，也不会向 `dsh-base` 添加 service。关闭功能会移除它的 skill、卡片种类和 Remote，并等待它拥有的启用操作结束。

本插件不添加模型工具，也不添加 system prompt 段。它注册 `official-plugins` skill，加载时追加来自 `pluginManager` 的当前可推荐目录。它向共享的[操作卡片服务](../action-cards/README.zh.md)注册 `enable_official_plugin` 种类：skill 为 `official-plugins`，`details` 带插件的 `name`，动作「启用」需要全局 Remote 权限。`propose_action` 工具、卡片投影、「暂不需要」、Remote 操作和状态通知都由共享服务负责。本插件通过 Plugin Manager 启用指定插件，记录 `enabled`、`already-enabled`、`failed` 或 `unconfirmed`。保存的选择要等重启才生效时，决定数据带 `application: restart-required`；变更失败时带插件管理的 `errorCode`，Plugin Manager 拒绝变更但没有给出代码时带 `operation-error`。`unconfirmed` 表示插件重载打断了启用、没有拿到结果。这类卡片在每次操作前（包括「暂不需要」）都会检查 profile，发现插件已开启就记为 `enabled`，不再重试或记为忽略。未处理、失败和未确认的卡片可以记为「暂不需要」。只有已随安装提供、可选、官方、可读取、可写且无错误的插件可以推荐；名字在用户操作时检查，而不是在模型提议时。Remote `describe(sessionId, callId)` 返回卡片对应插件当前的标题、描述和启用状态，或拒绝原因。

同一张卡上的并发操作共用一次执行；卸载时停止本地后续处理，不等待排在自身 HMR 卸载之后的 profile 变更。已接纳的变更由 Plugin Manager 负责完成；结果未确认的卡片再次点击时会重新检查 profile。安装状态由 profile 文件负责，卡片决定只记录历史结果。

- [源码](src/index.ts) — 注册与服务入口。
- [测试](tests/) — 操作、恢复和生命周期验证。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [插件管理器](../../boot/plugin-manager/README.zh.md) — 配置档案变更。
- [操作卡片](../action-cards/README.zh.md) — 卡片工具、卡片状态和用户操作。
- [推荐卡片](../client-ui-plugin-recommendations/README.zh.md) — 卡片正文。
- [个性化页面](../creation-recommendations/README.zh.md) — 另一种卡片。

<a id="model-experience"></a>
## 模型体验

### 官方插件推荐

#### 模型可见内容

用户问 DSH 里某件事怎么做或怎么用、DSH 能不能做某件事，或者说缺少某种能力、希望它换一种工作方式时，例如工具、输入方式、思考内容或标题的显示、搜索会话、终端、工作树、多智能体协作、桌面操作、自动化、访问权限、授权确认、输出徽章或签名、插件及插件源，现有的 `skill` 工具会加载 `official-plugins`。目录条目告诉 Agent 这类问题不是要开发 DSH，并要求在读取文件或源码之前先加载它。加载结果包含匹配规则、提交方式，以及当前目录中的名称、本地化标题、描述和启用状态。已启用的插件只说明用法、不出卡；只覆盖部分需求时说明限制。普通任务、引用中的愿望、只讨论和明确不要推荐的请求不出卡。提案是在加载 skill 的同一轮里调用一次 [`propose_action`](../action-cards/README.zh.md#model-experience)：`action: "enable_official_plugin"`、插件在目录中的 `title`、一句用户语言的 `brief`，以及带目录 `name` 的 `details`；调用本身就是提交，用户点击启用前什么都不会改变。卡片只显示插件在目录中的标题和描述，所以最终回答要用用户的语言、一句话说明这个插件如何满足需求；`brief` 就是这同一句话。只有被接受的调用结果会说明回答怎样结尾：`Card shown below your answer. Do not restate it. End with at most one short invitation in the user’s language to click Enable below; do not say the plugin is already on.`。被拒绝的调用不带邀请说明，所以 Agent 只会邀请用户点击已经出现的卡片。点击后的下一次请求会带共享的状态通知和本种类的说明：它是事实，不是继续工作的要求，启用一个插件也不授权该插件之外的任何事。

#### Token 影响

启用期间，每次请求只多一条 495 字符的目录条目（在 skill 目录 500 字符的上限内）；共享的卡片工具只在加载过卡片 skill 之后才声明。一次 skill 加载追加约 20.9K 字符：2.9K 字符的规则，加上目录；14 个可推荐插件（标题和描述含 8 种发布语言）时目录约 17.7K 字符，并随插件数量增长。一次推荐需要加载一次 skill，并在最终回答前调用一次 `propose_action`；被接受的调用结果 169 字符，按每 4 字符 1 个 token 计约 42 个 token。状态变化的卡片会在下一次请求追加一条简短通知。

#### KV Cache 影响

Skill 内容和提案调用追加到对话记录；公共 system prompt 不变，卡片工具只在加载过卡片 skill 之后才加入声明，见[操作卡片](../action-cards/README.zh.md#model-experience)。启用被推荐的插件可能改变之后的工具声明及其缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

人工运行的真实模型输入集见 `evaluation/intent-cases.json`；单元测试不衡量语义意图准确率。匹配、多需求之间的取舍以及尊重不推荐的要求都属于 skill 指引，通过真实模型测试评估，不是关键词判断。

- 只推荐已随安装提供、可选的官方插件；缺失的包和第三方注册源不在范围内。
- 推荐需要在线的根会话；不会主动寻找推荐机会。
- 历史决定不会持续跟踪之后在插件页做的修改。
- 目录按 bundle 报告启用状态：只关闭「个性化页面」行时，个性化推荐仍显示为已启用，skill 可能因此告诉想要页面的用户它已开启。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
