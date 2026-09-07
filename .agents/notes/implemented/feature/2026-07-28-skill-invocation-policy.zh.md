# Agent Note: 模型与用户彼此独立的 skill（技能）调用策略

Status: implemented

[English](2026-07-28-skill-invocation-policy.md) | 中文

## 问题

skill 注册表最初将发现操作视为模型目录：`ctx.skills.list()` 会移除禁止模型调用的 skill，而 `ctx.skills.get()` 仍是不过滤内容的可信 loader。该设计足以支持由模型发起的加载，却无法表示与 Claude 兼容的四类 skill：仅向用户公开、仅向模型公开、同时向两者公开，或者两者均不公开。TUI 从面向模型过滤后的列表中生成用户自动补全，并允许通过 `get()` 加载任意精确名称，这进一步放大了两类调用策略不匹配的问题。

本地解析器还将一种内部驼峰式拼写暴露为 frontmatter。若要支持既有的负向字段 `disable-model-invocation` 和正向字段 `user-invocable`，需要建立持久且对称的领域表示，同时避免把所有可能出现的 YAML 键都变成跨包的无类型约定。

## 决策

`SkillSummary` 包含一个必填且类型明确的 `invocation: SkillInvocationPolicy` 对象，其 `modelInvocable: boolean` 和 `userInvocable: boolean` 字段为正向且对称。只有显式输入边界可以省略它：未提供策略的运行时 `SkillRegistration`，以及两个调用键均未提供的本地 frontmatter，都会在生成候选项或定义前解析为 `{ modelInvocable: true, userInvocable: true }`。未来的 frontmatter 键只有在具备消费方和执行约定后，才会进入领域模型；本地提供方仍将 frontmatter 解析为开放的 `Record<string, unknown>`，然后只把已识别字段及其默认值投影到规范化的类型化策略中。

`ctx.skills.list()` 返回所有胜出的摘要，不再替任何调用接口选择策略。`isModelInvocable(skill)` 和 `isUserInvocable(skill)` 分别直接读取对应的正向字段。`ctx.skills.get()` 保持策略无关，因为可信内部调用方可能需要任意定义；对外消费方则必须在展示或加载 skill 之前执行自身对应的判定函数。模型工具和 TUI 会在调用 `get()` 前检查与调用策略无关的摘要，随后再次检查已加载的定义：被拒绝的名称绝不会进入定义加载流程，发现与加载之间发生策略变更也无法暴露该 skill 的正文。

本地提供方只接受拼写完全一致的 kebab-case frontmatter 键 `disable-model-invocation` 和 `user-invocable`。它接受 YAML 布尔值，以及不区分大小写的 `true`/`false`、`yes`/`no`、`on`/`off` 和 `1`/`0`，与 Claude skills 实际支持的布尔写法一致。它将 `disable-model-invocation` 映射为相反的正向字段，即使两个键都不存在，也会根据默认值填充两个正向字段。若使用外部驼峰式拼写或提供非布尔调用值，发现流程会丢弃整个 skill，并给出有针对性的警告；本仓库尚处于发布前阶段，因此不为磁盘格式保留兼容别名。调用数据校验遵循失败时默认拒绝原则，因为忽略这类数据会默认授予权限，可能使 skill 暴露在已禁用的接口上；与之不同，类型错误的可选 `whenToUse` 和 `metadata` 值会被省略，因为它们不参与调用判定。

面向模型的 `dsh-tool-skill` 目录和 loader 执行 `isModelInvocable`。TUI 的 `/skill:` 自动补全与精确名称 loader 在本地执行用户字段，因此仅允许用户调用的 skill 即使不出现在模型发现结果中，仍会在此处显示并可加载，同时不会将可选的 skill 对等依赖（peer dependency）变成运行时导入。由 launcher 预置、供引导式 `dsh migrate` 和 `dsh upgrade` 会话使用的初始 skill 沿用同一条 TUI 路径，因此必须保持允许用户调用。浏览器的 `skills/list` RPC 提供的是由用户选择、但仍要求模型加载的引用，因此只公开同时允许模型和用户调用的 skill；本次改动不新增让浏览器直接加载 skill 的 RPC。

这些规则允许以下四种组合：

| 策略 | 模型调用 | 用户调用 |
|---|---|---|
| `{ modelInvocable: true, userInvocable: true }` | 包含 | 包含 |
| `{ modelInvocable: true, userInvocable: false }` | 包含 | 排除 |
| `{ modelInvocable: false, userInvocable: true }` | 排除 | 包含 |
| `{ modelInvocable: false, userInvocable: false }` | 排除 | 排除 |

该决策扩展了 [skill 系统](../../archived/feature/2026-07-05-skill-system.md)，并取代[已归档的 TUI skill 斜杠命令](../../archived/feature/2026-07-21-tui-skill-slash-command.md)中记录的调用策略限制。

## 曾考虑的替代方案

**将所有 frontmatter 存入通用 `Map`，并在 `isModelInvocable` / `isUserInvocable` 中读取字符串键。** 不予采纳，因为拼写错误的键、非布尔值以及各消费方自行采用的类型转换都会越过包边界，且无法获得类型检查。解析器边界仍保持开放；领域模型则有意采用类型明确的窄接口。

**保持 `ctx.skills.list()` 仅返回允许模型调用的 skill，并另增一份用户列表。** 不予采纳，因为发现、重复项解析、缓存和排序都是与调用接口无关的工作。采用一份完整目录和显式判定函数，可以避免这些机制逐渐分化，并在各消费方边界清楚呈现其策略。

**在 `ctx.skills.get()` 内执行调用策略。** 不予采纳，因为 `get()` 无法判断调用方是模型工具、人类命令还是可信编排逻辑。在此处过滤还会使两个接口均禁止调用的组合无法被检查或管理。

**将驼峰式 frontmatter 作为别名处理。** 不予采纳，因为外部格式遵循采用 kebab-case 的 Claude skills 约定，而本仓库尚未发布，无需承担兼容义务。显式失败可以避免暗中保留不符合标准的拼写。

**增加由浏览器端直接调用 skill 的 RPC。** 本次改动不予采纳，因为现有浏览器流程插入的是模型引用，而非已经加载的指令正文。因此，该流程应当取模型与用户调用策略的交集；直接由用户加载的接口需要单独设计协议与日志记录方式。

## 后果

提供方与运行时注册对外提供小而类型明确的调用约定，同时本地 YAML 仍可扩展。每个新的发现消费方都必须明确选择模型判定函数、用户判定函数、两者的交集，或可信且不过滤的访问方式；如果遗漏这项选择，评审时可以直接看出问题，而不会再被注册表行为掩盖。

无密钥 ACP（Agent Client Protocol）快照固定了模型目录的变更：其中包含仅允许模型调用的 skill，并排除仅允许用户调用的 skill。组装后的无密钥 TUI 快照按精确名称发现并加载一个仅允许用户调用的 skill，随后在加载正文前拒绝一个仅允许模型调用的 skill；真实 Loader/PTY 冒烟测试通过随产品交付的终端进程证明了同一条仅允许用户调用的路径。真实宿主上的 Chromium 快照固定了浏览器在全部四种策略组合下的交集行为。TUI 单元测试覆盖这些组合以及 dispose（资源释放）竞态；注册表、本地解析器、模型工具和 API 代理测试则覆盖默认值、支持的布尔写法、格式错误的值、旧键拒绝、精确名称加载时的策略执行，以及浏览器侧的策略交集。
