---
description: "DeepSeek API-key authentication, model discovery, and the official model listing."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-api-key

[English](README.md) | 中文

## 概述

为 `deepseek-official` 注册鉴权、模型发现和官方模型列表。通过 [llm-deepseek](../llm-deepseek/README.zh.md) 共用 Messages 请求实现；本包拥有凭据解析、目录可用性判断和模型准入。

鉴权解析将验证后的 API key 放入 `x-api-key`，供 Messages 和 Files 请求共同使用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

`apiKeyEnv` 默认为 `DEEPSEEK_API_KEY`，在每次请求和模型发现时解析凭据。已组合 credentials 服务时，按其优先级解析；只有未组合该服务时才直接读取启动环境。请求时凭据缺失以 `MISSING_CREDENTIAL` 失败；格式错误以 `INVALID_CREDENTIAL` 失败。模型发现在凭据缺失时返回空目录，在模型选择器中隐藏该路由，但保留其设置入口。凭据格式错误和其他读取失败继续上报。添加或删除密钥会影响下一次模型发现。

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    reasoningEffort: high
    apiKeyEnv: DEEPSEEK_API_KEY
```

端点和凭据引用来自同一次配置解析；进行中的请求保留该快照，后续配置更新仅影响后续请求。账号登录态不影响该路由使用的凭据。

`models` 是该 provider 独立的可配置目录；默认值和协议能力来自共享传输包。当 `models` 等于内置目录、且 Messages 的 origin 是官方 API `https://api.deepseek.com` 时，路由改为提供官方 `GET https://api.deepseek.com/models` 列表。列表请求用 `x-api-key` 携带 API key，带上 harness 的 `User-Agent`，并拒绝重定向；没有 API key 时不发任何请求。其他端点，包括由 `baseURL` 或 `$DEEPSEEK_BASE_URL` 指定的端点，提供 `models`，不请求列表。目录判断不探测推理端点。

第一次访问会等待列表，最长 `modelsTimeoutMs`。之后的访问直接使用已加载的列表，列表超过 `modelsMaxAgeMs` 后在后台刷新；路由空闲时不发请求。获取失败或得到空列表时保留上一份；还没有加载到任何列表时，路由提供当前版本内置的目录（`deepseek-flash` 与 `deepseek-v4-pro`）。列表请求返回 HTTP 401 只让这一次加载失败。每次加载成功、连续失败中的第一次失败及其退回的目录、以及每个因声明无法读取或不可用而被隐藏的列表条目，都会以 `[llm-deepseek-api-key]` 标签写到 stderr；stdout 保留给协议消息，且不记录任何密钥。

列出的模型按[账号路由的规则](../llm-deepseek-account/README.zh.md#use-this-package)提供、与本版本的内置条目合并，并在网络请求之前以 `CLIENT_UPGRADE_REQUIRED` 或 `MODEL_UNSUPPORTED` 拒绝；列表没有列出的模型 id 照常透传。

与内置目录不同的 `models` 列表会替换整个目录，并停止请求列表；模型页把编辑后的目录存在这里。删除这个列表（即模型页上的**恢复默认模型**）后，路由重新使用列表，即使缓存的列表尚未过期，下一次访问也会重新加载。与内置目录完全相同的列表视为未自定义。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `modelsTimeoutMs` | `5,000` | 单次列表请求以及首次访问等待的上限 |
| `modelsMaxAgeMs` | `600,000` | 列表超过这个时长后，下一次访问时刷新；获取失败后同样在这个时长后重试 |

设置命名空间采用 Cordis entry id，没有 entry 时采用插件名。产品保留 official 的 `llm-deepseek` entry id，账号使用 `llm-deepseek-account`。

<a id="understand-the-implementation"></a>
## 理解实现

注册和监听随插件生命周期释放，释放时会中止进行中的列表请求。共享 Host 绑定提供附件访问、请求扩展、匿名标识和重试策略的原子更新；本包只注册自己的路由，并通过传输层的 `connect` 与 `admit` 钩子接入列表目录和门控。列表请求、缓存和目录解析来自共享传输包；缓存只在内存中，以端点和 API key 的 SHA-256 为键，因此换一个 key 会加载它自己的列表。一个 `loader/volatile-update` 监听器在路由开始或停止使用列表时丢弃缓存的列表。

<a id="further-exploration"></a>
## 进一步探索

[LLM streaming](../../../docs/subsystems/llm-streaming.zh.md) · [Messages](../llm-deepseek/README.zh.md) · [官方列表决策](../../../.agents/notes/implemented/architecture/2026-10-22-deepseek-official-model-listing.zh.md)

<a id="model-experience"></a>
## 模型体验

### 已鉴权的模型请求

#### What the model sees

`deepseek-official` 请求不包含本插件添加的模型可见文本；请求由共享 Messages 传输序列化。

#### Token effect

鉴权、目录过滤和列表都不增加输入 token。所使用的列表决定每个模型的上下文窗口和默认输出上限，每次请求记录的上下文和请求头会写明这些值。

#### KV Cache effect

凭据与目录可用性不进入模型输入；协议传输拥有请求前缀的序列化。列表改变某个模型的 system prompt 模式或工具更新模式时，之后的 system prompt 更新或工具更新的序列化方式随之改变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 配置的目录是配置元数据，不验证远端是否接受模型；实际调用仍可能失败。
- 路由使用列表时，模型页显示的仍是内置目录，因此只有列表提供的模型只出现在模型选择器中。在模型页编辑目录会保存页面上显示的行，这类模型会消失，直到点**恢复默认模型**。
- 自定义的目录收不到列表之后新增的模型。
- 是否自定义按当前版本的内置目录判断：保存的 `models` 列表若等于旧版本的内置目录，内置目录变化后就算作自定义，不再跟随列表，直到点**恢复默认模型**。
- 列表缓存只在内存中；没有网络的启动会一直提供内置目录，直到加载到列表。
- 进程运行期间的列表变化在 Web 模型选择器下一次刷新目录时生效；插件不主动通知。
- 当前版本不能用任何已列出的模型时，路由不提供模型。

<a id="dev-note"></a>
### 开发备注

注册与鉴权的测试也覆盖共享传输包中的 Loader 组合场景。
