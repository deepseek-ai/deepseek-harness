# DeepSeek Harness Python SDK

[English](README.md) | 中文

用于以子进程方式驱动 DeepSeek Harness 的 Python 包。客户端 SDK 通过 stdio 使用按行分隔的 JSON-RPC 与内置运行时通信。

## 包

| 目录 | 分发名／模块 | 职责 |
|---|---|---|
| [sdk](sdk/README.zh.md) | `deepseek-harness-sdk` / `deepseek_harness` | 高层轮次 API 与低层 JSON-RPC 客户端 |
| [sdk-runtime](sdk-runtime/README.zh.md) | `deepseek-harness-runtime-bin` / `deepseek_harness_runtime` | 内置 `dsh` CLI（命令行界面）可执行程序与原生伴随文件 |

## 行为

除非调用方选择另一个 `dsh` 可执行程序或 profile，否则 SDK 会启动匹配的内置 `dsh --profile sdk` 运行时。可运行的极简示例选择随附的独立 `sdk-minimal` profile；同一运行时还会打包 `dsh web` 及其前端产物，供单独通过 CLI 使用。每次启动都要求显式选择 Harness home；Python 绝不会静默读取 `~/.dsh`。[SDK 参考](sdk/README.zh.md) 和 [运行时载体参考](sdk-runtime/README.zh.md) 定义运行时选择、profile、patch 与外部插件管理约定。

## 贡献者工作流

[Python 贡献者工作流](development.zh.md)介绍运行时产物构建、包验证、源码模式开发和分发。
