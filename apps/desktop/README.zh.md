# DeepSeek Harness 桌面端

[English](README.md) | 中文

桌面应用是包裹 dsh Web UI 的 Electron 壳。它不打开监听端口：内置的上游 Node.js 子进程启动已安装的 dsh 项目，带版本的分帧字节管道在没有外层 Base64 信封的情况下承载 Fetch 请求与流式响应，Node IPC 承载生命周期控制，`dsh-app://` 则提供与后端版本匹配的客户端资源。

## 关键技术决策

| 决策 | 原因 | 直接结果 |
|---|---|---|
| 发布身份 | 桌面壳 API、Web 客户端、后端与插件依赖图作为一个组合完成验证；独立版本会产生未经验证的组合，并让更新可用性含糊不清。 | Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本。即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。 |
| 运行时 | Electron 的 Node.js 带有 Electron 补丁、fuse、ABI 与生命周期约束，而系统运行时和包管理器状态不可控。 | dsh 通过内置的上游 Node.js 运行，所有包操作都使用内置 pnpm。Electron 的 Node.js、系统 Node.js、系统 pnpm 与用户的包管理器配置都不进入执行路径。 |
| 包来源 | 即使离线，启动时安装核心依赖也会增加开销。 | `extraResources/dsh` 携带完整生产依赖树；profile 只安装外部插件。 |
| 共享模块 | 宿主 API 可能依赖模块实例身份。 | Desktop 用目录软链接或 Windows junction 把每个内置第一方包连接到 profile；普通插件依赖保留在本地。 |
| 状态归属 | 共享可执行依赖图会让 CLI（命令行界面）与 Desktop 相互改变 dsh、Cordis、插件或原生模块版本，而两个桌面进程还可能争用同一个 profile。 | Electron 在访问任何 profile 前获取进程生命周期单实例锁，并独占 `$DSH_HOME/profiles/desktop` 及其包管理器状态。CLI 与 Desktop 共享 `$DSH_HOME` 下受支持的产品数据，但绝不共享可执行包、插件激活、锁文件或 `node_modules`。 |
| 通信 | 监听 Web 服务会引入端口归属、认证、CORS 与暴露风险；Electron 与上游 Node.js 之间也需要明确的跨进程协议。 | 应用不打开 Web 端口。`dsh-app://` 承载 Web 资源和 Fetch 流量；分帧字节管道以背压传输有界请求与响应分块，Node IPC 只承载子进程生命周期控制。 |
| 插件变更 | 包安装和 Host 启动可能失败。 | Desktop 停止 Host 后直接修改当前 profile。失败保留部分修改供用户修复，不自动回滚 profile。 |
| 更新 | 桌面壳与 dsh 独立更新会重新产生版本分裂，而桌面壳未变化的数据块不应强制完整传输。 | Electron 壳、匹配的 dsh 运行时、Node.js 与 pnpm 组成一个已签名更新单元。平台更新产物可以复用未变化的数据块，但运行时版本选择绝不脱离 Desktop 发布。 |

[Electron 打包与更新 Agent Note](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md) 记录了这些决策背后的理由、替代方案、安全约束和发布验证要求。

## 安装归属

Electron 拥有 `$DSH_HOME/profiles/desktop`。其 `dependencies` 只包含已安装外部插件的精确版本；`dsh.profile.bundles` 包含内置 bundle，后接已启用插件。签名应用从 `resources/dsh` 提供 dsh、私有 Desktop Host 及其生产依赖。共享包链接解析到这些实际目录。宿主与插件在同一个内置上游 Node 进程中执行，使用正常的 realpath 解析；Desktop 不启用 `--preserve-symlinks`。CLI 不能启动或修改此 profile。

本地启动页提供启动状态和可用恢复操作；加载后的 dsh 渲染进程仅接收桌面协议标记。独立插件窗口接收结构化的列表、安装、删除、更新和更新检查操作；两个渲染进程都无法访问文件系统、原始 Electron IPC、shell 或任意 pnpm 参数。

