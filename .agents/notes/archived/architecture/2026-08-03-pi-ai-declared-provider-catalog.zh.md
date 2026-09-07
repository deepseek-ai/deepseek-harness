# Agent Note: pi-ai 路由是被声明的提供方，而不是 catalog 查表

Status: implemented
Archived: 2026-09-04

[English](2026-08-03-pi-ai-declared-provider-catalog.md) | 中文

## Problem

`dsh-llm-pi-ai` 把 pi-ai 包生成的 catalog 当成了可配置范围的边界。路由键必须点名一个已安装提供方（`resolveProfiles` 拒绝其余一切），模型列举原样返回 `getBuiltinModels(provider)`，请求期的模型解析又在同一份 catalog 里查这个 id、且只覆盖 `baseURL`。由此产生三个后果，而且三个都是死路而非缺口：OpenAI 兼容网关、自建服务，或比已安装 catalog 更新的提供方，根本无法配置；catalog 尚未跟上的模型即便端点正确也会以 `UNKNOWN_MODEL` 失败；模型的上下文窗口与输出上限完全由锁定的 pi-ai 版本决定，部署既无法更正陈旧值，也无法为 pi-ai 从未描述过的模型补上。要动其中任何一条，只能升级依赖。

适配器还经 `@earendil-works/pi-ai/compat` 的 `streamSimple` 发起流式请求，而该入口自己的模块文档声明它是临时兼容面——其 catalog 读取标了 `@deprecated`，并会在 pi-ai 完成 `ModelManager` 迁移时被删除。这三条配置限制与这个废弃依赖的解法是同一个，因为 pi-ai 受支持的运行时（`createModels()` / `createProvider()`）正是围绕「提供方是被*声明*出来的，而非查出来的」建立的。

## Decision

提供方路由是一份**声明**，已安装 catalog 是它的默认值。`resolveProfiles` 不再拿路由键去核对 `getBuiltinProviders()`，而是把每条路由解析成一份物化模型列表，外加服务它的 pi-ai `Provider`：

- `catalog.ts` 把已安装 catalog 合并到 profile 自身条目之下。profile 的 `models` 列表*替换*该路由的 catalog（列表缺席或为空则原样服务），每个条目从同 `id` 的已安装模型继承自身未设置的字段。只有 harness 会消费的字段可配置——`id`、`name`、`contextWindow`、`maxTokens`；[[2026-08-08-pi-ai-per-model-reasoning-declarations]] 之后加入了 `reasoningEfforts` 与 `compat`，当初「推理（reasoning）沿用已安装条目或直接缺席」的立场也在那里被重新审视（孤立的能力布尔量仍被拒绝；带 wire 拼写的逐档位完整声明没有它那个问题）。输入模态后来被开放，形态是条目上的 `input` 加路由级 `defaultInput`——图片准入点使得「未被报告的模态」变成部署无法解除的拒绝之后（[[2026-08-12-pi-ai-route-default-input-modalities]]）；当初「没有任何读取方」那句论证描述的其实是 `llm-deepseek` 的序列化器，而不是这条路由，它的转换器能携带图片。定价仍因原有理由不出现在配置面：`replay.ts` 把 pi-ai 的成本元数据清零，且没有任何消费方报告开销。物化时以已安装条目铺底、再覆盖已配置的字段，而不是逐字段枚举结果：枚举式重建会静默丢弃本包未建模的每一个 `Model` 字段——`headers` 就是这样从某条 nvidia 路由上消失过一次。
- `provider.ts` 构造路由的 `Provider`。保持 catalog 协议不变的 catalog 路由会**复用**已安装提供方，只替换 `getModels()`；其余路由都由 `createProvider()` 基于一张协议表构造，表中条目正是 pi-ai 自己的提供方工厂所用的 `@earendil-works/pi-ai/api/*.lazy` factory。该表刻意窄于 pi-ai 的完整 API 集合——只保留 profile 能用密钥、端点与标头完整描述的协议，因此 Bedrock（SigV4 加 region）、Vertex（project、location、ADC）、Azure（提供方环境加 api-version）与 Codex（OAuth）不在其中，而不是被当作无法认证的路由提供出去。catalog 路由仍可经自己的 provider 抵达它们；被拒的只有显式覆盖。
- `adapter.ts` 把每次解析变成一份**不可变快照**——profiles 加上持有这些 provider 的 `createModels()` 集合——每个操作都在自己第一个 `await` 之前整体捕获一份。

