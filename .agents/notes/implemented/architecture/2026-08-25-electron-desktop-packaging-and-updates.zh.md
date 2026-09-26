# Agent Note: 打包并更新 Electron 桌面应用

Status: implemented

[English](2026-08-25-electron-desktop-packaging-and-updates.md) | 中文

插件管理和原生恢复遵循[共享 Web 薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)。

[Electron 运行时决策](2026-09-11-desktop-electron-node-runtime.zh.md)替代独立上游 Node 可执行文件的选择；本文其他决策仍然适用。

## 问题

DeepSeek Harness 需要一个复用 Web UI 的 Electron 桌面应用。该应用无需系统 Node.js 或 pnpm 即可工作，通过应用内置 pnpm 安装 dsh 与桌面插件，并通过一个面向用户的流程更新完整桌面发布。

桌面应用与通过 npm 安装的 dsh 共享 `.dsh` 数据根目录，但两者可能使用不同的 dsh 与插件版本。它们必须共享受支持的产品数据，同时不得共享可执行包、lockfile、`node_modules`、插件激活状态或包管理器配置。

当前 GUI 协议绑定 Web 客户端与后端版本。Electron 产物与其中通过 内置 dsh 如果独立定版本，就会产生未经验证的壳、客户端、后端与插件组合，也无法明确判断更新是否可用。

## 决策

交付小型 Electron 壳和固定版本 pnpm；[运行时决策](2026-09-11-desktop-electron-node-runtime.zh.md)持有可执行文件选择。[薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)负责 Host 启动与传输：私有 Host 运行共享 Web profile runner，Electron 加载其认证 HTTP URL，子进程 IPC 承载生命周期消息。

Electron 拥有 `.dsh/profiles/desktop` 保留 profile。[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)负责核心资源存储、外部插件依赖、共享包链接和 profile 协调。私有 Desktop Host 保持独立于公共 CLI 包，且不会发布到 npm。

一个 Desktop 发布号同时标识 Electron 产物及其精确的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 依赖。发布不能在构建或运行时选择不同的核心版本。因此，即使壳代码没有变化，更新 dsh 也必须产生新的 Electron 发布。

Desktop Host 为保留 profile 提供共享 Web 插件管理器，并通过启动器信息提供内置 pnpm。CLI 保留 `desktop` 名称的所有大小写变体，并拒绝针对它的启动、配置 dump 和插件管理请求。Electron 在 profile 恢复或 Host 启动前获取进程生命周期单实例锁；后续启动只会聚焦或重建主窗口，不会接触 profile 状态。

## 归属

| Owner | 职责 |
|---|---|
| Electron 壳 | 窗口与子进程生命周期、保留 desktop profile 准备、原生恢复、更新协调 |
| Electron RunAsNode 与 pnpm | 执行 dsh 并安装桌面项目依赖，使用 pnpm 的正常配置 |
| Desktop profile | 由内置运行时决策定义的外部插件依赖、已启用 bundle 顺序和共享链接 |
| 私有 Desktop Host 包 | 与 dsh 一起安装、但不进入公共 CLI 包或 npm 发布的 Electron 专用子进程入口与组合 overlay |
| 已安装 dsh 包 | 后端、匹配的 Web UI、启动 manifest、客户端包和产品行为 |
| 共享 `.dsh` owner | 会话、设置、凭据、工作区和存储，由其现有锁与格式版本保护 |
| 通过 npm 安装的 dsh | 自己的可执行安装和用户管理的 profile；不能访问保留 desktop profile 或包状态 |

渲染进程使用 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`。Preload 提供启动就绪与失败报告、原生目录选择、主题同步，以及 Windows 菜单和外观适配。它不暴露原始 `ipcRenderer`、文件系统访问、shell 命令或 pnpm 参数。Electron 菜单与原生对话框使用类型化中英文文案，并以英文回退；Windows 跟随主文档语言。共享 Web 插件管理器负责自身客户端文案。

更新确认使用 shell 静态 origin，因为 Web Host 尚未就绪时也必须可用。其打包文档和资源保留与其他本地静态资源相同的方法和路径限制。

## 文件系统布局

```text
~/.dsh/
  profiles/
    desktop/
      package.json
      pnpm-lock.yaml
      lock
      pnpm-workspace.yaml
      node_modules/
  sessions/
  storages/
