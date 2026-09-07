# Agent Note: 由插件自己拥有的设置表层

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-plugin-owned-settings-surface.md) | 中文

## Problem

注册了 settings 命名空间的插件到不了浏览器配置页，而拦住它的两道门都在本仓库里。

`packages/host/apiproxy` 持有两份硬编码的命名空间清单。`settings.describe` 用它们过滤答复，每次写入也先对照它们，因此清单之外的命名空间即便其拥有方已注册，也只会得到 `settings-not-exposed`。于是把一个插件加进配置页，意味着要改一个插件作者并不拥有的包。

插件配置分区渲染的是注册进 `settings.plugin.item` 的卡片列表，无序。卡片携带的是不透明的 `id`，从不是它所编辑的命名空间，因此分区无从判断哪些被服务的命名空间已经有了归属。凡是"这个命名空间由谁渲染"的问题，都无法从分区看得见的账本里得到答案。

两者相加，用户自己写的插件就只能靠手改 `settings.yaml` 来配置。[web 插件配置 note](../feature/2026-08-10-web-plugin-configuration.zh.md) 把白名单记为刻意为之，[配置面边界 note](2026-07-30-config-plane-boundaries.zh.md) 则把「可在 Web 上配置」绑定到可配置提供方目录的成员资格。这两条结论恰恰挡住了那个通用 seam 本来要服务的插件作者。

## Decision

**注册即暴露。** api-proxy 服务 `ctx.settings.describe()` 返回的每一个命名空间，写入不设门禁。`WEB_SETTINGS_NAMESPACES`、`PRODUCT_SETTINGS_NAMESPACES`、与 `ctx.llm.listConfigurableProviders()` 的并集，以及 `settings-not-exposed` 错误码，全部删除。没有任何注册应答的名字——未知的，或格式非法因而根本无法寻址到注册的——都折叠为 seam 自己的 `settings-rejected`，于是代理既不贡献边界，也不贡献自己的词汇。

**settings seam 不动。** 哪个客户端可以读某个命名空间、哪个页面渲染它，都是关于 Consumer 的事实；Service Definition 只要携带其中之一，就等于让一个 Consumer 决定它的契约。`SettingsRegisterOptions` 一个字段都没加。

**`settings.plugin.item` 以 settings 命名空间为键。** 该 slot 从 `list` 改为 `keyed`，键就是卡片所编辑的命名空间，沿用 `tool.call.toolview` 的先例——每个工具插件把自己的渲染器注册在工具名这个键上。卡片声明 `key`，不再声明 `id`/`order`。该 slot 由「插件」分区的 `configurable` 标签页声明，卡片列表归它所有。

**标签页以被服务的命名空间驱动派发。** 它从 `ctx.settingsScope.describe()` 派生当前被服务的集合并跟随该共享 settings 镜像，自身的监听器只跟随卡片 slot 账本；随后为每个被服务的命名空间派发一个键。渲染出来的是两份账本的交集——存活 Host 插件注册的命名空间，以及注册在这些键上的卡片——由标签页的 controller 从 slot 账本（`ctx.slots.entries`、`ctx.slots.subscribe`）与镜像应答算出。后续的 [settings describe 镜像决策](2026-08-17-settings-describe-mirror.zh.md)持有浏览器全局的读取与失效生命周期。

以命名空间为键，让「缺席」本身成为信号，而这正是它消掉旧形态所需簿记的原因。归别的界面所有的命名空间（`ui-theme`、`permission`、`llm-*`、`agent-presets`）在其键上没有卡片，于是什么都不渲染，且无需在任何地方声明任何东西。命名空间未被本部署服务的卡片根本不会被派发，这同时修掉了旧的空态缺陷：标签页数的是已注册卡片，其中包含那些什么都不渲染的，因此一个都不暴露的部署看到的是空列表，而不是它那行空态文案。

**不渲染任何未被交给它的表单。** 标签页不提供兜底卡片。插件的浏览器半侧完整拥有自己的卡片——外观、控件与文案——而这正是 slot 的 `fallback` 选项会用一份 schema 反向渲染的表单取代掉的东西。

## 白名单实际护住了什么

这道门确实挡住了一样东西，本 note 如实写出，因为这个决策必须在准确版本下也站得住：不在名单上的已注册命名空间，其 resolved、`base` 与 `user` 值根本不会抵达浏览器。插件清单页不能替代它——`PluginInventoryEntry` 携带的是 `entryId`、`moduleName`、`enabled` 与 `fiberPhase`，它那一行「configuration」渲染的是启用／停用标签，从不是任何已存值。

这道门不是的，是它所处位置暗示的那种安全边界。Connection 在到达这段代码前认证每个 Host API 请求；`role('secret')` 字段在每种响应的每一层都被结构性剥离；而这个面所编辑的文档，本就是用户自己的 `settings.yaml`，同一个设置页还提供了打开它的入口。它没有挡住的写入，恰恰是有分量的那些：`permission`（能放宽审批预设）与 `agent-presets`（决定一个会话挂载什么）本来就已被服务。

