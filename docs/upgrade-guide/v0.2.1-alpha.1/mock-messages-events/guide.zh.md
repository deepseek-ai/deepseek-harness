---
kind: upgrade-guide
description: "Messages 模拟流为原生 SDK 消费方发布具名 SSE 事件。"
---

# 读取 Messages 模拟服务器的具名事件

[English](guide.md) | 中文

## 变更

下一版本的 `@deepseek-ai/dsh-llm-mock-server` 在每个结构化 SSE 载荷旁发送 Messages 事件名。原生 SDK 需要这些名称才能处理消息与内容块事件。只接受无名 SSE 消息的消费方必须更新事件处理。脚本载荷、顺序、请求捕获与分片计数保持不变；刻意生成畸形 JSON 的行为仍直接发送无效数据。

## 迁移

1. 消费具名 Messages 事件并解析其 `data` 字段。不要将流过滤为仅含无名事件。
2. 验证完整文本响应、工具调用响应和测试使用的故障行为。[模拟服务器参考](../../../../packages/test-support/llm-mock-server/README.zh.md)说明了可用脚本。
