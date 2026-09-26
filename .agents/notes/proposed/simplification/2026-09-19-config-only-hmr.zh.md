# Agent Note: 将 DSH HMR 限定为实时 profile 配置更新

Status: proposed

[English](2026-09-19-config-only-hmr.md) | 中文

## 问题

[DSH HMR](../../../../packages/boot/hmr/src/index.ts) 同时拥有串行 profile 配置刷新和运行中的 JavaScript 模块替换。模块替换增加了 Node loader 内部接口、依赖遍历、缓存备份、新旧插件 fiber、回滚、模块监听与导入错误格式化。[基础组合](../../../../packages/bundle/base/cordis.patch.yml) 使用 `root: []`；其他随产品发布的 profile 禁用或省略 HMR（热模块替换）。默认产品需要配置刷新，而源码替换服务于自定义 profile 的显式启用。

该选项是真实受支持的行为：[profile 测试](../../../../apps/cli/tests/profile-hmr.spec.ts)、模块测试和[构建后 CLI 测试](../../../../apps/cli/tests/built-bin.e2e.ts) 都覆盖它，生成的检查 API 也展示其方法和事件。本提案以开发连续性换取更小的维护子系统，并不将代码判定为不可达。

## 提案

保留 `watchConfig`、`runExclusive`、精确的 profile/home 补丁与 manifest（元数据清单）监听、应用就绪协调、串行刷新和释放排空。源码模块、任意 Include 和框架依赖的修改要求重启进程；删除框架变化时对 `loader.exit()` 的自动调用。浏览器 Client 加载保持独立。

删除模块监听与分发、依赖图分析、模块缓存/fiber 替换与恢复、仅供模块使用的状态/选项、`baseDir`、`getOuterStack`、`getLinked` 及 `hmr/change`/`hmr/reload`。删除[导入错误格式化器](../../../../packages/boot/hmr/src/error.ts)、仅供模块使用的依赖和模块/错误专用测试。保留 Chokidar 及[精确监听](../../../../packages/boot/hmr/src/watch-config.ts) 实际使用的配置监听选项。已定位约 400 行源码和 372 行专用测试属于可删除模块路径；实现时必须单独计算保留的配置代码和混合测试。

仅修改[profile 管理决策](../../implemented/architecture/2026-09-14-current-profile-plugin-management.zh.md) 与[单一启动器决策](../../implemented/architecture/2026-08-22-single-dsh-application-launcher.zh.md) 中承诺模块替换及其协调的部分。其配置、安装与启动器职责保留。[非事务式 Loader 决策](../../implemented/simplification/2026-09-09-nontransactional-loader.zh.md) 为避免重复回滚提供理由，但尚未授权撤回源码 HMR。

## 考虑过的替代方案

**保留可选源码替换。** 插件作者可以在不重启活动 Session 的情况下编辑代码，失败替换会恢复旧插件。这项能力有价值；本提案有意放弃它，以移除 DSH 对 loader 版本的耦合及替换状态所有权。

**仅删除回滚或将替换委托到别处。** 部分删除可能让缓存模块和活动 fiber 属于不同代。包装另一个 HMR 实现仍保留公共行为及协调负担。这两种方式都不能实现此处提出的完整删除。

## 验收标准

- 实时 profile/home 补丁与组合包列表变化、Plugin Manager 串行化、就绪、自身移除、释放排空及后续有效编辑后的恢复仍有覆盖。
- 源码和任意 Include 修改在重启后生效。删除的源码选项给出明确迁移/配置错误；更新随产品发布的 `root: []` 项，不静默忽略过时选项。
- 删除仅供模块使用的 API、事件、依赖、生成声明与测试。保留剩余公共队列/监听 API，以及包安装/重启语义。
- 运行聚焦的 HMR 配置/监听/协调及 Plugin Manager 测试、app-boot 重载覆盖与真实构建后 CLI（命令行界面）profile 刷新场景。将源码替换预期改为已同意的重启行为，并更新所需的组装快照与文档。

## 风险

自定义 profile 和已安装插件会失去实时服务端代码替换及其失败恢复。重启可能中断长时间开发工作，因此接受该提案需要同意此产品取舍。删除共享配置协调，或在另一个包重建源码替换，都会违背提案目的。
