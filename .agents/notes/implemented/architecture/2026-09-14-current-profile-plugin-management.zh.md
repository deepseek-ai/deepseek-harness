# Agent Note：当前 profile 插件管理共享 CLI 事务

Status: implemented

[English](2026-09-14-current-profile-plugin-management.md) | 中文

## 问题

Web 和 Agent 控件需要修改运行中的 profile，同时避免另建包安装器或覆盖用户编写的 YAML。文件监听器可能读到安装期间写入的中间 manifest，也可能在被删除插件尚未释放资源时报告成功。

## 决策

[插件管理器](../../../../packages/boot/plugin-manager/README.zh.md)与 `dsh plugin` 调用同一套异步包操作。launcher 通过纯数据 `ctx.profileContext` 提供 profile 与解析位置、启动时组合包和调用级 overlay。共享函数组合当前文件；该接口不包含回调或修改方法。CLI 与 service 修改持有 profile manifest 的写锁；[DSH HMR](../../../../packages/boot/hmr/README.zh.md) 通过同一队列串行执行模块替换、Include 刷新、profile 重新组合与管理器配置变更。HMR 在自身初始化时注册 profile 监听，等待应用就绪后再处理编辑。manifest 通知只比较有序组合包列表；仅依赖字段变化不会触发配置重载。最终 YAML 组合决定是否运行 HMR，启动器不安装回退实例。pnpm 在 `hmr.runExclusive()` 外执行；只有配置变更和 Loader 更新进入该队列。HMR 不获取包操作写锁，因此安装不会阻塞其他由文件变化触发的配置更新。每次重载重新读取 manifest、组合包层与用户 patch，同时保留调用级 overlay 的优先级。

配置监听默认使用 Chokidar 写入稳定检测。普通变化处理器会丢弃 50 ms 内的第二个事件，因此激活后立即再次写入可能让之前的组合包继续运行。稳定后交付事件会观察最终文件；文件驱动的更新承担稳定等待，直接管理器事务则不需要。回归测试通过 Chokidar 的真实规范化路径交付连续变化，验证两个状态均被应用。

profile 文件保持为持久状态：条目开关只修改最后一条符合条目 id 及模块名称断言的覆盖项中的 `disabled`，没有匹配项时追加，组合包开关修改有序字符串列表。更新依赖不会重新激活保留的已停用组合包。service 删除组合包时，先应用去掉该组合包的配置，等待旧 fiber 完成卸载后再删除依赖。已保存配置、pnpm 完成状态与运行时激活分别报告；失败的删除保留实际的部分状态与诊断路径，失败或被取消的安装则恢复它快照的 profile 文件。

这扩展了[profile 组合包决策](2026-08-05-profile-plugin-bundles.zh.md)。startup profile 保留进程组合，Desktop 包管理仍由 shell 持有。Web 控件与显式启用的 Agent 工具调用同一 service。管理操作向调用方返回结果，不向存活 Agent 添加消息。创造模式启用该 Agent 工具；base 组合包和其他内置预设默认禁用。纯浏览器 worker 预览没有宿主包安装器；其模块代理表明确拒绝 `execa` 调用，同时保留管理模块用于清单发现。

CLI 调用继承终端和认证环境；service 调用保留子进程凭据清理与有界诊断。管理结果提供错误码和参数，由 Web 词典呈现文案。重载前后比较 entry、fiber、配置与诊断：未变化的已有故障保留为警告，本次影响到的新故障使操作失败。显式启用的目标必须成功激活。

构建审批在同一个 profile 写锁内更新 pnpm 11 尚未决定的 `allowBuilds` 条目，并保留无关 YAML。授权按准确包名持久化，不采用无条件允许脚本的策略。重试只接受仍在待审批列表中的包名，因此过期请求不能覆盖后续拒绝。包清理保留审批设置，后续重试可以复用授权而不必保留部分安装的依赖。service 报告仅涉及策略的变化。Agent 工具可以代表用户授权；工具说明要求用户在对话中明确同意，而 service 仅验证待审批包名。审批拒绝 `allowBuilds` 内的锚点和别名，避免共享 YAML 节点改变未请求的权限。

## 考虑过的替代方案

**由 service 启动另一个 dsh 进程。** 这会重复生命周期协调，也无法确认当前 Loader 已完成卸载后才让 pnpm 删除文件。共享操作模块保留单一实现，同时让调用方持有各自的呈现方式。

**失败后恢复已有包。** 无法仅凭原 manifest 可靠重建包版本、依赖树和安装脚本的副作用，因此已有依赖及安装成功但激活失败的包保留原处。失败或被取消的安装只恢复 pnpm 运行前快照的 manifest 与 lockfile 文本（[引导式插件安装](2026-09-15-guided-plugin-installation.zh.md)）；已下载文件保留到下一次包操作清理为止。

**包更新时热替换源码模块。** 配置变化可以复用已加载模块缓存，替换已安装 JavaScript 则需要新的进程。替换已有依赖会报告需要重启。

## 影响

同一 profile 可以通过 CLI、Web 和工具管理，操作通过文件锁协调并保留 patch 优先级。运维人员需要根据报告的文件和诊断修复失败的包操作。startup 进程必须先停止，才能通过 CLI 删除其加载的包。管理组件受保护，不能通过 service 删除。