- 模型**显式配置**的 `maxTokens` 会成为 seam 的 `defaultMaxTokens`；从已安装 catalog 继承来的那份不会：pi-ai 要求 `Model.maxTokens` 表示模型的输出*能力*，而 `defaultMaxTokens` 是部署选定、发给未点名上限的请求的那个值，把前者物化成后者会让每个请求都被一个无人选择的数字封顶。

### 快照，而不是共享集合

`Models.streamSimple()` 惰性解析提供方——在返回的流首次被消费时，而那已在适配器 await 路由凭据之后。因此就地改动的单一集合，会让一个在旧配置下开始的请求在新配置下结束，或者撞上一个已不存在的提供方，尽管 `llm.prepareCall()` 早已冻结了该步的 config 并捕获了其适配器注册。配置变化改为构造*新*集合，正在被使用的那个原封不动，于是 seam 的每步冻结得以贯通到底：回复途中切换模型在下一步生效，绝不影响在途的那一步。

### 目录原子替换

可配置提供方目录跟随 profiles，因此每当一条声明路由出现或离开它都会变化。「撤销旧注册再新建一个」表达不了这件事：注册表拒绝的候选集合——比如一份键为 `deepseek-official` 的 profile，而 `llm-deepseek` 已声明了它——会让本插件的整个目录被撤走、Models 页变空，而且是静默的，因为 settings 变更回调把失败容住了。因此 `registerConfigurableProviders` 改为返回带 `replace(entries)` 的句柄，其「候选集先整体校验」的原子性与 `registerAdapter` 相同，插件改用它。被拒的替换只付出一条诊断；先前的条目继续服务。

解析失败得响亮，并点名出问题的路由与模型：catalog 未描述的模型会回落到该路由自己的 `defaultContextWindow`／`defaultMaxTokens`，因此只公布 id 的列表也能得到可服务的路由；catalog 未提供的路由需要 `api`、`baseURL` 和非空的 `models` 列表。由于构造出的 `Provider` 是解析结果的一部分，协议或模型出错时最后可用的路由集合会继续服务——与此前坏的 settings 快照的行为完全一致。

可配置提供方目录现在是已安装 catalog **与**当前 profile 声明的每条路由的并集，并在该集合变化时重新登记。没有这个并集，手工声明的路由就没有 settings 地址，任何配置界面都无法展示或编辑它。

### 唯一档位什么也做不到的能力，报告为不可用

pi-ai 把没有推理元数据的模型报告为只支持 `off` 一档，而适配器此前原样透传。它抵达 seam 时是一个单元素的 effort 列表，任何界面都会把它渲染成一个只有一项可选控件的选择器——而这个控件在撒谎：`off` 在派发时变成被*省略*的推理选项，与「不点名任何档位」产出的请求逐字节相同。自身默认就在思考的提供方会继续思考，界面却显示 `off` 已选中。

因此只要 `model.reasoning` 为假，`reasoningInfo` 就省略 Service Definition 的 `reasoning` 字段。判据是模型自身的元数据，而非模型的来源，所以它覆盖条目未声明 `reasoningEfforts` 的每一个手工声明模型（[[2026-08-08-pi-ai-per-model-reasoning-declarations]] 让声明的档位携带这份元数据）**以及** pi-ai 标记为不具备推理能力的那 251 个已安装 catalog 模型。它们此前提供那个孤零零的 `off`，现在什么也不提供，界面只剩提供方默认。携带推理元数据的模型不受影响——其档位列表仍不经筛选地穿过 seam、`off` 也在内，因为在那里它是在真实备选之间做选择。

