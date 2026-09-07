# Agent Note: DeepSeek reasoning passback on every reasoned turn

Status: implemented
Archived: 2026-09-04

[English](2026-08-19-deepseek-reasoning-passback-every-turn.md) | 中文

## Problem

`dsh-llm-deepseek` 只在同时携带工具调用的 assistant 轮次上，才把 `reasoning_content` 回放进历史。DeepSeek 思考模式文档在这类轮次上要求该字段，在其他轮次上会忽略它，因此在普通轮次上不回传能省下输入 token，对 `api.deepseek.com` 而言没有任何可观测的损失。

但该端点不是这个适配器唯一服务的对象。`Config.baseURL` 可以把它指向任何 OpenAI 兼容端点，包括把 DeepSeek chat-completions 对话重新编码转发给其他厂商的网关。这类网关在协议上没有承载上游思考签名的字段，只能对回放的思维链取哈希来恢复它。于是模型未调用工具就作答的轮次到达网关时完全不带推理文本，签名查找落空，重建出的对话与记录中的对话产生分叉。Agent 运行的大多数轮次都会调用工具，所以这个损失只在纯作答轮次上出现，表现为偶发。

## Decision

`serializeAssistant` 对每个内容携带推理的 assistant 轮次都发出 `reasoning_content`，与是否有工具调用无关。没有推理块时仍然不发出该字段，因此非思考轮次的行为不变。

回放文本与提供方流式下发的内容逐字一致：`translate.ts` 会把一次响应的整个 `reasoning_content` 通道累积进单个推理块，因此 `serializeAssistant` 中的拼接只连接一个成员，对回放取的哈希与对原始下发取的哈希相同。

## Alternatives considered

- **用 `Config` 开关选择回传策略。** 两种端点行为都真实存在，但该字段在不需要它的地方是惰性的，所以这个开关最多只换回一个轮次的思维链输入 token —— 代价却是一旦设置错误，会话就会静默地无法重建，两端都不会报错来归因。一个设错就静默失败的旋钮，比那点 token 更糟。
- **根据 `baseURL` 判断。** 一个端点是否会转发给其他厂商，无法从它的主机名读出：内部端点可能直连代理 DeepSeek，公网端点也可能转发。适配器只能对自己看不透的部署方式做猜测。
- **改为持久化签名，如 `dsh-llm-pi-ai` 的做法。** 该适配器在 replay state 中按块持久化 `thinkingSignature`，因为它的提供方会把签名放在协议里。DeepSeek chat-completions 不暴露签名，所以这个适配器没有可持久化的东西，回放文本是唯一通道。

## Consequences

每个含推理且不带工具调用的轮次，如今都会在后续请求中按其思维链计入输入 token。新增文本位于该轮次所在位置，且在此后每次请求中都相同，因此组装出的前缀保持稳定，只有跨越此次变更的第一个请求会从该位置起失去缓存复用。

`WireAssistantMessage.reasoning_content` 记录了两种端点行为，包 README 在协议格式说明以及 Model Experience 的 token 与缓存小节中陈述了该回传规则。

## Testing

`tests/serialize.spec.ts` 固定了三种 assistant 形态：推理与文本并存且无工具调用、推理与工具调用并存、以及内容保持为 `""` 的纯推理轮次。不携带推理的轮次仍不发出该字段，由无内容与仅工具调用两种用例覆盖。
