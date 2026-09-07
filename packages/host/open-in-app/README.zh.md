---
description: "open-in-app 的主机半边：在 macOS、Windows、Linux 上把已安装的编辑器、Git GUI、终端与文件管理器解析为已验证的启动器，并以三条 webServer 路由提供目录、图标与启动端点。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-open-in-app

[English](README.md) | 中文

## 概述

`dsh-host-open-in-app` 是 open-in-app 功能的主机半边：解析本机实际持有哪些目录应用——每个都解析为已验证、可直接使用的启动器——并在 `ctx.webServer` 上注册三条路由：已解析的应用列表、逐应用图标、以及在其中打开 workspace 目录的启动端点。目录是一份固定白名单；解析每主机进程执行一次，产出的映射由所有路由共享，因此点击、展开菜单或刷新页面都不会重新执行检测。所有路由都位于组合 `connection` 服务的信任栅栏与浏览器认证之后；解析用的主机命令在配置的期限内、不经 shell 执行，PATH 名称经 subprocess 能力在进程内解析，各应用适配器以清理过凭据的环境和各自的 Windows 可见性策略 detached 派生（文件管理器例外，走 OS shell 的 open verb，即 `dsh-native-command` 的路径打开器）。随发行版一起出货的消费方是 [`dsh-client-ui-open-in-app`](../../client/ui-open-in-app/README.zh.md) 中的浏览器分体按钮；该功能由社区插件 `@dsh-plugins/open-anywhere` 转正而来。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包挂进携带 `webServer`、`connection` 与 `subprocess` 的组合，通常与其浏览器表面 [`dsh-client-ui-open-in-app`](../../client/ui-open-in-app/README.zh.md) 并排；只要主机解析出至少一个已安装的目录应用，这对包就会在 Web 会话头部放上 "Open In..." 分体按钮。

### 何时选择

当 Web 部署的用户在本地编辑器、Git GUI、终端或文件管理器旁工作、希望一键在其中打开 workspace 目录时选择本包。若只需从主机代码用系统默认应用打开一个路径，请用 `dsh-apiproxy` 的 `openPath`——本包的主体是*用哪个*应用，带逐应用解析与启动器。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-host-open-in-app'
  config:
    probeTimeoutMs: 10000
    iconTimeoutMs: 10000
    launchWatchMs: 1000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `probeTimeoutMs` | 必填 | 目录解析主机命令（`xcode-select`、Windows 注册表读取）的逐命令期限（毫秒）。 |
| `iconTimeoutMs` | 必填 | 图标提取主机命令（macOS 的 `plutil`/`sips`、Windows 的 PowerShell 提取）的逐命令期限（毫秒）。 |
| `launchWatchMs` | 必填 | 每次启动的早期失败看护窗口：窗口关闭时仍在运行的启动器计为已启动并继续运行，因此它约束的是 open 路由挂起一次成功启动的时长。 |

三个期限彼此独立，调整一种操作的超时不会改变其他操作的响应时间；超时是失败上界而非延迟预算，命令健康时保守的解析/图标期限没有任何代价。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-open-in-app)是所有可接受字段的详尽来源。

### 目录及其解析方式

目录是一份固定白名单，覆盖编辑器与 IDE（Cursor、VS Code 与 Insiders、Windsurf、Zed、Sublime Text、Xcode、Android Studio，以及 JetBrains 系 IntelliJ IDEA、PyCharm、WebStorm、PhpStorm、GoLand、Rider、RustRover）、Git GUI（Fork、Sourcetree、GitHub Desktop、Tower、GitKraken、SmartGit、Sublime Merge）、终端（Ghostty、Warp、iTerm2、kitty、Terminal、Windows Terminal、Git Bash、GNOME Terminal、Konsole）与各平台文件管理器（Finder、文件资源管理器、`xdg-open`）。每个条目按平台声明按序尝试的启动器来源，且每个来源产出的都是**已验证的启动器**——本机实际持有的构件——绝不是一条裸的安装记录：

- **macOS** 在已知应用目录（`/Applications`、`~/Applications`）中查找条目的 bundle 拼写，启动 `open -a <解析出的 bundle>`；Xcode 跟随 `xcode-select -p`，因此能找到 Beta 或改名的安装。不做 Launch Services 查询，也不扫描磁盘。
- **Windows** 依次读取 `App Paths` 注册表键、Uninstall 记录（仅当它们能证明磁盘上存在可执行文件时才采用）、已知安装路径，以及采用版本化安装目录的应用中最新的目录。GitHub Desktop 会同时解析版本化可执行文件与随包提供的 `cli.js`，不经命令 shell 调用受支持的 `github open <path>` 行为。注册表读取按批进行，每次解析每个根只跑一条 `reg.exe query`。
- **Linux 与 Windows 的 CLI 名称**经组合的 subprocess 能力在进程内解析（PATH/PATHEXT stat，无 shell、无 `which`）；CLI 不在 PATH 上的 Linux GUI 条目回退到其 XDG desktop 条目验证过的 `TryExec`/`Exec` 可执行文件，且只有主机声明了 display server 时才提供 `xdg-open` 文件管理器条目。

### 预期行为

解析惰性执行，每主机进程一次，在首个需要它的请求上进行；安装应用要下次重启后生效，卸载方向则立即自愈——启动时发现可执行文件已消失会只重解析该条目一次，无法再证明时把它从列表中移除。图标路由在每个可提取的平台上提供应用真实图标：macOS 上 bundle 的 `.icns` 转 128px PNG，Windows 上可执行文件的关联图标转 32px PNG，Linux 上 desktop 条目在 hicolor 主题中的图标（PNG 或 SVG）；提取不到的图标应答 404，浏览器表面渲染通用占位图形。

