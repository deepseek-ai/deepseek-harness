---
kind: upgrade-guide
description: "Node PTC 默认使用 persistent-in-memory 执行和 scoped REPL，不再默认使用 per-call 函数体。"
---

# Node PTC 默认运行 scoped REPL

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-ptc-runtime-node` 原先的 `executionMode` 默认值是 `per-call`：每个 `run_code` 程序是在新 Node 进程中运行的 async 函数体，可以使用顶层 `return`，调用之间不保留状态。现在默认值是 `persistent-in-memory`，在默认 `replScoped` 下运行 scoped REPL，并报告程序格式 `scoped-repl`。每个存活的 Agent 保留一个 Node 进程，顶层绑定带到之后的调用；顶层 `return` 会被拒绝，最后一条顶层表达式语句是完成值。模型说明描述了新语法。

受影响的是所有省略 `executionMode` 的 `ptc-runtime` 条目，包括默认 profile 的 PTC 模式、在该运行时上运行的 workflow-ptc 脚本，以及不带配置挂载该提供方的直接运行时使用方。显式设置了 `executionMode` 的条目不变。对于省略该项的 profile，Computer Use 详情页显示共享 PTC 运行时已是持久模式，「设为持久化」按钮不可用。

## 迁移

1. 如果要继续在新进程中运行函数体，在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中设置执行方式。patch 会替换该条目的整个 `config`，所以要把条目已有的字段一并写进去：

   ```yaml
   - id: ptc-runtime
     config:
       executionMode: per-call
   ```

2. 为 scoped REPL 编写的程序，把末尾的 `return value` 改为末尾的 `value` 表达式语句，并用 `await import(...)` 代替 `require`。
3. 重启 profile，在同一会话中先运行 `var probe = 1`，再在下一次调用中运行 `inspect(typeof probe)`。scoped REPL 输出 `number`；`per-call` 输出 `undefined`。