### 凭据留在 pi-ai 之外

pi-ai 的 `Models` 自带一套凭据概念——按提供方 ID 索引的 `CredentialStore`，配合 `envApiKeyAuth` 解析 `credential.key ?? env(VAR)`。采用它会在 `ctx.credentials` 之外制造第二个凭据真源，更糟的是会把 harness 明确禁止的环境回落重新引进来：点名了却取不到的 `apiKeyEnv` 必须以 `MISSING_CREDENTIAL` 失败，而不是用环境里恰好持有的某个无关密钥完成认证。

`ModelsImpl.applyAuth` 会把 `options.apiKey` 当作该请求的密钥，但这条路必须经由一个声明了 api-key 方法的提供方：`resolveProviderAuth` 在覆盖存在时短路到该方法，否则依次落到凭据存储与环境发现；若提供方压根没有 api-key 方法，它返回空，请求随即以 `Provider is not configured` 失败。因此 harness 一如既往经自身 seam 解析路由密钥，并把结果作为请求的 `apiKey` 传入；该集合构造时不带任何凭据存储。

路由的 auth 由此推出。catalog 路由保留已安装提供方自己的 `auth`，从而为不点名凭据的 profile 保住其提供方原生环境发现，且在 `api` 覆盖之下同样保留：提供方读哪个环境是提供方自身的属性，而非其模型所讲协议格式（wire format）的属性。例外是没有 api-key 方法的 catalog 提供方——`openai-codex` 只走 OAuth——此时点名了凭据的 profile 会在提供方原有 auth 之外再获得 harness 的方法，否则它配置的密钥会在任何请求发出之前被拒。这类路由上不点名凭据的 profile 什么也不加、并保留那句诚实的拒绝：本适配器没有可供解析的 OAuth 存储。手工声明的路由则获得一个 harness 自有的 `ApiKeyAuth`，它报告「已配置但无密钥」而非「未配置」，把该要求留给协议——那才是它真正所在的位置：pi-ai 的 OpenAI 兼容实现仍要求密钥或 `Authorization` 标头，并且会自己说出来。

## Alternatives considered

- **保留 `createProvider()` 但不建 `Models` 集合**，改由 `provider.streamSimple(model, ctx, {apiKey})` 发起。改动最小且凭据路径原封不动，但 `createProvider` 的 `auth` 是必填字段，这条路上它永远不会被调用——一份因签名而必填、却没有调用方的实现。它还让 `refreshModels` 需要手工构造 `RefreshModelsContext`，并使适配器始终不在 pi-ai 真正支持的运行时上。
- **catalog 路由复用已安装提供方，只有声明式路由走 `createProvider()`**，且两者不共享解析。对 catalog 行为零风险，但 catalog 物化、端点覆盖与每模型配置这三件事都要各写两遍，而改指协议的 catalog 路由还得在解析中途跳到另一条路径。已采纳的拆法把不对称收敛在提供方构造这一处——那里的不对称是 pi-ai 不暴露已构造提供方的 API 实现所强加的。
- **让每条路由都经 `createProvider()` 重建**，包括 catalog 路由。完全对称，但已构造的 `Provider` 不暴露自己的 `api`，于是协议表会成为「哪些提供方能用」的天花板——Bedrock 经独立入口加载其 Smithy 模块，会因此静默失效。
- **完整暴露 pi-ai 的 `Model` 形状**（成本、输入模态、`thinkingLevelMap`、`compat`）。可配置性最大，但这些字段当时没有任何读取方，因此配了价格或模态什么也不会改变，却看起来像是受支持的。这条否决里由消费方驱动的那一半后来逐字段兑现了，每次都等到出现真实读取方：[[2026-08-08-pi-ai-per-model-reasoning-declarations]] 在选择器与分派真正消费之后开放了推理（以 `reasoningEfforts` 的形态，而非裸 `thinkingLevelMap`）和两个推理分派 `compat` 开关；[[2026-08-12-pi-ai-route-default-input-modalities]] 在图片准入点开始读取之后开放了模态（以 `input` 与 `defaultInput` 的形态，而非裸 `Model.input` 直通）。成本仍因原有理由保持关闭。