Electron 根据应用 locale 选择类型化的英文或中文桌面壳文案，并以英文作为 fallback。菜单、原生对话框、启动页与插件管理渲染进程使用同一 locale 数据；仓库的 Client UI i18n gate 会检查这些桌面源文件。

### 运行时与插件激活

签名资源中的 `resources/dsh/desktop-runtime.json` 绑定 shell 版本、内置 Node 版本、平台、架构、共享包版本和最终文件清单。启动读取元数据，并检查共享包记录。发布 schema、shell 版本、目标兼容性和文件完整性在打包时验证。首次启动不会把核心包复制到 profile 存储或通过 pnpm 安装核心包。

1. 主窗口在 profile 准备或后端启动前显示本地加载页。新 profile 创建清单和共享包链接，保留无关文件，然后启动一次实际后端。未变化的启动复用 profile，不扫描已安装插件的清单。
2. 兼容的应用升级在当前 profile 中刷新共享链接，并检查已启用插件的 peer 要求。插件文件、配置、版本和锁文件留在原处；不运行 pnpm。
3. 内置 Node 版本、平台或架构变化时，禁用脚本重新安装锁定的插件依赖图，验证并链接宿主包，然后运行已批准的待执行构建并再次验证。
4. 插件添加、更新和删除使用内置 pnpm 及 Desktop 独有的包管理器状态。保留的宿主包必须声明为 peer；共享包的嵌套副本和别名会被验证拒绝。普通插件依赖必须解析到 profile 内部。
5. 插件变更在直接修改当前 profile 前停止后端。准备成功后启动 Host。包操作或 Host 启动失败会保留已修改文件并报告错误。未完成的包操作保留标记，使下次启动重试锁定依赖的安装和待执行构建。Desktop 不创建 staging 目录、激活日志或回滚副本。

加载页不依赖 Host。错误页提供重启和重装指导。只有已打包应用的资源支持 profile 恢复时，才提供禁用插件和重置 Desktop；开发模式和早期初始化失败只提供重启。应用菜单仍提供插件管理器入口。每次后端启动前都会检查运行时标识；插件修改不自动回滚。

重置删除 `$DSH_HOME/profiles/desktop` 中除所持事务锁外的所有条目，然后初始化内置 profile。它删除 Desktop 配置和已安装第三方包，不保留备份。共享任务、设置和 Harness-home `.env` 保持不变。壳资源和 preload 失败时使用独立文档显示可用恢复操作和诊断；其控件不依赖 preload。

包事务独占持有 `$DSH_HOME/profiles/desktop/lock`，直到 pnpm 进程退出。重置保留目录及其锁，直到初始化和 Host 启动完成。共享链接在 macOS/Linux 使用目录软链接，在 Windows 使用 junction；清理只移除链接，不删除其目标。共享包使用文件系统的规范路径识别，因此 Windows 路径大小写变化不会单独触发 profile 激活。原生构建遵循 profile 中经过审查的 `allowBuilds` 列表；新安装的包如果需要构建但未在列表中获准，事务会失败。

## 开发

`dev:desktop` 会构建当前 Host、客户端 bundle、Web 前端和 Electron 壳，把已构建的 CLI 包、私有 Desktop Host 包及其 workspace 依赖投影为一次性桌面 npm 项目，然后直接启动 Electron；这条路径不下载安装包内的 Node.js，也不从 npm 解析 dsh：

```sh
pnpm run dev:desktop
```

开发 Harness 状态默认写入 `apps/desktop/.desktop-build/development/home`，一次性 npm 项目位于 `apps/desktop/.desktop-build/development/project`，Electron 浏览器数据则位于 `apps/desktop/.desktop-build/development/electron-user-data`。因此，会话、设置、凭据、包链接和浏览器数据都不会进入用户正常使用的 Harness home；显式 `DSH_HOME` 只会替换开发 Harness home。Renderer DevTools 默认自动打开，Main、Renderer 和 dsh Host 调试端口依次为 9229、9222 和 9230。`DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT` 与 `DSH_DESKTOP_HOST_INSPECT_PORT` 可以替换这些端口，`DSH_DESKTOP_OPEN_DEVTOOLS=0` 则保持 Renderer 调试窗口关闭。

