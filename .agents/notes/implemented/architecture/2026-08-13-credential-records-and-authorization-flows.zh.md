# Agent Note: 凭据记录与授权 flow

Status: implemented

[English](2026-08-13-credential-records-and-authorization-flows.md) | 中文

## Problem

harness 的凭据平面只能表达一种机密：藏在某个环境变量名之后的值。`CredentialRef` 是一个 POSIX 标识符，解析时按进程环境、受管文件、`.env` 回退分层，每个消费方按操作读取。这恰好覆盖 API key，此外什么都不覆盖。

有些凭据不是"可以让部署方去存"的值。它们是被**取得**的——与人对话：对方打开页面、批准账号、把码粘回来——产出的是一份带 refresh 半边、会在用户背后轮换的 token 文档。pi-ai 直接建模了这一点（`Credential = ApiKeyCredential | OAuthCredential`、由应用拥有的 `CredentialStore`、`Models.login()`），而 harness 无处安放其中任何一项。`PiAiAdapter` 用不带参数的 `createModels()` 构造集合，于是那个 store 就是 pi-ai 的内存默认实现：每次启动为空，每次配置变更被丢弃。只以 OAuth 认证的 `openai-codex` 因此每个请求都以 `Provider is not configured` 失败——[被目录withheld](../../archived/bug-fix/2026-08-13-oauth-only-providers-withheld.md) 作为发布前修复，它移除了错误的供给，但没有补上能力。

同一处缺失还带来另外两个缺口。提供方自带的凭据发现是对着裸进程环境跑的，因此凭据 seam 保管的密钥对它不可见，本地凭据文件更是从未被查找过。而登录没有任何界面可以发起，因为 harness 里没有任何东西能代替插件向人发问。

## Decision

三个 seam，各自拥有一个问题；所有 pi-ai 概念都藏在 `llm-pi-ai` 内部的适配器背后。

**`dsh-credentials` 长出第二个键空间。** `CredentialRef` 回答*这个环境变量名背后是什么*；`CredentialKey` 回答*这个插件为这个 id 持有什么凭据*。记录联合体是 `{ kind: 'api-key', key?, env? } | { kind: 'grant', payload }`——api-key 那半是结构化的，因为 seam 能描述它；grant 那半是不透明的，因为拥有 token 格式的库应当继续拥有它。对 payload 的唯一约束是它能原样通过一次 JSON 往返，读写两个方向都会校验。

键的形式是 `<scope>/<id>`，其中 scope 是**拥有该记录的插件的注册名**，不是提供方名。用户知道的是 `openai-codex`；究竟哪个 adapter 家族为记录里的字节负责，恰恰是裸提供方名会丢掉的信息。服务同一个提供方名的两个插件会互相读到对方的 payload，已卸载插件留下的记录也无法与仍在使用的区分开。`/` 同时让两种文法互斥，两个键空间因此不可能相撞。这以"同一个 provider 路由只由一个 adapter 注册"为前提，而 LLM 注册表本就强制了这一点。

记录不分层。授权 grant 没有任何"环境"可供读取，因此记录是否存在就是全部事实，管辖引用的空值规则在此不适用：一条既无 key 也无 env 的 `api-key` 记录，陈述的是其拥有者确认了环境认证可用，这属于已配置。

**`dsh-authorization` 拥有对话，从不拥有协议。** 知道如何取得自己那份凭据的插件，以该 flow 写入的 `CredentialKey` 注册。seam 对每个键同时只跑一次尝试，路由一套中立的 notice/prompt 词汇，然后结算。第二种授权协议以另一个 flow 的形式到来，而不是另一个 seam；能渲染一个 flow 的界面就能渲染全部 flow。

两个选择承担了主要分量：

- **写入由 flow 拥有。** `run()` 返回即表示记录已通过 `ctx.credentials` 提交；seam 核实的是本次尝试期间观察到的提交——只看记录存在与否，会让重新授权把陈旧记录冒充成新鲜的——并拒绝返回时没提交记录的 flow。正是这一点让 `Models.login()`——它把持久化当作登录的一部分，经由 store 适配器完成——保持为唯一写入方，而不是把凭据复制出来再写第二遍。
- **交互随请求传入，而非注册表。** 发起授权的一方才是能与人对话的一方，因此提示恰好抵达发问的那个页面，无头调用方传入一个直接拒绝的交互实现，也不存在"环境提供方缺席"或"该归两个已打开标签页中哪一个"的问题。

**三处翻译全都留在 `llm-pi-ai`。** `credentialStoreFrom` 把 pi-ai 的 `CredentialStore` 映射到记录；`authContextFrom` 先查凭据 seam 再查启动环境来回答 pi-ai 的环境提问，文件存在性则按宿主进程的文件系统判断；`registerPiAiFlows` 把 pi-ai 的 `AuthEvent`/`AuthPrompt` 重述为中立词汇并运行 `Models.login()`。每个集合都用前两者构造，正是这一点让已登录的提供方在配置变更导致集合重建之后仍然处于登录状态。有了行得通的姿态之后，目录不再扣留仅 OAuth 的路由，`openai-codex` 重新被提供。

凭据平面仍是可选的，正如它在引用解析上一贯如此。没有凭据服务时读取回答"未存储"，因为这样的组合确实不持有任何凭据；写入则指名拒绝，因为一次 grant 凭空蒸发的登录会先报告成功、再让每个请求失败。flow 注册通过 `ctx.inject` 限定在授权 seam 之下，因此 headless 或 ACP 组合挂载后没有登录能力，其余一切不变。

### seam 底下需要的两处机制

