---
kind: upgrade-guide
description: "自定义 Node PTC bootstrap 必须升级到协议版本 3，才能与新版 Host 一起运行。"
---

# Node PTC bootstrap 协议版本 3

[English](guide.md) | 中文

## 变更

Node PTC Host 要求 bootstrap 协议版本从 2 升至 3。它会在派发程序前拒绝旧 bootstrap，并报告 `bootstrap protocol mismatch; upgrade launch.bootstrapPath with the host`。这影响所有执行模式下自定义 `launch.bootstrapPath` 的部署。DSH 内置 bootstrap 随 Host 更新，无需修改配置。

版本 3 为每个新环境携带可选的 `ProgramBootData.initialization` 源码。bootstrap 安装本次绑定后独立执行初始化，随后等待 Host 对 `initialized()` RPC 的确认，再次检查取消状态后才执行模型程序。初始化失败会丢弃环境并阻止模型代码执行。Node 提供方仅在 `persistent-in-memory` 模式下支持注册初始化程序。

## 迁移

1. 如果 Node PTC 配置设置了 `launch.bootstrapPath`，请在其执行环境中部署匹配版本的 `@deepseek-ai/dsh-ptc-runtime-node`。使用包内构建产物 `lib/process.js`，或默认采用 REPL 的 `lib/persistent-process.js`，并保留其依赖。Host 与 bootstrap 版本必须匹配；只修改声明的版本号并不够。
2. 将 `launch.bootstrapPath` 指向匹配的入口并重启提供方。本地部署若不需要自定义 bootstrap，可以移除此覆盖项以使用安装默认值。[Node 运行时文档](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#persistent-repl)说明状态保留和远程启动方式。
3. 在每种已配置的执行模式中运行一个程序，确认正常完成且没有协议错误。使用 `registerEnvironmentInitializer(program)` 的消费方还须验证：初始化在每个新环境中只执行一次，且初始化出错时模型程序不会产生效果。
