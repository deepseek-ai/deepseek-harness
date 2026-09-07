# Agent Note: 会话的 agent 由一份 preset cordis.yml 组装而成

Status: implemented

[English](2026-08-03-per-session-agent-presets.md) | 中文

## 问题

一个 `dsh` 进程服务多个会话，但决定 agent（智能体）究竟是什么的那套组装——它的工具、人设、提示词段落、委派后端——由启动器所引导的 `cordis.yml` 一次性固定给整个进程。若某个部署希望一个 benchmark 精简 agent 与一个完整编码 agent 并存，就必须跑两个进程；而现有的变通方案（`apps/cli/config/minimal.cordis.yml`，一个用来禁用工具行的 `--config` 覆盖层）会一次性改变所有会话。

对"让会话自选组装"最直觉的理解，是 loader 需要新增一层。其实不需要。[`dsh-tools`](../../../../packages/core/tools/README.zh.md) 与 [`dsh-system-prompt`](../../../../packages/core/system-prompt/README.zh.md) 本就按调用方上下文的 scope 分层归档注册，而且 [agent 本身就是一个注册 scope](2026-07-08-agent-scope-contexts.zh.md)。此前缺的只是一种把整份 `cordis.yml` 指向某一个 agent scope 的办法。

## 决策

**preset** 是一个目录，其中放置一份 `agent.cordis.yml`。agent 工厂的 `setup(agentCtx)` 把它作为 Cordis `include` 子树，挂载到该 agent 的 scope 上下文之下。entry 上下文沿原型链连到子树被挂载时所在的上下文，因此 preset 内部的每一次注册都落进该 agent 的分层，并随 agent 一起卸载。没有任何注册表新增分层，也没有任何已在运行的会话被触及。

组装划分为两个平面，依据是什么必须共享，而不是什么感觉上与 agent 有关：

| 平面 | 实例数 | 内容 |
|---|---|---|
| 宿主 | 一份 | 注册表本身（`tools`、`systemPrompt`、`agents`、`agent-loop`、`sessions`）、跨会话设施（持久化、查询、投影、存储、设置、凭据、遥测）、这些设施所解析的 subagent provider，以及 web 宿主 |
| agent | 每会话一份 | 单个 agent 对这些注册表的贡献：工具插件、人设与提示词段落、压缩策略 |

模型路由不进 preset。`installAgentLlmTarget` 已经是 provider、model 与 reasoning effort 的按 agent 可替换点；而挂在 preset 内部的 LLM 适配器永远不会被 `agent-loop` 解析到，因为后者位于宿主平面。

部署交付哪些 preset，取决于 `packages/preset/agent-presets/presets/` 下有哪些目录；清单是那份目录列表，而不是在此另抄一份。

挂载默认按会话进行。实测一份十二行组装每会话约 3ms、约 600KB，因此隔离比任何共享方案都更划算；而由用户或 agent 写出的 preset 也因此拥有尽可能小的影响面。确实自带昂贵单例的 preset，可以用 Cordis 自身的 `isolate` 词汇显式选择共享：命名 realm 的 label 是进程级全局的，因此两棵子树只要写同一个 label 就解析到同一个实例。

未指名 preset 的会话拿到哪一个，是一项用户设置（`agent-presets.default`），叠在组装自身的 `default` 之上——后者成为 `base`。两层都需要：组装里的值是部署交付的东西，在完全没有 settings 提供方时也必须照常工作；而设置是让人不必去改一份可能并不属于自己的 `cordis.yml` 就能调整的东西。

## 后果

**有效默认值在每次解析时读取，绝不保存快照。** 缓存下来就需要一个 `watch` 订阅和一条重载路径才能保持诚实，而解析后的 scope 本来就会重读热重载过的文档。读穿也不只是省事，它让边界本身是对的：新值作用于**下一个新建的会话**，每个运行中的会话保持它被构建时的那份组装。这条不变量正是 session 日志从另一侧执行的同一条——header 记录会话**创建时**的 id，此后空白期的任何切换由 `agent-preset/selected` 事件记录，因此读取方解析的是两者之和（`resolveSessionPreset`）、绝不单看 header：恢复重建的是其历史所产出的那份组装而不是恢复时的部署默认值，冷读记录的 presenter 在那份组装的层里解析，网关也会拒绝把一个活着的会话收编到它当前运行的 preset 以外的 preset 之下。快照会让两者恰好在设置改变的那一刻各说各话。


