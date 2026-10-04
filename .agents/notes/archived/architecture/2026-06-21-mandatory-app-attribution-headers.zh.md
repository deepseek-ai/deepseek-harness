# Agent Note: 对提供方请求强制携带 `User-Agent` 归属标识

Status: implemented
Archived: 2026-09-30

[English](2026-06-21-mandatory-app-attribution-headers.md) | 中文

## 问题

LLM（大语言模型）提供方请求应当标识发出请求的产品。这对提供方侧的技术支持、滥用调查、兼容性调试和流量分析都有价值。在本 Agent Note 之前，harness 只做了部分工作：手写的 DeepSeek 适配器发送了一个手动复制的 `User-Agent` 常量（`packages/llm/llm-deepseek/src/adapter.ts`），而基于 pi-ai 的孪生适配器则完全不发送 harness 自有的头部（`packages/llm/llm-pi-ai/src/adapter.ts`）。因此新适配器可以悄无声息地省略归属标识，而基于库的适配器也可能与手写适配器产生偏差——尽管[孪生适配器 Agent Note](2026-06-13-twin-llm-adapters.zh.md) 的存在正是为了确保两种实现中的提供方约定真实可靠。

直接触发因素来自 OpenRouter 的[应用归属](https://openrouter.ai/docs/app-attribution)文档。OpenRouter 根据 `HTTP-Referer` 加上用于展示和分类的头部来创建应用页面和排名。这有价值，但它不是 HTTP 标准中的应用身份机制。风险在于：把 OpenRouter 的精确头部集当作通用标准来采纳，然后将提供方特有的头部泄漏到直连 DeepSeek 的请求、未来的 OpenAI/Anthropic/Vertex 适配器、测试服务器或无限期记录未知字段的代理中。

## 调研

- **OpenRouter 的机制是提供方特有的。** 其当前文档说明应用归属通过 `HTTP-Referer`（必需）、`X-OpenRouter-Title` 和 `X-OpenRouter-Categories` 来追踪；`X-Title` 仅为向后兼容而接受。其 API 参考称这些头部为可选，并说它们使应用在 OpenRouter 上可被发现。这是一项具体的 OpenRouter 约定，而非 IETF 或 OpenAI 兼容 API 标准。
- **在 agent（智能体）工具生态中，`HTTP-Referer` 是一种 OpenRouter 感知的惯例，而非通用 agent 惯例。** 它足够常见，以至于 OpenRouter SDK 和示例直接暴露它，面向 OpenRouter 的框架通常需要一种方式来透传它。但 ACP（Agent Client Protocol）等 agent 协议在自己的 initialize 消息中协商名称、版本和能力，而模型提供方请求仍需 HTTP 层面的身份标识。因此「在 agent 世界中被接受」意味着「被 OpenRouter 集成所识别」，而非「可跨 agent 运行时或提供方移植」。
- **编程 agent 在 `User-Agent` 中标识产品和版本。** 公开实现在环境细节和提供方特有的附加头部上各有不同，但产品身份是共同约定；不存在通用的精确格式。
- **标准化的通用客户端身份头部是 `User-Agent`。** RFC 9110 第 10.1.5 节将 `User-Agent` 定义为用户代理软件身份，说明它用于互操作性报告和分析，并说用户代理应当在每个请求中发送它（除非被配置为不发送）。这是唯一直接对应「哪个产品在发出此 HTTP 请求」的标准头部。
- **`Referer` 是标准的，但 OpenRouter 的 `HTTP-Referer` 不是标准字段。** RFC 9110 第 10.1.3 节将 `Referer` 定义为获取目标 URI 的来源 URI，并用大量篇幅讨论隐私限制。OpenRouter 则要求 `HTTP-Referer`，将其用作应用 URL 标识符。该名称和含义是 OpenRouter 特有的，尽管它形似标准 `Referer` 头部的 CGI 环境变量形式。
- **`From` 是标准的，但不适合作为强制默认值。** RFC 9110 第 10.1.2 节将 `From` 定义为负责用户代理的人的电子邮件地址。机器人代理应当发送它以便服务器联系运营者，但非机器人代理出于隐私和安全策略考虑不应在未经用户显式配置的情况下发送。harness 可以后续支持运营者联系方式，但不得凭空捏造或全局强制要求。
- **请求体中的 `user` 或 `metadata` 字段不是应用归属。** 部分模型 API 暴露稳定的终端用户标识符、请求元数据、标签或项目/账户头部。这些对滥用监控、内部计费、仪表盘或链路追踪有用，但它们要么标识的是终端用户而非产品，要么是提供方特有的 body schema，要么不保证能通过 OpenAI 兼容网关透传。它们不能替代静态的应用身份头部。
- **SDK 遥测头部标识的是 SDK，而非应用。** 官方和第三方 SDK 常发送库/版本头部。这些帮助 SDK 维护者调试其客户端，但除非应用显式提供产品归属层，否则它们不能标识 harness 作为应用。
- **pi-ai 有原生支持的头部钩子。** `@earendil-works/pi-ai` 的 `StreamOptions.headers` 将调用方头部最后合并（覆盖提供方默认值），因此基于库的适配器无需包装或上游改动即可满足与手写适配器相同的线路约定。mock 服务器测试套件对两个适配器都断言头部到达了线路。

## 决策

在 LLM 适配器边界，提供方无关的应用归属是强制的，且仅使用标准 `User-Agent` 头部。规则：每个产品级 LLM 适配器在每个提供方 HTTP 请求上发送一个静态、非机密的应用身份，且每个适配器都有测试证明 `User-Agent` 到达了线路（mock 服务器断言收到的头部；对于基于库的适配器，通过库的头部钩子馈入同一个 mock 服务器断言）。这条规则约束应用归属，不约束提供方特有的请求身份；[DeepSeek 请求身份决策](../feature/2026-08-11-deepseek-request-user-id-header.zh.md)另行负责其用户与会话头部。

OpenRouter 应用归属刻意未实现。`HTTP-Referer`、`X-OpenRouter-Title`、`X-Title` 和 `X-OpenRouter-Categories` 是 OpenRouter 特有的产品展示头部，不是提供方无关的模型请求归属。它们可以后续由 OpenRouter 适配器或显式 OpenRouter 模式提出，附带自己的隐私/产品决策、测试和文档。在此之前，即使请求指向 OpenRouter，也只发送本决策定义的共享 `User-Agent` 归属。

提供方无关的身份由 `dsh-llm`（`packages/llm/llm/src/attribution.ts`）拥有，而非各适配器。`AppIdentity` 仅包含构建 `User-Agent` 所需的公开产品事实，默认的 `APP_IDENTITY` 取值如下：

- `User-Agent` 的产品 token：`deepseek-harness`（与 Agent Note 之前的线路值及仓库/组织身份保持连续性）
- 版本：通过 `createRequire` 从所属包的 manifest（元数据清单）读取，绝不手动复制常量
- 应用 URL：`https://github.com/deepseek-ai/deepseek-harness`——仓库主页

默认值是强制的且非空。白标部署通过向 `attributionHeaders(identity)` 传入自己的 `AppIdentity` 来覆盖——覆盖钩子就是函数参数，在有消费方需要之前不做部署配置管道——省略时回退到 harness 默认值而非抑制归属。没有逐请求 API 允许模型、用户提示词、会话 id、cwd、用户邮箱、API key 所有者或本地机器身份影响这些字段。

线路映射（`attributionHeaders`；代码中头部名称小写——HTTP 字段名在线路上不区分大小写）：

| 目标 | 映射 |
|---|---|
| 所有基于 HTTP 的适配器 | `User-Agent: {product}/{version} (+{url})`——括号中的 `+url` 注释符合 RFC 9110 保守的 product/comment 语法。 |
| 直连 DeepSeek 端点 | `User-Agent` 用于应用归属；`x-deepseek-harness-user-id` 与条件性的 `x-deepseek-harness-session-id` 由 DeepSeek 特有决策作为独立请求身份管理。除非 DeepSeek 文档化了等效约定，否则不发送 OpenRouter 特有头部。 |
| OpenRouter 端点 | 仅发送 `User-Agent`。本决策排除 `HTTP-Referer`、`X-OpenRouter-Title`、`X-Title` 与 `X-OpenRouter-Categories`。 |
| 未来提供方 | 仅 `User-Agent`，除非后续提供方特有的 Agent Note 接受额外头部。不要类比复用 `HTTP-Referer`。 |

端点检测不在本 Agent Note 范围内，因为此处不接受任何端点特有的映射。如果后续支持 OpenRouter，检测必须是显式的：要么是专门的 OpenRouter 提供方包，要么是显式的 `provider: 'openrouter'` / `attributionTarget: 'openrouter'` 配置，而非任意路径片段或模型名称。

## 验证

已落地的约定：

- `dsh-llm` 为 `LlmAdapter` 作者文档化了强制的 `User-Agent` 归属约定（`LlmAdapter` JSDoc、包 README，以及 `docs/subsystems/llm-streaming.md` 的适配器约定（adapter contract）章节）。
- 共享辅助函数（`attributionHeaders` / `userAgent`）从包元数据构建应用身份和标准 `User-Agent` 值，适配器无需手动复制版本常量。
- `dsh-llm-deepseek` 在每个请求上发送共享的 `User-Agent`，其 mock 服务器套件断言精确值。
- `dsh-llm-pi-ai` 通过 pi-ai 的 `StreamOptions.headers` 钩子发送相同的 `User-Agent`，其 mock 服务器套件断言精确值。
- 本决策下没有适配器发送 OpenRouter 特有的归属头部（`HTTP-Referer`、`X-OpenRouter-Title`、`X-Title`、`X-OpenRouter-Categories`）。
- 没有应用归属字段携带机密、本地路径、会话 id、提示词文本、模型输出、用户邮箱或逐用户的稳定标识符。
- 适配器 README 声明了 `User-Agent` 归属策略，并明确避免将 OpenRouter 应用归属记录为已实现的行为。

## 曾考虑的替代方案

**现在就实现 OpenRouter 应用归属。** 本决策否决。发送 `HTTP-Referer` 加 `X-OpenRouter-Title` 可以满足 OpenRouter 排名，但这些头部是提供方特有的产品功能，不是本决策所标准化的提供方无关的模型请求归属。支持它们应当是后续显式的 OpenRouter 适配器/模式决策，而非隐藏在首个共享归属辅助函数中。

**向所有提供方发送 OpenRouter 头部。** 否决。这会把一项自定义的 OpenRouter 约定当作通用标准，并向未要求这些字段的提供方发送语义误导的头部。还有风险将 `HTTP-Referer` 当作通用应用 URL 字段使用，尽管标准 HTTP 已有 `User-Agent` 用于产品身份、`Referer` 用于不同的浏览上下文概念。

**仅使用提供方账户/项目身份。** 否决。组织/项目头部、API key、云账户和计费项目标识的是谁付费或谁拥有请求，而非哪个应用在发送流量。它们也不暴露公开的应用标题/类别，无法帮助 OpenRouter 等网关构建应用排名。

**终端用户 `user`/`metadata` 字段。** 本 Agent Note 否决。这些对滥用监控和客户支持有价值，但描述的是请求背后的人或租户。应用归属必须是静态的产品身份，且可安全地在每个请求上发送。

**仅配置启用的归属。** 否决。默认关闭的设置正是适配器不断漂移的原因。策略是强制默认归属加可覆盖的公开值，而非可选归属。

**以 SDK 命名的 token（`deepseek-harness-sdk`）。** 曾考虑用于 `User-Agent` token，因为受支持的运行时客户端栈使用 SDK 名称。`deepseek-harness` 胜出，因为它命名 DeepSeek Harness 产品、与组织／仓库身份和包 scope 一致，并且在不把完整产品称为 SDK 的前提下保持线路归属稳定。

## 后果

**提供方看到流量来自 harness。** 这正是目的，但意味着此前混在通用 SDK 流量中的部署变得可识别。缓解措施：仅发送静态公开产品数据，并允许 fork/白标部署传入自己的 `AppIdentity`。

**不同客户端库的头部支持有差异。** 手写适配器直接设置头部；基于 pi-ai 的适配器依赖 pi-ai 继续尊重 `StreamOptions.headers`（最后合并覆盖提供方默认值）。线路级 mock 服务器测试是守卫：如果 pi-ai 升级后不再投递该头部，套件会变红。这对抽象施加了有益的压力：一个无法设置强制头部的提供方适配器不能完整实现 harness 的 LLM 约定。

**OpenRouter 排名尚未受益。** `User-Agent` 是提供方无关的 HTTP 身份的正确基线，但它不会创建 OpenRouter 应用页面或排名，因为 OpenRouter 要求 `HTTP-Referer` 来实现该产品功能。这是有意为之：公开应用市场参与是一个独立的产品决策，不是强制请求归属的前提。
