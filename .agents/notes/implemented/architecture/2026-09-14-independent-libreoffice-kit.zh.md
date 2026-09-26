# Agent Note: 独立 LibreOffice kit 的归属

Status: implemented

[English](2026-09-14-independent-libreoffice-kit.md) | 中文

## Problem

LibreOffice 编译、源码补丁、平台资格验证和大型二进制发布的维护周期不同于 Harness 插件。将它们放在应用工作区会扩大常规 CI，并让引擎修复依赖 monorepo 包规则。

## Decision

`deepseek-harness/libreoffice-kit` 仓库维护可复用的 `@deepseek-ai/libreoffice-kit` Node API、Worker、字体处理、引擎选择、构建配方、补丁、测试和发布。API 不依赖 Cordis。Harness 负责将自己的 `OfficeToPdf` 服务适配到此 API，以及 Session 授权、转换生命周期、传输、Web UI 和应用打包。

kit 发布流程独立于 Harness 发布流程。kit 仓库验证并以统一版本发布 Node API 和引擎 npm 包，起始版本为 `0.0.1`。Harness 消费精确的 npm 版本，并在 `pnpm-lock.yaml` 中提交依赖解析结果；Harness 发布既不构建也不发布 kit 包。

上游 API 将平台引擎声明为可选依赖。[平台引擎决策](2026-09-15-platform-office-engines.zh.md)取代最初强制携带 WASM 回退引擎的策略。Desktop 将 kit 作为外部 npm 依赖安装。Python sidecar 将 Worker、所选引擎及其依赖闭包保留在真实文件系统中，位于可执行文件的虚拟文件系统之外。转换无需下载或 GitHub 凭据。

kit 仓库负责引擎资格验证和对应源码材料。API 和引擎携带 MPL-2.0 声明、可访问源码及再分发声明；Harness 打包时保留这些材料。再分发声明检查仅在许可为 MPL-2.0 时接受 API、WASM、macOS ARM64/x64 和 Windows ARM64/x64 的精确包标识；无关包和改变后的许可条款仍被拒绝。

## Alternatives considered

**将公开 API 和 Core 构建放在 Harness。** 这能同步源码变更，却让应用维护承担耗时的引擎构建和特殊包规则。Cordis provider 是应用集成点；可复用转换 API 应与引擎测试放在一起。

**安装前准备 GitHub Release 归档。** 这需要单独的鉴权、哈希、解压、工作区 overrides 和分发重打包。已发布的 npm 包使用应用常规的依赖安装与平台选择流程。

## Consequences

更新 kit 需要在其独立仓库验证并发布新版本，再更新 Harness 依赖版本和锁文件。必需的 npm 包缺失时安装失败；Harness 不通过编译引擎恢复。原生和 WASM 转换冒烟验证已安装的包，Desktop 与 Python 检查覆盖应用打包。