因此本次改动在本仓库实际新增的暴露面是一个命名空间：`agent-default-model`——它的两个字段指明一个提供方与一个模型，且没有任何浏览器半侧渲染它。将来若某个命名空间的值确实不该跨越协议，由 `role('secret')` 逐字段作答：比整命名空间开关更精细，而且已经在执行。

## Alternatives considered

**在 `settings.register()` 上加声明**（`client: { surface: 'plugin-config' | 'custom', title, description }`），这也是被删掉的 `WEB_SETTINGS_NAMESPACES` 注释所点名的既定方向。它让注册默认不跨越传输边界，并让插件作者一行代码自助。否决的原因是 `surface` 是浏览器页面的词汇，而 `title`/`description` 属于呈现：Service Definition 一旦携带它们，就成了被单个 Consumer 塑形的 seam。它那条 fail-closed 性质的价值也不如读起来那么高——见上文「白名单实际护住了什么」。

**另设一份暴露目录**，插件在注册 settings 之外再加入这份自有注册表，即把 `ctx.llm.registerConfigurableProviders()` 一般化。否决的原因是它把一件事实拆成两处可能脱节的注册：注册了命名空间却忘了目录条目，产出的是一个谁都编辑不了的分节，而没有任何门禁看得见这个错误。

**给 api-proxy 加一个 deny-list `Config` 字段**，让部署方能扣下某个命名空间。因为没有消费者而否决：当前每一个已注册的命名空间都是用户可以编辑的，而真正敏感的字段由 `role('secret')` 逐字段作答，那是更精细的工具。在第一个用例出现之前就发明出来的整命名空间开关，正是包规则所禁止的投机选项。

**把 schema 驱动的通用卡片作为该 slot 的 `fallback`**，让没有浏览器半侧的插件也能从 `schema.toJSON()` 得到一份表单（schemastery 本就携带 `description`、`role`、`min`/`max`/`step` 并将其序列化）。否决的原因是客户端插件按已挂载的 Loader entries 在运行时加载，插件作者完全可以交付一张真正的卡片；而反向渲染的表单在模型页那次已被判定不如手写。若这个判断日后改变，`fallback` 选项无需改动契约即可启用。

**客户端认领注册表**，让每个拥有某命名空间的界面声明它，好让通用卡片知道哪些已经有人管。与通用卡片一并否决：keyed 派发本就让无人认领的键什么都不渲染，这份注册表只会把 slot 账本已经说过的话再说一遍。

**保留 list slot，只给它的 options 加一个命名空间字段。** 否决的原因是分区枚举的仍是 entry 而非命名空间，空态缺陷照旧，未组装插件的卡片也仍需自我抑制。

## Consequences

在本仓库之外分发的插件无需改动这里即可从设置页配置：它在 Host 上注册自己的命名空间、在浏览器里把卡片注册在该键上，由分区把两者配对。卡片现在按卡片注册顺序出现，而不再依赖手工指定的 `order`。对本包注册的这几张卡它是稳定的——它们从同一个 generator 安装；对**跨插件**的卡片它并不稳定：包与包之间的 apply 顺序是无约束的（`packages/client/AGENTS.md`），因此多个外部卡片仍可能在不同次启动之间重排。要为它们定序，需要一个 section 可排序的显式键，而 keyed 注册并不携带。

以下延后，且都大于本次改动：脱敏器对只能经由 union、intersection 或 transform 抵达的 `role('secret')` 原样返回（其自身的 `TODO(settings-wire-redaction)`），而 `schema.toJSON()` 会携带 secret 的默认值。该缺口早于本次改动，但服务每一个已注册命名空间，把它的影响面从本仓库内经审计的 schema 扩大到任意第三方 schema，因此协议应当拒绝服务它无法证明可安全脱敏的命名空间。同样延后的还有：对本次头号能力的组装态测试——用 overlay 挂载一个 fixture 插件（Host 半注册命名空间、`dsh.client` 半注册卡片）并在端到端断言。当前覆盖分别证明了两个半侧；已发卡片输出未变这一点，证明不了新路径。

分区与其中的卡片都不再新增 `settings.describe` 读取：两者都从浏览器全局的镜像派生。它的失效通知在一个方向上不精确：协议通告的是文档提交与连接重置，而非注册行为，因此在镜像当前应答之后才被注册的命名空间，要等下一次提交或重连才会加入。

对仓库之外的作者仍留有两处摩擦，均记在该分区的 README 里。浏览器半侧必须是按客户端模块系统的 lazy-CJS factory 格式构建的 `dsh.client` 包，而产出它的 `clientBundle` 预设位于 `packages/client/tsdown.client.ts`，并非已发布的包。bundle 纯净度门禁禁止以值的形式导入本包的卡片外观与暂存表单模型，因此这样的卡片要重新实现暂存与 revision 设栅。要共享它们，要么发布该预设，要么在卡片内部声明一层子 slot 让分区提供外观；两者都尚未构建。
