# Agent Note: 将 open-anywhere 从社区插件转正为第一方包

Status: implemented

[English](2026-08-25-promote-open-anywhere-plugin.md) | 中文

## 问题

社区插件 `@dsh-plugins/open-anywhere`（gitlab.deepseek.com/Ciyou/dsh-open-anywhere）在会话头部增加一个 "Open In..." 分体按钮，可在 Finder、Cursor、VS Code、Xcode、Git GUI 或终端中打开会话的 workspace 目录。它以手写 `lib/` JavaScript 形式经 `dsh plugin add` 安装：无类型、无测试、直接调用 `node:child_process`、手搓下拉菜单和 style 标签、自带针对 rc6–rc8 的浏览器端 DSH 版本门禁，并靠探测 `process.argv` 猜测运行中的 dsh 版本。用户希望该功能成为 Web profile 的内置部分，而 bundle 安装路径给不了这一点——且外部形态几乎违反了仓库的所有约定（locale 拥有文案、逐文件覆盖率、wire 边界校验、主机命令的能力接缝）。

## 决定

第一方功能命名为 `open-in-app`：它选择在 Harness 主机上打开 workspace 目录的应用，不表示另一台机器或目的位置。

该功能的第一方归属是一对包：`@deepseek-ai/dsh-host-open-in-app` 位于 `packages/host/open-in-app/`（探测、目录与启动路由），`@deepseek-ai/dsh-client-ui-open-in-app` 位于 `packages/client/ui-open-in-app/`（分体按钮），由 `dsh-web-app` bundle 的 `open-in-app` 与 `ui-open-in-app` 两行挂载进 Web profile。转正是重写，不是 vendoring：

