---
description: "持久会话数据平面的包映射：持久化 seam 及其后端、检查点策略、投影、基于日志的标题与外发会话遥测。"
kind: "package-group"
---

# session/ — 持久会话数据平面

[English](README.md) | 中文

## 概述

session 组让对话持久保存，恢复已发布的日志格式，并使已提交历史在重启后仍可用。存储与检查点包保护请求、工具副作用和已完成步骤；投影包生成客户端可用的值；标题包为会话命名；遥测包上报活动。先使用随产品交付的 JSONL 存储，再添加检查点，并仅按部署需要添加投影、标题策略或遥测。每个包 README 负责各自的保证与配置，同级查询组则提供独立的读取和工具访问。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本组分为四个家族：持久存储（持久化 seam、后端、检查点策略）、投影、标题与遥测。每个包 README 负责各自的约定与配置。

### 持久化

| 包 | 职责 | ctx key |
|---|---|---|
| [`session-format/`](session-format/README.zh.md) | 纯相邻格式链与产物校验库 | 库，不使用 ctx key |
| [`session-format-v0-to-v1/`](session-format-v0-to-v1/README.zh.md) | 冻结的 released-v0 解码器，以及到 released v1 的恒等迁移 | 库，不使用 ctx key |
| [`session-format-v1-to-v2/`](session-format-v1-to-v2/README.zh.md) | 冻结的 released-v1 解码器，以及迁移到 released v2 时会改变基数的 Assistant 流迁移 | 库，不使用 ctx key |
| [`session-format-catalog/`](session-format-catalog/README.zh.md) | 自动生成的已交付相邻迁移静态目录 | 库，不使用 ctx key |
| [`session-persistence/`](session-persistence/README.zh.md) | 定义持久会话存储服务，以及每个后端组合的共享写入协调机制 | `ctx.sessionPersistence` |
| [`session-persistence-jsonl/`](session-persistence-jsonl/README.zh.md) | 随产品交付的后端：逐 Session 使用不可变规范 generation 文件名并排他发布后继；可选 Zstandard 压缩 | 注册到 `ctx.sessionPersistence` |
| [`session-checkpoint-policy/`](session-checkpoint-policy/README.zh.md) | 让模型请求、顶层工具副作用与已完成步骤在下一步动作前持久化 | 包装 `ctx.llm` 与 `ctx.tools` |
| [`session-log-deepseek/`](session-log-deepseek/README.zh.md) | 把增量规范日志作为可选的官方 DeepSeek 请求元数据上传 | 贡献 `dsh_session_log` |

### 投影

| 包 | 职责 | ctx key |
|---|---|---|
| [`session-projection/`](session-projection/README.zh.md) | 定义并驱动把已提交事件折叠为完整当前值的投影单元 | `ctx.sessionProjections` |
| [`session-projection-cache/`](session-projection-cache/README.zh.md) | 持久化投影检查点，使冷读跳过全量日志加载 | `ctx.sessionProjectionCache` |
| [`session-stats/`](session-stats/README.zh.md) | 通过 `sessionStats` 单元提供全日志会话计数与墙钟时间 | 注册到 `ctx.sessionProjections` |
| [`session-turn-outline/`](session-turn-outline/README.zh.md) | 通过 `turnOutline` 单元提供全日志轮次大纲（轮次、`turn/start` seq、提示词预览） | 注册到 `ctx.sessionProjections` |

### 标题

| 包 | 职责 | ctx key |
|---|---|---|
| [`session-title/`](session-title/README.zh.md) | 基于日志的会话标题，带确定性回退与一个可选提供方 | `ctx.sessionTitle` |
| [`session-title-llm/`](session-title-llm/README.zh.md) | 供提供方包共享的模型标题生成策略 | 库，不使用 ctx key |
| [`session-title-first-prompt-llm/`](session-title-first-prompt-llm/README.zh.md) | 根据第一条合格的人类消息为会话生成标题 | 注册到 `ctx.sessionTitle` |
| [`session-title-all-prompts-llm/`](session-title-all-prompts-llm/README.zh.md) | 根据所有合格的人类消息为会话生成标题 | 注册到 `ctx.sessionTitle` |

### 遥测

| 包 | 职责 | ctx key |
|---|---|---|
| [`session-telemetry/`](session-telemetry/README.zh.md) | 捕获会话活动并把记录交给配置的上报后端 | `ctx.sessionTelemetry` |
| [`session-telemetry-otel/`](session-telemetry-otel/README.zh.md) | 通过 OpenTelemetry 日志以 `FEEDBACK_ONLY` 或 `DISABLED` 模式投递遥测 | 注册到 `ctx.sessionTelemetry` |

同一时间只允许一个标题提供方注册；未注册时，标题服务保留其确定性回退。下面的子系统页面是各家族后端无关的参考资料。

-----

<a id="related-documentation"></a>
## 相关文档

- [会话持久化子系统](../../docs/subsystems/persistence.zh.md)——后端无关的服务语义、flush 检查点与崩溃恢复。
- [会话投影子系统](../../docs/subsystems/session-projection.zh.md)——投影单元约定与驱动语义。
- [会话标题子系统](../../docs/subsystems/session-title.zh.md)——标题资格、回退与提供方流程。
- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——捕获、脱敏与投递模式。
- [会话子系统](../../docs/subsystems/session.zh.md)——本组每个包持久化或派生的实时事件日志。

<a id="dev-note"></a>
## 开发备注

无。
