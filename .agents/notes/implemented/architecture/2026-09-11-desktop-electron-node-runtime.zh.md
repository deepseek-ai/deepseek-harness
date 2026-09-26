# Agent Note: 使用 Electron 作为 Desktop 的 Node 运行时

Status: implemented

[English](2026-09-11-desktop-electron-node-runtime.md) | 中文

## 问题

在 Electron 之外携带上游 Node 可执行文件会重复分发 JavaScript 运行时。Desktop 需要让 Host 和包脚本共用一个运行时，无需用户安装 Node。

## 决策

Desktop 通过自己的 Electron 可执行文件运行共享 Web Host 和内置 pnpm，并设置 `ELECTRON_RUN_AS_NODE=1`。应用不携带独立的上游 Node 可执行文件。目标 Electron 分发包同时作为打包输入，以及准备和验证生产依赖的运行时；发布元数据记录其实际 Node 版本。开发模式使用已安装的 Electron 分发包。

此决策替代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)和[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)中的独立 Node 选择。独立插件存储和普通资源目录布局仍然适用。[Web 薄壳](2026-09-10-desktop-web-wrapper.zh.md)保留共享 profile runner 和 HTTP 传输。

## 后果

Host 和 pnpm 启动时传入 `--expose-internals`：内置 Cordis 加载器使用 Node 内部 ESM 加载器，而其原生 builtin 访问器无法在 Electron 44 中找到所需符号。显式参数使加载器可用，无需修改 Cordis。RunAsNode fuse 保持启用。

Host 继承调用者的 PATH，不加入 Desktop 私有的 `bin` 目录，因此 PTC 和 agent shell 不会通过该目录解析内部启动器。`DSH_DESKTOP_NODE_EXECUTABLE` 仅为包安装注入。包脚本环境在 PATH 前添加一个小型 `node` shell 启动器，把参数转发给当前 Electron 可执行文件。这支持没有系统 Node 的 shell 生命周期脚本。Windows 上它是 `node.cmd`，并非替代的 `node.exe`；第三方代码若绕过 shell 直接启动名为 `node` 的可执行文件，必须使用 `process.execPath` 或提供自己的运行时。子进程继承 RunAsNode；worker 线程继承 Host 参数。Desktop 不模拟上游 OpenSSL 行为，也不自动重编译任意第三方原生扩展。

Electron 的 Node 补丁和原生 ABI 属于发布兼容性责任。打包原生 smoke 在 PATH 不含系统 Node 的情况下验证 pnpm shell 脚本，并验证 Windows shell 终端输出、Koffi、Sharp 和 HTML 转换。Host smoke 加载共享 Cordis 的外部插件，通过真实 Web 应用提供其路由。各平台仍需完成签名和已安装应用验收；Windows 结果不能证明 macOS 兼容性。Windows Token 签名串行执行并保留首次失败，阻止排队任务重复提交被拒绝的 PIN。

## 考虑过的替代方案

独立 Node 可执行文件可以让 Host 与 Electron 运行时分离，但会增加另一份二进制文件、下载、签名和版本选择。Electron RunAsNode 消除这一重复。将生产包移入 ASAR 是另一项涉及原生模块、包解析和子进程路径的改动；Host 继续加载普通资源文件。
