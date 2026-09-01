# Agent Note: web 配置平面

Status: implemented

[English](2026-07-30-web-config-plane.md) | 中文

> 范围：[请求级 LLM（大语言模型）配置 note](2026-07-29-request-level-llm-config-credentials.zh.md) 中延后的 wire 面与 web UI——带推送式失效的 `settings.*`/`credentials.*`/`llm.*` RPC 领域、分层且脱敏的 `describe()`、本地设置文档交接、llm 可配置提供方目录与拓扑事件、由 `dsh-client-ui-settings` 持有的 `ctx.settingsSchema` 模型服务，以及带手写提供方编辑器的 Models 设置页。`deepseek` → `deepseek-official` 提供方路由重命名作为解锁前提的破坏性变更一并搭车合入。

## 问题

请求级配置 seam 让 LLM 适配器配置免重启，但唯一的写入方还是直接编辑 `settings.yaml` 的文本编辑器：web 客户端没有触达设置、凭据或提供方拓扑的任何 wire 通道，「存入密钥、再次发起提示」于是仍意味着离开产品本身。挡住配置页的缺口不是一个，而是三个：`describe()` 只返回合并后的生效值（表单分不清用户覆盖与组合默认值，而且照原样序列化会把 `role('secret')` 的值发到每一个浏览器）；没有任何东西枚举适配器*可以*运行的提供方（裸挂载的 `llm-pi-ai` 在配置之前完全不可见）；两个适配器又都想要 `deepseek` 这个路由键，目录因此无法无歧义地把路由归到拥有它的 namespace 名下。为每个提供方手工维护一份表单被直接否决——schema 已经以 schemastery `Config` 值的形式存在，第二份字段真源注定漂移。

## 决策

**配置调用使用其所属的 wire 实现，拒绝落为错误码，owner 事件原样转发。**`@deepseek-ai/dsh-api-settings-controller` 持有 `settings/describe`、`settings/update`、`settings/replace`、`settings/mutate`、`settings/openSettingsDocument`、`settings/openAgentPresetDirectory` 与 `credentials/describe|set|unset` 的生成 Remote 方法；`@deepseek-ai/dsh-llm` 持有 `llm/listProviders`、`llm/listConfigurableProviders` 与 `llm/discoverModels`。provider 缺失时保留配置 API 可操作的 `internal` 诊断，seam 拒绝则保留 `settings-rejected {ns}`／`settings-conflict {ns, expected, actual}`／`credential-rejected {ref}`。Client 订阅转发的 settings、credentials 与 LLM owner 事件，无需轮询即可收敛（见[转发的 Remote 事件](2026-08-10-remote-event-delivery.zh.md)）。Connection 使用同一个浏览器会话认证生成的 Remote 方法与 API Proxy 回退；Host/Origin 失败仍会在身份校验前返回 403。

**`describe()` 增加分层与结构化 secret 脱敏。**`SettingsDescriptor` 在生效值之外携带 `base`/`user`，表单据此按「字段是否出现在用户层」来标记「已覆盖」，而非按值是否不等（与 base *相等*的覆盖仍然是覆盖）。`describe({ redactSecrets: true })`——在每个 wire 面都强制启用——经由对 schema 的纯结构遍历（object/dict/array 容器；secret 角色子树整体是一个不透明叶节点）从全部三层剥除 `role('secret')` 子树，并把剥除的槽位枚举为 `{path, set}`，页面因此不必收到任何值就能渲染只写输入框。

**Host 识别并打开本地设置文档。** settings seam 暴露可选的 `documentPath` 提供方元数据和 `prepareDocument()` 操作；`settings-file` 返回已完全解析的自定义文件名或 `$DSH_HOME/settings.yaml` 文件名，并在文档缺失时以仅属主可访问的权限独占创建空文档，非文件提供方则保留基类的 `undefined`。经浏览器认证的 `settings/describe` 响应会在脱敏 namespace 视图旁只携带布尔型 `hasDocument` 能力。`ui-settings-general` 只在回环页面注册一条 `settings.action` 条目，只有元数据确认可准备好一份由 provider 持有的本地文档后才显示，并调用无路径参数的 `settings/openSettingsDocument`；Host 会在文本文档交接前再次解析 provider 路径（macOS 上使用 `open -t`，使任意 YAML 文件关联无法重定向这次操作；桌面 Linux 上使用 `xdg-open`；Windows 上使用 `Invoke-Item`；WSL 上先执行 `wslpath -w`，再使用同一 Windows 交接）。通用 Workspace 路径仍保留默认意图，包括针对浏览器可渲染文档的浏览器偏好。浏览器既不推导 `$DSH_HOME`，也不会收到文件系统目标；非 loopback 页面保留 Client 策略，不为这项操作发起 Host settings 读取。

