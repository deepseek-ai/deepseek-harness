# Agent Note: 运行中插件 Config 检查取代 Host Builtin provider

Status: implemented

[English](2026-09-21-live-config-inspect-provider.md) | 中文

## Problem

创造模式的 agent 为已安装插件编写 `config:` 行时，没有任何运行时的 Config schema 来源。CLI 的 `--dump-config-schema` 参考在运行中的会话里不可达，而 `Builtin` Host 检查 provider 宣告的是模型已无法定义的动态 Host half 的沙箱符号。

## Decision

`@deepseek-ai/dsh-tool-cordis/host` 注册 `Config` 检查 provider，不再注册 `Builtin` provider。`Config.listConfigs` 读取运行中的 Loader 树：无输入时返回每个 entry 的 id、插件名和 Config 状态；给定 entry id 时，通过 app-boot 的投影器把该 entry 的原生 Schemastery Config 投影为一份自包含的 JSON Schema 文档。未激活的 entry 报告 `inactive` 且不带 schema。

provider 遍历 `ctx.loader.entries()` 和每个 fiber 的运行时 Config，而不是运行免启动的收集器，因为运行中的 profile 已持有收集器要安装且禁止重叠的模块解析拦截。app-boot 为此导出投影器、原生 schema 判定和共享的 `loaderExpression` 定义；CLI dump 保留其 profile 组合语义。

## Alternatives considered

**在 Host 内重跑 `generateConfigSchema`。** 它会在第二层拦截下重新导入每个插件模块，而收集器禁止在已安装拦截时重叠，并且它描述的是 profile 文件而非已挂载的树。

**让出货的 skill 去运行 CLI dump。** 它需要 agent 的 shell 里有 profile 名和 PATH 上的 `dsh` 可执行文件，会话都不保证，而且输出无界。

## Consequences

agent 可以在编写 patch 前读取已挂载插件的 Config schema。运行时生成的 Agent preset 树仍在 Loader 之外，不会被列出。Client 的 `Builtin` provider 不变：Client 插件代码仍运行在它所描述的浏览器模块加载器中。
