# Agent Note: 每个平台使用一个 Office 引擎

Status: implemented

[English](2026-09-15-platform-office-engines.md) | 中文

## Problem

在可用的原生引擎之外安装 WASM，会为应用下载和安装资源增加第二份 LibreOffice 载荷。[独立 kit 归属](2026-09-14-independent-libreoffice-kit.zh.md)中最初的回退策略要求固定平台的 Desktop 和 Python 分发物也携带这份额外载荷。

## Decision

Harness 从已安装 kit API 的 `optionalDependencies` 中选择一个引擎。声明了 `@deepseek-ai/libreoffice-kit-${platform}-${arch}` 的目标要求该原生包，其余目标要求共享 WASM 包。受支持的原生目标集合由 kit 发布版本决定，不由 Harness 中的操作系统分支决定。已声明的原生包缺失表示安装不完整，不会改选 WASM。provider 不直接依赖 WASM。

Python sidecar 组装仅复制所选引擎及其依赖闭包。wheel 打包和运行时查找依据同一份 kit 清单选择；迁移目录后的转换冒烟检查所选后端。Desktop 在签名和完整性封装前将 npm 安装结果过滤为该引擎。引擎编译、解析器兼容性、npm 平台元数据、资格验证与发布仍由 kit 仓库负责。

## Alternatives considered

**在每个原生引擎旁保留 WASM。** 这能容忍可选原生包缺失，却会增大每个支持原生引擎的分发物。固定平台分发物要求其已声明的原生引擎存在且经过测试。

**在所有平台移除 WASM。** 没有已发布原生引擎的目标仍需转换能力。共享 WASM 包为这些目标提供转换，无需引入新的原生发布目标。

**将 Python Office 伴随目录设为可选。** 运行时承载共享的 `dsh` CLI 及其 Web profile，而不只有默认 SDK profile。强制携带目标引擎使已安装 wheel 具备完整的内置 profile 集合，并在启动前报告载荷不完整。SDK 和 headless 用户也承担引擎的下载与安装体积。

## Consequences

声明了原生目标的分发物省去 WASM 资源，其余目标保留 WASM 的资源和字体要求。锁定的 kit 声明了 macOS/Windows ARM64 和 x64 原生包，因此当前 Linux 分发物选择 WASM；kit 发布版本可以新增 Linux 原生目标，无需修改 Harness 的选择规则。这不扩展 Harness 支持的发布平台。Harness 的 sidecar、wheel 和运行时解析测试覆盖已声明原生目标与 WASM 选择，包括原生包缺失。新包字节在发布前需要 kit 资格验证和匹配的依赖完整性记录。

新增引擎包标识还需要更新 `scripts/gen-third-party-notices.ts` 中的 `LIBREOFFICE_PACKAGES`、`pnpm-workspace.yaml` 中适用的 `minimumReleaseAgeExclude` 条目，以及 [kit 归属记录](2026-09-14-independent-libreoffice-kit.zh.md)中的包列表。许可证允许列表仍使用明确的包标识。

[公开 Python 发布工作流](../../../../.github/workflows/python-release.yml)拒绝任何大于等于 100,000,000 字节的 wheel。只选择一个引擎会减少载荷，但不能据此认定运行时 wheel 已满足此限制；npm 引擎发布、本地转换与 wheel 上传资格是不同的验证。
