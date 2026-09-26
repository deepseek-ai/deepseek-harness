# Agent Note: 删除仅供 fixture 使用的 app-boot 辅助函数

Status: proposed

[English](2026-09-19-retire-app-bin-boot-helpers.md) | 中文

## 问题

[App boot](../../../../packages/boot/app-boot/src/index.ts) 导出 `resolveConfigPath`，其中包含按文件名替换重放配置的逻辑，以及读取单个可选 `.env` 的 `loadEnv`。受支持的 [CLI 启动器](../../../../apps/cli/src/bin.ts) 使用 `loadLayeredEnv`；[profile boot](../../../../apps/cli/src/profile-boot.ts) 直接提供绝对路径。这两条生产路径都不调用旧辅助函数。

在 packages、apps 和 scripts 中搜索精确符号，可找到八个 fixture（测试前置数据）驱动器中的十次 `resolveConfigPath` 调用，重放模式全部传入 `undefined`。唯一非单元测试的 `loadEnv` 调用方是 [Loader 冒烟 fixture](../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts)。[快照启动器](../../../../packages/test-support/session-snapshot/src/launcher.ts) 单独拥有重放补丁选择。因此，旧辅助函数仅为 fixture 的需要保留了两个公共 API、生产中未使用的重放策略及专用测试。

[共享 app-bin 胶水代码记录](../../archived/simplification/2026-07-04-share-app-bin-boot-glue.md) 解释了最初的共享可执行入口用途。当前[单一启动器决策](../../implemented/architecture/2026-08-22-single-dsh-application-launcher.zh.md) 已替代这些受支持入口。这属于部分取代：`boot` 和明确失败处理仍有归属，归档记录保持冻结。

## 提案

从生产导出中删除 `resolveConfigPath` 和 `loadEnv`。八个 fixture 驱动器改用 Node 的 `path.resolve`。仅在需要它的 fixture 内保留读取单目录可选 `.env` 的处理，包括文件缺失与警告行为；不引入替代生产包。

删除辅助函数专用测试，并更新 app-boot 的包描述、README 配对及 `boot` JSDoc。保留 `boot`、`loadLayeredEnv`、随产品发布的 profile 组合和快照重放选择。已定位可删除 39 行生产源码/JSDoc 和约 73 行专用测试，需扣除少量 fixture 本地环境处理及内置模块导入；这是估算，尚非实现 diff。

## 考虑过的替代方案

**为底层嵌入方保留公共便利函数。** 它们可能有用，但当前 fixture 仅需要路径解析和单个可选文件读取。为这些用途维护第二套生产重放选择器及过时的 app-bin 指南，成本过高。

**将所有调用替换为 `loadLayeredEnv`。** 否决，因为分层发现、过滤和优先级不同于读取单个 fixture 本地 `.env`。名称相近不能证明行为等价。

## 验收标准

- 精确名称搜索不再发现有效的辅助函数导入或调用。十处路径替换仍为绝对路径并选择相同文件。
- 唯一加载环境的 fixture 保持文件缺失、文件存在和警告行为；删除辅助函数专用测试时不丢失保留的 boot 覆盖。
- 运行聚焦的 app-boot 和受影响 fixture 入口测试，包括所需的构建产物入口检查、随产品发布的 profile 冒烟，以及无密钥重放场景。
- 更新 README 配对及包/JSDoc 描述；运行 build、相关 hygiene、typecheck、doc-sync（文档同步门禁）和 lint。不添加兼容别名或第二个重放选择器。

## 风险

导入这些稳定前辅助函数的仓库外调用方，需要改用保留的 profile API，或自行拥有底层路径与环境策略。意外将 fixture 改为分层环境发现会改变其测试输入；必须明确保留这一差别。