- **一对 host/client 包，沿用 `directory-picker-browse`/`ui-directory-picker-browse` 的配对结构**：host 包的 `src/index.ts` 在 `ctx.webServer` 上注册三条 HTTP 路由（`GET /open-in-app/apps`、`GET /open-in-app/icon/<id>`、`POST /open-in-app/open`）；ui 包的 `src/client/index.ts` 经标准 slot/inject 通货把分体按钮注册进 `conversation.session.header.utilities`，文案在类型化的 `open-in-app` locale 命名空间中，样式为 `--dsw-*` token 上的 CSS Modules（原插件手工注入的 style 标签与内联下拉被 `Menu` 原语替代），节点半边是让插件出现在主机名册上的空 apply。路由路径与 wire 载荷类型只有一个家：host 包浏览器安全的 `./shared` 子路径（只有常量与类型）；client bundle 经 client tsdown preset 的 `INLINE_SAFE` 条目将其内联，与 `dsh-session` 各 wire 切片同一通道。host 根入口只导出 Loader 所需的插件实体与类型；目录、resolver、launcher 与图标 helper 保持源码内部可见。
- **一趟解析产出已验证的启动器；点击绝不重新检测。** 主机把整个目录每进程惰性解析一次，产出目录 id 到 `OpenInAppResolvedLaunch` 的映射——本机实际持有的启动器，绝不是裸的安装记录。`GET /apps` 提供映射的 keys，`POST /open` 直接启动其值；启动时发现可执行文件已消失（spawn `ENOENT`）会只作废该条目、重解析一次，无法再证明时把它从列表移除（卸载自愈，新安装等重启）。
- **解析来源按平台务实且廉价。** macOS 在已知应用目录（`/Applications`、`~/Applications`）查条目的 bundle 拼写，启动 `open -a <解析出的 bundle>`；Xcode 跟随 `xcode-select -p`。Windows 依次读 `App Paths`、只在能证明磁盘可执行文件时采用的 Uninstall 记录、已知路径，以及采用版本化安装目录的应用中最新的目录——每趟每根一条批量 `reg.exe query`。GitHub Desktop 会同时解析版本化可执行文件与随包提供的 `cli.js`，不经命令 shell 调用受支持的 `github open <path>` 行为。CLI 名称经 `ctx.subprocess.resolveExecutable()` 进程内解析（PATH/PATHEXT stat，无 shell、无 `which`/`where.exe` 子进程）；CLI 不在 PATH 上的 Linux GUI 条目回退到其 XDG desktop 条目验证过的 `TryExec`/`Exec`，且只有主机声明了 display server 时才提供 `xdg-open`。其余主机命令（`xcode-select`、`reg.exe`、图标提取）经 `@deepseek-ai/dsh-native-command`（argv，绝不走 shell）执行。
- **三个独立期限取代单一 `commandTimeoutMs`**：`probeTimeoutMs`（解析命令）、`iconTimeoutMs`（图标提取命令）、`launchWatchMs`（早期失败看护窗口），调整一种操作的超时不再改变其他操作的响应时间——随发行 bundle 保守地保留 10 秒命令期限（超时是失败上界而非延迟预算），看护窗口 1 秒，它才是约束 open 路由与按钮忙碌态挂起一次成功启动时长的量。启动以清理过凭据的环境（`dsh-subprocess` 的 `scrubbedParentEnv`）叠加适配器显式环境后 detached 派生；Windows GUI launcher 默认保持可见，只有负责另行打开 GUI 的 CLI 适配器会显式隐藏自己的进程。看护窗口关闭时仍在运行的启动器计为已启动，绝不会被杀死或等待（kitty 与 JetBrains IDE 在整个窗口生命周期内保持前台）。
- **有主机来源的平台都提取图标。** macOS 把解析出的 bundle 的 `.icns` 转 128px PNG（`plutil` + `sips`）；Windows 用生成的 PowerShell 脚本以位置式 `-File` 参数（路径不经命令行解析）提取解析出的可执行文件的关联图标为 32px PNG；Linux 沿 spec 的 desktop 条目 `Icon=` 查 hicolor 主题与 pixmaps 目录（PNG 或 SVG，纯文件系统）。任何失败应答 404，浏览器保持通用占位图形。
- **启动目录是按平台声明条目的数据表**（`OPEN_IN_APP_CATALOG`）：每个应用 id 按平台（`darwin`/`win32`/`linux`）声明一条按序尝试的启动器来源链——`fixed`（随系统内置）、`app`（已知目录的 bundle 拼写）、`xcode`（`xcode-select -p`）、`cli`（进程内 PATH 解析）、`file`（`${VAR}`/`~/` 展开后第一个存在的候选文件）、`scan`（带版本号安装目录取最新）、`app-paths` 与 `install-record`（Windows 注册表两层）、`github-desktop`（版本化可执行文件与随包 CLI）、`desktop`（Linux XDG desktop 条目）——加启动器 argv 模板（`{path}` token 原位携带目录，否则目录追加在末尾）、可选环境与 Windows 可见性策略，以及可选回退启动器（`xed` 之后的 `open -a <bundle>`）。白名单对齐 Codex 的 "Open In" 目标列表：编辑器与 IDE（VS Code、VS Code Insiders、Cursor、Windsurf、Zed、Sublime Text、Xcode、Android Studio、七个 JetBrains IDE）、转正插件原有的 Git GUI、终端（Terminal、iTerm2、Ghostty、Warp、kitty、Windows Terminal、Git Bash、GNOME Terminal、Konsole）与各平台文件管理器。文件管理器与平台终端使用独立 id（`finder`/`explorer`/`filemanager`），而非一个 id 配平台标签，因为标签是静态浏览器词典条目，且每台主机只会探测到其中一个。文件管理器条目直接经 `dsh-native-command` 的路径打开器启动（`shell-open`，OS shell 的 open verb，携带完整父环境，而非 detached 的清理环境 spawn），因为直接 spawn `explorer.exe <dir>` 不能可靠地弹出窗口。封闭 union 以 `assertNever` 收尾。
- **所有路由都运行在组合 connection 服务的信任栅栏之后**（`requestRejection`：挫败 DNS rebinding 与跨站调用的 Host/Origin 栅栏，加上浏览器认证），与 API gateway 施加在其 WebSocket upgrade 上的守卫相同；机制的唯一出处是 `src/index.ts` 的模块注释。在该栅栏之上，open 路由在 wire 边界校验请求体：`application/json` 媒体类型（精确 essence，而非子串匹配）、以排空后 413 的方式把 body 限制在 64 KiB、校验字段类型、只接受探测为可用的目录 id，并要求指向现存目录的绝对路径。
- **删除了 DSH 版本门禁。** 它存在是因为插件逐版本骑乘一个它不拥有的接口；第一方包与仓库同版本发布，门禁、它的 `sessionStorage`/`localStorage` 信任台账和 argv 遍历版本探测都失去了所指。
- **上次选择经 `createSnapshotStore(..., { persist })` 持久化**（`dsh.open-in-app.choice`），替代手写 `localStorage` 访问。新存储没有平台特定的初始选择；用户首次选择前，组件使用主机提供的第一个可用条目。

这对包放在 `packages/host/` 与 `packages/client/`，因为两个半边本来就是这两种东西：探测/启动侧是主机基础设施，与它消费的 webserver 同组；按钮是客户端表面，与其他 `ui-*` 包同组。评审把它从 `packages/workspace/` 的单个双半边包迁到这里（见替代方案）。

## 考虑过的替代方案

**将插件的 `lib/` 原样 vendor 进 `packages/`。** 最快，但手写 JavaScript 会整体不过 typecheck、覆盖率、i18n、JSDoc 和 invariant 门禁；为其保留豁免会造出仓库刻意不设的包类别。

**用 Typert Remote 而非裸 webServer 路由。** apps/open 调用符合 Remote RPC 形态，但 icon 路由提供二进制 PNG，JSON RPC 词汇承载不了；把 icon 拆去裸路由而 apps/open 走 Remote 会让一个功能有两种传输。裸路由也匹配原插件的客户端，且 `webhook-github` 已确立带校验裸路由的先例。

