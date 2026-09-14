---
description: "test-support 组地图：面向编写与运行仓库测试的开发者，提供无密钥测试 harness、LLM（大语言模型） mock 与回放服务器以及 Loader 冒烟测试辅助。"
kind: "package-group"
---

# packages/test-support

[English](README.md) | 中文

## 概述

test-support 组为仓库测试提供确定且无须密钥的真实产品测试方式。它包含 Loader 应用 harness、session-log 快照适配器、回放 LLM 插件和可通过脚本控制的 OpenAI 兼容故障服务器。每个包都是支持层基础设施；当某个包获得产品约定与产品消费方时，它就会移出本组。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`session-snapshot`](session-snapshot/README.zh.md) | 为 profile 驱动的测试提供 session-log 快照支持与协议适配器 |
| [`agent-loop-testkit`](agent-loop-testkit/README.zh.md) | 为运行具体 AgentLoop 的测试提供共享先决服务 |
| [`client-runtime`](client-runtime/README.zh.md) | 为浏览器功能测试提供 jsdom slot 测试台 |
| [`remote-mock`](remote-mock/README.zh.md) | 为整体客户端测试提供端点具名的 Typert Remote mock 与它们安装的 Connection 载体面 |
| [`loader-smoke`](loader-smoke/README.zh.md) | 启动由 Loader 组合的应用并驱动 fixture（测试前置数据）轮次以执行冒烟测试 |
| [`llm-mock-server`](llm-mock-server/README.zh.md) | 为恢复测试提供可通过脚本控制的 OpenAI 兼容故障服务器 |
| [`llm-replay`](llm-replay/README.zh.md) | 为无密钥测试与演示回放已记录的模型流 |

-----

<a id="related-documentation"></a>
## 相关文档

- [测试策略](../../docs/testing.zh.md)——这些 harness 所服务的无密钥快照层，以及何时必须使用该层。
- [运行时不变式子系统](../../docs/subsystems/invariants.zh.md)——包自有运行时检查的注册与执行。
- [包组](../README.zh.md)——支持组与产品组的关系。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
