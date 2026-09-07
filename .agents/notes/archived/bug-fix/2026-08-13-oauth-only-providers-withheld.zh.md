# Agent Note: 可配置提供方目录不再提供仅以 OAuth 认证的提供方

Status: implemented
Archived: 2026-09-04

[English](2026-08-13-oauth-only-providers-withheld.md) | 中文

## 问题

模型设置页把 `openai-codex` 当作普通 pi-ai 路由提供出来，配的还是每个 pi-ai 提供方共用的那句占位文案：填入 API 密钥，或留空使用环境认证。照此配置后发送消息，本轮以 `Provider is not configured: openai-codex` 失败，并被适配器归入兜底的 `PI_AI_ERROR`。

占位文案所邀请的那种配置姿态在这条路由上不可能工作。pi-ai 的 `resolveProviderAuth` 抵达 OAuth 提供方只有一条路径——集合的 `CredentialStore` 里已经存着的凭据——对它没有任何 ambient 回退；而 `openai-codex` 正是已安装 catalog 中唯一只声明 `auth.oauth`、没有 `auth.apiKey` 的提供方。`PiAiAdapter.current()` 以不带参数的 `createModels()` 构造集合，于是用的是 pi-ai 默认的 `InMemoryCredentialStore`：每次启动都是空的，每次配置变更产生新快照时又重建一份。本仓库没有任何位置调用 `Models.login()`；pi-ai 库这一半也不会去读 Codex 自己的 `~/.codex/auth.json`——它的 OAuth 模块是一套 PKCE 登录流程，凭据由*宿主*应用持久化，这正是 pi CLI 提供、而本适配器没有提供的东西。

于是页面用自己占位文案所描述的「留空」姿态，提供了一个根本没有「留空」姿态的提供方——而失败信息指向的是配置键，不是缺失的能力。唯一能让这条路由完成认证的，是把一个 ChatGPT OAuth token 粘进密钥框，那既不是这个提供所描述的用法，也会过期且这里没有任何环节会去刷新它。

## 决策

目录只提供本适配器认得的东西。`catalogProviderTakesApiKey(provider)` 回答 pi-ai 为某路由安装的提供方是否声明了 api-key 方法——这是 harness 唯一能供给的方法，因为它通过自己的凭据 seam 解析密钥，再作为请求的 `apiKey` 覆盖交给 pi-ai——`directoryEntries()` 跳过不满足它的 catalog 路由。

不尝试实现 OAuth。它需要持久化凭据存储、登录流程，以及运行登录的界面；这三样都不是发布阻塞项的修复，而在它们缺席时仍把提供方摆出来，正是这次报告的成因。

两条边界把「不提供」的范围收窄：

- **catalog 成员身份不变。** `catalogProviderIds()` 仍回答 pi-ai 装了什么，因此目录条目上的 `declared` 标记仍然表示「没有已安装提供方对应这条路由」，而不是「这条路由不被提供」。
- **联合的 profile 那一半无条件保留。** settings 文档已经写过的路由保留条目，因此已存储的 `openai-codex` profile 仍然可见、可编辑、可删除，而不会滞留在文档里、页面上却没有任何入口能移除它。

resolution 未被触动。在仅 OAuth 的路由上指定 `apiKeyEnv` 的 profile 仍会构造出可用的提供方——`routeAuth` 会在 catalog 的 OAuth 旁边补上 harness 的 api-key 方法，而 pi-ai 的 Codex API 从 token 本身推导 account id——因此把它写进 `settings.yaml` 或 `cordis.yml` 的部署保留这条路径。改为在 `resolveProfiles` 里强制拒绝会在注册时就否掉这类 profile；又因为 `validate` 在启动时与写入时同样运行，一份已经写有无密钥 OAuth 路由的文档会让整个 namespace 注册失败，而不只是一个提供方失败。

## 备选方案

- **在 `resolveProfiles` 里拒绝无密钥的仅 OAuth 路由。** 这才是本仓库通常强制决策的位置，而目录过滤是一层 `cordis.yml` entry 可以绕过的表面。因上述启动行为被否决：已存储的 profile 会连带拖垮该 namespace 中其他所有路由，对一次发布而言，这是拿一个提供方的缺陷换取全体的缺陷。留下的缺口是：被修的是「提供」而不是「能力」——部署仍可手写一条页面上已经无法添加的路由。
- **保留提供，只修正占位文案。** 那么该输入框只能写「此提供方需要本构建无法运行的登录」，等于一张唯一诚实内容就是「它不能用」的卡片。
- **把 `Provider is not configured` 映射成具名 `LlmError`。** 值得做，而且触发原因本次改动并未消除——任何留空密钥、其提供方又在进程环境里找不到东西的 api-key 路由，都会产生同一句话。作为独立改动暂缓：它改进的是诊断，而不是移除一个坏掉的提供。
- **把 `~/.codex/auth.json` 读进 pi-ai 的 `CredentialStore`。** 这能让 Codex 在没有登录流程的情况下可用，刷新也由 pi-ai 负责。但它为一个提供方把 harness 绑定到另一个工具的私有文件格式上，这属于 OAuth 那项工作的决策，而不是发布期的修复。

## 影响

`openai-codex` 从提供方选择器、以及模型设置页所 join 的目录中消失；其余已安装提供方一概不受影响，包括在 api-key 方法*之外*另提供 OAuth 的那六个（`anthropic`、`github-copilot`、`kimi-coding`、`openrouter`、`radius`、`xai`），它们保留条目也保留密钥路径。将来若出现只带 OAuth 的提供方，会被自动排除，而不是靠列名。

两处相邻缺口仍在，并记录在包 README 中：不指定凭据的路由仍走 catalog 提供方自带的发现，而它只读进程环境变量——不读 `~/.aws/credentials`，也不读 harness 凭据 seam——且由此产生的失败仍是兜底的 `PI_AI_ERROR`。

该扣留其后已被撤销：[凭据记录与授权 flow](../architecture/2026-08-13-credential-records-and-authorization-flows.zh.md) 为适配器补上了可持久的凭据存储与登录 flow，因此 `openai-codex` 重新被提供，`catalogProviderTakesApiKey` 也已删除。下文那两条边界正是把这次反转限制在一个判定函数与一个目录过滤器之内的原因。

## 测试

包测试钉住联合的两半：不予提供的路由不出现在 `listConfigurableProviders()` 中，而 `anthropic` 与 `openai` 仍在；已存储的 `openai-codex` profile 仍产出完整条目且 `declared: false`。既有的 resolution 测试未改动且依然通过，这正是「不提供」没有收窄手写 profile 可服务范围的证据。`models-settings` 与 `onboarding-usable-provider` 两条 web e2e golden 恰好各少了 `openai-codex` 这一行选项，录自真实装配的应用。
