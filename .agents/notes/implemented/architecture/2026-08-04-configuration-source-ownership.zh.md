# Agent Note: 配置来源的统一顺序，以及被发现的文件不得决定什么

Status: implemented

[English](2026-08-04-configuration-source-ownership.md) | 中文

## Problem

`$DSH_HOME/.env` 刚刚[变成普通环境层](../../archived/architecture/2026-08-04-credentials-yaml-and-user-environment-layer.md)，这使得 harness 解析面向用户的值时面对的是一个压平的 `process.env`，再也说不清某个值来自哪里。由此产生三个后果。

通过 Web 页面存下的密钥仍然被用户自己 `.env` 里更旧的密钥遮蔽，因为凭据提供方是拿「环境」与自己的文件比较，而现在环境包含了那个文件。这次拆分本该消除的迁移死路，只是换了个位置。

endpoint 可以被项目重定向。调用目录的 `.env` 和其他层一样会被物化，而 base URL 决定已解析的 API key 发往何处——于是写进模型可编辑工作区的 `DEEPSEEK_BASE_URL`，会把用户自己的凭据、以及承载其代码的提示词，一起发给该文件指定的任何主机。压平的视图无法把这件事和运维显式 export 同一个变量区分开。

而已交付组合里的 `!!js process.env.X` 让同一个值有两条抵达路径：一条经 entry config，一条经消费方各自的 ladder，胜负取决于层序而非这个值的语义。

## Decision

**非机密值走同一条顺序。** 每个本身不是凭据的可配置值都按同一顺序解析；各领域的差别只在于哪些层存在。

```text
explicit for this run     per-operation override, CLI argument
> user settings           settings.yaml
> composition             profile bundles, user patch layers, --patch overlays
> this launch's shell     inherited process environment
> discovered file         <invocation cwd>/.env, then $DSH_HOME/.env
> defaults                schema default, provider public default
```


settings 在 composition 之上，因为 [settings seam](../../archived/architecture/2026-07-28-user-settings-seam.md) 就是这么做的：插件把自己的 cordis entry config 注册为 `base` 层，用户 section 叠加其上，而 seam 无法区分某个值是 profile 的 bundle 设的，还是它的用户 patch 层或某个 `--patch` overlay 设的——它们都以 entry config 的形式抵达。产品 CLI（命令行界面）没有高于已存 settings 的手段，因此需要把某字段钉死、不被用户已存 settings 覆盖的部署方，应自带 bin 或 loader 配置树，或者干脆不挂载 settings 提供方。composition 仍然高于环境，所以 shell 里陈旧的 `DEEPSEEK_BASE_URL` 无法改写已配置的 endpoint。

**凭据保留一条更窄的独立顺序**，本 Note 不把它并入上表：

```text
inherited process environment      (read-only, wins)
> $DSH_HOME/.credentials.yaml      (provider-managed, writable)
> <invocation cwd>/.env
> $DSH_HOME/.env
```

继承环境优先，因为 `DEEPSEEK_API_KEY=… dsh`、CI 机密与容器 `-e` 是运维必须能按次施加、且无需改动机器状态的那一种覆盖；而它无法从进程内部修改，就必须*可见地*只读。配置本应只携带*引用*——解析哪个名字——该名字本身遵循上面的非机密顺序。

**harness 被启动于其中的项目默认可信，且不做询问。** 一个 checkout 可以携带自己的 endpoint、自己的普通变量和自己的密钥；密钥排在受管存储之下，因此通过 Models 页存下的密钥绝不会被 checkout 中恰好带有的那一个顶掉。`LaunchEnvironmentSnapshot.getFrom(name, sources)` 仍然只搜索调用方点名的层，省略某层仍是拒绝而不是降级——该机制供要求某一层不可达的决策使用；本决策包含项目层。

**信任不延伸到改变 harness 本身。** `loadLayeredEnv` 会在加载时、且在物化任何内容之前，拒绝任何设置了下列变量的 `.env`：决定进程如何启动的（`PATH`、`SHELL`、`NODE_OPTIONS`、`LD_PRELOAD`）、决定由哪个环境程序处理一项操作的（`EDITOR`、`PAGER`、`BROWSER`）、决定运行时在执行被要求运行的程序之前先执行哪些代码的（`BASH_ENV`、`PERL5OPT`、`PYTHONSTARTUP`、`RUBYOPT`、`JAVA_TOOL_OPTIONS`、Git 的钩子命令）、决定模型可见指令从哪里加载的（整个 `DSH_*` 命名空间、`HOME`、`XDG_*`），以及决定网络如何访问以及如何建立信任的（proxy 与 CA 变量）。匹配不区分大小写，因此 `https_proxy` 不是绕过手段。唯一的豁免记录在[代理策略笔记](2026-08-27-outbound-proxy-policy.zh.md)中：四个代理名可从 `$DSH_HOME/.env` 接受——没有任何 `.env` 能挪动该文件——但仍拒绝来自调用目录文件的同名变量。

