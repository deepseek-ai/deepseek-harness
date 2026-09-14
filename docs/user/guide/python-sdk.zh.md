# Python SDK 入门

[English](python-sdk.md) | 中文

本教程安装已发布的 Python SDK，运行随附的独立极简 profile，并说明如何从自己的程序自定义同一个 `dsh` profile。

## 前置条件

- Python 3.10 或更高版本
- Git
- Linux x64、Linux arm64、arm64 上的 macOS 14 或更高版本，或 Windows x64
- DeepSeek 兼容的 API endpoint 与凭据
- 隔离的 workspace 与隔离的 Harness home

## 安装 SDK

### Linux 与 macOS

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
```

### Windows PowerShell

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
Set-Location deepseek-harness
py -3.10 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install deepseek-harness-sdk
```

安装内容包含匹配的原生运行时 wheel 与 `dsh` 命令。普通 SDK 运行不需要系统 Node.js。需要构建产物的仓库贡献者应使用 [Python 贡献者工作流](../../../python/development.zh.md)。

## 运行检入示例

导出凭据；使用兼容代理时再设置 endpoint：

### Linux 与 macOS

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
```

### Windows PowerShell

```powershell
$env:DEEPSEEK_API_KEY = "sk-your-key-here"
# $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:8000/v1"
```

使用显式 workspace 与 home 路径运行一个任务：

### Linux 与 macOS

```sh
python python/sdk/examples/minimal.py \
  --workspace /absolute/path/to/disposable-workspace \
  --dsh-home /absolute/path/to/example-dsh-home \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

### Windows PowerShell

```powershell
python python/sdk/examples/minimal.py `
  --workspace C:\work\disposable-workspace `
  --dsh-home C:\work\example-dsh-home `
  --session-id example-001 `
  "Inspect the repository and fix the failing tests."
```

脚本会打印最终 assistant 响应。所选 home 会保存生成的 `sdk-minimal` profile、已安装插件，以及 `sessions/` 下的未压缩 JSONL 会话日志。示例与 SDK 绝不会静默读取 `~/.dsh`。

## 在程序中使用 SDK

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

workspace = Path("/absolute/path/to/disposable-workspace").resolve()
dsh_home = Path("/absolute/path/to/example-dsh-home").resolve()
with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    dsh_home=str(dsh_home),
    profile="sdk-minimal",
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )

print(result.final_response)
```

SDK 会延迟启动内置的 `dsh --profile sdk-minimal` 进程，并复用到上下文管理器退出。Profile、其持久 patch、home patch 与任何有序 `patches` tuple 共同组成应用配置。不存在独立 Python 运行时 bin 或完整配置选项。

## 安装或定义插件

需要在该 home 中持久保存依赖与 bundle 层时，使用 `dsh plugin`：

### Linux 与 macOS

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh --profile sdk-minimal --dump-default-config >/dev/null
dsh plugin --profile sdk-minimal add file:/absolute/path/to/my-plugin-bundle
```

### Windows PowerShell

```powershell
$env:DSH_HOME = "C:\work\example-dsh-home"
dsh --profile sdk-minimal --dump-default-config | Out-Null
dsh plugin --profile sdk-minimal add file:C:/work/my-plugin-bundle
```

第一个命令初始化随附的独立 profile。第二个命令把包管理转发给 `pnpm`，然后记录所有导出 `dsh.bundle` 层的已安装包。只有执行此管理命令时才需要安装 `pnpm`；启动已安装 SDK 不需要它。持久配置项变更应编辑 `$DSH_HOME/profiles/sdk-minimal/cordis.patch.yml`；单次启动变更则从 Python 传入 patch 文件。

另一个 `profile` 只有包含 `@deepseek-ai/dsh-sdk-app` 或另一个 JSON-RPC server 配置项时才有效。缺失 server 配置项、无法解析的插件和非法 patch 会在启动时失败，不会回退到其他组合。

<a id="opt-in-to-str_replace_editor"></a>
### 显式启用 `str_replace_editor`

随附运行时包含 `str_replace_editor`，但 `sdk-minimal` 的默认 Cordis tree 不挂载它。要使用该工具，请将以下配置保存为 `editor.patch.yml`；`insert` 会添加 editor，以及极简 profile 缺少的文件系统后端：

```yaml
- insert:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.cwd()
    - id: tool-str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
```

构造 `DeepSeekHarness(profile="sdk-minimal", ...)` 时传入 `patches=("/absolute/path/to/editor.patch.yml",)`，或将 patch 写入 `$DSH_HOME/profiles/sdk-minimal/cordis.patch.yml` 以持久保存配置。下次运行时启动后，模型请求会在持久 shell 之外包含 `str_replace_editor`。本地文件系统后端以运行时工作目录解析相对路径；与极简 shell 一样，它不会将访问限制在该目录内。对于标准 `sdk` profile，只插入 editor 配置项，让它使用已有的文件系统后端与策略。

## 理解极简 profile

| 属性 | 值 |
|---|---|
| 系统提示词 | `DSH_SYSTEM_PROMPT`，未设置时为 `You are a helpful software engineer assistant.` |
| `minimal.py` 的模型 | `--model`，然后是 `DSH_MODEL`，最后是 `deepseek-v4-flash` |
| 面向模型的工具 | Linux／macOS 上的持久 `bash` 或 Windows 上的 `pwsh` |
| Shell 超时 | 300 秒 |
| 运行时上下文与 compaction | 不存在 |
| 会话持久化 | `<dsh_home>/sessions` 下的未压缩 JSONL |

该 profile 的唯一组合包会在空根之上插入完整配置树，且不包含 `dsh-base`，因此基础 profile 以后新增的工具不会隐式出现。它包含 SDK 协议、一个由环境配置的 DeepSeek 适配器、本地执行与持久化；文件系统工具、settings、托管凭据、遥测、Web 工具、subagent、本地指令发现和 compaction 均不存在。它固定使用 `danger-full-access`，因此按平台选择的持久 shell 可以修改运行时可见的任何路径；应使用一次性 checkout 或容器。

已安装 wheel 仍会打包完整 `web` profile 与前端产物。如果 Python SDK 部署还需要浏览器应用，请针对显式 `DSH_HOME` 运行 `dsh web`；`web` 是独立 CLI 应用，不能为 Python SDK client 提供服务。

需要隔离 profile、插件、凭据、设置与会话时，应使用新的 home。独立工作应使用新的 session id；只有继续同一段持久对话和会话资源时，才同时复用 harness、home 与 id。

[组合包参考](../../../packages/bundle/sdk-minimal/README.zh.md)定义确切配置树，[示例参考](../../../python/sdk/examples/README.zh.md)定义可运行程序。[Python SDK 参考](../../../python/sdk/README.zh.md)介绍生命周期、结果、通知与底层行为；[dsh CLI 参考](../../../apps/cli/reference/README.zh.md)介绍 profile 分层。
