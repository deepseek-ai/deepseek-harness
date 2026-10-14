---
description: "DeepSeek 账号鉴权、模型列表与模型门控。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-account

[English](README.md) | 中文

## 概述

为 `deepseek-account` 注册鉴权、账号模型列表和模型门控。通过 [llm-deepseek](../llm-deepseek/README.zh.md) 共用 Messages 请求实现；本包负责凭据解析、账号目录和模型准入。

鉴权解析返回 `x-dsh-auth-token` 和捕获同一 token 的失败回调。HTTP 401 的分类和凭据失效处理由此提供方负责；被拒绝的旧请求不能清除替换后的登录。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

账号 token 仅由 `deepseekAccount.resolveToken(url)` 提供，目标地址必须通过账号服务的来源校验。未登录或目标不允许账号鉴权时，请求以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，目录为空；不会回退到 API key。其他凭据查询错误继续向调用者报告。

路由的目录来自账号的 `GET /models` 列表，地址为 Messages `baseURL` 的 origin 加 `/models`（官方端点即 `https://api.deepseek.com/models`），不可配置。列表请求用 `x-dsh-auth-token` 携带账号 token，带上 harness 的 `User-Agent`，并拒绝重定向。

同一凭据的第一次访问会等待列表，最长 `modelsTimeoutMs`。之后的访问直接使用已加载的列表，列表超过 `modelsMaxAgeMs` 后在后台刷新。获取失败或得到空列表时保留上一份；还没有加载到任何列表时，路由提供当前版本内置的目录（`deepseek-flash` 与 `deepseek-v4-pro`）。列表请求返回 HTTP 401 不会清除已保存的登录。每次加载成功、连续失败中的第一次失败及其退回的目录、以及每个被隐藏的列表条目，都会以 `[llm-deepseek-account]` 标签写到控制台日志；不记录任何密钥。每个账号 token 有自己的列表，因此服务端可以先对部分账号开放某个模型。

只有当前版本的 DeepSeek Harness 能用的模型才会出现在目录里。声明了 `client_requirements["deepseek-harness"].min_version` 的模型，在当前版本号按 semver 顺序不低于该版本时提供，预发布号（如 `0.2.0-alpha.1`、`0.2.0-rc.1`）同样参与比较。预发布版本低于同号的正式版本：`min_version: 0.2.1` 会拒绝 `0.2.1-alpha.2`，因此要放行预发布版本的列表应声明它允许的最早一个，如 `0.2.1-alpha.0`。没有这个声明的模型，只有内置目录认识它的 id 时才提供；其余列出的模型保持隐藏。请求一个当前版本不能用的已列出模型时，会在网络请求之前失败：`CLIENT_UPGRADE_REQUIRED` 会写明所需版本和当前版本，否则为 `MODEL_UNSUPPORTED`。列表没有列出的模型 id 照常透传。

提供的模型以列表中的名称、`context_window`、输入模态和 Messages system prompt 模式覆盖同 id 的内置条目，内置条目保留工具更新模式、图片预算和描述。`max_output_tokens` 限制请求默认值：请求没有指定上限时，发送 `maxTokens` 与该能力上限中较小的一个。列表中的推理档位不被读取；每个模型都提供 `off`、`low`、`high`、`max`。

`modelOverrides` 调整单个模型而不替换整个目录。键是模型 id；值的字段与 [Messages `models` 条目](../llm-deepseek/README.zh.md#minimal-configuration)相同，未设置的字段沿用下层的值。覆盖作用在列表和内置目录之上；不能新增模型，也不能让被拒绝的模型变得可用。列表声明的能力不约束覆盖：覆盖的 `maxTokens` 高于列表的 `max_output_tokens` 时按覆盖值发送，超出服务端限制的请求由服务端拒绝。覆盖指向的模型既不在列表里、内置目录也不认识，或者被列出的模型拒绝时，会成为模型页上该提供方的诊断信息；模型页不为此路由提供编辑器。被拒绝且内置目录不认识的模型，其覆盖要等当前版本能用该模型时才校验。此路由没有 `models` 字段；配置里仍写了它时，加载即失败并提示改用 `modelOverrides`。修改 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，下一次请求即生效。

```yaml
- id: llm-deepseek-account
  name: '@deepseek-ai/dsh-llm-deepseek-account'
  config:
    reasoningEffort: high
    modelOverrides:
      deepseek-flash:
        contextWindow: 524288
        maxTokens: 131072
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `modelsTimeoutMs` | `5,000` | 单次列表请求以及首次访问等待的上限 |
| `modelsMaxAgeMs` | `600,000` | 列表超过这个时长后，下一次访问时刷新；获取失败后同样在这个时长后重试 |
| `modelOverrides` | `{}` | 按模型 id 的字段覆盖 |

账号请求的 HTTP 401 与响应正文无关：映射为 `ACCOUNT_TOKEN_INVALID`，并要求账号服务仅在当前 token 仍与请求所用 token 相同时清除凭据。403 和其他错误不会触发清除。账号模块负责退登后打断任务，本插件不遍历 Agent。

设置命名空间采用 Cordis entry id，没有 entry 时采用插件名。产品保留 official 的 `llm-deepseek` entry id，账号使用 `llm-deepseek-account`。

<a id="understand-the-implementation"></a>
## 理解实现

注册和监听随插件生命周期释放，释放时会中止进行中的列表请求。共享 Host 绑定提供附件访问、请求扩展、匿名标识和重试策略的原子更新；本包只注册自己的路由，并通过传输层的 `connect` 与 `admit` 钩子接入目录和门控。列表缓存只在内存中，以端点和 token 的 SHA-256 为键。

共享传输判定为 `QUOTA` 的失败请求离开本提供方前会被改写为 `ACCOUNT_QUOTA`，HTTP 402 响应与流内 SSE 错误都适用。共享传输与 `deepseek-official` 路由保留 `QUOTA`，因此账号路由的充值操作不会出现在 API Key 或第三方失败上。

<a id="further-exploration"></a>
## 进一步探索

[LLM streaming](../../../docs/subsystems/llm-streaming.zh.md) · [Messages](../llm-deepseek/README.zh.md) · [账号目录决策](../../../.agents/notes/implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.zh.md)

<a id="model-experience"></a>
## 模型体验

### 已鉴权的模型请求

#### What the model sees

`deepseek-account` 请求不包含本插件添加的模型可见文本；请求由共享 Messages 传输序列化。

#### Token effect

鉴权和列表不增加输入 token。解析后的目录决定每个模型的上下文窗口和默认输出上限，每次请求记录的上下文与请求头会记下这些值。

#### KV Cache effect

凭据与目录可用性不进入模型输入；协议传输拥有请求前缀的序列化。目录中某个模型的 system prompt 模式变化，会改变之后 system prompt 更新的序列化方式。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 列表缓存只在内存中；没有网络时启动，在加载到列表之前使用内置能力。
- 进程运行中途的列表变化，要等 Web 模型选择器下一次刷新目录时才会显示；插件不会主动通知。
- 门控在客户端执行；改过的客户端仍可以请求任意 id，除非服务端拒绝。
- 列表中的推理档位被忽略。
- 当前版本能用的已列出模型一个都没有时，账号不提供任何模型，模型选择器显示通用的空状态，而不是升级提示。
- 覆盖可以设置、但不能移除 `systemPromptUpdate` 与 `toolUpdate` 声明。

<a id="dev-note"></a>
### 开发备注

注册与鉴权的测试也覆盖共享传输包中的 Loader 组合场景。
