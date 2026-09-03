# Agent Note: 读取协议特定的模型列表

Status: implemented

[English](2026-09-02-protocol-specific-model-listing-discovery.md) | 中文

## 问题

[提供方草稿询问决策](2026-08-04-draft-provider-endpoint-interrogation.zh.md)最初只读取 OpenAI 兼容的 `data` 数组。一些兼容网关改为公布富信息 `models` 对象，而 Anthropic 公布了具有不同认证与 URL 规则的原生模型列表路由。把任一情况视为不受支持，都会迫使用户手工复制模型 id 和容量，即使端点已经公布这些信息。

向一个网关发送 OpenAI SDK `User-Agent` 可以使其返回 OpenAI 风格数组。该行为没有文档，改变了请求归属，并使回答取决于客户端身份而非受支持的响应解析器。

## 决策

`dsh-llm-pi-ai` 按所选协议格式读取模型列表。`openai-completions` 与 `openai-responses` 以 bearer 认证使用 `GET {baseURL}/models`。`anthropic-messages` 以 `x-api-key` 和 `anthropic-version: 2023-06-01` 使用 `GET /v1/models?limit=1000`。Anthropic 页大小采用文档规定的最大值；模型发现不会继续跟随 `has_more`，因此公布超过 1,000 个模型的端点只会暴露第一页。

Anthropic SDK 资源方法会自行追加 `/v1`，而网关文档会同时发布带与不带该后缀的 API 根地址。因此列表 URL 会把末尾为 `/v1` 的 Anthropic `baseURL` 草稿视为与不带该后缀的地址相同的 API 根地址，并且只有它会归一化这一段：模型请求收到的仍是配置原样的 `baseURL`，与 pi-ai 的处理完全一致。部署路径前缀会保留：`https://gateway.example/tenant/v1` 与 `https://gateway.example/tenant` 都在 `/tenant/v1/models` 列表。

解析器接受 `data` 数组或富信息 `models` 对象，并在数组存在时优先使用它。数组条目使用自身的 `id`；对象条目使用属性键，因为嵌套 `id` 可能指向规范模型，而不是请求所接受的路由别名。只有值为对象的映射条目才视为模型，因此原始类型的目录元数据不会意外成为候选。空属性键才会回退到嵌套 `id`。

解析器会把受支持的名称与容量拼写归一化为 `LlmDiscoveredModel`。缺失的显示名会变成请求 id，使采纳操作填入完整的可编辑行。请求保留 Harness 归属标头；网关兼容性由响应解析提供，而非冒充客户端身份。

## 考虑过的替代方案

**跟随 Anthropic 的所有页面。** 游标遍历可以返回超过 1,000 个条目的列表，但会给配置操作增加多请求失败、取消、游标推进与总大小处理。实现请求 Anthropic 的最大页面，并记录剩余截断限制。

**同时归一化推理地址。** 在模型路由前截掉同一段 `/v1` 可以让 `/v1` 地址既能列表也能服务，但这会把请求 URL 规则从 pi-ai 挪进本包，且只为一种协议。模型请求保持 pi-ai 自身对 `baseURL` 的处理；列表请求是本包构造的唯一 URL。

**拒绝末尾的 `/v1`。** 在加载或探测时拒绝可以尽早点出错误，但网关文档发布的就是 `/v1` 写法，照文档粘贴地址的用户会被一个本能工作的列表拒之门外。

**为模型发现发送 OpenAI SDK `User-Agent`。** 这会让一个网关返回 `data`，但会错误标记 Harness 流量，并依赖未记录的客户端名称分支。读取两种已知响应格式可以保持归属准确。

**采纳 `models` 对象的每个属性。** 原始类型属性不能证明其键是模型 id，也可能是数量或状态等目录元数据。把条目限制为记录可避免虚构模型候选。

## 后果

Models 页面无需改变请求身份，即可询问 OpenAI 兼容网关与 Anthropic Messages 端点。发现的候选会在端点提供时携带路由 id、名称、上下文窗口与最大输出 token 数，只有 id 的列表也会通过 id 回退获得可编辑标签。Anthropic 地址以根地址或 `/v1` 形式都能列表；模型请求使用 pi-ai 收到的配置地址。

受支持格式仍是显式兼容集合，而不是任意 JSON 推断。可见模型超过 1,000 个的 Anthropic 账户需要手工录入第一页之外的条目，原始类型的 `models` 属性会被忽略。

## 测试

本地 HTTP 服务器测试钉住两种受支持响应格式、字段归一化、名称回退、忽略畸形条目、Anthropic 标头、最大页查询，以及 Anthropic 根地址的两种写法。2026-09-02 从 OpenRouter、models.dev 与 DeepSeek 录得的回复，连同 Anthropic List Models 参考文档给出的示例回复，存放在 `packages/llm/llm-pi-ai/tests/fixtures/model-listings/` 下并经解析器回放，因此受支持的字段拼写钉在真实端点与公开参考文档上，而不是手写样例上。
