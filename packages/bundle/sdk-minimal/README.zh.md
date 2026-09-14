---
description: "供需要不含共享 base bundle 的极简跨平台 coding agent（编程智能体）的用户使用的独立 SDK profile，默认提供一个 shell 工具。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-minimal`

[English](README.md) | 中文

## 概述

当 SDK 客户端需要小型、显式的 coding agent 运行时时，请使用 `dsh --profile sdk-minimal`。该 profile 默认只公布按平台选择的持久 shell，把会话持久化为未压缩 JSONL，并从 SDK 初始化请求选择模型。它提供完整 Cordis 配置树，并刻意排除 `dsh-base`、Web、settings、托管凭据、遥测、压缩（compaction）、文件系统工具、workspace 指令、skill（技能）、jobs 与 subagent。其 danger-full-access 策略允许 shell 修改进程可访问的任何路径，因此只能配合隔离 workspace 使用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

直接启动该 profile，或从 Python SDK 选择它。提供显式 `DSH_HOME`、使用一次性 workspace，并通过 `DEEPSEEK_API_KEY` 提供模型凭据。

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh --profile sdk-minimal
```

`DSH_CONTEXT_WINDOW` 为不在适配器建议目录中的模型设置后备容量。`DSH_SYSTEM_PROMPT` 替换默认 persona。SDK 初始化请求是唯一的模型选择依据，并覆盖环境默认值。

使用 `dsh plugin --profile sdk-minimal` 管理持久外部依赖。Profile、home 与有序 `--patch` 文件可以替换完整默认配置树中的配置项，或在该配置树上方插入 bundle。随附模板只在启动时应用 patch。

该 profile 只挂载一套持久 shell：Linux 和 macOS 使用 Bash，Windows 使用 PowerShell。两套配置都使用 300 秒超时与一个 agent 自有终端；另一平台的配置项保持禁用。

与其他随附 profile 一样，它统一挂载 [MCP 资源](../../mcp/mcp-resources/README.zh.md)一次。只需配置 [MCP 客户端条目](../../mcp/mcp-client/README.zh.md)即可添加服务器。其他提供方挂载的客户端也属于已配置状态。调用方作用域中未配置服务器时，MCP 不贡献提示词文本或工具，默认仍只有一个 shell 工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该 bundle 的单个 insert 就是完整应用配置树：SDK stdio 启动与 JSON-RPC 服务、一个由环境配置的 DeepSeek 适配器、显式 agent 核心、按配置启用的 MCP 资源工具、本地子进程执行、按平台选择的持久 shell PTY，以及位于 `$DSH_HOME/sessions` 的未压缩 JSONL 持久化。它不继承其他 bundle，因此每个额外配置项都是显式 profile 变更。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 完整独立 profile 配置树及其环境默认值 |
| [`src/index.ts`](src/index.ts) | Bundle 包入口 |
| — | 不发布运行时不变式伴生项；本包只是静态 patch 列表载体，插入的各行分别拥有自己的运行时关系和不变式伴生项。 |
| [`tests/sdk-minimal.spec.ts`](tests/sdk-minimal.spec.ts) | 精确组合、profile 名称与平台选择检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Python SDK 示例](../../../python/sdk/examples/README.zh.md)——从 Python 启动本 profile，并使用明确指定的 Harness home。
- [SDK 应用 bundle](../sdk-app/README.zh.md)——完整与极简 SDK profile 复用的 JSON-RPC 应用层。
- [Base bundle](../base/README.zh.md)——本 profile 刻意省略的完整产品基础。

-----

<a id="model-experience"></a>
## 模型体验

### 极简 coding agent 组合

#### 模型看到的内容

系统提示词取 `DSH_SYSTEM_PROMPT`，未设置时使用 `You are a helpful software engineer assistant.`。未配置 MCP 服务器时，对外公布的唯一工具是 Linux/macOS 上 agent 所有的持久 `bash` 或 Windows 上的 `pwsh`；运行时上下文、文件系统工具、workspace 指令、skill、jobs 控制、压缩与 Harness 身份均不存在。

#### Token 影响

默认是一个稳定 persona 加一个工具 schema。已配置 MCP 服务器会添加自己的工具、共享资源工具及可用的服务器指令。工具结果与普通对话历史随会话增长。

#### KV Cache 影响

当 persona、平台、提供方、模型与 bundle patch 栈固定时保持稳定。Profile 变更在下一个进程生效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **该组合刻意省略共享产品服务** — 需要 settings、托管凭据、策略预设、遥测、Web 工具或完整默认工具清单时，请选择 `dsh --profile sdk`。
- **用户 patch 可以扩展配置树并破坏 stdout** — profile 自定义属于受信任的应用组合；向 stdout 写入普通文本的插件会破坏 JSON-RPC 分帧。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
