# Desktop 本地更新验证

[English](README.md) | 中文

## 概述

本地下载和强更弹窗证据与生产后端联调、视觉验收、已安装应用升级分开记录。运行 [Desktop README](../README.zh.md) 中的命令可生成新的隔离报告。

已安装应用验收可显式启用 `DSH_DESKTOP_UPDATE_JOURNAL_DIR`，使用安装目录树之外、两个版本共同保留的绝对路径。每个主进程将已安装版本、状态转换和人工操作标记刷新到单独的 JSONL 文件。原始诊断和请求数据被排除；存储错误会向上传播。[日志决策](../../../.agents/notes/implemented/testing/2026-09-14-desktop-installed-update-journal.zh.md)定义证据的局限。单元与主入口测试覆盖该日志；签名安装版升级仍未验证。

## 目录

- [原生浮层可见性](#verification-overlay)
- [验证证据](#verification-evidence)
- [手动演练](#verification-interactive)
- [待验证事项](#verification-open)

<a id="verification-overlay"></a>

## 原生浮层可见性

在 macOS 上，编译 Desktop Host 源码后复用缓存的 Electron 运行时：

```sh
pnpm exec tsc -b apps/desktop/tsconfig.host.json
apps/desktop/.desktop-build/targets/mac-arm64/electron/Electron.app/Contents/MacOS/Electron apps/desktop/tests/fixtures/update-overlay-visibility.mjs
```

夹具使用独立 profile，在 `.desktop-build/qualification/update-overlay-*` 下写入 `result.json`。它对照所属测试目录中的预期输出，检查父窗口隐藏／显示、父窗口隐藏期间文档就绪两种顺序中的原生可见性、父页面不受模糊影响及监听清理。它不使用网络、产品登录或 dsh Host。这项验证覆盖原生窗口恢复，不覆盖完整的首次登录流程。

<a id="verification-interactive"></a>

## 手动演练

实际安装、启动后发布、失败重试与重启证据使用[已安装应用更新人工清单](installed-update/README.zh.md)。下方交互式运行器拦截安装，属于另一类验收。

Host、客户端与 Desktop 产物构建完成后，在 Windows 仓库根目录运行 `node --import tsx apps/desktop/scripts/test-workspace-updates.ts --interactive`。真实工作区持续打开，并提供独立控制窗口。其菜单可选择普通或强制更新、保持和放行下载、注入下载失败，以及添加或清空测试任务。失败模式须在开始下载前选择。确认安装并完成任务收尾后，fixture 消息提示安装器调用已被拦截；确认消息结束演练。关闭控制窗口也会退出。每次运行独占私有 profile 和回环服务器；载荷不是安装器。重新运行命令开始新一轮。省略 `--interactive` 则运行自动化场景，保留 120 秒截止时间和自动退出；交互模式下载的网络截止时间为十分钟。

<a id="verification-evidence"></a>

## 验证证据

本地命令构建 Desktop，并在 Electron 44 中运行真实 HTTP updater、策略客户端、沙箱预加载和强更页面。它记录每个场景，并把报告保存在 `.desktop-build/qualification/local-updater-*`。安装器调用、外部浏览器和剪贴板均替换为观测记录；下载字节不是可执行安装器。

打包监督 fixture 控制自己的 Git 元数据，并使用真实文件哈希和无签名行为的子进程。Git 提交或工作区变化仍会拒绝打包；并发测试不会改变该 fixture 记录的 Git 输入。

| 层次 | 观测结果 |
|---|---|
| 常规 updater | 同版本／旧版本拒绝、用户授权完整下载、SHA-512 拒绝、传输中断、清单／下载停滞截止时间、显式重试、请求合并、同地址清单替换、就绪状态和独立安装交接通过 |
| 强更策略 | 扁平化 `40005`、完整发布头、游客请求、无需强更验证、失败保留、间隔／退避、超时和 dispose（资源释放）回归通过 |
| 常规调度 | 真实协调器配合模拟时钟的回归验证有上限的抖动／退避、手动复用、成功重置、不自动重试下载、不受系统时钟调整影响，以及 dispose。主入口测试验证聚焦／恢复节流、显式检查立即执行和退出清理 |
| 真实强更窗口 | 服务端纯文本内容、Windows 内嵌 shell frame、不创建额外原生窗口且主窗口保持启用、Esc 阻塞、直接下载、同弹窗任务确认、稍后更新、仅恢复态页面操作、导航／复制反馈和新策略解除通过；定向测试验证关闭时退出且不清除策略 |
| 真实常规弹窗 | 隔离预加载、380px 卡片、24px 圆角、黑色主按钮、父窗口模糊、Esc 取消后保留就绪，以及任务警告批准后的安装交接记录均通过 |
| 解锁后的 Windows 交互 | 对真实强更页面执行系统级点击并截图，确认 Esc 阻塞、用户发起下载、就绪、红色策略错误提示，以及弹窗解除后父窗口恢复可用。fixture 提供的原生任务警告弹窗在选择稍后更新后回到就绪态；任务活动为模拟，不是完整 Host 工作负载 |
| 主入口 | 已知阻塞拒绝插件修改和恢复，但不停止 Host；新成功响应关闭阻塞；打包策略忽略环境覆盖；正常停止后的安装器失败在下次确认前恢复 Host，并保留强更阻塞 |
| Host 任务保护 | 替换组合环境后的真实控制器识别运行中的 agent、排队的 turn／step、全局和 agent job；API 读取不触发警告。请求准入锁定向新请求返回 503，等待已有请求结束并复查任务；解锁恢复准入 |
| 可见输出 | 中文强更弹窗 DOM 预期输出和常规更新展示预期输出通过；账户行组件测试覆盖进度和持久重试 |
| 打包配置 | 元数据嵌入配置的应用 ID 和策略；构建后的打包前钩子拒绝 HTTP 策略源站，不执行打包或上传 |

弹窗、主入口、设置和侧栏的定向运行通过 119 个回归用例。五个载体测试覆盖共享更新状态源的全部语句、分支、函数和代码行。真实 Electron 命令通过 17 个场景，并捕获常规就绪、任务警告和强更错误弹窗。这些隔离检查不认证完整工作区或发布。全仓门禁结果及环境限制与这些定向证据分开记录。

Chromium headless shell revision 1228 已安装在忽略目录 `.desktop-build/playwright` 中。组装后的设置和侧栏浏览器套件通过 18 个用例。[Desktop 工作区浏览器场景](../../web/tests/desktop-updates.e2e.ts) 的中英文用例均通过，每种语言捕获六张截图，并验证底部账户行位置、紧凑进度及重复点击拦截、顶部展开按钮提示、带错误悬停详情的持久红色重试，以及独立的就绪操作。展示函数、Host Web 组合、客户端插件和 CSS 均为真实实现；Desktop 载体使用替身。这些用例不执行 Electron IPC、菜单、任务授权或安装。

[构建后 Host 场景](fixtures/host-update-qualification.mjs) 使用真实 profile Loader、standard agent 预设、任务服务和 Node 后台进程。它验证排队的轮次／步骤、运行中的模型请求、等待答复的提问／审批、运行／停止中的全局和 agent job、不会取消任务的准入锁定、准入恢复，以及 Host 释放后的检查拒绝。仅模型响应和人工答复使用替身。两个独立调用使用私有 profile 和会话数据并发通过；全部自有 agent、job 和 Host 完成后才写入成功报告。

[Electron 工作区运行器](../scripts/test-workspace-updates.ts) 在私有目录中执行编译后的主入口，使用真实预加载、工作区和独立 Host 进程。它确认首次启动声明，并通过 Electron 输入事件及嵌入式 Windows frame 的 Chromium 调试器输入操作页面按钮。私有应用复用已准备的目标运行时资源。十个场景通过，覆盖菜单反馈、下载失败与重试、独立安装确认、确认期间真实任务创建、推迟安装、强更阻塞和真实 Host 停止超时。普通与强更失败均恢复替代 Host，并要求重新确认安装；恢复不会清除强更策略。分发使用本地服务器，安装被拦截；这些不是签名已安装应用的验证结果。

[Windows 验签运行器](../scripts/test-windows-update-signature.mjs) 使用已安装的 electron-builder 元数据生成器和 `NsisUpdater` 验签器，输入为公开发布证书和真实可执行文件。发布者属性匹配时通过；同一有效签名在预期发布者不同时被拒绝，未签名可执行文件也被拒绝。缺少发布者的负对照确认验签被跳过。单元回归覆盖 DN 转义、不完整身份，以及显式或宿主默认 Windows 目标；移除发布者配置会使两条元数据用例失败。此检查不下载、安装或签名产物。

[签名下载运行器](../scripts/test-signed-updates.mjs) 连接真实 Electron HTTP、`NsisUpdater`、Windows Authenticode 和构建后的协调器。四个场景通过：哈希正确但发布者错误时拒绝、哈希正确但未签名时拒绝、传输损坏先于验签被拒绝，以及显式重试后签名文件就绪并单独交接安装。被拒绝的可执行文件缓存为空，自动检查不发送重试请求，已准备的下载保持可用，原始输入的 SHA-512 不变。合成清单和测试应用适配器不证明已安装版本兼容性；不会启动安装器或 Host。

提供旧安装器和两个原始 blockmap 后，同一运行器还会验证单段 Range、多段 Range 重建、缺少旧 blockmap 时回退，以及 Range 被拒绝时回退。重建的可执行文件通过 SHA-512 和 Authenticode 检查。请求记录区分差分负载字节与全量下载；全量回退不能满足差分成功断言。这些回环结果不证明 CDN Range 支持或已安装应用的缓存可用。

<a id="verification-open"></a>

## 待验证事项

以下事项不是通过证据，review 时必须保持可见：

- Electron `capturePage()` 捕获单个窗口。Windows 交互观测包含合成弹窗和原生菜单选择，但跨平台 Figma／布局验收与完整录制仍未验证。自动化工作区运行器直接调用菜单处理器。
- 开发启动器在此 Windows 工作区遇到指向缺失目标的可选 Linux ARM64 依赖 junction；验收运行器直接链接已有依赖图，不验证该启动器的依赖投影。
- fixture（测试前置数据）不执行安装器，不覆盖已安装应用，也不证明新版本成功启动。发布前仍需签名 Windows 和 macOS 的已安装版本验收。
- 两个隔离 Windows 测试安装包通过签名包检查，包括内嵌清单配置。安装后启动、失败重试、自动重启和数据保留仍待操作者验证；文件检查不认证发布。
- 真实策略源站、网关行为、限流、批准的页面源站和已部署策略配置仍待后端联调。本地响应不能证明线上服务可用。
- 策略、updater 清单与下载停滞均达到真实截止时间并可恢复。下载写入的 `ENOSPC` 故障注入已覆盖；真实卷耗尽与已安装版本升级的磁盘压力仍未验证。差分下载和发布者拒绝已通过真实 Electron 下载验证，但尚未在新打包应用的已安装版本升级路径中验证。
- Windows 原生剪贴板写入通过。已尝试启动默认浏览器，但因自动化工具无法可靠识别当前 URL，目标地址验证停止。macOS 浏览器和剪贴板集成仍未验证。
- 强更与常规失败使用本地化摘要和折叠诊断；复制失败展示可选择的地址。常规错误悬停提示显示摘要，不展示原始诊断。Windows／macOS 安装包的图标提醒、通知权限与专注模式行为仍未验证。
- 完整 `doc-sync`（文档同步门禁）在文档站测试中遇到 Windows 文件符号链接 `EPERM`。这不是 updater 失败，也不代表完整文档门禁通过。