- **保留单个可变 `Models` 集合并重新同步。** 分配更少，且对每个同步完成解析的操作都是正确的；唯独对那个不同步的操作恰恰是错的：`stream()` 会在捕获模型与派发模型之间 await 一次凭据。
- **用「先 dispose 再注册」模拟目录原子替换。** 无需改 seam，且在新集合有效时确实可用——而那正是从不需要原子性的那种情形。
- **运行时动态 catalog**——`fetchModels` 加 `ModelsStore`，后台刷新。本次变更拒绝：它把模型列表变成需要缓存、失效与离线路径的外部可变状态，而产品需求是一次性的发现动作、其结果由用户采纳进 `settings.yaml`。该动作属于配置界面，与之一并暂缓；`settings.yaml` 始终是「路由服务什么」的唯一真源。

## Consequences

配置一个提供方不再取决于 pi-ai 的发布节奏。网关、自建服务，或比锁定 catalog 更新的模型，都是一次 `settings.yaml` 编辑，陈旧的上下文窗口也能就地更正。废弃的 `/compat` 导入已经消失，因此 pi-ai 删除它不再是破坏性事件。`defaultMaxTokens` 现在会在部署明确给出时从配置中传入，不会从 catalog 元数据里发明一个上限。

代价是：声明式路由会让 `settings.yaml` 变长，因为它必须自报端点、协议与模型 id。`api` 作用于整条路由，因此混合协议的 catalog 路由无法承载另一种协议的模型——把它拆成两个路由键是变通办法。没有任何环节查询提供方的 `/models`，因此模型列表的新鲜度只到最近一次编辑为止。有一种情形下报错形状发生变化：auth 解析不出任何值的路由，现在会在任何网络调用之前把 pi-ai 自己的诊断作为错误 `finish` 分片呈现，而此前的适配器会发出无密钥请求并呈现提供方的 401。

## Testing

`tests/catalog.spec.ts` 针对本地 mock 服务器端到端覆盖该约定：手工声明的路由带着自己的凭据流向自己的端点、它在可配置提供方目录中的出现、每模型覆盖从已安装 catalog 继承默认值、向 catalog 路由添加模型、带与不带端点覆盖的协议改指、catalog 独有元数据在覆盖后存活、无密钥姿态及其 `Authorization` 标头变通、只走 OAuth 的 catalog 路由用 profile 点名的密钥完成认证而无密钥者保持未配置、改指协议的路由保留其 catalog auth，以及每一种点名路由或模型的解析失败。`tests/catalog.spec.ts` 还钉住了快照与目录两项约定：在途请求即便其路由集在 credential await 期间改变，仍抵达它解析时对应的端点；下一个请求取用新配置；冲突的声明路由让目录保持完好；声明路由的条目随其 profile 出现与离开。`packages/llm/llm/tests/topology.spec.ts` 覆盖 `replace`——拒绝他人已拥有的候选同时保住当前集合、接受对自身条目的替换、允许空集合，以及 dispose 之后失败。`tests/sdk-options.spec.ts` 把 SDK 边界从已移除的 `/compat` 导入改指到协议表的 lazy api 模块，同时钉住「setup 失败以终止性错误分片而非抛出的形式抵达」。twin 的[设计验证角色](2026-06-13-twin-llm-adapters.zh.md)不变。
