# Agent Note: 独立的预编译 LibreOffice 包

Status: implemented
Archived: 2026-09-11

[English](2026-09-11-independent-libreoffice-package.md) | 中文

## 问题

在普通 DSH 构建中编译 LibreOffice，会要求每个贡献者和 CI job 获取工具链并重复执行大型本机构建。Desktop 也需要能随离线安装材料分发的不可变引擎资源。

## 决策

[引擎包](../../../../native/libreoffice-wasm/package.json)采用独立版本，只导出产物清单。源码目录不属于主 pnpm workspace。安装没有生命周期 hook，打包只校验已有的成功构建，不执行编译。[发布工作流](../../../../.github/workflows/libreoffice-wasm-release.yml)仅在明确调度时编译；发布要求匹配的引擎版本 tag 和受保护的 npm 环境。

每个 tarball 包含引擎清单和产物、对应的源码版本、补丁、完整源码差异，以及构建发行物的许可证和声明。打包拒绝不匹配的构建记录、被修改的产物、未列入清单的引擎文件、缺失的声明和内置字体。失败不会自动触发编译。

[本地预览决策](../architecture/2026-09-10-local-office-preview.zh.md)继续负责转换与显式产物配置。此改动建立发布机制，不向 DSH 添加尚未发布的引擎依赖。现有 [Desktop 包集合](../../../../apps/desktop/scripts/prepare-package-set.ts)仍是未来固定版本依赖及其离线 seed 的预期载体。

## 考虑过的替代方案

**在普通构建或包安装期间编译。** 即使引擎版本没有变化，每个消费方也要承担工具链可用性要求和编译开销。

**抽出通用 Node 转换库。** 字体处理、Worker 所有权和转换 API 可以继续由提供方负责。分发预编译产物及将编译与 DSH CI 隔离不需要迁移这些逻辑。

**将引擎源码链接为 workspace 依赖。** 工作区链接会把已发布的预编译包替换为缺少引擎文件的源码目录。

## 影响

引擎可以独立于 DSH 编译和发布版本。包暴露文件而非转换 API；提供方保留运行时所有权。[打包测试](../../../../scripts/libreoffice-package.spec.ts)检查普通构建不编译 LibreOffice。

首次发布和固定版本消费方接入尚未完成。与记录的配方不一致的源码树不能产生发布 tarball。首个被消费的引擎发行版必须同时完成真实引擎转换、打包安装，以及 Desktop 离线 seed 验证。