显式构建完成后，`start:desktop` 会重新生成一次性项目，并跳过构建直接启动已有产物：

```sh
pnpm run start:desktop
```

Workspace 开发使用调用命令的 Node.js 运行当前 CLI 与私有 Desktop Host 包，并禁用桌面包修改；只有该模式明确链接的一次性 profile 可以从自身目录外解析 bundle。需要验证内置 Node.js、内置 pnpm、内置 dsh 资源、插件安装和修复时，应运行未封装安装器的应用目录。

## 打包

正常打包只需执行一条完整命令。该命令会先准备发布资源，再生成宿主平台的安装包与更新元数据。所有目标都要求通过 `DSH_DESKTOP_APP_ID` 提供反向域名形式的应用 ID。macOS 目标还要求通过 `DSH_DESKTOP_MACOS_SIGNING_IDENTITY` 提供 electron-builder 证书限定名，通过 `DSH_DESKTOP_MACOS_TEAM_ID` 提供对应的 10 字符 Apple Team ID，并提供一套完整的 notarytool 凭据方案。App Store Connect API Key 方式使用以下变量：

```sh
export DSH_DESKTOP_APP_ID='<reverse-DNS application ID>'
export DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<certificate name without the Developer ID Application prefix>'
export DSH_DESKTOP_MACOS_TEAM_ID='<10-character Apple Team ID>'
export APPLE_API_KEY='<absolute path to the .p8 file>'
export APPLE_API_KEY_ID='<App Store Connect API Key ID>'
export APPLE_API_ISSUER='<App Store Connect issuer UUID>'
```

无需提前执行 `prepare:desktop`：

```sh
pnpm run package:desktop
```

发布自动化使用固定目标命令，确保运行时准备、dsh 准备与 electron-builder 接收相同的平台和架构：

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

macOS arm64 命令要求 Apple Silicon。macOS x64 命令可以在 Intel macOS 或带 Rosetta 的 Apple Silicon 上运行。Windows x64 命令要求 Windows x64。Linux 不是受支持的 Desktop 发布目标。

每个目标都在 `apps/desktop/.desktop-build/targets/<target>/` 下持有自己的打包输入、已准备运行时、包集合、dsh 依赖树、pnpm 准备状态、未打包应用、更新元数据和最终产物。Node.js 归档缓存继续由 `.desktop-build/downloads` 共享，因为每个归档文件名都包含版本、平台和架构，并且在解包前经过验证。目标构建绝不读取其他目标的可变准备状态。

### 运行时文件筛选

生产包首先经过 npm 发布规则和依赖安装。[桌面文件规则](scripts/runtime-file-policy.ts)随后在签名和完整性封存之前过滤不可变的 `resources/dsh/node_modules` 副本。它排除 TypeScript 声明、明确属于 JavaScript/CSS/TypeScript 的 source map、TypeScript 构建缓存、Domino 测试目录、指定的原生编译产物，以及其他平台的 node-pty 预构建文件。它保留运行时 JavaScript、原生模块及其 DLL/EXE 辅助程序、WASM、未知资源、许可证和声明。规则不会修改 npm tarball、内置包管理器或用户安装的插件文件。

打包应用运行编译后的 JavaScript 和预生成的 Typert 元数据，不编译 TypeScript 插件。源码级调试导航和编辑器声明仍可从开发包中获取。[复制规则测试](tests/runtime-file-policy.spec.ts)覆盖排除项和保留资源；`prepare:dsh` 在 Host smoke 和最终清单验证之前，使用内置 Node 执行[产物 smoke](tests/fixtures/runtime-payload-smoke.mjs)。

