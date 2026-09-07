# Agent Note: 请求级 LLM 配置与凭据 seam

Status: implemented
Archived: 2026-09-04

[English](2026-07-29-request-level-llm-config-credentials.md) | 中文

> 范围：`ctx.settings` 的第一批生产消费方（两个 LLM（大语言模型）适配器插件）、新增的 `packages/credentials/` 能力族，以及 `packages/util/atomic-write` 的抽取。后续的 wire 面（`settings.*`/`credentials.*` RPC、secret 角色脱敏、web 设置表单）是另行开展的工作，不在本 Agent Note 范围内。

## 问题

[settings seam](2026-07-28-user-settings-seam.zh.md) 落地时没有生产消费方，而 LLM 适配器正是当初驱动该 seam 的那个消费方：两个适配器都在插件加载时把 `apiKey`/`baseURL`/catalog 冻结进适配器实例，改密钥或端点就要重启进程，密钥缺失则直接使插件加载失败——对个人配置页而言，这是最糟糕的首次运行姿态（「先存密钥，再重启」）。机密的走向也不对：顺理成章的做法（把 `apiKey` 放进设置文档）会被迫引入脱敏、`replace` 时的服务端回填与 dotfiles 同步告警，为一个同类产品根本没有的问题堆起一整摞缓解措施——Codex（`env_key` + auth.json）、Reasonix（`api_key_env` + 家目录 `.env`）、OpenCode/Pi（`auth.json`）、Claude Code（`apiKeyHelper`）全都把机密挡在配置文件之外。

## 决策

**按请求解析，而非重建 fiber。**适配器改为接收一个 options thunk（外加按流调用的凭据解析器），不再持有冻结的构造期事实，每个操作解析一次——即 Pi 的模式，连同其经测试固定的语义：跨越一次变更的两个请求看到两份配置，一个请求恰好解析一次，进行中的流保持其起始事实。这删掉了重建式设计所需的整套切换机制（`DUPLICATE_ADAPTER` 顺序问题、`NO_ADAPTER` 窗口、延迟激活状态机），并把密钥缺失变成*请求时*可据以处理的失败（`MISSING_CREDENTIAL` 点名每个配置入口），同时路由保持注册、catalog 保持可浏览。唯一在注册期捕获的事实——`ctx.llm` 注册表在 `registerAdapter` 时快照的重试策略（外加 pi-ai 的路由*集合*）——在其变化时于一个同步区段内原地重新注册同一适配器实例。

**机密是引用，值藏在 `ctx.credentials` 背后。**配置（两个面）携带 `apiKeyEnv: DEEPSEEK_API_KEY`；三包凭据 seam 按操作解析它。`credentials-local` 把活跃进程环境（只读、优先——启动时覆盖是操作者意图，必须*可见地*只读，因此被遮蔽的写入直接拒绝而不是表面成功）叠加在提供方管理的文档之上（可写、重载时整体替换快照使删除的条目绝不滞留——来自 Claude Code 增量重放（additive reapply）的教训）。该文档当时是 dotenv 形式的 `$DSH_HOME/.env`；[凭据文档拆分](2026-08-04-credentials-yaml-and-user-environment-layer.zh.md)后来把它移到 `$DSH_HOME/.credentials.yaml`，并让旧路径转为用户的环境层。适配器通过 seam 解析该引用；仅在未挂载 seam 时，才通过各环境层解析。

**按插件划分 namespace，schema ≡ `Config`。**每个适配器注册自己的 namespace（`llm-deepseek`、`llm-pi-ai`），schema 用其插件 `Config` schema，组合 `base` 用其 `cordis.yml` 条目——settings 分节与 entry 配置是同一种 YAML 形状，`resolveAdapterOptions`/`resolveProfiles` 对两者仍是唯一的显式 resolve 步骤。实时快照若违反 schema 之外的约束，则保留最后可用事实（seam 的最后可用值哲学向上延伸一层）；entry 配置本身仍会加载失败。pi-ai 的 `providers` 改为以路由为键的字典，base 层与用户层因此按提供方合并，路由集合也由结构直接表达；数组形状响亮失败并给出迁移指引，而空字典是合法的休眠姿态——组合可以裸挂该适配器，把每一条路由都留给用户面决定。

## 曾考虑的替代方案

- **由桥接插件（`dsh-llm-models`）持有统一的 `models` 字典**——有了按插件划分的 namespace，就没有什么可桥接的了；它所需的适配器映射规则纯属凭空发明的间接层。
- **把机密放进 settings.yaml 并靠 `role('secret')` 脱敏**——删除问题本身（引用）胜过缓解问题（脱敏 + 回填 + 同步告警）；coding-agent（智能体）同类产品在这一点上口径一致。
- **注册表级的实时重试策略**——让 `providerRetryPolicy` 每次调用都重读，会静默改变所有注册都依赖的 `ctx.llm` 捕获约定；原地重新注册路由既保住该约定，又保持可观察。

## 后果

上手流程端到端免重启（由 `missing-credential` headless 快照与凭据轮换组合测试固定）：无密钥启动、浏览 catalog、存入密钥、再次发起提示。demo 默认挂载 `settings-file` + `credentials-local`，不再内联任何 `!!js` 密钥接线。`runLoaderSmoke` 新增 `expectedExitCode`，使按设计出现的失败面可以被固定而非被掩盖。延后事项：wire/UI 面在任何 RPC 暴露 `describe()` 之前必须对 `role('secret')` 字段脱敏；settings 层的数组仍整体替换（deepseek 的 `models` 列表）；settings 分节无法移除组合提供的 pi-ai 路由（只能覆盖或扩展）。后来的一项决策改造了存储的所在位置与谁可以读取它，让一个请求解析出一个配置世代，并使路由替换成为原子操作（[credential boundaries note](2026-07-30-credential-boundaries-and-atomic-registration.zh.md)）。
