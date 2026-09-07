# Agent Note: client 文案全量接入 typed locale 席位

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-client-locale-full-rollout.md) | 中文

## Problem

typed locale 标准席位（`locale:` 注册声明 → 框架注入强类型 `t`）落地后，只有四个先行包接入；其余 client 包的文案仍是硬编码的中英混杂字面量。全量迁移需要几个先行包没有触及的机制：注册期文本（导航行、视图 tab 的 label）在语言切换时如何刷新，以及 zero-Cordis 的 ui-primitives 原子组件如何在不依赖运行时的情况下拿到文案。

## Decision

**注册期文本走 label thunk。** ui-slots 的 list 注册项 `label` 接受 `SlotLabel = string | (() => string)`；owner 投影 ledger 行时必须经 `resolveSlotLabel` 解析（不裸读 `options.label`），并让读取点跟随 locale revision（outlet 自身订阅 revision；ledger 外的投影如 ui-settings 导航把 revision 并进缓存键、订阅双源）。thunk 每次读取时求值，语言切换零 ledger churn——没有重注册、version 不动，`locale/change` 重注册接线全部删除。

**组件文案走标准 `t` 席位；深层子组件用 prop 下传**，类型写 `XxxProps['t']`。字典规范形态不变：`zh satisfies Record<string, string>` 为 key 源、`en satisfies Record<XxxKey, string>` 锁双语平衡。

**内置 locale 集合封闭，语言目录可扩展。** 本包只提供 `zh` 与 `en`，类型化命名空间注册仍要求这对双语字典。外部 client 插件通过 `ctx.effect(() => ctx.locale.addLanguage({ id, label, fallback }))` 增加语言，并通过既有的单 locale 字典注册贡献不完整翻译；语言定义与字典可以按任意顺序注册。外部语言 id 是经过校验的 BCP 47 标签，同时用于偏好存储、字典查找、浏览器匹配和 `<html lang>`；该标签承载可互操作的语言语义而非不透明身份，因此 `LocaleId` 保持 string。内置 `zh` 定义继续使用内部 `zh-CN` 文档标签。每个新增语言都声明一个已注册的 fallback，fallback 自身的定义给出下一层 fallback，整条链必须终止于 `en`；未知目标和循环在注册时失败。每个 key 先在请求的命名空间中沿链查找，再在 `common` 中重复同一条链，最后显示 key 本身。Host 存储开放字符串偏好；不可用的已保存 id 会保持待采用，直至对应语言注册；定义移除后，正在使用的选择会回落到可用的浏览器匹配或 `en`。目录变更推进 `LocaleFace` revision，使语言设置行跟随注册和 dispose。

**zero-Cordis 原子组件（ui-primitives）通过必填 prop 接收文案。** `HoverCard`、结构化工具块、JSON/Markdown 渲染器、`ConnectionIndicator` 和 modal chrome 均保持运行时独立；已本地化插件从自己的 `t` 席位传入完整的字典驱动 label 对象，对缓存敏感的对象按 `t` 身份 memo。移除带语言默认值以及完整 prop 清单由 [locale 归属文案决策](2026-08-23-locale-owned-client-ui-copy.zh.md)负责。

**所有产品编写的 UI 短语都翻译。** client 兜底文案、设计 label、trajectory 检查面、无障碍名称和格式化单位均按 [locale 归属文案决策](2026-08-23-locale-owned-client-ui-copy.zh.md)进入字典。用户/模型/提供方/wire 文本以及协议或代码 token 仍作为数据原样呈现。不依赖框架的 boot 标记仍早于 locale 服务运行；本地化应用激活后会替换其中的产品文案。

**派生层不让展示文本承担身份。** ui-workspace 的 `relativeTime` 返回结构化 `{unit, n}`，由渲染组合字典模板；blank 会话标题和未分组 label 从 `blank` 标志/`workspaceId` 缺席派生，内部值保持为空或稳定；**搜索态 blank 行一律排除**（双语标题无法与单语查询稳定匹配）。日期不引 Intl：格式模板进字典（消息时钟 `clock.md`/`clock.ymd`，workspace hover `date.ymd`），格式化函数接收 `t` 参数。

**测试与 e2e 口径**：`makeTranslate(...dicts)`（dsh-client-test-runtime）镜像服务查找链（首个命中字典胜出、key 兜底、`{name}` 插值），组件测试的 `t` 桩统一用它并以真实 props 席位定型。web e2e 统一通过 `newEnglishPage`（`en-US` 浏览器）打开，built-boot 快照 同样固定 navigator 语言：golden 因而不受语言迁移影响。settings 语言切换用例绕开该 helper 并开启 `zh-CN` 浏览器，因为在显式 Host 偏好到达前，暂定 locale 会跟随 `navigator`（[由浏览器推导初始 locale](../feature/2026-07-31-browser-derived-initial-locale.zh.md)）。

[settings/locale/theme 分层 Note](../../proposed/architecture/2026-07-25-client-settings-locale-theme.zh.md) 中「apply 层订阅 `locale/change` 重注册刷新 label」的机制已被本决定取代（thunk + revision 生命周期）。

## Alternatives considered

- **label 保持 string、语言切换时重注册**（先行包的旧形态）：boot 已经为每个包注册一次，`locale/change` 监听者重注册会放大成风暴；ledger version 抖动还会击穿一切按 version 缓存的投影。thunk 把刷新成本移到读取点，读取点本来就跟随 revision。
- **给 ui-primitives 造 locale 上下文/注入通道**：破坏 zero-cordis 边界（原子组件从此依赖运行时），且强迫未本地化消费方（ui-trajectory）陪跑。props 化让每个消费方独立决定。
- **翻译外部或 wire 错误数据**：否决。提供方与协议诊断是需要原样搜索和比对的证据。产品编写的外围失败 chrome 会翻译，外部编写的数据不会。
- **日期用 `toLocaleString()`/Intl**：跟随浏览器/OS 语言而非应用语言，切换后必然产生混合文本；字典模板量小且与消息时钟同构。
- **blank 行参与搜索（匹配本地化标题或存储标题）**：任一选择都在某个语言下「看得见搜不到」；占位行本无信息量，整体排除语义最稳。

## Consequences

- 语言切换全 UI 即时刷新且零重注册；新包接入 = 字典 + declare-merge + `locale: NS` 三步，无手写胶水。
- 代价：list label 的消费方必须知道 `resolveSlotLabel`（裸读 `options.label` 现在可能拿到函数）；类型上 `SlotLabel` 已挡住多数误用。
- ui-primitives 要求本地化 label prop，因此新增原子组件渲染点也必须新增明确的文案 owner；遗漏会在类型检查失败，而不是选择隐藏语言。
- e2e 英文钉死意味着 zh 文案面主要靠包级组件测试与 settings 语言切换用例覆盖，浏览器 e2e 不再验证 zh 文案。开场/回落 locale（浏览器未声明任何已注册语言，或非浏览器运行）是 `en` 而非 `zh`，见 [browser-derived initial locale](../feature/2026-07-31-browser-derived-initial-locale.zh.md)。
