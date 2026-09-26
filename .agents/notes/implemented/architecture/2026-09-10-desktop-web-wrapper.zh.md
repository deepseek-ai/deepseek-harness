# Agent Note: 通过共享 Web 应用运行 Desktop

Status: implemented

[English](2026-09-10-desktop-web-wrapper.md) | 中文

[Electron 运行时决策](2026-09-11-desktop-electron-node-runtime.zh.md)替代独立上游 Node 可执行文件的选择；本文其他决策仍然适用。

## Problem

独立的 Desktop 组合与请求传输需要分别维护配置、模块加载、流式响应与资源服务行为。即使共享渲染界面，这些实现也可能遗漏 Web 功能。Desktop 需要独立安装与原生控件，但不需要第二套应用后端。

## Decision

私有 Desktop Host 针对独立归属的 Desktop profile 调用 CLI 的共享 profile runner。完整 Web 组合负责认证、HTTP 路由、客户端资源、RPC 与响应流。Electron 在子进程就绪前加载打包静态 Web 资源。子进程 IPC 承载就绪、结构化启动注入与关闭。[立即显示窗口决策](2026-09-09-desktop-immediate-window-and-direct-start.zh.md)规定本地文档 HTTP 转发与认证 WebSocket 访问；Web 保留应用分派与流帧处理。

共享 runner 负责 profile 与 Harness-home patch、代理设置、遥测默认值、runtime resolution、配置重载和应用生命周期。Desktop 从共享 Web 模板初始化 profile，并在主应用中使用其插件管理器。Electron 负责窗口、菜单、原生目录选择、恢复和发布更新。

[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)保留独立运行时与插件存储、内置 pnpm，以及明确的包归属。公开 CLI 继续拒绝保留的 Desktop profile。Electron profile 准备和原生恢复在 Host 不可用时仍可执行。

独立包归属防止 CLI 与 Desktop 修改彼此的安装，不代表 Desktop 采用更严格的插件策略。Desktop 将 registry、store、Git、tarball、本地路径及普通包安装交给 pnpm，并遵循正常用户与 profile 配置。Host 继承 `NODE_OPTIONS`、`NODE_PATH` 及 npm/pnpm 环境变量。用户构建配置决定哪些依赖生命周期脚本可以执行。这以 Web 使用的相同包管理器和加载器职责取代 Desktop 专用的来源、环境及构建限制。

共享 Web 插件管理器负责安装、激活、错误和重启要求。Electron 不提供独立插件管理渲染器、preload、shell 资源路由、插件 IPC 或包变更执行器。打包明确选择主入口和应用 preload，避免旧构建产物重新带入已删除的桥接。

共享 `initProfile` 创建缺失的 profile 文件并保留现有内容。Host 通过 `createRuntimeResolution` 计算 runtime resolution，并通过 `PluginPackages` 安装它，不写入 fallback 链接。pnpm 管理的目录保持优先。Desktop 不维护第二套运行时状态、锁文件哈希或链接协调机制。

本记录部分取代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)中的私有组合与无端口传输。该设计避免监听端口，并使用分帧字节管道避免 Base64 膨胀与跨版本 V8 序列化。共享 HTTP 放弃无端口保证，将服务与认证交给已有 Web 实现。发布身份、签名、进程归属及原生壳功能仍是有效决策。

本地应用的原生目录选择通过窄 preload IPC 调用 Electron 的窗口所属对话框。Main 仅接受当前应用窗口中位于 `dsh-app://app` 的主框架请求；shell、远程页面和子框架均不能调用。并发请求共用待完成的对话框，窗口销毁后丢弃选择结果。Web 后端选择和 Host 浏览由共享实现负责。

## Alternatives considered

**在 Electron 中使用 Host 操作系统选择器。** Host 的 macOS AppleScript 对话框没有 Electron 父窗口，无法可靠跟随应用焦点。Electron 负责本地对话框，Web 保留 Host 选择器；取消和错误不会启动第二个选择器。

**维护第二套后端组合与传输。** 这允许应用不监听端口，但每项 Web 路由、重载行为、认证变化和流式能力都需要 Desktop 实现或明确省略。只有无法使用 Web 实现、且足以承担持续维护成本的桌面产品需求，才支持重新引入这种方案。

**合并 CLI 与 Desktop 插件安装。** 共享启动代码不要求共享可执行依赖。独立安装允许分别验收发布与插件版本，共享会话和设置则仍由已有数据归属方负责。

**保留 Desktop 链接账本与 manifest 协调器。** 这些机制重复共享 profile 逻辑，并可能因派生元数据漂移而拒绝原本可用的安装。单一 runtime resolution 归属方可以保护 pnpm 目录，无需在插件 profile 中维护发布身份。

**保留独立原生插件管理页。** 它可以在 Web Host 不可用时运行，但重复维护包操作、渲染器 IPC、本地化和后端重启处理。原生恢复已能在没有 Host 时禁用第三方 bundle 并备份 profile patch。只有出现此恢复方式无法提供的修复操作时，才应重新引入。

**固定 registry 与 store、过滤运行时环境，并仅允许批准的插件来源。** 这些规则限制执行和包选择，却使同一用户配置在 Desktop 与 Web 中产生不同行为。独立安装归属无需这些限制仍然有用。Desktop 专用限制需要独立的产品需求，不能仅由打包或插件隔离推导而来。

## Consequences

Desktop 通过相同启动与服务路径继承 Web 功能。HTTP 监听归属与认证仍属于应用启动。Electron 使用报告的 Host 地址，并在就绪前后保留现有 Web 文档。共享 Web 加载页在 Host 启动前可用；原生恢复在启动失败时仍可用。

用户选择的运行时选项、包来源和允许的生命周期脚本可能影响 Host 执行、加载第三方代码或造成启动失败。共享 Web 管理器负责包操作失败处理；Electron 为致命启动失败保留原生恢复。签名核心运行时不为用户安装的插件代码背书。

验证需要覆盖共享 runner、认证 HTTP 资源与 API 传输、配置重载、原生目录选择、子进程关闭及插件失败恢复。安装后平台验收与真实模型 GUI 验收独立于单元测试；本记录不声称已测得启动或传输提升。
