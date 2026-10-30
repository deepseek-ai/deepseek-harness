# Python SDK 示例

[English](README.md) | 中文

基于唯一应用启动器 `dsh` 的可运行 Python SDK 示例。Python 客户端负责 JSON-RPC stdio；所选 profile 负责 agent（智能体）组合、持久化、执行策略与插件。

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
- 配合支持图片输入的模型读取 PNG/JPEG/WebP/GIF 文件的 `read_image`
- 查询或修改 Session 目录的 `working_directory`

该组合包不包含 `dsh-base`，因此每一个新增配置项都是显式 profile 变更。运行时上下文、文本文件工具、本地指令发现、设置、托管凭据、遥测、Web 工具、subagent 与完整默认工具清单均不存在。配置树保留 SDK 启动与 JSON-RPC 服务、一个由环境配置的 DeepSeek 适配器、本地执行和 JSONL 持久化。[自动上下文压缩](../../../packages/bundle/sdk-minimal/README.zh.md#model-experience)通过额外模型请求生成较早历史的摘要，同时保留完整日志。这个最小组合将不支持的斜杠输入保留在普通提示词路径上。

持久 PTY 可以修改运行时进程可访问的任何路径，因此只应在一次性 checkout 或容器中使用。

<a id="compact-a-full-sdk-session"></a>
## 压缩完整 SDK Session

[压缩示例](compact.py)使用完整 `sdk` profile。它将所选工作区的 `README.md` 读入 `Session.run()` 输入，通过同一方法执行 `/compact`，随后使用保留的上下文继续提问。模型凭据和 `DSH_MODEL` 默认值与极简示例一致，并且要求显式指定 home：

```sh
python python/sdk/examples/compact.py \
  --dsh-home /absolute/path/to/compact-dsh-home \
  --workspace /absolute/path/to/disposable-workspace
```

脚本对提示词和命令均打印 `RunResult.final_response`。不成功的 `finish_reason` 会停止示例。完成和错误行为见[运行文本与命令](../README.zh.md#run-text-and-commands)；`minimal.py` 使用同一个 `run()` 入口，能力由所选 profile 提供。

<a id="change-session-permissions"></a>
## 修改 Session 权限

[权限示例](permission.py)以 `workspace-write` 为默认值启动完整 `sdk` profile，发送 `/permission <preset>`，随后在同一个 Session 中运行普通文本。请显式指定 preset：

```sh
python python/sdk/examples/permission.py \
  --dsh-home /absolute/path/to/permission-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --preset read-only
```

命令会修改 Session 的策略，而打印出的启动设置仍为 `workspace-write`。后续输入使用 Session 的当前策略。裸 `/permission` 是普通文本，未知 preset 返回命令错误。结果和状态语义见[运行文本与命令](../README.zh.md#run-text-and-commands)。

<a id="review-a-plan"></a>
## 审查计划

[计划示例](plan.py) 通过 `run()` 发送 `/plan <task>`，并在这次调用中保持 Session 通知订阅和问答处理器运行，直到计划活动结束。输入 `a` 批准、`k` 提供反馈、`d` 关闭；取消或作答前遇到 EOF 会关闭审查。批准后模型可以从后续步骤开始实施，因此应选择隔离的工作区。

```sh
python python/sdk/examples/plan.py \
  --dsh-home /absolute/path/to/plan-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  "Plan the requested change and present it for review."
```

原生计划通过 `exit_plan_mode` 携带，而不是写入工作区文档。权限仍为 workspace-write。关闭审查会保留计划模式并结束当前轮次。示例通过 `run()` 等待，并报告根轮次截断或失败；问答回调独立于协议读取线程。等待输入时也可以通过 Ctrl+C 结束示例。

管道答案使用父进程的 stdin 编码，后续行保留给后续问题。UTF-16 和 UTF-32 输入须明确指定小端或大端编码。EOF 处截断的字符会作为输入错误报告。

<a id="run-a-goal"></a>
## 运行目标

[目标示例](goal.py) 提交 `/goal <objective>`，打印目标变化和助手回复，并在终态目标事件后等待最后的回复。示例使用完整 SDK profile 和 workspace-write 权限。

```sh
python python/sdk/examples/goal.py \
  --dsh-home /absolute/path/to/goal-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  "Calculate 17 * 19, verify the result, and complete the goal without changing files."
```

`--timeout-seconds` 必须是有限正数，用于限制首次命令等待及之后的观察时间，默认为 300 秒。超时会报告失败并关闭运行时，不会将目标标记为完成。恢复会话后可查看持久化目标，再显式恢复执行。`run()` 包含自动轮次及最后回复。

## 通过审批管理完整 profile 的插件

[`manage_plugins.py`](manage_plugins.py) 先显式下载可选创作运行时，再以 `workspace-write` 权限和 stdio 审批启动完整 `sdk` profile。它显示每次请求的操作，只有输入 `y` 才批准一次，其他回答均拒绝。准备好的 Node/pnpm 可在没有系统 pnpm 时执行包操作。下载该载荷也会准备其中的 Python 库和 Office skills。

```sh
python python/sdk/examples/manage_plugins.py \
  --dsh-home /absolute/path/to/example-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  "Install and enable the bundle at /absolute/path/to/my-plugin-bundle."
```

当前进程保留原有插件。收到 `restart-required` 后，使用相同 home 重新运行示例以加载已保存的配置。删除仍被当前启动组合使用的组合包，需要先停止该运行时，再使用 `dsh plugin`。

## 添加插件

对同一个显式 home 使用运行时 wheel 包提供的 `dsh` 命令，以进行持久 profile 变更：

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh plugin --profile sdk-minimal add file:/absolute/path/to/my-plugin-bundle
```

在该命令中使用 `sdk-minimal` 可扩展本示例，使用 `sdk` 则扩展基于完整 base 的 SDK profile。Python 调用也可以在 `patches=(...)` 中传入更多绝对 patch 路径；后面的文件优先。所选 profile 必须保留 `@deepseek-ai/dsh-sdk-app` 或另一个 JSON-RPC server 配置项。该示例不接受完整 Cordis 文件或任意进程 argv。

同一个运行时 wheel 包还打包了供直接 CLI（命令行界面）使用的 `web` profile 及其前端产物：`dsh web` 会启动这个独立应用。Python SDK 客户端不能选择 `web`，因为其中没有 JSON-RPC 服务器配置项。

另见 [Python SDK 教程](../../../docs/user/guide/python-sdk.zh.md) 与 [SDK 参考](../README.zh.md)。