**直接挂载的子树对启动审计不可见。** 它不会把自己关联到 `Entry`，因此不在 `ctx.loader.entries()` 中，`assertEntriesActivated` 也看不到它。改由挂载过程自行校验各行，通过一个会公开自身 tree 的 `Include` 子类读取。

**preset 能写出 group，是因为 app 注册了它。** 跨行共享 realm 就是一个 `cordis:group` 行，而住在本工作区之外的 preset——也就是 Harness home 下由人或 agent 创作的那些，正是这套设计的目的——无法按名字解析 `@cordisjs/plugin-group`：Node 向上查找 `node_modules` 的路径从那里永远走不到 harness。因此 `boot()` 把 `cordis:group` 与 `cordis:include` 并排注册为 loader builtin，两者都经由环境模块管线加载，而不依赖被包含树自身的说明符解析。没有它，上文那套 `isolate` 词汇就只能一行一行地表达，提供方也永远无法与它的消费方归入同一组。

**preset 不得把服务发布进根 realm。** 这类服务是进程级全局而非按会话的，因此第二个挂载同一 preset 的会话会与第一个相撞——而这次相撞表现为 `setup` 永远观察不到的未处理 rejection，留下一个看起来健康、实则组装到一半的 agent。挂载改为直接拒绝它；本包的运行时不变量还会在每次服务通知时复查，因为从定时器或异步续体中发布的行会绕过一次性审计。

**失败会让 agent 回滚。** `setup` 在发布之前运行，因此挂载被拒绝会让 `ctx.agents.create()` 失败且不留残留。这正是 `setup` 是唯一受支持调用点的原因。

**「preset 文件从不被回写」这条断言，必须先有失败的可能。** 最初那版在一次普通挂载之后断言文件未变，其实什么也抓不到：Loader 只在认定 config 变了时才会走到写路径，而那份组装里没有任何一行会自行销毁。回归用例改为植入一个自行销毁的行——真实 preset 在每次 agent 被拆除时都会命中的形状——并把组装放在临时根目录而不是 `fixtures/` 下：没有那个覆写，Loader 会回写它读入的文件，于是提交进仓库的 fixture 会被**恰恰是证明该缺陷的那次运行**改坏，之后每一次运行都拿改坏后的文件作比较从而通过。

**fiber 归属判定用对象同一性，而非 `uid`。** `uid` 是按 registry 计数的序号，因此两个不同根下的 fiber 会在它上面撞号；按 `uid` 比较曾导致一个运行时的子树为另一个运行时中发布的服务背锅。`ctx.plugin()` 返回的是 thenable 的 `Object.create(fiber)` 包装对象，与父链中出现的 fiber 永远不同一，因此子树在构造时捕获自己的 fiber。

**preset 文件是输入，绝不是持久化目标。** 只要 loader 认为配置变了，`EntryTree.write()` 就会回写整棵树，而一个插件自我 dispose 就足以触发——销毁 agent 会 dispose 它的整棵子树。若继承该行为，它会重写自己读入的那份组装，实际后果是第一次会话结束时把随附 preset 截断成 `[]`。子树因此把 `write()` 覆盖为空操作。

**按自身名字回查全局注册表的插件，在 preset 里必然失效。** `ctx.tools.register()` 归档进**调用方**上下文的 scope，因此挂在 preset 里的插件只为一个 agent 注册，而不带 scope 的 `ctx.tools.get(name)` 理所当然查不到。`dsh-tool-skill` 正是这样写的，于是每次 preset 挂载都抛错；现在它与自己注册的那个定义比对。任何希望可被 preset 挂载的插件，都必须持有自己的注册对象，而不是按名字重新读取。

**entry 本地 `isolate` realm 不仅对宿主不可见，对 agent 自身的 scope 同样不可见。** 只有该组内部的行能解析到该服务。这正是让 preset 的 `skills` 注册表归属单个 agent 而非共享的原因——同时也意味着：留在提供方组之外的消费方会悄然解析到宿主注册表，然后什么都不贡献。

