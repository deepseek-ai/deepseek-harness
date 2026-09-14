# Python SDK 示例

[English](README.md) | 中文

基于唯一应用启动器 `dsh --profile sdk-minimal` 的可运行 Python SDK 示例。Python 客户端负责 JSON-RPC stdio；profile 负责 agent（智能体）组合、持久化、执行策略与插件。

## 运行极简 agent

安装 `deepseek-harness-sdk`、导出模型凭据，然后提供隔离的 Harness home 与 workspace：

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
python python/sdk/examples/minimal.py \
  --dsh-home /absolute/path/to/example-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

如需使用兼容代理，请设置 `DEEPSEEK_BASE_URL`；可通过 `DSH_MODEL` 设置脚本的默认模型，通过 `DSH_SYSTEM_PROMPT` 指定部署角色设定。`--model` 是唯一运行时模型选择，不要求匹配的环境变量；`--profile` 可以选择另一个提供 SDK 服务的 profile。所选 home 保存生成的 `sdk-minimal` profile，并在 `sessions/` 下保存未压缩 JSONL 会话日志；脚本绝不会隐式读取 `~/.dsh`。

随附的 [`@deepseek-ai/dsh-sdk-minimal` 组合包](../../../packages/bundle/sdk-minimal/README.zh.md) 是该模式完整且显式的 Cordis 配置树。它只暴露：

- Linux／macOS 上所有者作用域内的持久 `bash`，或 Windows 上的 `pwsh`

该组合包不包含 `dsh-base`，因此每一个新增配置项都是显式 profile 变更。运行时上下文、文件系统工具、本地指令发现、压缩（compaction）、设置、托管凭据、遥测、Web 工具、subagent 与完整默认工具清单均不存在。配置树保留 SDK 启动与 JSON-RPC 服务、一个由环境配置的 DeepSeek 适配器、本地执行和 JSONL 持久化。

持久 PTY 可以修改运行时进程可访问的任何路径，因此只应在一次性 checkout 或容器中使用。

## 添加插件

对同一个显式 home 使用运行时 wheel 包提供的 `dsh` 命令，以进行持久 profile 变更：

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh plugin --profile sdk-minimal add file:/absolute/path/to/my-plugin-bundle
```

在该命令中使用 `sdk-minimal` 可扩展本示例，使用 `sdk` 则扩展基于完整 base 的 SDK profile。Python 调用也可以在 `patches=(...)` 中传入更多绝对 patch 路径；后面的文件优先。所选 profile 必须保留 `@deepseek-ai/dsh-sdk-app` 或另一个 JSON-RPC server 配置项。该示例不接受完整 Cordis 文件或任意进程 argv。

同一个运行时 wheel 包还打包了供直接 CLI（命令行界面）使用的 `web` profile 及其前端产物：`dsh web` 会启动这个独立应用。Python SDK 客户端不能选择 `web`，因为其中没有 JSON-RPC 服务器配置项。

另见 [Python SDK 教程](../../../docs/user/guide/python-sdk.zh.md) 与 [SDK 参考](../README.zh.md)。