Windows 发布验收还需在 Desktop 构建后手动运行[原生清理和替换检查](scripts/smoke-windows.ps1)。将 `$Electron` 设为已准备的 Electron 可执行文件，将 `$Makensis`、`$SevenZip` 和 `$PluginDir` 分别设为锁定版本构建器的 NSIS 编译器、7-Zip 可执行文件和 x86-unicode NSIS 插件目录。从仓库根目录运行以下命令。它验证 Electron junction 清理、安装器临时目录清理和两种文件占用替换方式；不属于单元测试通道。

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Electron $Electron -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir
```

### 上传更新

`DSH_DESKTOP_AUTO_UPDATE_ENV` 同时选择打包时写入的更新 URL 与后续 COS 上传目标，可取 `test` 或 `production`；未设置时使用 `test`。测试打包必须通过 `DOWNLOAD_TEST_ORIGIN` 提供 HTTPS origin，生产 origin 仍为 `https://download.deepseek.com`。上传还必须通过 `DOWNLOAD_TEST_COS_BUCKET` 或 `DOWNLOAD_PROD_COS_BUCKET` 提供所选环境的 COS bucket。目标路径为 `_/harness/desktop/stable/<target>/`，其中 `target` 为 `mac-arm64`、`mac-x64` 或 `win-x64`。

更新目标与上传凭据都与所选环境对应：

| 环境 | 公开 origin | COS bucket | COS 凭据 |
|---|---|---|---|
| `test` 或未设置 | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`、`DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`、`DOWNLOAD_PROD_COS_SECRET_KEY` |

同一目标必须在同一环境下完成打包与上传。例如，默认测试环境使用：

```sh
export DOWNLOAD_TEST_ORIGIN='https://desktop-updates.example.com'
pnpm run package:desktop:mac:arm64

