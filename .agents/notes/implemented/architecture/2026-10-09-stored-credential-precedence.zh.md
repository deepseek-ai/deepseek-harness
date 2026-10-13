# Agent Note: 存储的凭据优先于启动环境

Status: implemented

[English](2026-10-09-stored-credential-precedence.md) | 中文

[Headless 环境认证](2026-10-12-headless-environment-auth.zh.md)决策部分取代本文的单次覆盖策略：随附 headless profile 不挂载存储。存储挂载时仍遵循下述顺序。

## 问题

[配置来源所有权](2026-08-04-configuration-source-ownership.zh.md) 把继承的进程环境排在 `$DSH_HOME/.credentials.yaml` 之前，并且 `credentials-local` 会拒绝对启动 shell 已导出的名字执行 `set` 和 `unset`。于是两类存储的凭据具有相反的优先级。pi-ai 的解析器先读取存储在 `llm-pi-ai/<provider>` 下的凭据记录，再读取任何环境变量，因此存储的 OAuth 授权或 `api-key` 记录会压过导出的密钥；而 Models 页面以引用形式存储的密钥会输给同名的导出变量。一次请求使用哪个凭据因此取决于提供方类别，而且只要该名字被导出，Models 页面就会禁用其密钥输入框（#5527）。

## 决策

**存储的凭据对每个提供方都优先。** `LocalCredentialProvider` 按以下顺序解析引用：

```text
$DSH_HOME/.credentials.yaml        (provider-managed, written by set/unset)
> inherited process environment    (fallback; the provider never writes it)
> <invocation cwd>/.env            (fallback; the provider never writes it)
> $DSH_HOME/.env                   (fallback; the provider never writes it)
```

保存总是写入胜出的那一层，因此 `describe` 对每个引用都报告 `writable: true`，`set` 与 `unset` 也不会因为名字已被导出而拒绝。`resolve` 与 `describe` 仍以 `source`（`file`、`env`、`project-env` 或 `user-env`）报告提供值的层。`llm-pi-ai` 中的 `authContextFrom` 先从凭据 seam、再从启动环境回答 pi-ai 的 `env()`，因此 pi-ai 解析器依次读取其存储的记录、存储的引用，再按上面的顺序读取后备来源。

配置来源所有权中的非秘密顺序与环境限制保持不变。本 Note 只替代其中的凭据优先级。

## 按次覆盖

之前的顺序让 CI、容器和一次性的 `DEEPSEEK_API_KEY=… dsh` 无需修改机器状态就能覆盖凭据。全新的 CI 或容器 harness home 中没有 `.credentials.yaml`，因此其导出的机密仍是生效值。harness home 中存有密钥，只可能是有人通过 Models 页面或直接编辑该文件存入的。要对该名字使用导出的值，用户应删除对应的 `refs` 条目，或使用单独的 `DSH_HOME` 启动。

## 考虑过的替代方案

**保持启动环境在最上层。** 它无需改动存储就能保留按次覆盖，但会保留存储记录与存储引用之间相反的优先级，而且只要启动 shell 导出了该名字，Models 页面就无法保存或替换密钥。

**只有启动环境提供该名字时拒绝写入。** 在新顺序下这样的写入会生效，因为存储值优先于环境。拒绝它会阻止为每个已导出的名字首次保存密钥，也会保留新顺序已经去掉的只读输入框状态。

**存储值遮蔽导出变量时发出警告。** 提供方需要在每次解析时比较各层，并向有意同时保留两个值的用户报告结果，例如在 shell 配置文件中为其他工具导出密钥的用户。Models 页面的帮助文本说明了该顺序，`describe` 也会报告提供值的层。

## 后果

- 留在 `.credentials.yaml` 中的密钥会覆盖同名的导出变量，包括在 harness home 存有该名字的机器上运行的 CI 机密。[升级指南](../../../../docs/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence/guide.zh.md)说明受影响的用户如何继续使用导出的账户。
- Models 页面总能保存、替换或删除密钥，也不会因名字被导出而禁用密钥输入框。
- 存储之上没有按次生效的标志。一次运行的覆盖需要使用单独的 `DSH_HOME`。
- `packages/credentials/credentials-local/tests/local.spec.ts` 覆盖在启动环境值之上存储、以及 `unset` 后恢复该值；`packages/llm/llm-pi-ai/tests/auth.spec.ts` 覆盖存储的凭据压过每个启动层。