**扩展 `host/apiproxy` 的 `openPath` 而非新 open 端点。** `openPath` 用系统默认应用打开一个路径；本功能的主体是*用哪个*应用，带可用性探测和逐应用启动器——是不同的契约。两者共享 `dsh-native-command`。

**放在 `packages/workspace/` 的单个双半边包（最初交付的形态，沿用 `dsh-session-log-export`）。** 评审期拆成 host/client 对：workspace 组的契约是 host-side only，该功能消费的是 `webServer` 而非 `workspaceRegistry`，且单包整体注册在 Client 编译聚合面迫使主机路由与目录测试伪装成 `.client.spec.ts`。拆分让每个半边的测试落在自己的编译面、依赖落在正确的区段；wire 契约经 host 包的 `./shared` 子路径保持唯一出处。

**可配置目录（cordis.yml 定义应用）。** 延后：每个条目耦合发现、启动参数、进程策略与图标行为，因此接受任意命令前需要明确的用户设置归属与校验规则。用户提供的 label 属于用户数据，不与 locale 拥有的产品文案冲突。Codex 与 Orca 展示了可能的扩展形态：维护过的内置 preset 加可配置 custom handler。

**通过操作系统 API 枚举所有已安装应用。** 不作为菜单真源：Launch Services、Windows 注册信息与 XDG desktop 条目可以定位应用，但不能证明每个应用都能接收 workspace 目录，也不能给出正确打开目录所需的启动协议。OS 原生标识仍可作为维护过的 preset 的 locator 输入；custom handler 用于覆盖长尾，而不是猜测启动语义。

**为 Windows/Linux 条目内置静态图标（Codex 为每个目标打包 PNG）。** 拒绝：图标路由在三个平台都提供主机真实图标，为装饰性收益打包第三方产品图形会引入资产管线与商标风险面。

**重子进程检测（最初交付的形态）：macOS 每条目一次 `open -Ra`、CLI 各一次 `which`/`where.exe`、每次启动重新解析。** 评审期替换：一次列表解析在 macOS 上派生约 26 个子进程，按显示名查 Launch Services 的证据弱于磁盘上的 bundle，仓库已有进程内 PATH 解析（`ctx.subprocess.resolveExecutable()`），且点击时重新检测把探测期限放上了交互路径。为挪位 macOS bundle 考虑过批量 `mdfind` 兜底，依评审的 known-paths 指示未采用；漏检记入已知限制。原生 LaunchServices/NSWorkspace 查询需要仓库尚无的 addon——延后，以已知 `.app` 路径为替身。

**公共的应用发现 Service Definition。** 按单消费者规则延后：在出现第二个 GUI 发现消费者之前，resolver 保持为包内模块。

**经 `SHDefExtractIcon` P/Invoke（`Add-Type`）脚本取 128px Windows 图标。** 延后：`ExtractAssociatedIcon` 是不需编译片段的 .NET 标准面，32px 在按钮 15-18 CSS px 的尺寸上仅在高分屏略微发软；若实际在意，P/Invoke 变体是脚本内局部升级。同理未追用户的 Linux 图标主题——hicolor 是所有主题继承的 freedesktop 兜底——自定义主题桌面会看到原版图标。

## 后果

- 只要主机在 macOS、Windows 或 Linux 上探测到至少一个已安装的目录应用，Web profile 就会出现头部按钮；其余情况零渲染（探测目录为空 → 组件返回 null）。
- 社区插件的安装路径仍然有效但已冗余；其原始路由与浏览器选择键独立于 `open-in-app`，因此使用第一方功能的安装应移除社区插件，避免出现重复的头部控件。
- 解析与图标每主机进程惰性执行一次，dsh 运行期间安装的应用要重启后才出现——接受；卸载方向经 `ENOENT` 单条目刷新自愈。
- 目录在编译期固定；扩展它意味着同时编辑 `OPEN_IN_APP_CATALOG` 与两份 locale 词典（README 已知限制）。平台覆盖不均——若干 Git GUI 与终端仅有 macOS 条目；Windows 图标受限于 .NET 标准接口的 32px 提取，Linux 跟随 hicolor 而非当前主题，没有 desktop 记录的纯 CLI 条目则保留通用图标。
- 覆盖：resolver 逻辑（每种 locator 在临时文件系统上、注册表转储与 desktop 条目 fixture、注入的 env/home/PATH 表）、逐平台图标提取、三条路由（真实 Loader + 真实 WebServer 组合，含单趟缓存、`ENOENT` 刷新与 HMR 安全处置）、controller wire 行为和组件呈现都以逐文件 100% 门禁做了单元测试；不新增 snapshot，因为随仓库发布的免密 snapshot fixture 断言会话驱动的输出，而这个纯浏览器侧控件不触及它。Web ARIA golden 禁用 `open-in-app` 与 `ui-open-in-app` 两行，Host-only 的 preset e2e 组合禁用 host 行：按钮反映运行机器实际安装了哪些应用，其出现与否和标签都是主机事实，跨平台 golden 无法钉住。
