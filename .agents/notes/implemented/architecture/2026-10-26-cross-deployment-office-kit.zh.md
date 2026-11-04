# Agent Note: 各部署共用单一 Office Kit 包

Status: implemented

[English](2026-10-26-cross-deployment-office-kit.md) | 中文

## 问题

各部署定位 LibreOffice Kit 的方式不同：转换提供方、技能和 Desktop 壳各自查找 Kit，Kit 缺失时转换配置行加载失败。没有下载 Office sidecar 的 Python SDK 可执行程序、没有原生引擎的源码检出，都属于部署缺少 Kit，而不是组合配置错误；让配置行失败会隐藏提供方和技能，而它们的大部分行为并不需要 Kit。

## 决策

[Web bundle](../../../../packages/bundle/web-app/cordis.patch.yml) 只在 Desktop 中挂载 [`skill-office`](../../../../packages/skill/skill-office/README.zh.md)，[SDK bundle](../../../../packages/bundle/sdk-app/cordis.patch.yml) 只在有主运行时时挂载，沿用[渐进式 Office 技能](2026-09-27-progressive-office-skills.zh.md)中的挂载决策。

内置 Python 环境（[`tool-workspace-dependencies`](../../../../packages/skill/tool-workspace-dependencies/README.zh.md)）只在 Desktop 以及有主运行时的 SDK 中挂载。`skill-office` 显式声明 `pythonEnvironment: 'workspace-dependencies' | 'user'`；没有主运行时启动的 Desktop profile 选择 `'user'`。默认值为 `'workspace-dependencies'`，因为旧 SDK patch 会整体替换 `skill-office` 行的 `config`；这样的 patch 不含新键，仍保留它所针对的内置环境说明。

[`@deepseek-ai/dsh-office-kit`](../../../../packages/document/office-kit/README.zh.md) 负责 Kit 定位和共享转换服务。Kit 定位是提供方的内部实现，不对外导出：提供方传入自己的 `import.meta.resolve` 查找函数，原生引擎路径使用 ASAR 解包映射。定位不读取环境变量。[按需激活的 Office 工具](2026-10-31-native-office-tool.zh.md)在 Host 内执行 Kit 操作，因此任何部署都不发布 Kit CLI 路径或 Office 可执行文件变量。

Kit 缺失时降级，而不是加载失败。转换服务照常注册，以代码 `unavailable` 拒绝转换，只保留成功的 Kit 导入，并对每种不同的失败只报告一次；`office_render`、`office_convert` 和 `office_recalculate` 工具保持注册并在调用时返回该消息。

`office-to-pdf` 改为 `office-kit`，使后续的 Kit 消费方（例如原生渲染（PR #5374）和 `tool-office` 包）从同一个包获取 Kit。LibreOffice Kit 依赖在每个清单中声明同一个精确版本，因此转换器和打包的引擎来自同一个 Kit 发行版。

## 考虑过的替代方案

**`pythonEnvironment` 默认取 `'user'`。** 这与没有主运行时启动的 Desktop 一致，但整体替换该行 `config` 的旧 SDK patch 会让有主运行时的 SDK 部署悄然改用用户的 Python。

**在定位函数中读取部署环境变量。** 这样可以去掉 `cordis.yml` 表达式，但会把部署配置藏进库中，使源码、Web、Desktop 和 SDK 的行为依赖环境变量。bundle 本来就负责部署专有的表达式。

**Kit 缺失时让转换配置行失败。** 这样能在加载时报告缺失，符合配置错误应尽早报告的规则；但缺失属于部署环境而非配置，而且会停用不需要 Kit 的预览渲染路径和依赖技能。

**保留独立的定位包。** 没有 Cordis 依赖的独立包可以让 `skill-office` 与服务隔离，但要为一个紧密耦合的组件重复维护发布、依赖策略和文档配置。提供方以外没有消费方需要定位 Kit，因此定位逻辑留在提供方内部。

## 影响

没有 Kit 的部署看到的是 `unavailable` 预览和报告 Kit 缺失的 `office_*` 工具，而不是启动失败；加载技能时不检查 Kit；之后安装的 Kit 无需重新加载提供方即可用于转换。外部组合按[升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.3/office-kit-package/guide.zh.md)从 `office-to-pdf` 配置行、`ctx.officeToPdf` 和 `officeToPdf/*` Remote 方法迁移到 `office-kit` 包。

从 Desktop 内置终端启动的进程会继承 `DSH_PRIMARY_RUNTIME`，因此 SDK 使用其内置环境。Desktop 壳不发布 Kit 位置；子应用自行解析自己的 Kit。

验证覆盖从提供方 Kit 入口查找 Kit（[kit-lookup.spec.ts](../../../../packages/document/office-kit/tests/kit-lookup.spec.ts)）、引擎解析与 ASAR 解包路径映射（[engine-package.spec.ts](../../../../packages/document/office-kit/tests/engine-package.spec.ts)）、按 Kit 安装独立解析引擎（[anchors.spec.ts](../../../../packages/document/office-kit/tests/anchors.spec.ts)）、Kit 缺失或无法加载后的转换重试、去重后的警告、Kit 缺失时 `office_*` 工具的 `unavailable` 结果，以及 Office profile 端到端测试。
