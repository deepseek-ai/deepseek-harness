---
description: "DeepSeek 账号 authentication and model discovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-account

[English](README.md) | 中文

## 概述

为 `deepseek-account` 注册独立的鉴权和模型发现插件。通过 [llm-deepseek](../llm-deepseek/README.zh.md) 共用 Messages 请求实现；本包拥有凭据解析和目录可用性判断。

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

账号 token 仅由 `deepseekAccount.resolveToken(baseURL)` 提供，目标地址必须满足账号服务的来源校验。未登录或目标不允许账号鉴权时，请求以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，目录为空；不会回退到 API key。其他凭据查询错误继续向调用者报告。

```yaml
- id: llm-deepseek-account
  name: '@deepseek-ai/dsh-llm-deepseek-account'
  config:
    reasoningEffort: high
```

账号请求的 HTTP 401 与响应正文无关：映射为 `ACCOUNT_TOKEN_INVALID`，并要求账号服务仅在当前 token 仍与请求所用 token 相同时清除凭据。403 和其他错误不会触发清除。账号模块负责退登后打断任务，本插件不遍历 Agent。

`models` 是该 provider 独立的可配置目录；默认值和协议能力来自共享传输包。目录判断不探测推理端点。设置命名空间采用 Cordis entry id，没有 entry 时采用插件名。产品保留 official 的 `llm-deepseek` entry id，账号使用 `llm-deepseek-account`。

<a id="understand-the-implementation"></a>
## 理解实现

注册和监听随插件生命周期释放。共享 Host 绑定提供附件访问、请求扩展、匿名标识和重试策略的原子更新；本包只注册自己的路由。无需 invariant companion：目录直接由同一次配置和凭据读取派生，不维护独立副本。

共享传输判定为 `QUOTA` 的失败请求离开本提供方前会被改写为 `ACCOUNT_QUOTA`，HTTP 402 响应与流内 SSE 错误都适用。共享传输与 `deepseek-official` 路由保留 `QUOTA`，因此账号路由的充值操作不会出现在 API Key 或第三方失败上。

<a id="further-exploration"></a>
## 进一步探索

[LLM streaming](../../../docs/subsystems/llm-streaming.zh.md) · [Messages](../llm-deepseek/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 已鉴权的模型请求

#### What the model sees

`deepseek-account` 请求不包含本插件添加的模型可见文本；请求由共享 Messages 传输序列化。

#### Token effect

鉴权和目录过滤不增加输入 token；实际调用的 token 由所选模型与请求内容决定。

#### KV Cache effect

凭据与目录可用性不进入模型输入；协议传输拥有请求前缀的序列化。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 目录是配置元数据，不验证远端是否接受模型；实际调用仍可能失败。

<a id="dev-note"></a>
### 开发备注

注册与鉴权的测试也覆盖共享传输包中的 Loader 组合场景。
