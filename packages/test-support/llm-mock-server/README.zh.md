---
description: "用于在无提供方密钥的情况下测试 LLM 适配器与恢复策略的可编脚本 OpenAI 兼容故障服务器，面向测试作者与演示。"
kind: "package-library"
---

# @deepseek-ai/dsh-llm-mock-server

[English](README.md) | 中文

## 概述

`dsh-llm-mock-server` 在测试期间以可编脚本的 OpenAI 兼容 HTTP／SSE（Server-Sent Events）服务器代替真实模型提供方：你脚本化一串协议行为——流重置、停滞、畸形分片、限流、服务器错误、成功补全、工具调用——每个已接受的 `/chat/completions` 请求依次消费下一个。它通过真实 HTTP 服务发布的 DeepSeek 适配器与 agent loop（智能体循环），因此重试、退避与超时等恢复策略会在真实协议边界上得到检验，且无需提供方密钥。CLI（`pnpm run mock:llm`）可独立运行服务器；库入口 `startMockLlmServer` 将其嵌入测试并返回捕获的请求。`random` 行为配合带种子的权重可混合故障，用于开放式压力运行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包让测试或演示无需提供方即可讲提供方协议：启动服务器，脚本化你想检验的协议行为，然后把真实 LLM（大语言模型）适配器指向它的 base URL。

### 独立运行

从本仓库运行源入口：

```sh
pnpm run mock:llm \
  --port 8000 \
  --api-key mock-key \
  --sequence partial_disconnect,success \
  --partial-text "discard this half"
```

将发布的 DeepSeek 适配器指向服务器；它会将 `/chat/completions` 追加到已配置 base：

```sh
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1 \
DEEPSEEK_API_KEY=mock-key \
pnpm dsh --profile headless "test provider recovery"
```

仓库脚本将 JSONL 写入 stdout：`ready` 记录携带以 `/v1` 结尾的 base URL 与随机种子，后续请求/结果记录同时命名脚本行为与实际选中的具体行为。本包不公开可安装的二进制命令。

### 脚本化行为

`--sequence` 是逗号分隔的 FIFO。耗尽时返回结构化 HTTP 500；`--repeat-last` 显式重用最后一项。

| 行为 | 协议结果 |
|---|---|
| `connection_reset` | 在发送 HTTP 标头前销毁 socket |
| `stream_disconnect` | 发送 SSE 标头，然后在第一个事件前重置连接 |
| `partial_disconnect` | 发送文本增量，然后重置 socket |
| `stall` | 发送 SSE 标头，并保持空闲，直到客户端／服务器取消 |
| `empty` | 发送有效的无内容 stop 和 `[DONE]` |
| `empty_body` / `stream_eof` / `partial_eof` | 正常结束，但缺少必需的 `[DONE]` 边界 |
| `malformed_json` / `malformed_event` | 发送无效 SSE JSON 或无效提供方分片形态 |
| `rate_limit` / `server_error` / `service_unavailable` | 返回面向重试的 429/500/503 JSON 错误 |
| `auth_error` / `invalid_request` / `context_overflow` / `quota_exceeded` | 返回终止性错误或需要单独恢复的提供方错误 |
| `success` / `slow_success` / `reasoning_success` | 流式发送完整文本响应，可选延迟或先发送 reasoning |
| `tool_call_success` / `max_tokens` | 以工具调用或结束原因 `length` 完成 |
| `wrong_content_type` | 以 `application/json` 内容类型发送有效 SSE 正文 |
| `random` | 按带权重的种子随机选择具体请求行为 |

`connection_refused` 只能在 CLI 中使用，且必须是第一个条目。它会延迟绑定调用方指定的非零端口，因此 `--listen-delay-ms` 期间的请求会收到真实 TCP 拒绝；其余条目在 listener 启动后开始。

### 随机模式

使用重复 `random` 条目执行开放式混合运行：

```sh
pnpm run mock:llm \
  --port 8000 \
  --sequence random \
  --repeat-last \
  --seed 42 \
  --random-weights 'success=60,slow_success=10,connection_reset=5,stream_disconnect=5,partial_disconnect=10,empty=5,server_error=5'
```

