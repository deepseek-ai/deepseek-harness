---
description: "DeepSeek API key authentication and model discovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-api-key

[English](README.md) | 中文

## 概述

为 `deepseek-official` 注册独立的鉴权和模型发现插件。通过 [llm-deepseek](../llm-deepseek/README.zh.md) 共用 Messages 请求实现；本包拥有凭据解析和目录可用性判断。

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

`apiKeyEnv` 默认为 `DEEPSEEK_API_KEY`，在每次请求时解析凭据。已组合 credentials 服务时，按其优先级解析；只有未组合该服务时才直接读取启动环境。请求时凭据缺失以 `MISSING_CREDENTIAL` 失败；格式错误以 `INVALID_CREDENTIAL` 失败。模型发现始终返回配置的目录，不依赖凭据。

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    reasoningEffort: high
    apiKeyEnv: DEEPSEEK_API_KEY
```

端点和凭据引用来自同一次配置解析；进行中的请求保留该快照，后续配置更新仅影响后续请求。账号登录态不影响该路由使用的凭据。

`models` 是该 provider 独立的可配置目录；默认值和协议能力来自共享传输包。目录判断不探测推理端点。设置命名空间采用 Cordis entry id，没有 entry 时采用插件名。产品保留 official 的 `llm-deepseek` entry id，账号使用 `llm-deepseek-account`。

<a id="understand-the-implementation"></a>
## 理解实现

注册和监听随插件生命周期释放。共享 Host 绑定提供附件访问、请求扩展、匿名标识和重试策略的原子更新；本包只注册自己的路由。无需 invariant companion：目录直接由配置派生，不维护独立副本。

<a id="further-exploration"></a>
## 进一步探索

[LLM streaming](../../../docs/subsystems/llm-streaming.zh.md) · [Messages](../llm-deepseek/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 已鉴权的模型请求

#### What the model sees

`deepseek-official` 请求不包含本插件添加的模型可见文本；请求由共享 Messages 传输序列化。

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
