---
kind: upgrade-guide
description: "Node PTC 的 persistent-in-memory 执行默认使用 scoped REPL，replScoped 为 false 时除外。"
---

# 保留状态的 Node PTC 默认使用 scoped REPL

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-ptc-runtime-node` 在 `executionMode: persistent-in-memory` 下省略 `replScoped` 时，原先用 Node 的 REPL 求值器运行程序；现在按 scoped REPL 语句运行，并报告程序格式 `scoped-repl`。每次调用是独立的严格模式脚本，开始时拿到之前调用留下的顶层绑定的拷贝，因此之后的调用可以再次声明同名的 `let`、`const` 或 `class`。`require`、`_`、`_error`，以及给未声明的名字赋值而产生的全局变量都不可用。模型说明描述了这些行为；包 README 列出了它的[已知限制](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#known-limitations-and-deferred-work)。

受影响的有：

- `ptc-runtime` 条目设置了 `executionMode: persistent-in-memory` 但没写 `replScoped` 的 profile，包括在该运行时上运行的 workflow-ptc 脚本；
- 在 Computer Use 详情页打开的持久化 PTC，现在会写入 `replScoped: true`；
- Computer Use 的 `cua_run_code` 工具，其专用运行时在没有设置 `standaloneRunCode.runtime.replScoped` 时省略 `replScoped`；
- 合并 `@deepseek-ai/dsh-ptc-runtime-node/configuration` 中 `resolvePersistentExecution` 结果的 profile 编辑器，该函数现在对函数体和 REPL 语句返回 `replScoped: true`。

`per-call` 和 `vm-script` 执行（包括默认 profile）不变，设置了 `replScoped: false` 的条目继续使用 Node 的 REPL 求值器。

## 迁移

1. 如果保留 scoped REPL，替换只在 REPL 下可用的代码：用 `await import(...)` 代替 `require`，有意的全局变量赋给 `globalThis.name`，不要在 `let` 或 `const` 的初始化表达式里读取同名的旧值，改用新名字。
2. 如果要恢复 Node 的 REPL 求值器，在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里设置 `replScoped: false`；要让设为 `false` 的条目改用 scoped REPL，删除这个键或改为 `true`。下面每个 patch 都会替换该条目的整个 `config`，所以要把条目已有的字段一并写进去，`cua` 条目还包括 `agentPreset`、`allowedApps` 和 `standaloneRunCode` 的其他字段：

   ```yaml
   - id: ptc-runtime
     config:
       executionMode: persistent-in-memory
       replScoped: false
   ```

   对 `cua_run_code`，在 Computer Use 提供方条目上设置：

   ```yaml
   - id: cua
     config:
       standaloneRunCode:
         runtime:
           replScoped: false
   ```

3. 重启 profile，在连续两次调用里运行 `const probe = 1`。scoped REPL 两次都接受；Node 的 REPL 求值器在第二次报告 `probe` 已经声明过。
