# DeepSeek Harness Python SDK

[English](README.md) | 中文

用于通过 stdio 上按行分隔的 JSON-RPC 驱动 DeepSeek Harness 的 Python 子进程 SDK。安装 `deepseek-harness-sdk` 时，会同时安装当前平台上版本完全相同的 `deepseek-harness-runtime-bin` wheel 包。

```sh
python -m pip install deepseek-harness-sdk
```

## 启动运行时

Python SDK 没有独立的应用入口。它以 `--profile sdk` 启动内置的 `dsh` CLI（命令行界面）；所选 profile 负责 JSON-RPC 服务器、agent（智能体）组合、凭据、持久化、工具和关闭流程。

每次启动都必须显式指定 Harness home。请传入 `dsh_home`，或在子进程环境中提供非空的 `DSH_HOME`。SDK 刻意不会发现 `~/.dsh`。

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    dsh_home="/absolute/path/to/isolated-dsh-home",
    cwd="/absolute/path/to/workspace",
    provider="deepseek-official",
    model="deepseek-v4-flash",
    reasoning_effort="max",
    max_tokens=49_152,
) as harness:
    result = harness.run("Say hi.", session_id="example-001")

print(result.final_response)
```

`DeepSeekHarness` 延迟启动运行时，并在调用 `close()` 或退出上下文管理器前复用该进程。首次 profile 握手通过 `initialize_timeout_seconds` 使用独立的 30 秒默认上限；普通轮次在未设置 `request_timeout_seconds` 时仍不设上限。超时诊断会指明所选 profile，并包含保留的运行时诊断。`cwd` 是 agent workspace；`runtime_cwd` 独立选择子进程工作目录。两者都会在启动前转成绝对路径。`provider`、`model`、可选的 `reasoning_effort` 和可选的正整数 `max_tokens` 通过 JSON-RPC 初始化发送。`base_url` 与 `api_key` 会显式覆盖子进程环境中的 `DEEPSEEK_BASE_URL` 与 `DEEPSEEK_API_KEY`。

## 自定义插件

持久自定义属于 `dsh` profile。使用运行时 wheel 包提供的 `dsh` 命令初始化随附的 SDK profile，并安装外部 bundle：

```sh
export DSH_HOME=/absolute/path/to/isolated-dsh-home
dsh --profile sdk --dump-default-config >/dev/null
dsh plugin --profile sdk add file:/absolute/path/to/my-plugin-bundle
```

`file:` 形式会把本地 bundle 安装到 profile 包树中，使其 peer import 可以到达内置安装后备。profile manifest（元数据清单）会记录已安装依赖与有序 bundle 层；`$DSH_HOME/profiles/sdk/cordis.patch.yml` 是持久用户 patch。只有管理外部包时，`dsh plugin` 才需要 `pnpm`。运行 SDK 不需要系统 Node.js。

对于单次调用的变更，可传入一个或多个 patch 文件。它们会转成绝对路径，并在 profile 层与 home patch 层之后按顺序传给 CLI：

```py
with DeepSeekHarness(
    dsh_home="/absolute/path/to/isolated-dsh-home",
    profile="sdk",
    patches=("/absolute/path/to/first.patch.yml", "/absolute/path/to/last.patch.yml"),
) as harness:
    result = harness.run("Make the requested code change.")
```

`profile` 可以选择另一个已存在的 profile，但该组合必须保留 `@deepseek-ai/dsh-sdk-app` 或另一个 `@deepseek-ai/dsh-sdk-jsonrpc-server` 配置项。配置错误会在 CLI 启动或 SDK 初始化时失败；不存在完整配置回退。`dsh_bin` 可以选择另一个 `dsh` 可执行程序，同时保持相同的 profile 语法。任意 argv 替换仅是内部 fake-runtime 测试适配器，不属于公开 API。

`provider` 选择指定 Cordis 组合所注册的提供方路由；`model` 是该适配器解析出的模型 ID。`reasoning_effort` 是该确切路由可选的非空适配器自有标识符；省略时保留模型自身的默认值。`max_tokens` 是一个可选的正整数，用于限制根 agent 及其进程内后代在每次请求中输出的 token 数量；省略该参数时，由提供方的默认行为决定输出上限。缺少适配器、模型不可用或推理强度不受支持时，初始化会在提示词运行前拒绝。压缩（compaction）摘要继续使用压缩插件单独配置的上限。内置默认组合注册 `deepseek-official`。自定义组合可以挂载 `llm-pi-ai`，在其中配置各提供方专属的凭据和端点，并选择 pi-ai 已安装 catalog 中存在的任意提供方／模型组合。

随附的 `sdk-minimal` profile 是独立显式配置树，而不是 `dsh-base` 上的 overlay。使用 `profile="sdk-minimal"` 选择它；普通 `model` 参数是唯一运行时模型选择，也适用于不在适配器建议目录中的模型 ID。它只提供按平台选择的持久 shell、本地执行与 JSONL 会话；文件系统工具、设置、托管凭据、遥测、Web 工具与完整默认工具清单仍由独立的完整 `sdk` 与 `web` profile 提供。

## 结果与通知

`Session.run()` 的活动区间从提示词被持久 inbox 接收时开始，到整个 agent 下一次进入空闲状态时结束，并返回 `RunResult(session_id, final_response, finish_reason, events, notifications)`。`final_response` 是该区间内根会话最后提交的助手文本。`finish_reason` 是最后一个根会话 `turn/end` 的 `kind`，例如 `completed`、`max-tokens` 或 `error`；没有轮次结束时为 `None`。缺少字符串 `data.reason.kind` 的 `turn/end` 违反协议，并会抛出 `SdkProtocolError`。

`HarnessClient` 会在运行时进程的整个生命周期内保留已发现的 subagent 谱系。在 `Session.run()` 期间，`RunResult.notifications` 与 `on_notification` 按协议顺序接收根会话和已知后代的通知。`RunResult.events` 只包含根会话事件，因此后代输出不会替换根响应。底层 `session_prompt()` 会立即返回已排队消息的 id；绕过 `Session.run()` 的调用方自行负责后续活动边界。

所选 home 保存 profile、插件与每个 profile 自有的持久资源。完整 `sdk` profile 使用其中的凭据、设置与会话存储；`sdk-minimal` 只使用自己的 JSONL 会话存储。需要隔离这些资源时应使用新的 home；独立工作应使用新的会话 ID。同时复用 harness 与会话 ID 会延续持久对话和会话资源。

另见 [Python 教程](../../docs/user/guide/python-sdk.zh.md)、[可运行示例](examples/README.zh.md) 和 [运行时 wheel 包参考](../sdk-runtime/README.zh.md)。
