---
kind: upgrade-guide
description: "预装的 Node PTC bootstrap 必须使用控制协议 3，PtcProgramFormat 新增 'scoped-repl'。"
---

# Node PTC bootstrap 协议 3 与 scoped-repl 格式

[English](guide.md) | 中文

## 变更

Node PTC 宿主与子进程 bootstrap 改用控制协议版本 3，新增 `scoped-repl` 程序格式。所有执行模式下，bootstrap 报告其他版本时，宿主在运行任何程序之前就拒绝它，调用失败并报 `bootstrap protocol mismatch; upgrade launch.bootstrapPath with the host`。默认的本地启动和 embedded 启动使用宿主自带的 bootstrap，不受影响。把 `launch.bootstrapPath` 指向单独安装的 bootstrap 的部署受影响，包括使用 `node-script` 启动、设置了 `launch.bootstrapPath` 和 `launch.bootstrapHash` 的 `@deepseek-ai/dsh-ssh` 宿主。

`@deepseek-ai/dsh-ptc-runtime` 的 `PtcProgramFormat` 新增 `'scoped-repl'`；`@deepseek-ai/dsh-ptc-runtime-node` 在 `executionMode: persistent-in-memory` 下设置 `replScoped: true` 时，`PtcRuntime.programFormat` 报告这个值。对这个联合类型做穷尽匹配的代码，处理新值之前无法通过编译。

## 迁移

1. 在单独运行 bootstrap 的环境中，安装与宿主版本一致的 `@deepseek-ai/dsh-ptc-runtime-node`，并把 `ptc-runtime` 条目的 `launch.bootstrapPath` 指向该版本的 `lib/persistent-process.js`。
2. 使用 `node-script` 启动的 `@deepseek-ai/dsh-ssh`：把新的 bootstrap 复制到远端的 `launch.bootstrapPath`，并把 `launch.bootstrapHash` 设为它的小写 SHA-256，例如用 `sha256sum` 计算。
3. 在按 `PtcProgramFormat` 分支或以它为键的地方处理 `'scoped-repl'`。`scoped-repl` 程序是 REPL 语句，最后一条表达式就是结果；不支持顶层 `return`，末尾的 Promise 不会被等待。
4. 运行一次 `run_code`，确认不再报 `bootstrap protocol mismatch`，再对使用 `PtcProgramFormat` 的代码做类型检查。
