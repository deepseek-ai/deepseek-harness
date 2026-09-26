# Agent Note: 内置 Desktop 运行时并保留外部插件

Status: implemented

[English](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) | 中文

插件管理和原生恢复遵循[共享 Web 薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)。

[Electron 运行时决策](2026-09-11-desktop-electron-node-runtime.zh.md)替代独立上游 Node 可执行文件的选择；本文其他决策仍然适用。

## 问题

Desktop 初始化时安装核心依赖图，会重复发布构建器已经完成的工作。离线 store 消除了下载，但仍有解压、包管理器启动和安装成本。用户需要应用在生产依赖已就绪时启动，同时保留普通 npm 插件安装能力，以及跨应用升级的插件状态。

分离的包目录可能加载重复的 Cordis 或服务模块。仅保留插件文件也不能证明它与新的宿主 API 或 Node 运行时兼容。

## 决策

[运行时准备](../../../../apps/desktop/scripts/prepare-dsh.ts)在构建时物化一次生产依赖图，并通过 `extraResources/dsh` 分发。Electron 壳保留在 ASAR 中。Electron RunAsNode 进程从资源启动私有 Desktop Host，并从 `$DSH_HOME/profiles/desktop` 加载已启用插件。

本记录负责核心资源存储与外部插件依赖。[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)保留发布身份、签名、进程归属和仅限 Electron 的插件授权。[薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)负责共享 Web 启动与 HTTP 传输。

## 包归属

资源描述文件记录精确发布版本、Node 版本、平台、架构、共享包版本和最终文件哈希。运行时树包含普通文件和目录，不包含指回 pnpm 构建 store 的链接。原生 Mach-O 文件先签名再哈希；应用签名器保留其字节，并在签名后检查清单。明确的 `dsh/node_modules` 资源映射绕过 electron-builder 对根 `node_modules` 的排除，并在任何签名或公证前验证复制后的依赖树。

[桌面文件规则](../../../../apps/desktop/scripts/runtime-file-policy.ts)在生产 npm 依赖安装之后、原生签名或描述文件生成之前执行。npm 发布列表服务于库的使用者，可以包含声明、map、测试和原生构建输入，不能直接表示桌面进程需要哪些文件。桌面副本排除声明和已识别的 source map，因为 Host 执行 JavaScript 和生成的 Typert 产物。Host 继承用户环境。已发布的 npm 包和外部插件目录保留各自的文件。源码调试导航由开发包提供。

包专用排除项包括 Domino 测试、fs-ext 编译产物、Koffi 的 Windows 导入库，以及非目标平台的 node-pty 预构建文件和调试符号。规则保留原生可执行依赖、node-pty 的 ConPTY 源分发内容、许可证和未知资源；宽泛排除 `src`、`test`、`.ts` 或 `.map` 可能移除可执行代码或运行时数据。复制测试保留哨兵资源并封存过滤后的清单；Electron 的[产物 smoke](../../../../apps/desktop/tests/fixtures/runtime-payload-smoke.mjs)验证 PTY 输出、原生文件定位、FFI、图像转换和 HTML 解析。运行时准备仍会验证每个保留字节，并携带外部插件启动完整 Host。

共享 profile runner 通过 runtime resolution 补全安装包与选中 bundle 缺失的依赖。pnpm 安装的包优先。运行时解析委托给所选包路径，因此 Host 与插件导入同一导出时共享其模块实例。不同的 ESM 与 CommonJS 条件导出仍是不同入口；运行时解析不会合并包的双重实现。

外部插件使用正常 Node 包解析。Desktop 不递归检查 peer 版本、重复包、链接包或上级目录依赖解析。这些检查重复包管理器及加载器的职责，并拒绝 pnpm 支持的安装来源。runtime resolution 提供缺失的包，但插件可以解析到另一份已安装副本；不兼容插件可能在 Host 启动时失败，需要通过独立壳 UI 恢复。

profile manifest 分别记录 pnpm 安装的依赖及已启用 bundle 列表。禁用插件保留其包、锁文件条目及用户配置。[薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)将初始化、bundle 协调和运行时模块解析交给共享 app-boot helper；Desktop 不保存独立链接账本或运行时状态身份。

## 事务与升级

首次启动创建 profile 元数据，不运行 pnpm，并保留无关文件。每次启动都从当前安装计算 runtime resolution，包括兼容的发布变化或应用移动之后。Node 版本、平台或架构变化时保留已安装插件；安装和兼容性错误由 pnpm 与加载器报告。

共享包目录使用原生规范路径识别。Windows 启动器可能改变路径大小写而不移动应用；字符串相等判断会触发不必要的 profile 准备。

共享[插件管理器](../../../../packages/boot/plugin-manager/README.zh.md)负责支持的包规格、bundle 验证、激活和安装失败处理。内置 pnpm 读取正常的用户和 profile 设置。开发模式使用相同的 Web 管理器操作独立 Desktop profile，工作区包由开发运行时提供。

共享 Web 插件管理器负责包变更和激活；Electron 保留 profile 准备和原生恢复。[Web 薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)负责这些职责。

[立即显示窗口决策](2026-09-09-desktop-immediate-window-and-direct-start.zh.md)负责直接启动 Host。Web 应用无法启动时，原生恢复对话框可禁用第三方 bundle 并备份 profile patch。已安装插件文件保留以供修复。

## 考虑过的替代方案

完整运行时验证属于打包流程。启动读取资源描述文件，并检查共享包记录及必要的 Host 入口。[发布验证决策](2026-09-09-desktop-build-release-validation.zh.md)将发布与目标兼容性检查交给打包流程。启动既不枚举已安装运行时文件，也不计算其哈希。后端加载前读取每个文件会增加与分发体积成正比的 I/O；不可用模块改由加载时失败暴露。构建时验证按记录清单拒绝内容变化、缺失、多余或链接文件。

- **启动时安装内置离线 seed。** 这保留普通 pnpm 安装流程，但会在每台受影响机器上重复核心解压与安装。物化资源消除了这部分工作，代价是更多应用文件和发布构建器责任。
- **强制插件使用 Host 依赖版本。** 这会让普通插件依赖不必要地耦合于 Host。runtime resolution 提供缺失的包，pnpm 拥有的条目保留独立版本。
- **使用硬链接。** 它不能表示目录，可能无法跨卷，共享可写字节，并在应用替换后保留旧 inode。运行时解析不需要文件系统投影。
- **使用 `NODE_PATH` 或保留软链接路径。** 它们不能提供统一的 ESM 解析或共享模块身份。runtime resolution 为 ESM 与 CommonJS 提供相同的选包结果。
- **把核心包留在 ASAR。** 普通 `extraResources` 保留原生加载和子进程路径。ASAR 需要单独验证包解析。

## 影响

首次启动和兼容升级不安装核心包。元数据检查和后端加载仍需要启动时间；没有测量前，不声称发布启动延迟或下载体积改善。插件保留以宿主 API 和原生运行时兼容为条件，条件不满足时提供可见的恢复入口。

[Desktop README](../../../../apps/desktop/README.zh.md)负责操作说明。定向测试覆盖真实 pnpm 安装与已批准构建、共享 ESM 实例身份、私有依赖版本、应用移动、停用插件、运行时变化时保留插件、激活失败和事务锁。签名安装产物升级、macOS 公证、Windows junction 与原生行为、发布体积与启动基准，以及真实模型 GUI 录制仍是发布环境验收要求；单元夹具不能替代这些验证。