export DOWNLOAD_TEST_COS_BUCKET='<test COS bucket>'
export DOWNLOAD_TEST_COS_SECRET_ID='<test COS SecretId>'
export DOWNLOAD_TEST_COS_SECRET_KEY='<test COS SecretKey>'
pnpm run upload:mac:arm64
```

生产发布需在打包前设置 `DSH_DESKTOP_AUTO_UPDATE_ENV=production`，再在执行 `upload:mac:arm64`、`upload:mac:x64` 或 `upload:win:x64` 前提供 `DOWNLOAD_PROD_COS_BUCKET` 与生产凭据对。打包不要求 COS bucket 或凭据。它会明确禁止 electron-builder 发布，从其子进程中删除全部四个 COS 凭据字段，并且只有在 electron-builder 以及全部签名或公证钩子成功后才写入目标完成记录。上传会先要求该记录与所选环境、目标、公开 URL 和当前 dsh 版本一致，再要求根 dsh 版本、Desktop 版本、频道元数据版本、产物名称、大小与 SHA-512 全部一致，之后才读取所选 COS 凭据对。它只上传该目标不可变且带版本的产物，最后以 `no-cache` 上传根据版本得出的频道元数据，并且不会删除历史对象。稳定版本使用 `latest-mac.yml` 或 `latest.yml`；`alpha` 等预发布版本则使用 `alpha-mac.yml` 或 `alpha.yml`，与 electron-builder 生成的文件名一致。

macOS 配置使用必填发布环境，不会接受钥匙串中最先发现的证书。空值、格式错误的 Team ID、包含 electron-builder 不支持的 `Developer ID Application:` 前缀的签名身份，以及不完整的公证凭据都会被拒绝。macOS 打包要求已配置的身份及其私钥可用。运行时准备会把该身份、安全时间戳与 hardened runtime 应用到每个内嵌 Mach-O 文件；应用签名完成后，深度严格检查会拒绝其他叶证书 Authority 或 Team ID，验证通过才生成发布产物。macOS 固定目标安装包命令为已签名应用创建独立副本，并发执行两条产物流。一路先公证 App 并钉票，再生成 ZIP 及其更新元数据。另一路把已签名 App 副本封装进签名 DMG，再公证 DMG、钉票并验证；其中的 App 不单独附加票据。只有两路均成功结束，产物才会移入最终目录并写入发布完成记录。仅生成目录的命令同样需要公证凭据，并等待 Apple 公证和 App 钉票完成。[并行公证决策](../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.zh.md)负责副本隔离与容器票据语义。私钥可以来自登录钥匙串或 electron-builder 的标准 `CSC_LINK` 输入；环境中的 `CSC_NAME` 与证书发现顺序都不能选择发布所有者。公证凭据也可以使用 electron-builder 支持的完整 Apple ID 或钥匙串 profile 方式。手动执行 `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>` 重复应用检查时，也必须提供两个 macOS 身份变量。

macOS 签名遍历真实文件，不跟随 Framework 的软链接别名。PAK 资源保留全部随附语言，由外层 Framework 或应用签名记录完整性，不逐个签名。[发布策略](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责依赖补丁和验证要求。

可通过公司代理加速向 Apple 公证服务上传。代理配置参见公司内部文档。

### 未签名 Windows 测试安装包

在 Windows x64 上，使用完整的未签名打包命令进行本地安装测试：

```sh
pnpm run package:desktop:win:x64:unsigned
```

该命令要求设置 `DSH_DESKTOP_APP_ID` 并具备常规构建依赖，包括编译原生模块所需的 Python 和 Visual C++ 构建工具。Python 不在 `PATH` 中时，将 `PYTHON` 设置为其可执行文件路径。命令将安装包写入 `.desktop-build/targets/win-x64/unsigned-artifacts/`，省略自动更新配置，清除签名凭据，且不生成发布完成记录。它不需要 EV 凭据或更新源地址。签名打包和上传命令仍遵循正式发布要求。

### Windows EV 签名

Windows 打包将 7-Zip 过滤器固定为 `BCJ`，以兼容内置的 NSIS 解码器。这样可以保留 x64 安装包中由依赖携带的 ARM64 二进制文件；自动 ARM64 过滤会生成该解码器无法解压的条目。

NSIS 在安装阶段清理临时解压目录，完成后才显示完成页或自动启动应用。已安装的生产依赖保持为普通文件；启动时不会再次解压。安装仍会写入完整的应用目录树。

Windows 发布打包要求 `DSH_DESKTOP_WINDOWS_CER_FILE` 标识公开的 GlobalSign EV 叶证书，要求 `DSH_DESKTOP_WINDOWS_SIGNTOOL` 标识与 SafeNet 兼容的 SignTool 可执行文件，要求 `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` 标识匹配的私钥容器，并要求 `DSH_DESKTOP_WINDOWS_TOKEN_PIN` 包含 SafeNet Token Password。证书文件保留在源码仓库之外，匹配的私钥仍位于 USB Token。运行固定 Windows 目标前设置这四个输入：

```powershell
$env:DSH_DESKTOP_WINDOWS_CER_FILE = 'C:\path\to\server.cer'
$env:DSH_DESKTOP_WINDOWS_SIGNTOOL = 'C:\path\to\the\validated\signtool.exe'
$env:DSH_DESKTOP_WINDOWS_KEY_CONTAINER = '<SafeNet private-key container name>'
$env:DSH_DESKTOP_WINDOWS_TOKEN_PIN = '<SafeNet Token Password>'
pnpm run package:desktop:win:x64
```

打包前插入并解锁 Token。electron-builder 钩子把每个产物交给采用 CRLF 的 `scripts/windows-sign.cmd`；该 CMD 只调用一次已配置的 SignTool，并指定 `/f`、SafeNet `/kc "[{{PIN}}]=容器"`、`/csp "eToken Base Cryptographic Provider"`、SHA-256 文件摘要和 DigiCert SHA-256 RFC 3161 时间戳。钩子不会改用 electron-builder 内置的 SignTool，也不会重试失败的签名请求。SignTool、证书、容器、PIN、Token 或签名不可用时，Windows 发布打包会失败，不会生成未签名产物。

PIN 不能包含 `]`、引号或换行，因为这些字符用于分隔 SafeNet `/kc` 值或对应的 CMD 参数。CMD 会禁用延迟展开，因此包含 `!` 的 PIN 可以原样到达 SafeNet。打包流程不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 运行时准备子进程；它只向 electron-builder 提供四个配置输入，在其他字段已经清理的环境中只向签名 CMD 提供经过校验的签名字段，在 SignTool 启动前清除这些字段，并遮盖 SignTool 诊断。SafeNet 仍要求 PIN 出现在 SignTool 进程命令行中。只能在连接了物理 Token 的受控 self-hosted Windows runner 上把它注入为临时 secret；绝不能提交该值、把它写进 `.env`，或持久保存为 Windows 用户或系统环境变量。

使用对应的 `:dir` 命令可以生成可直接运行的应用目录，而不是安装包，例如：

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

需要检查或诊断为宿主目标准备的资源而不调用 electron-builder 时，可以让同一流水线在准备完成后停止：

```sh
pnpm run prepare:desktop
```

这条诊断命令是另一种停止位置，并非两条命令构建流程的前半段。之后执行 `package:desktop*` 时仍会重新完成正式构建与准备，避免使用陈旧的 dsh 包、运行时文件或 dsh 内容。

每条打包命令都会构建仓库，打包以 dsh 和私有 Desktop Host 为根的第一方生产依赖闭包，并准备目标专用的 Node 与 pnpm 可执行文件。`prepare:dsh` 在构建时安装一次生产依赖图，把物化包复制到 `extraResources/dsh`，移除包管理器元数据，并生成包含共享包版本和最终文件哈希的 `desktop-runtime.json`。在 macOS 上，它先签名并验证原生文件，再生成清单；electron-builder 不对已签名的此目录重复进行嵌套签名。资源映射明确包含默认根目录过滤器会忽略的 `dsh/node_modules`；复制后的清单在签名前及签名后分别验证。签名安装包、公证、已安装应用升级和各目标原生模块的验收需要发布环境。

未压缩产物包含 Electron、物化后的 dsh 生产依赖树、上游 Node.js 与 pnpm，以及壳应用。安装包大小与文件系统占用不同；发布验收需要测量两者，以及 profile 插件存储和首次启动耗时。此布局用更多应用内文件换取消除用户机器上的核心包安装过程。

## 更新

打包应用会在主窗口打开十秒后检查目标专用的发布流；本地化的 **检查更新…** 菜单项会手动触发同一检查。发现可用版本时，应用打开一个原生确认弹窗。用户确认后，应用等待正在进行的检查完成，下载并验证已签名的 Desktop 发布、停止 dsh 子进程，并把安装与重启交给 electron-updater。下次启动在显示本地加载页的同时校准版本绑定的运行时。

签名打包为 `DSH_DESKTOP_AUTO_UPDATE_ENV` 选择的部署生成 generic-provider 频道元数据。NSIS 差分包与 macOS ZIP 目标让 electron-updater 可以复用未变化的数据块；供手动安装的 DMG 经过公证，但不生成 blockmap，因为它不是 macOS updater 的载荷。运行时与桌面壳仍属于同一个签名 Desktop 发布。macOS 签名与公证凭据使用 electron-builder 的标准环境变量；Windows EV 签名使用上文所述的公开证书、已验证 SignTool、SafeNet 容器和 runner PIN。必填 Desktop 发布环境选择构建所验证的应用身份与平台签名身份。

## 底层开发覆盖项

未打包的 Electron 进程使用应用目录下的 `.desktop-build/development/project` 作为开发项目。`DSH_DESKTOP_NODE_BINARY`、`DSH_DESKTOP_PNPM_ENTRY` 和 `DSH_DESKTOP_DSH_DIR` 用于选择明确的运行时资源。打包应用会忽略这些变量，从 `process.resourcesPath` 解析签名资源，并使用受管 Desktop profile。

## 已知限制

- Desktop 禁用 Web 的「在本地应用中打开…」操作，因为其 Host 插件依赖 HTTP 路由，而 Desktop 不提供 `webServer`。
- 发布签名、公证、更新托管和跨上一版本的已安装产物验证需要生产发布环境。
- 依赖包含 lifecycle script 的桌面插件，只有其包名进入桌面项目经过评审的 `allowBuilds` 策略后才能安装。
- 桌面壳与 CLI dsh 共享 `$DSH_HOME` 下的会话、设置、凭据、工作区和存储，但可执行包、插件激活、锁文件与包管理器状态彼此隔离。
