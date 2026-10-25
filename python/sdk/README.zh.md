# DeepSeek Harness Python SDK

[English](README.md) | 中文

用于通过 stdio 上按行分隔的 JSON-RPC 驱动 DeepSeek Harness 的 Python 子进程 SDK。安装 `deepseek-harness-sdk` 时，会同时安装当前平台上版本完全相同的 `deepseek-harness-runtime-bin` wheel 包。

```sh
python -m pip install deepseek-harness-sdk
```

## 可选 Office 操作

显式下载 Office 运行时后，即可调用本地 API，无需 agent、Session、模型请求、API key 或 Harness home：

```py
from deepseek_harness_runtime import download_office
from deepseek_harness.office import convert, recalculate, render_images

download_office()
pdf = convert("report.docx", "report.pdf")
workbook = recalculate("forecast.xlsx", "calculated.xlsx")
preview = render_images("report.docx", "report-preview", pages=[1])
```

输出文件或图片目录必须不存在。调用方拥有成功输出；Kit 删除失败输出。`OfficeOptions` 提供操作限制和字体偏好。结果包含类型化路径、缺失字体和图片元数据。`OfficeError` 保留 CLI 失败代码；无效结果抛出 `SdkProtocolError`。重算不验证业务逻辑或 Excel 兼容性。Ctrl+C 会等待 CLI 清理；再次中断会强制终止，可能留下未完成输出。Windows 要求绝对 `SystemRoot` 路径，并通过共享控制台传递 Ctrl+C。

创作环境可通过 `deepseek_harness_runtime.download_primary_runtime()` 独立选择。缓存选择、资源启用与下载行为见[运行时参考](../sdk-runtime/README.zh.md)。SDK 启动和 Office 操作都不会自动获取缺失资源。

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

`harness.resume_session(saved_session_id)` 恢复持久化历史，并返回可调用 `run()` 的 `Session`。请保存原会话 id，并沿用其 `dsh_home` 和工作区。恢复会保留存储的目录、修复最后一个被中断的轮次，且不发送新输入。会话缺失、不可读、不兼容或被占用时会抛出异常，不创建替代会话。`start_session(id)` 只打开惰性句柄，不会请求持久化恢复。此 API 不恢复 shell、浏览器或其他外部进程。

```py
with DeepSeekHarness(dsh_home="/absolute/path/to/saved-home") as harness:
    session = harness.resume_session(saved_session_id)
    result = session.run("Continue the task.")
```

<a id="client-approvals"></a>
## 客户端审批

此底层示例接收一次审批并拒绝。完整运行应使用专门处理请求的线程或循环：`next_request()` 会阻塞，请求处理器必须与 `session/wait` 或高层 `run()` 并行运行。仅在处理器就绪时，在 `HarnessClient.initialize()` 或 `DeepSeekHarnessConfig` 设置 `approval_requests=True`；省略时保留运行时应答链。决定只作用于单次操作；无效响应和断连会拒绝放行，取消后丢弃迟到响应。构造决定时，可用 `ApprovalRequestResult` 校验响应值。

```py
from deepseek_harness import ApprovalRequestParams, HarnessClient, HarnessConfig

with HarnessClient(HarnessConfig(dsh_home="/absolute/path/to/dsh-home")) as client:
    client.initialize(cwd="/absolute/path/to/workspace", provider="deepseek-official",
                      model="deepseek-v4-flash", approval_requests=True)
    client.session_prompt("main", [{"type": "text", "text": "Run the operation requiring approval."}])
    request = client.next_request()
    if request.method == "approval/request":
        question = ApprovalRequestParams.model_validate(request.payload)
        print(question.toolName, question.reason)
        client.respond(request.id, {"outcome": "rejected"})
    else:
        client.respond_error(request.id, code=-32601, message="Unsupported client request")
```

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

随附的 `sdk-minimal` profile 是独立显式配置树，而不是 `dsh-base` 上的 overlay。使用 `profile="sdk-minimal"` 选择它；普通 `model` 参数是唯一运行时模型选择，也适用于不在适配器建议目录中的模型 ID。它提供按平台选择的持久 shell、`read_image`、`working_directory`、本地执行、JSONL 会话和自动压缩。文本文件工具、设置、托管凭据、遥测、Web 工具与完整默认工具清单仍由独立的完整 `sdk` 与 `web` profile 提供。SDK 提示词文本不会执行 `/compact`。

## 原生用户问答

向 `DeepSeekHarnessConfig`、`DeepSeekHarness` 或 `HarnessConfig` 传入 `on_user_question`，即可通过原生 SDK 协议回答内建的 `ask_user_question` 工具。回调接收 `UserQuestionRequest`（包含 `request_id`、`session_id` 和原始 `questions`）以及表示取消的 `threading.Event`。返回 `UserQuestionAnswer`，或形如 `{"answers": [{"id": "question-id", "selected": ["option label"], "custom": "optional free text"}]}` 的 JSON 对象。每个原问题 id 必须恰好出现一次。应用自行提供 UI 或模拟用户策略；SDK 不选择答案。

回调在独立线程执行，读取线程仍可处理取消和其他请求。回调可以并发执行，也可以再次调用客户端请求。取消 Event 置位时应释放回调拥有的工作。客户端关闭会通知所有待决回调，并给其工作线程总计 0.5 秒的 join 窗口；忽略取消的回调可能继续执行，但晚到答案不会发送到运行时或后续新进程。回调异常转为协议错误；未提供回调时保留原生回答方，或报告 `NO_PROVIDER`。

## 结果与通知

`Session.run()` 的活动区间从提示词被持久 inbox 接收时开始，到整个 agent 下一次进入空闲状态时结束，并返回 `RunResult(session_id, final_response, finish_reason, events, notifications)`。`final_response` 是该区间内根会话最后提交的助手文本。`finish_reason` 是最后一个根会话 `turn/end` 的 `kind`，例如 `completed`、`max-tokens` 或 `error`；没有轮次结束时为 `None`。缺少字符串 `data.reason.kind` 的 `turn/end` 违反协议，并会抛出 `SdkProtocolError`。

`HarnessClient` 会在运行时进程的整个生命周期内保留已发现的 subagent 谱系。在 `Session.run()` 期间，`RunResult.notifications` 与 `on_notification` 按协议顺序接收根会话和已知后代的通知。`RunResult.events` 只包含根会话事件，因此后代输出不会替换根响应。底层 `session_prompt()` 会立即返回已排队消息的 id；绕过 `Session.run()` 的调用方自行负责后续活动边界。

所选 home 保存 profile、插件与每个 profile 自有的持久资源。完整 `sdk` profile 使用其中的凭据、设置与会话存储；`sdk-minimal` 保存 JSONL 会话，将图片存储在 `$DSH_HOME/attachments/v1` 下，请求图片缓存位于 `$DSH_HOME/cache/attachments` 下。需要隔离这些资源时应使用新的 home；独立工作应使用新的会话 ID。同时复用 harness 与会话 ID 会延续持久对话和会话资源。

另见 [Python 教程](../../docs/user/guide/python-sdk.zh.md)、[可运行示例](examples/README.zh.md) 和 [运行时 wheel 包参考](../sdk-runtime/README.zh.md)。

`Session.get_working_directory()` 读取有效工作目录；`set_working_directory(path)` 修改目录并返回校验后的绝对路径。两者都可创建未知 Session，而不运行模型轮次。相对路径以该 Session 当前目录解析。起始目录元数据、权限与已有进程保持不变。底层客户端提供同名方法，并以 `session_id` 作为首个参数。