**只有空白会话才允许切换。** 一旦跑过任何轮次，那段历史就是在该 preset 的工具下产生的，替换会留下无法执行的已记录 tool call，因此 `agentPreset.select` 返回 `agent-preset-locked`。空白期的切换保留 agent 与 session，只替换子树——因为宿主丢弃了它创建的 `AgentHandle`，也没有 delete RPC；而保留它们本身就是更好的结果，会话 id、workspace 挂接与 projections 都原地不动。该替换是"先卸后装"（两份组装会把同名工具注册进同一分层），因此它在拆除任何东西之前先解析新 preset，并在新组装装载失败时恢复原来的那一份。

**创作 preset 是一次 RPC，而且是特权 RPC。** 组装是一个文件，但“去文件系统里改它”并不是浏览器能提供的操作，因此名单在 `select` 之外新增了 `read`/`write`/`remove`。Connection 用一个浏览器会话认证创作操作、`list`、`select` 与完整 Host API：组装指明一个会话所运行的插件，因此读取它是侦察，写入它是任意能力；选择 preset 则没有授予 `session.create` 携带 `agentPreset` 时尚未拥有的能力。这份能力也不由 preset 授予：部署自带的默认 preset 本就带着 `bash` 与文件系统工具，因此任何被允许开启会话的调用方，早已能以本进程的身份执行命令。约束是 id 自身的性质（`[a-z0-9][a-z0-9-]*`），在它成为目录名之前就检查，而不是事后再去审视拼接出的路径；文本使用 loader 自身的 schema 与方言解析，因此保存不会留下任何会话都无法加载的文件。随部署提供的 preset 拒绝写入与删除，因为部署自带的那一份正是用来对照有问题的本地 preset 的——这也让“先复制、再编辑”成为创作路径本身，而非事后补充。

**在 agent 平面之外还有消费方的服务，不能搬进 preset。** 激进拆分把 `subagents` 注册表连同 spawn/fork 后端一起搬进了 delegation 组的 entry-local realm，于是 `dsh web` 直接起不来：`SubagentRuntime` 是 Host 行，它公开浏览器的跨会话 Remote 查询（`list`、`prompt`），因而永远等待一个只有会话才提供的服务。按会话各一份在两个层面上都是错的——provider 名只能注册一次，第二个会话本来也会相撞。注册表与所有共享后端，包括[固定的 Codex 与 Claude Code 产品 provider](../../archived/architecture/2026-08-10-product-subagent-providers-in-shared-host.md)，都属于宿主平面；preset 只贡献自己的 agent 应看见的委派**工具**，这些工具解析宿主注册表。`workflows` 保持 entry-local，因为 agent 之外没有任何东西读它。本该拦下它的是「检索注入方」这一步，而它没拦住：检索必须覆盖宿主包，而不只是 agent 平面的包。

**真实组装测试若禁用了某个宿主行，就无法审计该行。** web 组装测试保持 API Gateway 与各业务 Remote 服务启用，同时禁用只承载传输的 webserver、Connection、Session export、资源与遥测行。替换为 browse 目录选择器后，其启动审计无需绑定端口即可覆盖 Host 平面的服务图。

**preset 的包名必须从 harness 解析，而非从 preset 解析。** `EntryTree.import()` 按行所属树的 `baseUrl` 解析，而 `Include` 把它设为组装文件所在的目录。这对相对标识符是对的，对包名却是致命的：本地创作的 preset 位于用户主目录之下，Node 向上查找 `node_modules` 永远够不到已安装的 harness，因此每一个 `@deepseek-ai/dsh-*` 行都会导入失败，整个 preset 无法挂载。随部署提供的 preset 掩盖了这一点——它们本就在安装目录之内。挂载在插入子树之前先记录宿主组装的基址，并把裸标识符送往那里，同时让相对路径继续从 preset 解析，使它自带的文件仍随它一同迁移。发现它的正是那个把 preset 写入临时根目录的真实组装测试。

**preset id 对模型可见，必须写入日志。** 它决定工具集与提示词，因此被恢复的会话必须还原同一份组装；记录它属于会话事实，而非运行时状态。它与 `cwd` 并列写在会话头部，并由会话摘要携带，使选择器显示的是某个会话实际运行的 preset，而非部署当前的默认值。

