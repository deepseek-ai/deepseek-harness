# Agent Note: pi-ai Wire-Compatibility Surface in llm-pi-ai

Status: implemented
Archived: 2026-09-04

[English](2026-08-18-pi-ai-wire-compat-surface.md) | 中文

## Problem

pi-ai 依据提供方 id 与 baseURL 决定每个请求的形状——系统提示词由哪个角色承载、输出上限写在哪个字段、是否发出 `store` 与 `stream_options`、工具定义是否携带 `strict`。对于其检测无法识别的端点，答案是「这就是 OpenAI 本身」：`detectCompat` 返回 `supportsDeveloperRole: true`、`maxTokensField: "max_completion_tokens"`、`supportsStore: true`。而手工声明的路由按其构造就是 pi-ai 未随附的端点，于是每一条这样的路由都收到了 OpenAI 自己的请求形状。

适配器只开放了 pi-ai 三十个 compat 字段中的两个（[[2026-08-08-pi-ai-per-model-reasoning-declarations]] 把它们限定为「pi-ai 推理分派读取的那些开关」），而 `supportsDeveloperRole` 恰恰落在该作用域之内却不在其中：它的发送点是 `model.reasoning && compat.supportsDeveloperRole`。因此一个声明了 `reasoningEfforts` 的手工声明模型会把系统提示词以 `role: "developer"` 发出——多数 OpenAI 兼容网关会拒绝该角色——而没有任何配置能够更正，该网关根本接不进来。

硬写这个字段比不支持更糟。schemastery 会放行未知键，而解析只读取两个名字，于是 `compat: {supportsDeveloperRole: false}` 通过校验、落盘，随后被丢弃：运维看到的是一次被接受的写入和一个毫无变化的故障。`maxTokensField` 带着同一缺陷、却有更大的波及面，因为它塑造每一个请求，而不只是推理模型的请求。

## Decision

每个 pi-ai compat 类型一张漂移门禁——以 `Record<keyof OpenAICompletionsCompat | …, CompatDisposition>` 为键——把每一个上游字段分类为 `offer` 或 `withhold`。去重后三十四个字段，开放二十三个。分界线在于私有 URL 能推出什么：凡是无法从未识别端点推断的，部署方必须能够说出口；而 pi-ai 已安装 catalog 为具名厂商设定的字段保持扣留，因为伸手去够 `openRouterRouting` 或 `deferredToolsMode` 的路由，本就是一条应当以该厂商命名、并继承其值的 catalog 路由。

`PiAiCompatProfile` 保持为带逐字段 JSDoc 的显式 interface——它是配置界面所渲染、也是 `docs/config-catalog.md` 所粘贴的东西——并由一个作用在对称差上的类型级 `AssertNever` 证明它恰好命名了开放集。schemastery schema 声明为 `z<PiAiCompatProfile>`，而使这条标注在两个方向上都真正吃劲的是 `exactOptionalPropertyTypes`，于是四个面互锁：上游新增字段、门禁漏一条、interface 忘记一个字段、schema 少一个键，都会在编译期失败。字段的**类型**派生自上游而非重述，另有一条证明把 profile 钉为可赋值给上游 compat 类型，因此被拓宽的值并集不会悄悄收窄配置所接受的范围——否则物化处对 `ModelCompat` 的强转会把它洗掉。

协议适用性逐字段判断，且归组依据是 compat **类型**而非协议名：pi-ai 让 `openai-responses`、`azure-openai-responses` 与 `openai-codex-responses` 共用同一个 `OpenAIResponsesCompat`，因此可设在其中之一的开关，三者皆可设。仅按协议名归组曾使两条随附的 catalog 路由拿不到其自身模型所声明的字段。协议集派生自 `Model.compat` 自身的条件类型，因此某个版本若给别的协议加上 compat 类型，门禁列表会以点名的方式失败。模型级开关若其协议并不接受，解析失败并点名该协议实际提供哪些开关；路由级开关则落在读取它的模型上、跳过其余模型，只有当路由上没有任何模型能读取它时才被拒绝。`chatTemplateKwargs` 与 `chatTemplateArgs` 予以开放，因此两个 `chat-template` 格式和 `baseten` 都可命名；这些配对不做交叉校验，因为实际生效的格式可能来自 catalog 条目或 pi-ai 的检测，而解析读不到那两层。

