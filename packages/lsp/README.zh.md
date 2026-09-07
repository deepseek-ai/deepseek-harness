---
description: "lsp 组地图：通过 LSP seam、其 stdio 提供方与面向模型的 lsp 工具实现的语言服务器代码导航，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# lsp/：语言服务器代码导航

[English](README.md) | 中文

## 概述

lsp 组为 agent 提供精确的、由语言服务器支撑的代码导航：转到符号的定义、查找其引用、跳转到其实现，或阅读悬停文档，而模型无需知道是哪个服务器在应答。该能力拆分为三个产品包：`dsh-lsp` seam（`ctx.lsp`）按文件扩展名选择提供方并规范化结果，`dsh-lsp-stdio` 提供方驱动配置好的本地语言服务器命令，面向模型的 `dsh-tool-lsp` 工具拥有 `lsp` 的 schema、提示词与呈现。只有提供方与工具在加载后才实际做事；部署需要显式配置服务器命令与扩展名映射，本组自身不随附任何语言服务器。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`lsp/`](lsp/README.zh.md) | 定义代码导航服务：按文件扩展名选择提供方、四种规范化的只读操作与结构化错误 | `ctx.lsp` |
| [`lsp-stdio/`](lsp-stdio/README.zh.md) | 通过 `ctx.fs` 与 `ctx.subprocess` 驱动配置好的 stdio 语言服务器命令，注册为提供方 | 注册到 `ctx.lsp` |
| [`tool-lsp/`](tool-lsp/README.zh.md) | 通过 `lsp` 工具向模型暴露精确的代码导航 | 注册到 `ctx.tools` |

提供方注册的是能力而非工具：`tool-lsp` 是面向模型的名称、schema、提示词指引与呈现的唯一 owner，因此更换提供方绝不会改变模型请求导航的方式。

-----

<a id="related-documentation"></a>
## 相关文档

- [LSP 导航子系统](../../docs/subsystems/lsp.zh.md)——操作、坐标、请求与结果，以及 `LspError` code。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-lsp)——模型接收的 `lsp` schema。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