**持久化 header 字段在 provider 写入前都算不上持久。** `agentPreset` 带着正确理由落在 `SessionHeader` 上，而 JSONL provider 遗漏了它；派生 query index 也显式映射 header 字段，于是恢复后的 Session 没有 preset，所有据以命名它的 surface 随之失声。`summarizeCold` 是同一种形式——它手工拼装 cold list row，而没有复用共享 projection。声明为持久的字段，需要一个跨越真实 store 的测试，而不只是声明它的类型。

**这个选择属于它仍然可用的那个界面。** composer 座位几乎一生都处于禁用状态，因为一旦跑过一个轮次，preset 即固定。它移到了新建会话界面、工作区选择器旁边，选择在那里是**暂存**的：该界面先于它要应用到的会话存在，暂存值在某个会话成为当前会话且仍为空白时落地——这既覆盖工作区连接新建的会话，也覆盖它复用的那个空白会话，而搭 `sessions.create` 的便车会漏掉后者。它一经使用即被清空，与旁边的工作区选择器一致。至于运行中的会话在跑什么，则是其标题旁的一个只读标签：在那里放控件，等于承诺一次宿主会断然拒绝的切换。

**preset 放大的是宿主本来就在付的代价：没有任何东西会 dispose 一个 agent。** 用 `--expose-gc` 对随附组装实测：一个存活的 agent 在 `minimal` 上约占 0.17 MB、在 `standard`/`cordis` 上约 1.31 MB，挂载耗时分别约 38 ms 与 135 ms；进程里第一个 agent 另需约 7 MB，那是 Node 首次 import 模块的一次性成本，此后每次挂载共享。增长严格线性——10、30、50 个的单个增量一致——且 dispose 后基本全额回收（50 个 `standard` 占住 57.8 MB，释放后全部归还）。所以对象图并不泄漏，缺的是生命周期。`ApiSessionAgentController` 会丢弃注册表返回的 `AgentHandle`，`archiveSession` 只改工作区注册表，`AgentRegistry` 没有驱逐机制，而宿主里唯一一处 dispose 是 JSON-RPC 服务器自身的关停。于是一个 web 宿主会留住它接触过的每一个会话，组装 preset 之后每个约 1.3 MB，而在此之前约 0.2 MB。注意：剪枝挂载注册表在这里没有用——它丢弃的是 fiber `uid` 已清空的记录，而永不死亡的 agent 永远不会清空它。

- 遗留 TODO：idle agent 驱逐——会话持久化后 dispose，恢复时重新挂载。它属于持有 handle 的那个宿主，不属于本 seam。

## 考虑过的替代方案

**在 scope 注册表中新增 preset 分层。** `ScopedLayers.merge()` 把全局层与恰好一个精确 scope 层合并。新增中间层可以让多个会话共用一份已挂载的组装，但它要改动 `dsh-scope` 及每个 scope 感知的注册表，换来的只是毫秒级的开销节省，而且会让 preset 的注册获得一个没有任何 agent 拥有的生命周期。

**把 agent 的 scope 键设为 preset。** 同一 preset 上的会话就能免费共享一层，但按 agent 的注册——`installAgentLlmTarget`、按 agent 的工具限制——会跨会话相撞。

**把每个 preset 作为子进程运行。** [`subagent-dsh-sdk`](../../../../packages/subagent/subagent-dsh-sdk/README.zh.md) 已经证明完整的子 harness 可行，隔离性也会是绝对的。但这同时意味着要按会话代理流式输出、审批与投影，那是一个传输层项目，而非组装问题。

**给产品 subagent 增加全局启用设置与独立设置页。** 进程级值会与 preset 争夺模型可见工具的所有权，也无法表达两个会话使用不同组装。产品 provider 留在宿主，普通 preset 行分别暴露 Codex 与 Claude Code 工具。

**为 Codex 与 Claude Code 的每种组合交付一份 preset。** 四个身份会复制完整 preset 组装，只为表示两条独立行。复制后的 preset 已能直接启用任一行，因此组合 preset 只增加名单与维护成本，不增加用户结果。
