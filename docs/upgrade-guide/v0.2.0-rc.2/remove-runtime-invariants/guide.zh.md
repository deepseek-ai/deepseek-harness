---
kind: upgrade-guide
description: "运行时不变式注册表包和每个包的 `./invariant` 子路径导出均被移除。"
---

# 运行时不变式插件被移除

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，`@deepseek-ai/dsh-invariants` 提供 `ctx.invariants` 服务，`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-agent-loop` 等 workspace 包发布向该服务注册检查的 `./invariant` 配套插件。`sdk-minimal` profile 挂载其中五行，id 为 `invariants`、`session-invariant`、`agent-invariant`、`scope-invariant` 和 `agent-loop-invariant`。

下一版本不再发布 `@deepseek-ai/dsh-invariants`、`InvariantRegistry`、`InvariantInstaller`、`InvariantFailure`、`InvariantError`，也不再发布任何 `<package>/invariant` 子路径。`sdk-minimal` profile 不再包含这五行。`credentials/reference-updated`、`credentials/record-updated`、`authorization/settled` 和 `llm/adapters-updated` 的发出方会隔离并记录每个监听器失败，包括 `code: 'INVARIANT'` 的错误，不再重新抛出。

引用已移除模块的 `cordis.yml`、patch 或 overlay 无法加载该模块。指向上述五个 `sdk-minimal` id 之一的 patch 会记录 `patch: entry <id> not found`。导入已移除模块或符号的 TypeScript 代码无法编译。

## 迁移

1. 从 `cordis.yml`、`$DSH_HOME/profiles/<name>/cordis.patch.yml` 和 `--patch` overlay 中删除 `name` 为 `@deepseek-ai/dsh-invariants` 或以 `/invariant` 结尾的行。
2. 删除指向 id `invariants`、`session-invariant`、`agent-invariant`、`scope-invariant` 或 `agent-loop-invariant` 的 patch 条目。
3. 从 `package.json` 依赖中移除 `@deepseek-ai/dsh-invariants`，并删除对它和 `<package>/invariant` 子路径的导入。依赖上述四个发出方重新抛出 `INVARIANT` 失败的插件，必须通过自己的通道报告该失败。
4. 确认：`dsh` 启动该 profile 时没有模块未找到错误或 `patch: entry ... not found` 警告，`tsc` 不再报告缺失的模块或导出。
