# Python 贡献者工作流

[English](development.md) | 中文

根据所需的贡献者成果选择工作流：构建运行时产物、验证 SDK、从源码运行或构建分发包。包行为分别见 [SDK 参考](sdk/README.zh.md) 和[运行时载体参考](sdk-runtime/README.zh.md)。

## 构建运行时产物

各平台可执行文件是构建产物，不检入 git。请在仓库根目录运行构建：

```sh
pnpm install
pnpm exec tsx scripts/build-exe-for-python-sdk.ts
```

所需 `lib/` 产物已存在时使用 `--skip-build`；如需选择平台，请使用 `--targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64`。每个目标都应在其原生架构上构建。产物写入 `dist-exe/`，脚本会将所选载体同步到 `python/sdk-runtime/`。Windows 会生成 `.exe` 与 `-rg.exe`；macOS 构建还会同步 `node-pty` 所需的配套 spawn 辅助程序。

## 验证 SDK

请将虚拟环境放在 `python/` 之外，安装测试组，然后运行 Python 测试套件：

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv"
uv sync --project python/sdk --group test
uv run --project python/sdk pytest
```

`python/sdk/tests/test_bundled_runtime.py` 会运行可用的内置载体；某个载体的产物尚未构建时，会跳过该载体。仓库级测试政策见 [测试](../docs/testing.zh.md)。

该套件面向的是伪造的运行时对端。`scripts/smoke-python-runtime.py` 面向打包运行时。必需的 `python-runtime` CI 任务会构建每个已发布原生目标，把匹配的 SDK wheel 包与运行时 wheel 包安装进新的 Python 3.10 虚拟环境，在 checkout 外清除 `PYTHONPATH` 与 `DSH_RUNTIME_MODE` 后运行，证明两个模块及可执行文件都来自这些 distribution，然后运行全部 keyless 场景。聚焦的本地源码 SDK 运行可以选择一个已构建可执行文件与场景：

```sh
uv run --project python/sdk python scripts/smoke-python-runtime.py \
  --scenario sdk-minimal --exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64
```

其中三个场景会比对 `scripts/snapshots/python-sdk-single-exe/` 下已提交的期望输出。`minimal/model-visible.json` 固定 Linux／macOS `sdk-minimal` profile 所组装的系统提示词、对外公布的工具 schema 与模型可见消息；`minimal/win-x64/model-visible.json` 固定对应的 PowerShell 版本。因此，插件一旦贡献出计划外的系统分段或 user 消息，该任务即失败，且该 profile 发出的每条消息都会参与比对。`advanced/` 跨所有目标固定一个复杂进程的 SDK 结果及父／子会话日志。`restart/` 针对同一持久化根目录启动两个完整 SDK 运行时进程，并跨所有目标固定其彼此隔离的模型历史、高层结果与独立持久日志。重新运行对应场景时加上 `--update-snapshots`，并在提交前审阅该差异。

可信拉取请求还会在每个原生目标上运行 `--scenario sdk-live --installed-wheel`。该场景面向 `https://api.deepseek.com` 执行两个使用工具的轮次，从外部验证已创建文件，并在仓库密钥缺失时失败而不是自行 skip。Fork 与 Dependabot 拉取请求会运行完整的 keyless 安装后 wheel 路径，但不会获得密钥。

交互式冒烟测试需要环境变量或仓库根目录 `.env` 中存在 `DEEPSEEK_API_KEY`：

```python
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(dsh_home="/absolute/path/to/test-dsh-home") as harness:
    print(harness.run("say hi").final_response)
```

也可以导出非空 `DSH_HOME`。SDK 会拒绝可能静默使用 `~/.dsh` 的启动。

## 针对 Node 源码运行

仓库贡献者可以选择以下任一开发路径；两者都执行普通的 `dsh --profile sdk` 启动器：

- 设置 `DSH_RUNTIME_MODE=node`，在系统 Node `>=22.19` 上使用已构建的 Node 载体。构建脚本会刷新该载体，但分发物绝不会包含或自动选择它。
- 将 `dsh_bin` 设置为已构建 `apps/cli/lib/bin.js` 的绝对路径，直接验证当前 checkout 的 CLI。请显式提供 `dsh_home`，并按需提供 `profile` 与有序 `patches`。

`python/sdk/tests/manual_sdk_agent_smoke.py` 使用内部 `_launch_args` 测试适配器，通过 tsx 验证未构建的 TypeScript CLI。公开 SDK 刻意不提供任意 argv 替换。

## 构建分发包

根目录 `package.json` 的版本是两个 Python 分发包的权威版本。暂存脚本会将该版本注入两个 wheel 包，并将 SDK 固定到同版本的 `deepseek-harness-runtime-bin`。

纯 SDK wheel 包只需构建一次；每个原生平台分别构建一个运行时 wheel 包：

```sh
version="$(python - <<'PY'
import runpy

release = runpy.run_path("scripts/build-python-release.py")
print(release["pep440_version"](release["repository_version"]()))
PY
)"
python scripts/build-python-release.py --package sdk --output-dir dist-python
python scripts/build-python-release.py --package runtime --platform macos-arm64 --runtime-exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64 --output-dir dist-python
pip install \
  "dist-python/deepseek_harness_sdk-$version-py3-none-any.whl" \
  "dist-python/deepseek_harness_runtime_bin-$version-py3-none-macosx_14_0_arm64.whl"
```

运行时分发包仅提供 wheel 包。发布流水线会连同纯 SDK wheel 包一起发布五个平台 wheel 包：Linux x64、Linux arm64、macOS 14 或更高版本的 arm64 与 x64，以及 Windows x64（`win_amd64`）。只有与仓库版本匹配时，才接受 `python-v<repository-version>` 标签；`0.0.1-rc.1` 之类的仓库预发布版本在 wheel 包文件名和元数据中使用规范化的 PEP 440 写法，例如 `0.0.1rc1`。

## 验证候选发行版

手动运行 GitHub 的 `Release (Python)` 工作流并设置 `publish=false`，即可构建全部六个 wheel 包，在 Python 3.10 和 3.14 上安装 Linux 发行集合，检查精确文件名和元数据，执行 PyPI 默认单文件大小限制，并保留一份带 SHA-256 哈希的汇总产物。该运行没有注册表凭据，dry-run 运行无法进入任何发布作业。

公开发布从私有自动化仓库运行。包元数据指向独立的只读公开源码镜像，该镜像不运行发布 Actions。私有仓库把仓库变量 `PYPI_PUBLISHER_REPOSITORY` 定义为自身的 `owner/name`，并且只在有意发布期间把 `PUBLIC_PYPI_RELEASE_ENABLED` 从 `false` 改为 `true`。

独立的运行时与 SDK 作业使 SDK 上传失败后可以继续执行，而无需重新发送不可变的运行时文件。只有工作流从配置的发布仓库、匹配的 `python-v*` 标签运行，且受保护的 `pypi-runtime` 和 `pypi` 环境分别批准运行时与 SDK 作业时，才接受 `publish=true`。PyPI Trusted Publishing 仍会提供短期 OIDC 凭据，但公开 attestation 会披露私有发布仓库身份，因此将其禁用。
