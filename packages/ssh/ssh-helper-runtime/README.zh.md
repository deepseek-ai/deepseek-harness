---
description: "构建并验证内嵌 Node 运行时的 Linux 与 macOS SSH helper 可执行文件。"
kind: "package-library"
---

# @deepseek-ai/dsh-ssh-helper-runtime

[English](README.md) | 中文

## 概述

远端机器无须安装 Node 或 npm 包即可运行 SSH helper。每个发行包都包含可执行文件、原生资源和完整性元数据。这个私有载体通过既有 SSH 提供方支持托管进程、终端、沙箱和内嵌 PTC worker。项目命令仍使用远端机器自身的开发工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 构建与安装

这个私有工作区生成发行压缩包，不是配置插件或 npm CLI。在已安装依赖的源码目录中构建当前原生平台：

```sh
pnpm exec tsx scripts/build-exe-for-ssh-helper.ts
```

构建器需要 Node 24、C/C++ 编译器和该 Node 安装附带的开发头文件。Linux 还需要 `musl-gcc`，其 node-pty 扩展必须满足 glibc 基线。[原生构建工作流](../../../.github/workflows/build-exe-for-ssh-helper.yml) 在打包前准备兼容扩展。`--target` 选择一个原生目标，`--skip-build` 复用已准备的 JS／原生输出，`--dry-run` 校验目标与依赖声明而不构建。

| 目标 | 原生发行包 | 检查的部署基线 |
|---|---|---|
| `node24-linux-x64` | `linux-x64` | glibc 2.28 |
| `node24-linux-arm64` | `linux-arm64` | glibc 2.28 |
| `node24-macos-x64` | `macos-x64` | macOS 14 部署目标 |
| `node24-macos-arm64` | `macos-arm64` | macOS 14 部署目标 |

产物位于 `dist-exe/ssh-helper/`。每个 `dsh-ssh-helper-<version>-<platform>-<arch>.tar.gz` 都有配套的 `.sha256` 文件。压缩包包含 `dsh-ssh-helper`、`native/system/`、许可证和 `manifest.json`，macOS 还包含 `dsh-ssh-helper-spawn-helper`。清单记录源码提交、源码树是否存在未提交修改、内嵌 Node 版本、协议，以及每个产物文件的摘要和权限。

验证压缩包摘要后，将整个目录解压到项目及被替换的临时挂载之外的版本化运行时位置。原生资源须与可执行文件保持相对位置。安装目录可以只读，但 helper 用户需要可写的临时／缓存位置。为 [`dsh-ssh`](../ssh/README.zh.md) 配置 `launch: { kind: "executable" }`、绝对 `helper` 路径，以及清单中可执行文件的 SHA-256。客户端通过 `ctx.ssh.ptcLaunch` 获取内嵌 PTC 启动方式。

### 验证与发布

[产物验证器](../../../scripts/verify-ssh-helper-artifact.ts) 接受 `--archive` 和可选的 `--report` 路径。它校验并移动解压后的发行包，将安装文件设为只读，再运行两个共享全新原生缓存的并发 Loader 组合。这些组合通过 SSH 提供方验证文件、进程、PTY、原生 flock 和 PTC。macOS 还在拒绝访问源码目录和宿主 Node 的策略下运行 worker。`--sandbox=required` 要求真实隔离；Linux 额外的 `--backend=landlock-run` 检查使 bwrap 探测不可用，并要求使用包内 Landlock 启动器。

[OpenSSH 验证器](../../../scripts/verify-ssh-helper-ssh.ts) 接受 Linux `--archive`。它创建未安装 Node 的临时 glibc 2.28 SSH 服务器，仅挂载发行包和一次性公钥，并验证生产连接。这个可移植性测试不声明内核隔离能力，该检查由原生主机测试负责。测试身份、主机密钥、端口和工作区均由本次运行独占。

普通 PR 和 master CI 运行源码及构建脚本检查，不构建 SSH 可执行文件。修改 helper 启动、原生依赖或打包逻辑时，应在合并前手动运行[原生工作流](../../../.github/workflows/build-exe-for-ssh-helper.yml)；它支持指定目标，默认构建全部四个平台。`CI master` 也提供手动 `ssh-helper` 测试入口。[Release (SSH helper)](../../../.github/workflows/publish-ssh-helper.yml) 默认为 `publish=false`：从选定 ref 构建四个平台，并校验干净源码构建提供的同一提交完整验证证据。设置 `publish=true` 时，必须选择匹配的 `dsh-v<version>` 标签，工作流将已测试的压缩包及 `SHA256SUMS` 附加到对应 GitHub Release；Release 不存在时创建草稿。发布前仍须通过原生运行验证。仅检查部署目标不能证明已在最低 macOS 版本上运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

载体通过仓库带补丁的 `pkg --sea` 流程内嵌完整依赖集合。入口分派 SSH helper、托管子进程启动器或 PTC worker。共享的[部署函数](../../../scripts/executable-packaging.ts) 也用于 Python SDK 构建器。生产部署会在调用构建工具前恢复开发依赖安装状态，避免 pnpm 的自动依赖检查将它们删除。

操作系统必须从真实文件执行 Landlock 和 PTY 启动器。进程内的解析钩子将 system 包指向随包分发的原生目录；node-pty 使用其既有的相对可执行文件定位 spawn-helper 的约定。二进制检查在打包前覆盖内嵌原生模块，并在发布前覆盖外部资源。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 连接](../ssh/README.zh.md) — 鉴权、启动与生命周期。
- [PTC Node 运行时](../../ptc-runtime/ptc-runtime-node/README.zh.md) — 显式 worker 启动与执行限制。
- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 远端执行坐标。

-----

<a id="model-experience"></a>
## 模型体验

None，因为这个私有进程载体不注册面向模型的工具或提示内容，操作结果由其消费方负责。

#### KV Cache 影响

载体不添加请求前缀内容。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 构建目标不包含 Windows 和基于 musl 的 Linux。沙箱可用性仍取决于目标内核和系统工具。
- 自动下载、部署、更新和连接 UI 独立于发行包生产。
- 可执行文件接受私有 worker 调用，不接受任意 Node CLI 参数。项目中的 `node` 命令和嵌套 JavaScript 子进程需要单独安装 Node。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
