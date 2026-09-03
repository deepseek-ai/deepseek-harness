---
description: "共享工具家族的包映射：原子文件写入、品牌化 id、双端队列、JSON 值、harness 主目录路径、启动环境、原生命令、输出保留、时区与超时。"
kind: "package-group"
---

# util/：共享工具

[English](README.md) | 中文

## 概述

`util/` 组为能力包提供共享的机制原语，避免重复实现。它涵盖原子写入、品牌化 id、双端队列、无损 JSON 值、UUID、Harness home 路径、启动环境、出站代理策略、原生命令、输出保留、时区规范化和超时处理。这里的每个根入口都是库：它不注册产品服务或事件，业务语义仍由消费它的能力负责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包提供一个原语；打开对应包页面了解如何使用。

| 包 | 职责 |
|---|---|
| [`brand/`](brand/README.zh.md) | 提供名义字符串类型及其无状态构造函数 |
| [`crypto/`](crypto/README.zh.md) | 基于跨运行时 `crypto.getRandomValues` 原语生成 RFC 9562 v4 UUID |
| [`deque/`](deque/README.zh.md) | 提供摊销常数时间的队列操作和有界空闲存储 |
| [`values/`](values/README.zh.md) | 校验、创建快照、比较和冻结无损 JSON 兼容值 |
| [`home-paths/`](home-paths/README.zh.md) | 解析统一的 Harness 主目录并拼接共享的用户数据路径 |
| [`http-proxy/`](http-proxy/README.zh.md) | 解析出唯一的出站代理策略，并为 `fetch`、SDK agent 与派生子进程安装它 |
| [`launch-environment/`](launch-environment/README.zh.md) | 冻结的启动环境，记住每个值来自哪一层 |
| [`atomic-write/`](atomic-write/README.zh.md) | 原子文件替换与跨进程写锁 |
| [`native-command/`](native-command/README.zh.md) | 直接运行宿主原生命令，绝不拼 shell 字符串 |
| [`workspace-path/`](workspace-path/README.zh.md) | 提供浏览器安全的 Workspace 路径与显示辅助函数 |
| [`output-retention/`](output-retention/README.zh.md) | 限制面向模型的输出并报告精确的省略元数据 |
| [`time/`](time/README.zh.md) | 校验并规范化调用方所报的 IANA 时区 |
| [`timeout/`](timeout/README.zh.md) | 截止时间运算、信号融合与超时/取消分类 |

-----

<a id="related-documentation"></a>
## 相关文档

- [根包映射](../README.zh.md)——`util/` 在所有包组中的位置。
- [生成配置目录](../../docs/config-catalog.zh.md)——本组所属的库包索引。
- [添加包实操手册](../../docs/cookbook/adding-a-package.zh.md)——新的共享原语如何落入本组。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
