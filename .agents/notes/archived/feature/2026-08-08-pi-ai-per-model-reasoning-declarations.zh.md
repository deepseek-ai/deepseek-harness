# Agent Note: llm-pi-ai 的按模型推理声明

Status: implemented
Archived: 2026-09-04

[English](2026-08-08-pi-ai-per-model-reasoning-declarations.md) | 中文

## 问题

在声明式提供方 catalog（[[2026-08-03-pi-ai-declared-provider-catalog]]，它刻意把推理排除在可配置字段之外）之下，手工声明的 pi-ai 路由，其模型物化出来就带着 `reasoning: false`，于是 `getSupportedThinkingLevels` 短路成 `["off"]`：输入框不为它们提供档位选择器，而路由级的 `reasoning` 默认值——当时 profile 仅有的推理旋钮——让发往这类模型的每个请求都在网络 I/O 之前以 `UNSUPPORTED_REASONING_EFFORT` 失败。同一个路由级旋钮对 catalog 路由来说也放错了层级：同一提供方下各模型接受的档位并不一致（deepseek 自带 `[off, high, max]`，旁边就是带 `xhigh` 的 catalog 模型），单个路由级档位怎么设都会弄坏路由的一部分——这正是模型页彻底停写它的原因（#1860），而 `settings.yaml` 也因此没有了任何按模型对齐档位的办法。

两个相邻的缺口让问题雪上加霜。pi-ai 靠识别端点 URL 来决定推理的*协议方言*（`compat.thinkingFormat`、`compat.supportsReasoningEffort`），而私有网关的 URL 什么也说明不了——说 DeepSeek 方言的网关只会收到 OpenAI 方言的请求，且没有任何配置能更正它。另外，想动单个 catalog 模型，唯一的手段是 `models` 列表，而它会*替换*所服务的 catalog：收窄 `gpt-5` 的档位，意味着要么重述全部三十八个 openai 模型，要么静默丢掉三十七个。

## 决策

`PiAiModelProfile` 新增 `reasoningEfforts`：**每个键是选择器提供的一个档位，其值是分派在协议中发送的拼写**。该声明会转换为 pi-ai 的 `Model.reasoning` + `thinkingLevelMap`，七个档位全部显式决定——已声明的档位携带自己的协议值，未声明的档位一律固定为 `null`——因此 profile 作者永远不需要了解 pi-ai 那条不对称的默认规则（键缺席对五个基础档位意味着「支持」，对 `xhigh`/`max` 却意味着「不支持」）。`off` 是唯一的三态键：不写，选择器不提供 Off，显式请求 Off 会被拒绝（不点名档位的请求仍会不带参数地发出，提供方保留自己的默认行为）；声明而不给值，则提供 Off，分派什么也不发送（`deepseek` 方言发送 `thinking: {type: "disabled"}`）；声明并给值，该值就在协议中发送。`false` 声明一个不具备推理能力的模型；空声明会被拒绝，而不是去猜。「禁用」的拼写取 `false` 而非 `{}`，因为 schemastery 会把缺席的字典物化成 `{}`——只有 `z.union([z.const(false), dict])` 才能让缺席、禁用与已声明三态保持可区分；而裸写的 `reasoningEfforts:`（YAML null）会不经校验地从该 union 溜过去，因此解析对它显式拒绝。

`compat.thinkingFormat` 与 `compat.supportsReasoningEffort` 变为两级可配置——路由级（作为其模型的默认值）与模型级（逐字段胜出）——解析顺序为模型 → 路由 → 已安装 catalog 条目 → pi-ai 按 URL 得出的猜测。`thinkingFormat` 经 `Record<UpstreamUnion, true>` 漂移门禁钉在 pi-ai 的联合类型上，因此新增格式的 pi-ai 升级会编译失败，直到新成员被归类（对照已发布的 0.84.1 tarball 验证过：其 `thinkingFormat` 联合类型相对钉住的 0.82.1 新增了 `baseten`）。`compat` 承载哪些字段、每个字段由哪些协议接受、以及无法读取的键如何被拒绝，归 [[2026-08-18-pi-ai-wire-compat-surface]] 所有；上面这条两级解析顺序正是该面所推广的东西。

`modelOverrides` 就地重塑单个 catalog 模型而不替换所服务的集合：键 = catalog 模型 id，值 = 去掉 `id` 的 `models` 条目，物化时把覆盖交给既有的条目路径，因此容量、档位、compat 与请求默认值语义完全一致。与忽略未知 id 的 Pi 自有配置层不同，凡是落不到任何地方的覆盖都会被拒绝——与 `models` 列表并存、写在手工声明的路由上、点名未知模型，或在值里夹带 `id`（schema 会放行未知键，被夹带的 id 会悄悄把模型改名）。

## 曾考虑的替代方案

- **把 `reasoning` + `thinkingLevelMap` 原样透传**（pi-ai 自家 radius 配置的形状）。用户以运维人员困惑为由否决：map 用 `null` 标记「不支持」的约定，加上不对称的键缺席规则，意味着这份配置的含义取决于对 pi-ai 内部机制的了解；选定的形状则让键集合本身就是对外提供的全部。
- **裸档位列表**（`reasoningEfforts: [off, high]`）。表达不了协议侧改名，而 catalog 自己的 map 证明改名真实存在：1230 条已安装 map 条目里有 66 条不是恒等映射（`off→none`、`minimal→low`、`low→LOW`、`high→default`）。
- **用 `{}` 作为禁用拼写。** 无法实现：schemastery 会把缺席的字典物化成 `{}`，于是每个没写该字段的模型都会被强制禁用。
- **把这件事并进路由级的 `reasoning` 旋钮。** 那个旋钮是*默认选择*，不是能力集合；它保留下来，而已声明模型的档位如今约束着它能选什么。

## 后果

- 输入框的档位面板对手工声明的模型直接可用，UI 零改动——`resolveModelInfo` 经 catalog 元数据所走的同一 seam 报告已声明档位（由 `declared-reasoning` web 场景钉住）。
- #1860 暂缓的缺口——模型接不住的路由级档位会让发往它的请求失败——如今有了运维侧补救：对齐该模型的 `reasoningEfforts`，或去掉路由默认值。
- 刻意不提供任何把单个 map 键或 compat 字段交还给「catalog 原本怎么说」的拼写：这份声明就是对外提供的全部，要保留某个 catalog 值就得重述它。README 记载了这一点。
- `verify-package-invariants` 原封未动：该功能新增的是配置解析，没有新事件，也没有可变的运行时关系。