**llm seam 声明可配置性并公布拓扑。**`registerConfigurableProviders()` 是一个全有或全无、以 fiber 为作用域的目录，条目为 `{provider, displayName, settingsNs, settingsPath}`——这正是配置页要为一条可能尚不存在的路由打开正确设置子树时所需要的寻址；`listConfigurableProviders()` 在 wire 处理器里与存活路由合并，未声明的存活路由因此仍报告为激活。零负载的 `'llm/adapters-updated'` 事件从全部四个注册／注销提交点触发，listener 派发带异常隔离（INVARIANT 重抛），沿用 settings/commands 的先例。`llm-deepseek` 的路由重命名为 `deepseek-official`，因为 pi-ai catalog 名正言顺地拥有 `deepseek` 这个聚合器条目；依预发布立场，不设别名。

**架在 schema 模型层之上的手写编辑器。**`dsh-client-ui-settings` 提供的 `ctx.settingsSchema` 把 wire 的 `toJSON()` 信封还原（rehydrate）为活的 schemastery 节点，用于校验、路径解析与不可变草稿编辑——但不做通用渲染：第一版交付了完整的 schema 驱动表单渲染器，得到的却是一个未加样式、把 schema 原样倾倒出来的页面（每个进阶字段都平铺到卡片上、原始字段名直接充当标签、`retryPolicy` 的「不支持」回退落在主流程里）。手写方向胜过了再加一套提示／分组系统，进一步的简化又把引用输入框整个移除：卡片的主字段是一个 **API 密钥** 输入框，未配置密钥的整分节提供方会以其设置卡片的形式打开，收起的「自定义设置」折叠区承载按家族精选的额外字段（两个家族都有 `baseURL`，deepseek 有 `reasoningEffort`／pi-ai 有 `reasoning`，另有直接 DeepSeek 模型行的 `id`、`name` 和 `contextWindow`）。现有模型字段中不在可见集合内的部分会在数组编辑后保留；重试策略、超时及其他字段仍归 `settings.yaml` 所有。校验仍会在写入前运行还原出的 schema，适配器特有的检查则会拒绝序列化 schema 无法表达的目录不变量。卡片的颜色经 `--dsw-alias-*` 设计 token 解析；它此前引用的 `--border`／`--surface`／`--text-*` 在本应用中无人定义，于是渲染出的是它们的亮色模式回退值，在暗色主题下依旧保持亮色。模型目录采用 pi-ai 提供方表单引入的行形态：每个模型一个带边框的条目，ID 与显示名称落在行上，容量则收在该行自己的折叠区里，使两个编辑器呈现为同一套设计，而不是各自分岔。每个字段都保留那个为其命名的带序号 `aria-label`。两项容量都是文本输入框，读取十进制的 `K`／`M` 后缀（`1M` 即 1000K，与容量的通行标注方式一致）并存储纯数值：字段持有焦点期间保留键入的文本，因为若每次按键都从解析出的数值重新推导该文本，`1000` 会在尚未输完时就被改写成 `1K`；无法解析的文本也会留在屏幕上，因此保存时的拒绝点名的是用户仍能看见的那一行。共用的类名只承载已声明的 token 写法：`--dsw-alias-border-subtle`、`--dsw-alias-text-tertiary` 和 `--dsw-alias-text-primary` 均未声明，写出它们就会解析为各自回退槽位中的亮色模式字面值。现在有一个样式测试会拒绝 token 表未声明的任何 `--dsw-*` 名称，因此下一个写出这类名称的编辑者会当场失败，而不是交付一个只有亮色的界面。

**Models 页是一次三领域联接，应用语义与服务同形。**每一行是一个已配置的提供方；「新增」卡片的选择框是可配置提供方目录中剩余的休眠条目。路由存活状态仍用于就绪判定，并会使该联接失效，但页面不将其渲染为提供方状态，因为配置存在与运行时可用性是两个不同概念。密钥通道保持引用形态，却从不展示任何引用：键入的密钥经 `credentials.set` **只写**存入 profile 的 `apiKeyEnv` 之下，引用不存在时便派生 `<ROUTE>_API_KEY`（仅在输入密钥时，pi-ai profile 才会记录该派生），因此 `settings.yaml` 从不携带密钥值；留空 pi-ai 密钥会具化一个不带引用的 profile，并保留提供方原生认证。profile 的编辑和删除会针对脱敏后的用户分节，以按路径寻址的最小 `settings.mutate` 操作落地，绝不会点名页面未收到的机密。删除用户层提供方时，会先打开本地化确认对话框，其行操作、标题、说明和最终操作都会点名同一个提供方；确认后会先清除与派生目标精确匹配且已配置、可写的凭据，再删除 profile，自定义目标、环境目标和无法识别的目标则保持不变。两个阶段都具备幂等性，部分失败会留在对话框中供重试。DeepSeek 的模型列表是数组替换配置：继承而来的生效模型行会一直显示，直到第一次编辑将完整列表具化到用户层；重置则会取消设置该列表覆盖。`llm.discoverModels` 的结果会留在选择框的本地状态中，直至点击**添加所选**；已配置的 ID 默认不勾选，本地化搜索会过滤 id 和可选显示名称而不改变隐藏项的勾选状态。**全选**／**取消全选**只会改变本地集合中的可见候选，因此经过过滤的批量选择仍遵守同一条容量保护规则。部分提交与凭据所有权的理由记录在[提供方凭据生命周期 note](../bug-fix/2026-08-06-provider-credential-lifecycle.zh.md)中。