这条界线在于：它们无需任何用户动作、在任何轮次开始之前、且在权限策略与沙箱之外就生效。`DSH_PERMISSION_MODE` 会关掉让「信任项目」根本成立的那道审批，而 `BASH_ENV` 会在 bash 工具每次发出 `bash -c` 时执行项目指定的文件——项目的代码在 agent（智能体）的策略下运行是约定，项目改写那份策略不是。一个变量一个变量地枚举是必输的游戏，所以整个 `DSH_*` 命名空间被拒绝而不是只拒绝一份经审查的子集，也所以这份清单是按变量*做什么*而不是按哪个运行时拥有它来组织的。不设逃生门：逃生门本身总得从某处读取，而任何被发现的文件能设置的东西，就是那个漏洞本身。

**`packages/util/launch-environment` 拥有该快照**，刻意做成 utility 而不是三包能力 seam。快照在 Cordis 启动前就冻结，并由启动器一次性注入，因此不存在需要切换的运行时实现；消费方需要的只是类型和纯函数，而 `util/` 包能提供这些且不必依赖 UI 包。`launchEnvironmentOf(ctx)` 返回启动器的快照，或者返回只含继承环境的那一层——SDK 宿主或裸 `cordis.yml` 从未发现过任何文件，它那唯一一层确实就是它被启动时的环境，因此同样的受信查询在那里原样继续工作。

**`verify-config-source-ownership`** 仅作为一道窄门禁，检查已交付 Cordis 配置中从环境内联 `apiKey`/`baseURL`/`headers` 的普通单行写法。删除这些内联正是「部署层」得以成立的原因——已交付配置树对 `baseURL` 保持沉默之后，「有值」就意味着「人或部署设过它」。实际解析由适配器负责；该门禁不声称覆盖仓库范围内的 `process.env` 访问。

## Consequences

- Web 凭据表单现在能压过用户 `.env` 里更旧的密钥；只有在启动 shell 里 export 的密钥才会让它变成只读，诊断信息也会这么说。
- 含 `DSH_*`、`PATH`、`BROWSER` 或（在调用目录中）proxy 变量的 `.env` 会导致启动失败而不是被应用。把开关放在仓库 `.env` 里的开发者需要改放到 shell——这是一次刻意且响亮的破坏。
- composition 不再会被陈旧的 shell endpoint 覆盖。但它仍然会被用户已存的 `settings.yaml` 覆盖，这是 settings seam 的分层方式，本 Note 不改变它；产品 CLI 没有高于它的标志，因此需要压过已存 settings 的部署方要自带 bin 或 loader 配置树。
- 未解决的：各层仍然会被物化进 `process.env`，因此普通项目变量继续按子进程清洗规则抵达子进程。bootstrap 变量完全不能来自文件；环境包将其余变量仍可抵达子进程这一点记录为一项限制。
- Exa 与 Perplexity 仍在加载时捕获密钥，而不是经凭据 seam。它们不再读裸 `process.env`——改为经受信层解析——但把它们改造成按请求解析凭据是另一件事。

## Alternatives considered

**按「来源由谁书写」把凭据并入非机密顺序。** 尝试过并放弃：它读起来很顺，但 settings seam 已经把 composition 固定在用户 section *之下*，因此「由部署方写入」根本不是该 seam 能表达的一层；而把 `.credentials.yaml` 抬到启动环境之上，会夺走 CI、容器和一次性 `DEEPSEEK_API_KEY=…` 所依赖的那唯一一种覆盖。两条各自说明优先顺序的规则，好过一条两边都描述不准的规则。

**在项目被显式信任之前，不给它路由与凭据能力。** 作为产品立场被否决：checkout 默认可信，不询问，也不存储信任记录。残留风险是真实的、值得写明——克隆一个携带 `.env`、其中指定了另一个 endpoint 或密钥的仓库，会让该会话经由它——处理它的地方是日后的 project trust 门禁，而不是一条让常见情形都要走仪式的规则。

**审查出一份 `.env` 可设置的 `DSH_*` 白名单。** 否决：每新增一个开关都要重新审查，而遗漏的失败模式是静默的。拒绝整个命名空间是 fail safe。

**把 bootstrap 变量排在 process 层之下，而不是拒绝它。** 否决：`PATH` 和 `NODE_OPTIONS` 没有有意义的「输了之后」行为——把它写进 `.env` 的用户认为它生效，而静默忽略正是本决策要消除的那种「我的设置没有效果」。

**把快照做成三包能力 seam（`environment` / `environment-local` / 消费方）。** 作为过早拆分而否决：生产方在 Cordis 存在之前就运行，也没有第二个实现需要选择。仓库规则是不要预先拆分。

**不再把各层物化进 `process.env`。** 延后而非否决：它能让项目变量彻底进不了子进程，但会静默破坏任何读 `!!js process.env.X` 的用户 patch 层。快照已经是 harness 解析一切的依据，因此这件事以后落地也不改变任何 ladder。