三类 `compat` 键在其被写下之处遭到拒绝而非丢弃：没有任何协议声明的键、被门禁扣留的键，以及完全没有写值的键。该检查在任何协议解析之前遍历全部键，因此即便路由上的模型永远不会走到那个本会接受它的协议，笔误同样失败。它刻意读取原始键：被扣留或未声明的名字不在 schema 中，所以 schemastery 不可能物化它，写下它的必然是人。无值那一类是必须失败而不能忽略的：schemastery 会把 YAML 裸键放行为 null，照单收下就会用 null 写覆盖已安装 catalog 的值，随后 pi-ai 的 `??` 转而去够它的 baseURL 检测，catalog 这一层被整个跳过。随后再单独过滤携带值的字段，因为 schemastery 会把缺省的 dict 物化成 `{}`，于是无论有没有人写过，两个模板参数字段都会出现在每一个解析过的 profile 上。

## Where a refusal lands

所有检查都在 `resolveProfiles` 中运行，而请求路径不会重新进入它：适配器按原始快照的标识 memoize，且 `apply` 会主动预先解析一次。因此一次拒绝会以 `settings-rejected` 的形式在落盘之前抵达 `settings.mutate`，以插件挂载失败的形式抵达 `cordis.yml` 的 `config:` 块，以 `settings.register` 启动失败的形式抵达已存的 section。

对 settings 文件的外部编辑是唯一无法报告的路径：提供方监听器调用 `publish()`，它捕获失败的 section、记录 `settings: keeping last good "%s"`，并让该 namespace 继续服务其先前的值。这是 settings seam 对每一种 schema 与校验器失败的既有行为，并非本次开放引入，弥合它属于那个 seam 而不属于此处。对 compat 而言改变的是失败模型而非报告方式：一个从前永远静默无效的键，如今会拦下下一次启动。

## Alternatives considered

**只补 `supportsDeveloperRole`。** 它修好了报告中的那个网关，却放任 `maxTokensField`——它塑造每一个请求，而不只是推理模型的请求——继续拖垮一整类端点，而且下一个上游新增字段依然可以静默落后。

**开放全部上游字段。** pi-ai 自己的 custom-provider 文档收敛到一个小得多的集合，其旗舰示例只点名六个，其余都是其 catalog 已经设定好的厂商绑定开关。在手工声明路由上暴露 `zaiToolStream` 或 `vercelGatewayRouting`，等于提供一个「正确用法是别做手工声明路由」的旋钮。

**把 `compat` 按协议分层**（`compat: {openai-completions: {…}}`）。手工声明路由恰好只有一个 `api`，因此这层嵌套只是复述路由已经说过的事，还白白破坏了所有按扁平形状写下的 profile。

**接受一个不透明的透传 dict。** 该 schema 同时是配置界面渲染的形状、也是 `verify-config-catalog` 交叉校验的声明，无结构的 dict 会同时击溃两者；它还会让 responses 独有的字段落到 completions 模型上，而逐字段适用性正是为拒绝这种情况而存在。

**未知键只告警不拒绝。** 这恰恰是让本缺陷伴随该面存活至今的姿态：一次被接受的写入加一个毫无变化的故障，教给运维的是「这个开关没用」，而不是「这个名字写错了」。

**为未知键给出近似拼写建议。** 仓库中没有计算编辑距离的工具，在逐文件覆盖率门禁之下为一条诊断引入依赖或手搓一个都不成比例。点名开放字段能确定地回答同一个问题：词汇检查跑在任何协议解析之前，因此它列出整个开放集，而按协议的拒绝则收窄到该协议实际接受的字段。

## Consequences

- 拒绝 `developer` 角色、`max_completion_tokens`、`store`、`stream_options` 或 `strict` 的 OpenAI 兼容网关，如今属于配置问题而非无法接入的提供方；拒绝 `temperature` 或工具 `cache_control` 的 Anthropic 兼容网关同理。
- pi-ai 升级新增 compat 字段或思考格式会使构建失败，直到有人为它做出分类；门禁包含两个模板参数字段和当前每一种格式。
- 未知 compat 键并入了其余所有配置错误的失败模型。相对此前静默丢弃的改善程度受 settings seam 限制：外部文件编辑仍会保留其上一个有效值并告警，因此运维拿到的信号是一次重启，而不是那次写入。
- **搁置而非解决：** 改指 `api` 且完全未配置 compat 的路由，会经模型字面量的 `...base` 展开保留已安装条目的 `compat`，且形状属于**另一个**协议。多个 compat 类型共有的字段（`supportsLongCacheRetention`、`sendSessionAffinityHeaders`）因而会跨协议串味。它早于本面存在——其所依附的提前返回本就在那里——留给独立的一次改动处理。
- **搁置而非解决：** `publish()` 对被拒绝的已存 section 只通过 `ctx.logger.warn` 报告，没有面向用户的通道。它影响每一个 settings namespace，归属 `dsh-settings`。
- [[2026-08-08-pi-ai-per-model-reasoning-declarations]] 被部分取代：其 compat 作用域的陈述在此重述，而其 `reasoningEfforts` 形状、该形状所击败的备选方案以及 `modelOverrides` 仍是当前权威。