### `./shared` 子路径

路由路径与 wire 载荷类型以浏览器安全的 `./shared` 子路径发布（只有常量与类型，没有运行时身份）；浏览器包把它内联进自己的 client bundle。路由或载荷的变更落在 `src/shared.ts`，两个包都从那里获取。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本包拆为一张数据表与三个角色。[`src/catalog.ts`](src/catalog.ts) 是编译期表格：每个条目按平台的 locator 链（`fixed`、`app`、`xcode`、`cli`、`file`、`scan`、`app-paths`、`install-record`、`github-desktop`、`desktop`），以及 Linux 上拥有其图标的 desktop 条目 id。[`src/resolver.ts`](src/resolver.ts) 把表格解析到本机：一趟产出目录 id 到已验证启动的映射（主/回退 argv 加图标来源），共享一次批量的 Windows 注册表读取；argv 启动以清理过凭据的环境（`scrubbedParentEnv`）叠加适配器显式环境后 detached 派生，Windows GUI 默认保持可见，只有负责另行打开 GUI 的 CLI 适配器会隐藏自己的进程。`shell-open` 启动（文件管理器）在同一看护窗口下经 `dsh-native-command` 的路径打开器执行 OS shell 的 open verb，spawn 的 `ENOENT` 被归类为 `missing`，让路由能刷新失效条目。[`src/icons.ts`](src/icons.ts) 按平台提取图标：macOS 在解析出的 bundle 上跑 `plutil`/`sips`，Windows 在解析出的可执行文件上跑生成的 PowerShell `ExtractAssociatedIcon` 脚本（`-File` 位置参数让路径不经过命令行解析），Linux 走 desktop 条目/hicolor/pixmaps 的文件系统查找。

[`src/index.ts`](src/index.ts) 在 `ctx.webServer` 上注册三条路由：`GET /open-in-app/apps`（解析映射的 keys）、`GET /open-in-app/icon/<id>`（提取的图标，进程内内存缓存）、`POST /open-in-app/open`（直接使用映射中已验证的启动器——绝不重新检测）。每条路由都先向组合的 `connection` 服务询问是否拒绝；完整的信任叙述——Host/Origin 栅栏与浏览器认证——唯一的出处在 [`src/index.ts`](src/index.ts) 的模块注释。在该栅栏之上，open 路由在 wire 边界校验请求体：`application/json` 媒体类型、64 KiB 上限、解析为可用的目录 id、指向现存目录的绝对路径。解析与图标命令经 [`@deepseek-ai/dsh-native-command`](../../util/native-command/README.zh.md)（argv，绝不走 shell）在各自期限内执行；PATH 名称走 `ctx.subprocess.resolveExecutable()` 进程内解析。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-client-ui-open-in-app](../../client/ui-open-in-app/README.zh.md)——消费这三条路由的浏览器分体按钮。
- [dsh-subprocess](../../subprocess/subprocess/README.zh.md)——提供进程内 PATH 解析与清理过的子进程环境的能力。
- [dsh-native-command](../../util/native-command/README.zh.md)——解析与图标命令的免 shell 主机命令运行器。
- [dsh-host-webserver](../webserver/README.zh.md)——承载三条 HTTP 端点的路由注册表。
- [Host 包地图](../README.zh.md)——本包所属的 GUI 主机家族。

-----

<a id="model-experience"></a>
## 模型体验

无。本包为人打开主机应用，不触及任何提示词、消息、schema、流或工具结果。

#### KV 缓存影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **目录在构建期固定。** 部署无法从 cordis.yml 增加自己的编辑器或 Git GUI；扩展列表意味着同时扩展 `OPEN_IN_APP_CATALOG` 与浏览器包的词典。操作系统可以定位已知应用，但无法证明每个已安装应用都能接收 workspace 目录，也无法给出各应用需要的启动协议，因此本包不会无边界地枚举 OS 应用。可配置的 custom handler 仍然延后；其中由用户提供的 label 属于用户数据，不是 locale 拥有的产品文案。
- **macOS 检测只查已知路径。** bundle 改名超出目录收录的拼写、或挪到 `/Applications` 与 `~/Applications` 之外就不会被检测；不做 Launch Services 查询（原生 LaunchServices/NSWorkspace 查询需要仓库尚无的 addon），也刻意不扫描磁盘。
- **图标保真度受平台约束。** Windows 图标来自 32px 的 `ExtractAssociatedIcon`——不带原生 addon 时 .NET 标准面能给出的最大尺寸——在高分屏上可能略微发软；Linux 图标只查 hicolor 主题与 pixmaps，不追用户的自定义图标主题；若干条目（没有 desktop 条目的纯 CLI 启动器）没有图标来源，保持通用占位图形。
- **新安装要重启后出现。** 解析每主机进程一次；只有卸载方向自愈（启动器缺失时当场只重解析该条目）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

转正期的各项决定——host/`ui-` 分包、为什么用裸 webServer 路由而非 Typert Remote、目录为什么保持编译期固定、resolver 重设计（已验证启动器、单趟解析、点击不再重新检测）、三期限配置、以及各平台图标策略与被拒的替代方案——记录在[转正 Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.zh.md)。

</details>

**运行时不变量：** 不发布 companion。本包经三条无状态路由提供一趟主机解析的结果；路由注册已由各自的 HMR 安全测试证明可处置，不存在可能分叉的独立观测。