`withFileLock` 接受按调用声明的等待上限。pi-ai 在 `credentials.modify()` **内部**执行 OAuth 刷新，因此记录写入路径要跨越一次网络往返持锁；2 秒的默认值是按"渲染并 rename"的量级选的，会让该文档的每一个其他写入方失败。重试节奏保持固定——那是协议常量——而等待时长按争用方可能遇到的最长持锁方来定：refs 与 records 共享同一份文件、同一把锁，因此该文档的每一个写入方（`DOCUMENT_LOCK_WAIT_MS`，含引用写入与记录删除）都要等得起一次 OAuth 刷新，而不只是执行刷新的那个 mutation。

seam 的边缘与写入路径同一纪律。prompt 被拒是结果而非故障——交互实现以 `AuthorizationDeclinedError` 拒绝，尝试以 `cancelled` 结算；渲染不了 notice 的界面只丢那条 notice、绝不拖垮 flow；`authorization/settled` 按 credentials seam 的条款以遏制方式分发监听器故障。存储侧，api-key 记录在渲染前先行准入（`parseRecord` 下次启动会拒绝的，写入时就拒绝），`llm-pi-ai` 在寻址记录前先问 `isCredentialKeySegment`，任意手写路由键读作「没有存储任何东西」，而不是在解析途中抛错。

撤销会结算一次尝试，无论其 flow 是否响应信号。flow 本应在信号触发时停止，但不停止的那个会把键占到进程结束，而被卡住的键从外部看与忙碌中的键无法区分。被遗弃的执行体听任其自行结束。

## Alternatives considered

- **把 pi-ai 的 `CredentialStore` 形状直接放进 seam。** 那是行得通且已经设计好的形状。它同时把 `api_key`/`oauth` 定为世上仅有的两种凭据类别，并以 provider id 为键，也就是上文那种所有权丢失；第二个 adapter 家族将不得不假装自己是 pi-ai 才能参与。记录联合体刻意只在两处更抽象一步——键，以及 grant 的不透明性。
- **在 `user-questions` 旁再建一个专用登录交互 seam。** 授权提示看起来就像问题，复用 `ctx.userQuestions` 很有诱惑力。但那个 seam 是为"模型的工具调用代表 agent 暂停"而建的：它校验调用方 agent、拒绝被委派的调用方、只有一个环境 UI 提供方。授权提示没有 agent，必须抵达发起它的配置页面，还可能被浏览器回调赢得竞速后按单个提示撤下。词汇重叠，生命周期不重叠。
- **把 `~/.codex/auth.json` 读进一个 store。** 这能让 Codex 在不做上述任何事的情况下工作，刷新也由 pi-ai 负责。它同时为了一个提供方把 harness 绑死在另一个工具的私有文件格式上，且其余所有登录仍然没有着落。
- **让第二次 `begin()` 并入已在运行的尝试。** 比拒绝更友好，直到两个人在回答同一个 flow 的问题为止。以 entry 上的 `inFlight` 配合拒绝，界面得以禁用按钮，而不是靠报错才发现状态。
- **把"仅 OAuth 则扣留"当安全网保留。** 它现在会藏起一个能用的提供方。该判定被删除而不是留成惰性代码；`docs/subsystems/credentials.md` 与包 README 承载了取代它的内容。

## Consequences

`.credentials.yaml` 增加了版本与两个分区。启动时会把能精确识别的发布前扁平布局原地升级——全字符串的扁平 mapping 在写锁下逐字下沉到 `refs:` 之下——因为早期内测构建经模型页面存下的密钥必须在布局变更后继续可用，不能要求手工编辑，也不能让模型请求失败。识别器无法证明自己理解的扁平形态仍被指名拒绝，迁移办法写在报错信息里；解析器本身始终只读一种布局，迁移步骤将随发布前立场在首个正式版本时移除。仓库中所有写扁平文档的 fixture 都已改写；llm 各套件的 fixture 被记录改动本身漏掉了，在此补上。

`openai-codex` 回到提供方选择器与 Models 页目录。全部 38 个已安装提供方都提供登录入口：31 个经 pi-ai 自己的提示收取密钥，6 个在此之外还提供订阅登录，Codex 只提供订阅登录。

尚未包含的是界面：把 notice 与 prompt 送到浏览器的 wire 契约，以及 Models 页上发起登录的控件。在那之前，flow 只能在进程内触达，部署方仍然通过在设置表单里输入密钥来配置。

有两项限制记在包 README 里而非就地修复。一次尝试不可持久，登录途中刷新页面会丢弃它。登出即 `deleteRecord`，它只在本地遗忘而不通知签发方；需要服务端吊销的提供方无处声明这一点。

## Testing

seam 自己的套件钉住它拥有的生命周期：单飞的拒绝与释放、flow 启动前与进行中的撤销、一个忽略自身信号的 flow、提交核实，以及包含"调用方看到的是抛出错误"那种 `failed` 情形的结算事件。invariant companion 钉住"已结算的键就是空闲的键"，因为被卡住的键否则不可见。

`llm-pi-ai` 针对一份真实的 `$DSH_HOME` 文档覆盖三处翻译——逐字段的 api-key 凭据、连 refresh 半边一起原样保存的 OAuth 凭据、按 scope 跳过的他插件记录，以及没有凭据服务时的写入拒绝——外加每一个 `AuthEvent` 与 `AuthPrompt` 成员的重述；`Models.login()` 在集合边界处被 mock，因为真实登录会打开浏览器。两个真实组合测试分别在挂载与不挂载授权 seam 的情况下启动插件。

`models-settings` 与 `onboarding-usable-provider` 两条 web e2e golden 恰好收回了被扣留时失去的那一行 `openai-codex` 选项——这是本决策记录的唯一装配后应用差异，因为 Models 页还没有可录制的登录控件。
