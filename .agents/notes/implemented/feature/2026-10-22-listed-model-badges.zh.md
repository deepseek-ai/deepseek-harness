# Agent Note: 模型选择器角标来自模型列表

Status: implemented

[English](2026-10-22-listed-model-badges.md) | 中文

## 问题

Web 模型选择器通过一个专门的客户端包在 `DeepSeek-V4.1-Flash` 旁显示 `1017`，该包写死匹配两个 DeepSeek 提供方、一个模型 id 和一个确切的目录名称。修改或撤下这个版本标记、给其他模型加标签，都要发一次客户端版本；而两条 DeepSeek 路由早已从服务端的 `GET /models` 列表读取模型元数据。

## 决策

- 每个 `/models` 条目可以在 `client_metadata["deepseek-harness"]` 下声明 `badge: { text, tone }`，与 `client_requirements` 一样以 User-Agent 的产品名为键。`client_metadata` 存放所有版本都可以忽略的客户端专属数据，因此公开的模型字段保持不变，以后新增的 DeepSeek Harness 字段也放进同一个对象。`text` 采用包元数据的 `LocalizedText` 形式：单个字符串，或以小写语言 id 为键且包含 `en` 的译文。每段文字去掉首尾空白后须为单行，长度为 1 到 12 个用户可见字符；拒绝控制字符、Unicode 行分隔符、双向控制符及仅由空白或默认可忽略字符组成的文字。
- `tone` 取 `neutral`、`info`、`success` 或 `warning`，分别是 `Tag` 表示普通事实、强调、利好和需要注意的配色。已发布的版本标记使用 `info`；调研的选择器把套餐和能力标签画成中性色，新功能用强调色，用量提示用警示色。`danger` 和 `solid` 保留各自表示失败和当前选中的含义。
- [`parseModelListing`](../../../../packages/llm/llm-deepseek/src/listing.ts) 与条目的其他声明一起解码角标，[`resolveListedCatalog`](../../../../packages/llm/llm-deepseek/src/listed-catalog.ts) 保留已提供模型的角标；两条路由都通过 `catalogModelInfo` 附上角标。这条路径上任何一层缺省或为 `null` 时不显示角标；`tone` 缺省或无法识别时按 `neutral` 显示。某一层不是对象或角标无法读取时，角标被丢弃，并与列表的其他问题一起报告，但不会隐藏所属模型。
- `LlmModelInfo.badge` 与 `ModelCatalogModel.badge` 把角标从模型发现经 Host 模型目录送到浏览器。`resolveModelInfo` 不返回它，模型请求、Session 事件和面向模型的工具都不读取它。
- [`ui-model-selection`](../../../../packages/client/ui-model-selection/README.zh.md) 在触发按钮中把角标放在目录名称之前，在根菜单当前值和各选项中仍放在名称之后，并用 `ctx.locale.resolveText` 解析其文字。`conversation.input.model.label` 的扩展会同时替换名称与角标，并从 owner props 收到角标。
- 本版本不内置任何角标：路由加载到第一份列表之前不显示角标。API key 路由在自定义目录或非官方端点上不跟随列表；账号路由跟随配置的 `baseURL` 的源，包括自定义端点。写死的 `ui-deepseek-model-label-1017` 包及其 Web bundle 条目已移除。
- 按凭据区分的缓存首次使用后按 `modelsMaxAgeMs`（默认十分钟）自动刷新，通过 `llm/models-updated` 发布目录变化。成功加载会替换所有角标元数据，因此省略或 `null` 都会清除旧角标。刷新失败时保留上次成功加载的列表及其角标：请求失败并不能证明服务端撤下了角标。这样也避免了每个浏览器独立轮询。间隔为零时仍只在访问时刷新。

## 考虑过的替代方案

**顶层 `badge` 字段。** 公开的 `/models` 字段为所有客户端描述模型的能力与限制，而角标是 DeepSeek Harness 的发版和运营文案。放在顶层会被当作模型属性，其他客户端可能开始显示它，此后服务端就无法随意修改或撤下；两个客户端也无法显示不同的角标。

**把 `badge` 放进 `client_requirements["deepseek-harness"]`。** 这样不增加顶层字段，已发布版本也会忽略其中多出的键。但版本要求无法读取时，所有版本都会隐藏该模型，已发布的版本也不例外；撤下角标后，序列化器若把清空的对象写成 `null`，模型就会被隐藏。版本要求决定模型能否使用，展示数据必须可以忽略。

**范围更窄的映射，例如 `client_presentation` 或 `client_annotations`。** 这些名称把对象限定为展示数据或附加说明，下一个其他类型的客户端专属字段（例如默认值）又要新开一个顶层字段；`client_metadata` 可以容纳任何版本都能忽略的字段。

**用语义化的角标类别映射到客户端字典。** OpenCode、ZCode 和 DeepSeek-Reasonix 都翻译一组封闭的、由客户端持有的标签类别，没有一家直接渲染服务端发来的文字。固定词表表达不了 `1017` 这样的版本代号，每出现一种新说法都要发一次客户端版本，而列表正是为了免去这一步。列表文字属于提供方数据，按[客户端文案归 locale 管理的决定](../architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)原样渲染；`LocalizedText` 形式仍允许服务端提供译文。

**接受列表下发的颜色、CSS 或标记。** 调研的产品都不接受目录下发的样式；任意颜色会绕过主题的明暗配色及其对比度。封闭的语调集合直接对应现有 `Tag` 配色；无法识别的语调降级为 `neutral`，因此较新的服务端新增的取值不会让文字消失。

**把 `1017` 保留为内置默认值。** 内置角标能让标记在离线和自定义端点下继续显示。但按照“字段缺失时沿用本版本的值”的列表规则，服务端只能用特殊的空值才能去掉它，而且旧版本在加载不到列表时会一直显示过时的标记。不内置角标，列表就是唯一来源，省略字段即可去掉角标。

**给角标加过期时间或生效时间。** 列表缓存只在内存中，超过 `modelsMaxAgeMs` 后在访问时刷新，服务端撤下的角标在一次刷新内就会消失。客户端时间窗口会引入对客户端时钟的依赖，却消除不了实际可能出现的陈旧数据。

**角标有误时丢弃整个条目或整份列表。** OpenCode 会丢掉目录状态无法解码的模型，Codex 遇到一个未知枚举值就让整份目录解码失败。角标只用于展示，有误时只丢弃角标本身。

**在目录之外为 DeepSeek 单独提供角标 Remote。** 让角标不进入 `LlmModelInfo`，就需要第二个 Remote、客户端的第二次请求，以及两份缓存对“有哪些模型”保持一致。在现有目录上增加一个可选字段，一次加载即可送到所有显示位置。

## 影响

- 服务端无需客户端发版即可修改、翻译或撤下角标；运行中的客户端在下一次列表刷新和目录重新加载后显示变化。
- 旧版本必须执行的条件放在 `client_requirements`；`client_metadata` 下的每个字段都必须保证不读取它的版本也能安全运行。
- 服务端声明并加载到列表之前，`deepseek-flash` 不显示角标。API key 路由的自定义目录与非官方端点不接收列表角标。
- `/model` 弹窗、触发按钮的无障碍名称和模型设置页仍只显示名称。
- 仍指向 `ui-deepseek-model-label-1017` 的 profile patch 不再匹配任何条目，启动时会给出警告（[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/model-badge-package-removal/guide.zh.md)）。