```

`.dsh/profiles/desktop` 是唯一活动桌面 profile。其可执行包归属及允许解析的目录遵循[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)。pnpm 根据正常配置选择 store 和缓存。

## 安装与解析

共享 Web 插件管理器负责 profile 包操作。Electron 保留启动准备和原生恢复；[Web 薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)负责这一职责划分。

Electron 进程生命周期锁是 Desktop 的权威所有者。profile 准备和原生恢复使用记录 Electron PID 的排他锁；存活的所有者阻止竞争操作，失效 PID 可被回收。Web 包操作使用共享插件管理器的锁。

核心物化、首次启动、插件安装和共享模块解析遵循[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)。实际 Host 启动时会组合已启用且提供 `dsh.client` 代码的桌面插件。

## 更新与恢复

Electron 更新只使用一个 `electron-updater` 发布流和签名 `electron-builder` 产物。该版本就是 Desktop 发布版本；不存在独立 dsh manifest、兼容范围或仅更新 dsh 的操作。前台安装会等待正在进行的后台检查，而不会把检查结果复用成安装结果。更新弹窗下载并安装 Electron 产物，然后重启进入新发布。

[立即显示窗口决策](2026-09-09-desktop-immediate-window-and-direct-start.zh.md)负责本地加载页、直接启动 Host 和主窗口恢复。profile 协调遵循[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)。

`DSH_DESKTOP_AUTO_UPDATE_ENV` 默认为测试部署，也可以选择生产部署，并同时决定目标专用的 generic-provider URL 与 COS 目标。发布自动化通过 `DOWNLOAD_TEST_ORIGIN` 提供测试 HTTPS origin，并通过 `DOWNLOAD_TEST_COS_BUCKET` 或 `DOWNLOAD_PROD_COS_BUCKET` 提供各部署的 bucket；可变的测试路由与 COS 存储身份不写入源码，部署基础设施变更时无需发布新代码，而公开的生产 origin 仍固定。打包只解析公开更新 URL、禁止 electron-builder 发布、从子进程环境中删除每个 COS 凭据字段，并且只有在 electron-builder 以及每个签名或公证 hook 成功后才写入完成记录。目标上传还必须提供所选 bucket，随后会先要求完成记录、根 dsh 版本、Desktop 版本、根据版本得出的频道元数据、产物名称、大小与 SHA-512 全部一致，再读取所选凭据或发送数据。它先上传不可变且带版本的更新载荷与所有独立 blockmap，最后替换 electron-builder 生成的频道元数据，并且不会删除历史对象。稳定版本使用 `latest` 元数据名称，预发布版本则使用语义化版本的第一个预发布标识符。NSIS 把 blockmap 嵌入已签名的可执行文件，macOS ZIP 则使用独立 blockmap；两者都让 electron-updater 在平台支持时只下载变化的数据块，而应用替换与本地 pnpm 包操作仍是两个独立操作。

测试发布必须从平台 dotenv 文件提供 `DOWNLOAD_TEST_RELEASE_ID`。清单和安装包共用 `dsh-desk/<release-id>/`，生产环境保留固定目录。ID 是打包更新 URL 的一部分，因此上传会拒绝不同的 ID。轮换后可通过内部分发提供新安装包，已安装客户端保留原清单地址。随机目录降低被猜中的概率，但不对持有链接者进行鉴权。[发布配置](../../../../apps/desktop/README.zh.md#upload-updates)定义生成与复用方式。

## 安全与发布策略

核心 dsh 和私有 Desktop Host 只来自签名应用的资源树。插件安装把包规格交给 pnpm，包括本地和远程来源，但不接受原始 pnpm 命令。pnpm 负责依赖解析和 profile 的 `allowBuilds` 策略；Host 加载已启用的 bundle。

Electron 发布产物必须签名；macOS 产物必须公证。打包与上传命令从 Git 忽略的目标 `.env.windows` 或 `.env.macos` 读取发布配置，子进程通过编排器选择的环境字段接收配置。目标文件是发布字段的唯一来源，避免旧的 shell 或系统凭据覆盖本地选择；配置加载不修改父进程环境。打包在构建、下载或清理发布记录前校验该模式必需的应用 ID、更新地址、签名身份及本地文件，macOS 还要求一套完整公证凭据。单独的 `check:package` 执行同一校验而不访问 Token 或 Apple；凭据真实性仍由实际签名与公证验证。配置加载会拒绝缺失或格式错误的标识符和不完整的公证凭据，macOS 打包还会强制签名，避免证书发现过程静默选择其他已安装身份或生成未签名发布。运行时准备会验证每个内嵌 Mach-O 文件的精确 Authority 与 Team ID，以及时间戳和 hardened-runtime 标记。签名后钩子会执行 Apple 的深度严格应用验证，并要求同一叶证书 Authority 与 Team ID 完全匹配，验证通过后才继续生成产物。固定目标安装包命令使用[隔离的 App 副本并行公证](../process/2026-09-09-parallel-macos-notarization.zh.md)：ZIP 包含已钉票的 App，签名 DMG 则携带覆盖其中未钉票 App 的票据。DMG 的 artifact-completion hook 要求其使用配置的身份、具备有效票据并通过 Gatekeeper。只有两条产物流都成功，命令才会移入其输出并写入发布完成记录；仅生成目录的命令仍会公证 App 并钉票。macOS 更新使用签名 ZIP，因此 DMG 不生成 blockmap；否则钉票会让已经生成的 DMG blockmap 失效。

[固定版本的 osx-sign 补丁](../../../../patches/@electron__osx-sign@1.3.3.patch)在两种已发布模块构建中使用 `lstat`，因此 Framework 的文件和目录别名不会触发重复签名。选定的上游版本能够跳过这些别名前，仍需保留该补丁。PAK 文件由外层 bundle 签名记录完整性；逐个签名会增加串行时间戳请求，但不会增加资源完整性保护。Desktop 保留全部语言文件，只跳过其单独签名。可执行代码仍使用 Developer ID 签名、安全时间戳和 hardened runtime。[签名器遍历回归测试](../../../../apps/desktop/tests/macos-signing-walk.spec.ts)使用真实 Framework 别名执行已安装依赖；发布验收仍要求严格应用验证、公证和启动。

Windows 发布打包通过 `/f` 向已配置且与 SafeNet 兼容的 SignTool 提供 `DSH_DESKTOP_WINDOWS_CER_FILE` 指定的公开 EV 叶证书，并通过必需的 `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` 标识匹配的私钥。证书文件保留在源码仓库之外，私钥仍留在 USB Token 上。electron-builder hook 把每个产物交给采用 CRLF 的 `windows-sign.cmd`；该 CMD 只调用一次 SignTool，并指定 SafeNet `/kc "[{{PIN}}]=容器"` 值与 CSP、SHA-256 文件摘要和 DigiCert SHA-256 RFC 3161 时间戳。hook 不会改用其他 SignTool，也不会重试失败的请求。打包编排不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 运行时准备子进程，只会把证书路径、SignTool 路径、密钥容器和 PIN 传入 electron-builder。签名器在已清理的 CMD 环境中只提供经过校验的签名字段；CMD 会禁用延迟展开，在 SignTool 启动前清除这些字段，并仅在 SignTool 必需的命令行中保留 PIN。所有对外诊断都会替换 PIN，而且只能允许专用构建账号和管理员检查该 runner。签名器会在企业 Code Integrity 检查 electron-builder 的临时 NSIS bootstrap 前先为该可执行文件签名；对于生成的可执行文件，只有证书表条目指向文件末尾之外时，才会在最终签名前清除该条目。SignTool、证书、容器、PIN、Token 或签名不可用时，打包会在产生未签名产物前失败。

Windows 打包调用强制设置 `ELECTRON_BUILDER_7Z_FILTER=BCJ`。内置的 7-Zip 24.09 编码器会为 ARM64 PE 文件自动选择 ARM64 过滤器，但 `nsis-resources-3.4.1` 中的 NSIS 解码器会在解压时遗漏这些条目。使用实际 NSIS 插件的原生解压验证表明，自动过滤会丢失两个 `node-pty` ARM64 二进制文件，而 BCJ 可以逐字节还原二者。使用兼容的过滤器能够保留依赖内容与运行时完整性，无需删除特定架构的文件或削弱校验。

本地 Windows 安装测试使用显式的 `--unsigned` 打包调用，并执行相同的构建和运行时准备。它清除证书输入，将产物隔离到 `unsigned-artifacts`，并省略更新器配置和发布完成记录。即使父进程环境请求未签名模式，常规打包命令也会显式选择签名模式。这样既能在没有 EV Token 时诊断安装问题，也能防止本地测试产物通过发布上传校验。

Windows 应用替换遵循[目录安装决策](2026-09-11-windows-directory-installation.zh.md)：使用能返回失败状态的命令行工具解压到目标旁边，再在同卷内改名替换完整目录。安装器在暂存期间保留旧目录，正式替换失败时恢复旧目录。注册信息、快捷方式和签名卸载器仍由 electron-builder 持有。

打包应用会忽略开发资源和项目环境变量覆盖。只有未打包的 Electron 进程可以替换 pnpm 入口、dsh 资源 或活跃项目。

分架构构建报告实际组件级压缩体积和安装体积。

## 实现

| 表面 | 实现 |
|---|---|
| 壳 | `apps/desktop` 负责 Electron 窗口、受限 preload、自定义协议、子进程生命周期、profile 准备、原生恢复、更新协调和 electron-builder 配置。 |
| 已安装运行时 | 私有 `@deepseek-ai/dsh-desktop-host` 调用共享 profile runner，并向 Electron 报告认证 Web URL。 |
| 包状态 | Electron RunAsNode 执行不可变核心资源；内置 pnpm 只修改 Desktop profile 中的外部插件依赖图。 |
| 资格验证 | macOS 打包要求已配置的公司身份与公证凭据可用，在生成清单前验证每个原生运行时文件，验证完整应用签名，并要求应用和 DMG 都完成公证且通过 Gatekeeper。Windows 打包要求已配置的公开证书、SafeNet 私钥容器、Token Password 与 SignTool，并验证生成的每个签名。更新托管、跨上一版本的已安装产物测试和各平台 GUI 录制仍是发布环境门槛。 |

`dev:desktop` 会构建当前 workspace，把已构建 CLI 包、私有 Desktop Host 包及其依赖链接投影为一次性项目，使用隔离的 Harness home，打开 Main、Renderer 和 Host 调试器，并在不准备发布资源的情况下启动未打包 Electron。开发运行时为独立的插件 profile 提供工作区链接；插件管理和恢复使用与打包应用相同的流程。固定的 macOS arm64、macOS x64 与 Windows x64 打包命令会把同一目标传给运行时准备、dsh 准备和 electron-builder；每条命令还提供未封装安装器的变体，用于在生成安装器前验证发布路径。

## 考虑过的替代方案

**使用 Electron 的 Node.js 执行 dsh。** 这可以减小包体积，但会让 dsh 耦合到 Electron 的 Node 补丁、fuse、原生 ABI、TLS 行为和进程生命周期。内置上游 Node.js 可以让 dsh 继续使用其受支持运行时。

**通过 JSON IPC 以 Base64 承载 Fetch 消息体。** 这会膨胀请求与响应消息体、在两个进程中构造大字符串，并在分派前缓冲请求。原始分帧管道避免 Base64 膨胀，但仍需维护第二套传输；[薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)选择已有的 Web HTTP 传输。

**把产品 Web UI 永久打包进 Electron。** 独立 UI 与后端更新需要新的版本化兼容计划。从同一个 dsh 包安装后端与 Web UI 可以保持当前发布绑定。

**维护 Electron 专用插件安装器。** 独立页面、IPC API 和包服务会重复共享 Web 管理器的功能。共享服务使用保留 Desktop profile 和启动器提供的 pnpm，同时继续禁止 CLI 访问该 profile。

**让桌面 profile 使用 CLI 管理的包或插件。** 任一产品都可能改变另一产品的依赖图、Cordis 版本、插件版本或原生模块。Desktop 拒绝通过 CLI profile 回退目录解析包。

**分离核心与插件解析，却不提供共享包链接。** pnpm 未安装宿主 peer 包时，插件需要访问内置运行时。[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)通过明确链接提供 profile 缺失的包，同时保留 pnpm 安装的包。

**从 registry 包删除非目标 Mach-O 文件。** 架构裁剪可以节省少量 运行时空间，但包可能有意附带多个架构变体，调用方也可以观察安装后的文件集。签署每个实际携带的 Mach-O 对象，无需发明 Desktop 专属包布局就能满足公证要求。

**把 Windows EV 私钥导出到 PFX 文件。** 外部提供的公开叶证书让 SignTool 构造签名，`/csp` 与 `/kc` 则定位硬件密钥。EV 私钥保持不可导出，并留在 Token 上。

**把凭据写进已跟踪脚本或系统环境。** 本地平台文件把配置限制在单个 checkout，并使打包输入明确。代价是凭据以明文落盘：构建账号需要限制文件访问权限，CI 必须清理临时配置，Git 与发布文件映射都必须排除真实配置。已提交的模板不含凭据；Windows CMD 只包含变量引用，签名串行执行并在首次失败后停止，文件格式不会免除 Token 的错误 PIN 计数。

**让 electron-builder 或通用目录同步直接发布。** 直接发布可能在所有引用产物就绪前暴露频道元数据，可能把陈旧或其他目标的文件混入发布，也无法证明已完成签名的构建仍与当前 dsh 版本一致。目标专用且经过校验的上传可以明确控制发布顺序与发布身份。

## 结果

- 没有系统 Node.js 或 pnpm 的干净离线机器能够启动内置 dsh，无需安装核心依赖。
- 签名应用记录最终运行时文件清单；每个 macOS 原生文件都具有发布 Developer ID、安全时间戳和 hardened runtime，每个 Windows 产物都具有配置的硬件 EV 签名。
- `.dsh/profiles/desktop/node_modules` 保存由共享 Web 插件管理器管理的外部插件。
- Desktop 包操作使用启动器提供的内置 pnpm，以及共享管理器的子进程环境与 profile 配置。
- 主应用的“插件”页面向共享 Host 服务发送结构化包操作与激活请求。
- 独立 CLI 仍不能访问保留 Desktop profile。
- npm/CLI dsh 与 Electron 绝不从对方的 `node_modules` 解析或安装插件。
- 在产品 UI 加载前，活跃后端与 Web UI 报告相同 dsh 版本和兼容壳 API。
- 共享插件管理器负责包操作失败处理；原生恢复负责 Host 致命故障。
- 一个 Desktop 版本绑定 Electron 与 dsh；每次 dsh 更新都通过一个 Electron 更新弹窗交付，并产生一次用户可见的重启。
- 共享 `.dsh` 数据在迁移或修改前拒绝不兼容的读取方。
- Web 应用负责 HTTP 认证与服务；沙箱渲染进程不能访问任意文件系统或 Electron API。
- Workspace 开发无需下载发布资源即可运行当前已构建代码，未封装安装器的应用验证仍保留生产安装路径。
- Windows 发布打包要求已验证的 SignTool、EV Token、匹配的公开叶证书、Token Password 和明确的密钥容器，绝不会回退到未签名产物或可导出的密钥文件。
- 目标更新只有在已完成签名的构建及其引用的每个产物通过发布校验后才能暴露新频道元数据；保留的历史产物继续供差分更新使用。
- 每个发布阻断平台上的签名已安装产物均能从上一个受支持版本成功更新。

## 评审决策

| 决策 | 建议 |
|---|---|
| 首次启动 | 检查内置发布元数据并创建 profile 链接，不安装核心依赖 |
| 桌面 profile | 一个由 Electron 拥有的保留 profile，保存外部插件和共享包链接 |
| 插件管理 | 共享 Web“插件”页面与 Host 服务，使用启动器提供的内置 pnpm |
| 激活 | 启用 HMR 时由共享管理器应用配置；否则变更需要重启 |
| 初始平台 | macOS arm64/x64 与 Windows x64；Linux 尚无受支持的发布目标 |
| 更新行为 | 后台检查，差分下载与重启前显式确认，启动时校准 dsh |

## 风险

插件生命周期脚本会执行第三方代码。profile 的 `allowBuilds` 配置决定哪些构建获准执行。

更新绑定的 dsh 可能使插件 peer 依赖或原生模块不兼容。原生恢复可以禁用第三方 bundle 并重启应用，之后可通过共享“插件”页面修复。

通过 npm 安装的 dsh 与桌面 dsh 可能在共享持久化数据时使用不同版本。每个共享 owner 都必须在读取、迁移或写入前执行格式版本与进程锁。

包操作失败与取消遵循共享插件管理器的还原规则。原生恢复不会重新安装包。

代码签名、公证和更新托管需要生产发布基础设施。只运行仓库测试不能完成这些认证。

## 相关提案

[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)负责核心资源与外部插件依赖。[薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)负责共享 Web 传输和插件管理。发布身份、签名与进程归属仍由本记录负责。