省略 `--seed` 会生成种子，并在 `ready` 记录中打印。`--random-weights` 接受非负的相对 `behavior=weight` 条目，并要求至少一个正权重具体行为。导出默认值是一个成功占主导的压力分布，包含 reset、disconnect、部分输出、空完成、stall、429/5xx、干净截断与格式错误的 JSON；它用于施加测试压力，而非估计生产事故频率。`connection_refused` 被排除，因为已绑定的请求处理器无法产生真实拒绝。随机权重包含 `stall` 时，为待测客户端配置较短的流空闲超时，使场景及时结束。

### 时序与内容控制

CLI 公开 `--success-text`、`--partial-text`、`--reasoning-text`、`--chunk-size`、`--chunk-delay-ms`、`--disconnect-delay-ms`、`--retry-after-ms`、`--request-id`、`--tool-name` 与 `--tool-arguments`。毫秒延迟是 Node timer 范围内的有界整数；`retryAfterMs` 还必须为正数。库接受相同的 camel-case 选项。可选的精确 `apiKey` 验证 `Authorization: Bearer <token>`；省略时接受任何 token。

### 可能出什么问题

- **脚本耗尽**——耗尽时返回结构化 HTTP 500；当一次运行需要更多请求时设置 `--repeat-last` 或加长序列。
- **没有正权重具体行为的随机权重会被拒绝**——每个条目都必须命名现有行为，且至少一个条目带正权重。
- **无效请求不消费脚本**——错误方法、路径、Bearer token 与畸形 JSON 会收到普通 4xx 响应，因此配置错误的客户端可能耗尽重试却不推进序列。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务器的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计

服务器建立在一个规则之上：每个已接受的 chat-completions 请求从按到达顺序排列的 FIFO 游标消费恰好一个行为，服务器从不重试或解读 harness 策略。校验先于游标推进——只有 `POST` 且路径以 `/chat/completions` 结尾、配置密钥时携带有效 Bearer token、且 JSON 正文可解析的请求才消费脚本；其余请求都收到普通 4xx。`random` 条目在请求时通过带种子的 PRNG 按配置权重解析，因此一次运行可由其打印出的种子复现。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `startMockLlmServer`：listener、行为表、种子随机、遥测、捕获的请求记录 |
| [`src/cli.ts`](src/cli.ts) | `--sequence` 与时序/内容选项解析、JSONL stdout 遥测 |
| [`src/bin.ts`](src/bin.ts) | `pnpm run mock:llm` 源入口 |
| — | 不发布运行时不变式伴生入口；协议行为通过 HTTP 测试检验。 |

### 协议流程

请求进入处理器、通过校验，然后选择行为：具体脚本条目直接运行，`random` 抽取一个，已耗尽脚本则以结构化 500 报告 `script_exhausted`。随后 `runBehavior` 执行协议结果——销毁 socket、SSE 流、JSON 错误或补全——同时每个请求与结果按到达顺序记录到返回的句柄上，供测试断言。`close()` 停止接受请求并强制终止停滞连接。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从故障服务器逐步进入它所检验的适配器约定，以及用于已记录成功 transcript 的无密钥替代方案。

- [LLM 包](../../llm/llm/README.zh.md)——本服务器所检验的提供方流约定与重试策略。
- [llm-replay](../llm-replay/README.zh.md)——回放已记录成功 transcript 而非制造故障的无密钥替代方案。
- [测试策略](../../../docs/testing.zh.md)——本服务器服务的覆盖层级与恢复测试。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无。该测试服务器替代提供方协议行为，而不调用真实模型。

#### KV Cache 影响

无；请求在本地终止，绝不会到达提供方缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时需要对该服务器特别小心。它们是当前包约束，不是任务积压。

- **随机权重建模测试压力，而非生产事故频率**——需要环境专用分布的调用方必须提供已测量权重，并记录发出的种子。
- **请求脚本按到达顺序执行**——并发调用方共享一个游标，因此确定性的每会话故障分配需要独立服务器实例。
- **真实连接拒绝发生在监听器生命周期阶段**——CLI 延迟必须与客户端尝试重叠；请求级随机选择只能重置已接受的连接。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