## 曾考虑的替代方案

- **在 wire 上改发 JSON Schema**——schemastery 的 `toJSON()` 信封能往返保留 `role()`/meta，并还原成客户端为草稿校验本就自带的那个校验器；转换成 JSON Schema 丢掉的恰恰是凭据控件与 secret 脱敏所依赖的角色注解。
- **通用的 schema 驱动表单渲染器**——先实现、后被替换：如实呈现字段却缺失视觉层级，产出的卡片丑陋且不可用；要把它做好，就意味着构建一套提示词汇（主要／进阶分组、逐字段描述、数组项卡片），成本堪比手写编辑器，却仍无法与任何设计稿完全吻合。相关的两份 schema 是 DeepSeek 的 `Config` 与共享的 pi-ai profile，手写因此就是两套以 namespace 为键的薄布局；漂移风险由保存时的 schema 校验以及未知字段在文档中的原样保留共同约束。
- **逐字段脱敏机密并在 `replace` 时回填哨兵值**——请求级 seam 的决策（机密是引用）已经为产品默认形态删掉了「存储字面量」这种情况；结构化脱敏加上只写的凭据通道足以处理残余情形，无需让每个写入方都学会一套哨兵协议。
- **把键入的密钥存成字面 `apiKey` 设置**——单个 API 密钥输入框的需求本可以把字面量直接写进 profile，但 UI 的每条删除路径都会从*脱敏后的*各层重建用户分节，任何重置或整行删除都会静默丢掉已存储的兄弟密钥；派生引用让输入保持单字段，同时让 `settings.yaml` 不含机密、每一次 replace 都安全。
- **由 `models` 桥接插件持有提供方配置**——与请求级 seam note 相同的否决理由：按插件划分的 namespace 加上四字段的目录声明已经给了 UI 需要的一切；桥接层的统一字典会把适配器映射那层间接重新引进来。
- **页面侧轮询而非推送帧**——mux 已经承载 `host/commands-changed`；再加三个帧，每个只需增加一种形状，就能让第二个标签页、外部的 `settings.yaml` 编辑和由设置催生的路由都以事件速度收敛。
- **在浏览器中硬编码 `$DSH_HOME/settings.yaml`，或经 `session/openWorkspacePath` 回传 `documentPath`**——否决，因为 `settings-file.path` 可能选择另一份 YAML/JSON 文档、非文件提供方没有 Host 路径，而且通用路径请求会让浏览器成为本地文件系统目标的权威。提供方的准备操作才是权威来源，由 Host 持有的操作会把结果交给现有打开器。

## 后果

整条闭环以无密钥方式固定在浏览器测试通道（`apps/web/tests/models-settings.e2e.ts`）：「新增」卡片提供休眠的 pi-ai catalog，携键入的密钥添加 `minimax-cn` 会把只含引用的 profile 写入 `settings.yaml`、把密钥值存入 harness 家目录 `.env` 中派生的 `MINIMAX_CN_API_KEY` 之下、路由随拓扑帧注册为存活，「自定义设置」折叠区则把 `reasoning` 合并到引用旁边——全程零模型调用，「新增」卡片态、已配置态、模型选择框态与已点名目标的删除确认态各有 ARIA golden，另有脚手架式的 `harnessHome`，测试绝不触碰真实的 `~/.dsh`（受测提供方是派生引用不可能与开发者已导出密钥相撞的那一个）。模型选择器路径会过滤 catalog、只清除可见项的选择、在查询清空后恢复隐藏勾选，并在 ARIA golden 中记录本地化搜索控件；组件测试还固定了按 id 和可选名称匹配、无结果状态以及仅作用于可见项的批量选择。设置外壳场景会截获无路径参数的原生意图；Service Definition、提供方、wire、React 与原生打开器测试分别固定了提供方缺失、自定义路径解析、缺失文件创建、仅属主权限、远程／不可用时隐藏、重复点击合并、本地化失败、macOS 文本编辑器分发，以及 Linux/Windows 桌面分发。删除场景证明，取消会保留 profile 和密钥，随后的确认会同时删除 profile 及其已识别的受管凭据。DeepSeek 首次使用 fixture 会把默认目录编辑为用户自有列表、持久化任意模型的 ID／名称／上下文窗口、移除活动模型行，并观察模型选择器的空选择回退。这次重命名触及 239 个文件（fixture（测试前置数据）、golden、文档、python），未保留兼容别名。替换渲染器不需要任何 wire 变更：应用语义、脱敏与目录联接从一开始就与渲染器无关。延后事项：每行的模型预览（选择器已能列出模型）和为从未声明可配置性的存活路由提供页面地址。
