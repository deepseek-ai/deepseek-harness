---
kind: upgrade-guide
description: "forge-session 不再自行识别 gh 命令；由 forge 提供方注册绑定变更请求的命令，已有的 forgeChangeRequests 检查点会重新折叠一次。"
---

# Forge 提供方注册绑定变更请求的命令

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-experimental-forge-session` 过去自行识别 `gh pr create`、`gh pr view`、`gh pr edit` 与 `gh pr checkout`。现在它只识别 forge 提供方通过 `ctx.forgeSession.registerCommands(rule)` 注册的命令：`@deepseek-ai/dsh-experimental-forge-github` 注册 `gh`，`@deepseek-ai/dsh-forge-gitlab` 注册 `glab`。加载 forge-session 但不加载 forge-github 的组合，不再从 `gh` 命令绑定 pull request；`git push` 发现、`track` 与已记录的绑定不变。规则注册后，每个 Session 此前执行过的命令同样会绑定。

`forgeChangeRequests` 投影的状态版本现由已注册的规则派生，因此此前版本检查点中的每一行都会被丢弃一次：每个 Session 下次被读取时重新折叠其日志，在此之前 Session 列表不显示它的缓存绑定。绑定不会丢失。对未写明主机的编号，`gh` 查询现在执行 `gh pr view <number> --repo <repository> --json url --jq .url`。

受影响的是自定义 `cordis.yml` 组合与注册命令规则的代码。forge 套件会加载两个提供方，无需改动。

## 迁移

1. 在加载 forge-session 的组合中，同时加载 `@deepseek-ai/dsh-experimental-forge-github` 以识别 `gh` 命令、加载 `@deepseek-ai/dsh-forge-gitlab` 以识别 `glab` 命令，或两者都加载。
2. 若要绑定其他 CLI 的命令，像 [`packages/experimental/forge-github/src/commands.ts`](../../../../packages/experimental/forge-github/src/commands.ts) 那样，从注入 `forgeSession` 的插件中通过 `ctx.forgeSession.registerCommands` 注册一条 `ForgeCommandRule`，并在其对任何命令的分类发生变化时提高 `version`。
3. 打开一个执行过 `gh pr create` 的 Session；forge 面板列出该命令打印的 pull request 时，迁移即已生效。
