# Agent Note: 打包并更新 Electron 桌面应用

Status: implemented

[English](2026-08-25-electron-desktop-packaging-and-updates.md) | 中文

## 问题

DeepSeek Harness 需要一个复用 Web UI 的 Electron 桌面应用。该应用无需系统 Node.js 或 pnpm 即可工作，通过应用内置 pnpm 安装 dsh 与桌面插件，并通过一个面向用户的流程更新完整桌面发布。

桌面应用与通过 npm 安装的 dsh 共享 `.dsh` 数据根目录，但两者可能使用不同的 dsh 与插件版本。它们必须共享受支持的产品数据，同时不得共享可执行包、lockfile、`node_modules`、插件激活状态或包管理器配置。

当前 GUI 协议绑定 Web 客户端与后端版本。Electron 产物与其中通过 pnpm 安装的 dsh 如果独立定版本，就会产生未经验证的壳、客户端、后端与插件组合，也无法明确判断更新是否可用。

## 决策

交付一个小型 Electron 壳，其中内置上游 Node.js 可执行文件和固定版本的 pnpm。Electron 把私有 Desktop Host 包作为隔离子进程启动；该包组合已安装的 dsh 后端与匹配的客户端图。Fetch 元数据及有界的原始请求与响应分块通过两条带版本的分帧字节管道传递，Node IPC 只承载就绪、致命失败和关闭，Electron 通过 `dsh-app://` 提供经过验证的资源；它不会打开监听端口。每个帧都包含固定标记、类型、单调 stream id、负载长度和经过验证的负载。串行 writer 遵守 pipe drain，请求或响应 stream 施加背压时 reader 会全局暂停，取消会关闭匹配的 stream，已退役 stream 的迟到响应帧保持无效。Connection 插件无需 `webServer` 即可提供与载体无关的 RPC 与 Fetch 注册表，Client Modules 则向 shell-owned carrier 提供与广告内容完全一致的组合 bundle 响应；Web 组合为两者挂载可选 HTTP route。渲染进程保留相同的 Fetch、RPC 与 Remote-stream 格式，子进程载体则避免 Base64 膨胀，也不依赖 Electron 与内置上游 Node.js 之间的 V8 序列化兼容性。发送 shutdown 后，Electron 会关闭自己持有的请求管道写端，以便在等待子进程退出前释放 Windows 上仍在进行的管道读取。该设计沿用 [GUI 分层与 RPC 协议 Agent Note](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)中的 Electron 预留。

Electron 拥有保留 profile `.dsh/profiles/desktop`。其中精确的 `@deepseek-ai/dsh` 依赖提供后端与匹配的 Web UI，匹配的私有 `@deepseek-ai/dsh-desktop-host` 依赖则只提供 Electron 子进程入口与组合 overlay。dsh 发布、私有 Host 及其第一方依赖闭包使用同一次源码构建生成的本地 npm tarball；profile manifest 把每个核心包列为本地 `file:` 依赖，`pnpm-workspace.yaml` 再通过 overrides 重复该映射。Host 不进入公共 CLI 包，也不会发布到 npm。桌面插件既是同一 profile 中来自 registry 的其他 npm 依赖，也是有序的 `dsh.profile.bundles` 条目，并从该 profile 唯一的 `node_modules` 解析。

一个 Desktop 发布号同时标识 Electron 产物及其精确的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 依赖。发布不能在构建或运行时选择不同的核心版本。因此，即使壳代码没有变化，更新 dsh 也必须产生新的 Electron 发布。

浏览器 Web UI、dsh 后端、现有 `dsh plugin` CLI、用户 npm 和用户 pnpm 都不能修改该 profile。CLI 保留 `desktop` 名称的所有大小写变体，并拒绝针对它的启动、配置 dump 和插件管理请求。Electron 在项目恢复或 Host 启动前获取进程生命周期单实例锁；后续启动只会聚焦或重建主窗口，不会接触 profile 状态。Electron-only GUI 通过 preload 发送结构化安装、删除和更新请求；Electron 只调用其内置 pnpm。

## 归属

| Owner | 职责 |
|---|---|
| Electron 壳 | 窗口与子进程生命周期、分帧字节管道、生命周期 IPC、自定义协议、保留 desktop profile、插件 GUI、更新协调、回滚 |
| 内置 Node.js 与 pnpm | 执行 dsh 并安装桌面项目的精确依赖，不读取用户 `PATH` 或 pnpm 状态 |
| Desktop profile | 为桌面 dsh 包与桌面插件提供一个依赖图、有序 bundle 列表和一个 `node_modules` |
| 私有 Desktop Host 包 | 与 dsh 一起安装、但不进入公共 CLI 包或 npm 发布的 Electron 专用子进程入口与组合 overlay |
| 已安装 dsh 包 | 后端、匹配的 Web UI、启动 manifest、客户端包和产品行为 |
| 共享 `.dsh` owner | 会话、设置、凭据、工作区和存储，由其现有锁与格式版本保护 |
| 通过 npm 安装的 dsh | 自己的可执行安装和用户管理的 profile；不能访问保留 desktop profile 或包状态 |

渲染进程使用 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`。Preload 暴露类型化 RPC、生命周期、更新、locale 与桌面插件操作，而不暴露原始 `ipcRenderer`、文件系统访问、shell 命令或 pnpm 参数。Electron 根据应用 locale 选择类型化的中英文字典，并以英文作为 fallback；菜单、原生对话框与插件管理渲染进程使用这些由 locale 持有的文案。

## 文件系统布局

```text
~/.dsh/
  desktop/
    staging/<transaction-id>/profile/
    rollback/profile/
    pending.json
    lock
    pnpm/
      store/
      cache/
      state/
      config/
  profiles/
    desktop/
      package.json
      pnpm-lock.yaml
      pnpm-workspace.yaml
      desktop-release.json
      desktop-packages.json
      desktop-packages/
      node_modules/
  sessions/
  storages/
```

`.dsh/profiles/desktop` 是唯一活跃的 desktop profile。其 package manifest 记录内置与已安装插件 bundle 的顺序；只有 Electron 可以修改它的依赖、lockfile 和 `node_modules`。生产启动会拒绝解析到该 profile 之外的 bundle，包括 CLI 维护的 `.dsh/profiles/node_modules` fallback。desktop profile 安装的所有包内容都使用 `.dsh/desktop/pnpm/store`。

## 安装与解析

安装器绝不原地修改活跃 profile。它把 profile 元数据复制到事务暂存目录，并使用内置 pnpm 应用精确依赖变更。测试 staging 前，Electron 会停止活跃后端；它单独启动并停止 staging 后端，再在激活前恢复活跃后端，因此两个 Desktop 后端绝不会并发共享 `.dsh` 状态。激活过程再次停止后端，在对应目录移动前先持久化 `pending.json` 的每个下一阶段，把活跃 profile 移到 `rollback/profile`，把暂存 profile 移到 `.dsh/profiles/desktop`，然后重启。恢复过程会结合预写阶段与真实的 active、rollback 和 staging 目录，因此任一个写入与移动间隙中断后仍会保留或恢复一个完整 profile。

进程生命周期 Electron 锁是 Desktop 的权威 owner。包事务锁用于纵深防御，并记录仍能修改包状态的进程：包操作之间记录 Electron，pnpm 运行期间记录已生成的 pnpm PID。Owner 变更通过已经打开的排他锁文件完成截断、写入与同步。如果 Electron 在 pnpm 执行期间终止，后续进程会发现仍存活的 worker，并拒绝启动并发的 store 或 staging 事务；该 worker 退出后，陈旧 PID 才可以恢复。

打包 seed 是离线安装包，而不是可执行 dsh 目录。它包含发布身份、初始桌面项目 manifest、分别以 dsh 和私有 Desktop Host 为根的第一方包闭包之并集的描述文件及不可变 tarball、lockfile、完整性清单和所需 store 子集。每个 `mac-arm64`、`mac-x64` 和 `win-x64` 构建都在 `.desktop-build/targets/<target>` 下持有自己的打包输入、运行时、包集合、seed、pnpm 准备状态、未打包应用、更新元数据和最终产物；只有不可变且经过校验和验证的 Node.js 下载缓存会被共享。发布构建要求 Electron 包、根 dsh 包与私有 Host 包使用相同版本，从正式源码构建生成最终 npm tarball，在本地打包私有 Host，选择可达的 dsh、Host 与 vendored 包以及 Landlock 入口，并验证 Host tarball 中包含 `lib/index.js` 与 `config/desktop.cordis.patch.yml`。Host 的 `files` manifest 只包含该运行入口与 overlay，并且该包不会发布到 npm。公共包 tarball 仍是由各包发布 manifest 控制的正式 `pnpm pack` 结果；Desktop 不删除已发布的声明文件，也不建立第二套包内容策略。seed manifest 把每个选中的包列为本地直接依赖，关闭 peer dependency 自动安装，workspace 文件再把每个选中的第一方包 override 到对应本地 tarball。目标 Node.js 执行内置 pnpm，因此 pnpm 的操作系统和 CPU 选择会使物化的依赖图与 seed 成为目标专用内容。内置 pnpm 关闭全局 virtual store，在禁用生命周期脚本的情况下从 npm 物化外部生产依赖，删除 `node_modules` 以及所有临时 pnpm cache、config 和 state 目录，然后只使用最终 store 执行一次干净的离线安装，并检查私有 Host 的入口与 overlay。构建会拒绝任何通过 registry 版本解析本地第一方包名的 lockfile。生成清单前会删除第二次生成的 `node_modules` 和临时 pnpm 项目注册。在复制 package set 前与离线安装后都要求这两个 Host 文件，可防止进程入口能够加载、却无法组合所需 overlay 的发布进入应用签名阶段。

种子根据规范化 store 路径，把 pnpm 内容放入 16 个确定性的未压缩 tar 分片。Apple 公证会检查这些归档内的 Mach-O 代码，因此 macOS seed 会 staging 每个被引用的内容寻址 Mach-O 对象，最多并发四个独立的 Developer ID 签名进程，并带上安全时间戳与 hardened runtime。任一签名失败后，准备过程会等待已启动的签名进程全部退出，原始 CAS 对象与包索引保持不变。所有签名成功后，准备过程把每个对象写到新的 SHA-512 路径，并以事务方式重写 pnpm MessagePack SQLite 索引内全部基础文件和 side-effects 文件引用。第二次离线安装证明 pnpm 可以解析重写后的 store；准备过程随后完成分片、解包最终归档并验证每个内嵌签名。包路径和非原生字节保持不变；种子保留包内附带的架构变体，因为删除文件会创建 Desktop 专属的包文件集。种子完整性覆盖分片 manifest 和解包前的每个归档。启动时验证归档路径、条目类型、唯一性和数量，把所有分片解包到唯一且由 Desktop 拥有的 staging 目录，替换匹配的不可变 store 文件，并以事务方式把各 pnpm store 版本的 SQLite `package_index` 合并进 `.dsh/desktop/pnpm/store`。Seed 记录替换匹配的键，为 Desktop 插件下载的记录继续保留。中断的文件合并可能留下有效的不可变缓存内容，但每次 SQLite 合并都是原子的，profile 安装与激活仍必须通过 pnpm 完整性与完整健康检查。

启动过程先要求安装包内的发布身份等于 Electron 应用版本，再在启动后端前比较 `.dsh/profiles/desktop/desktop-release.json`、已安装 dsh 包、已安装 Desktop Host 包与该发布版本。它在 staging 中通过 `pnpm install --offline --frozen-lockfile --trust-lockfile` 安装新的 seed manifest 与 lockfile。Electron 替换后，启动过程再通过一次离线 pnpm add，从桌面端现有 store 与元数据缓存恢复活跃 profile 记录的每个插件 bundle 精确版本。完整依赖图必须通过同一套健康检查才能激活。

插件 GUI 执行等价于 `pnpm add <package> --save-exact`、`pnpm remove <package>` 和精确版本更新的 registry npm 包操作。每次修改都保留本地核心包描述文件、tarball、dsh 与 Desktop Host 依赖和完整 override 映射。Electron 验证已安装包 manifest，并更新 profile 的依赖与有序 bundle 条目；任何渲染进程请求都不能选择 registry、安装目录、生命周期策略或任意 pnpm flag。

后端与 Loader 把 `.dsh/profiles/desktop/package.json` 作为 profile manifest 和 npm 解析锚点。公共 profile loader 先组合其中的有序 bundle 条目，再由私有 Desktop Host 应用其打包的 overlay。Host、dsh、Cordis、桌面插件、插件依赖和 peer dependency 均通过普通 pnpm `node_modules` 图解析。贡献 `dsh.client` 代码的桌面插件只有在完整 profile 通过健康检查后才进入启动 manifest。

## 更新与恢复

Electron 更新只使用一个 `electron-updater` 发布流和签名 `electron-builder` 产物。该版本就是 Desktop 发布版本；不存在独立 dsh manifest、兼容范围或仅更新 dsh 的操作。前台安装会等待正在进行的后台检查，而不会把检查结果复用成安装结果。更新弹窗下载并安装 Electron 产物，然后重启进入新发布。

新发布在打开窗口前从安装包种子校准 dsh，同时保留已安装桌面插件。健康检查覆盖依赖解析、原生模块、壳 API 兼容性、后端启停、Web 资源和客户端启动图。不兼容插件会阻止激活，并保留上一个项目用于回滚。启动过程会明确失败，而不会运行版本不匹配的壳与 dsh。

`DSH_DESKTOP_AUTO_UPDATE_ENV` 默认为测试部署，也可以选择生产部署，并同时决定目标专用的 generic-provider URL 与 COS 目标。发布自动化通过 `DOWNLOAD_TEST_ORIGIN` 提供测试 HTTPS origin，并通过 `DOWNLOAD_TEST_COS_BUCKET` 或 `DOWNLOAD_PROD_COS_BUCKET` 提供各部署的 bucket；可变的测试路由与 COS 存储身份不写入源码，部署基础设施变更时无需发布新代码，而公开的生产 origin 仍固定。打包只解析公开更新 URL、禁止 electron-builder 发布、从子进程环境中删除每个 COS 凭据字段，并且只有在 electron-builder 以及每个签名或公证 hook 成功后才写入完成记录。目标上传还必须提供所选 bucket，随后会先要求完成记录、根 dsh 版本、Desktop 版本、根据版本得出的频道元数据、产物名称、大小与 SHA-512 全部一致，再读取所选凭据或发送数据。它先上传不可变且带版本的更新载荷与所有独立 blockmap，最后替换 electron-builder 生成的频道元数据，并且不会删除历史对象。稳定版本使用 `latest` 元数据名称，预发布版本则使用语义化版本的第一个预发布标识符。NSIS 把 blockmap 嵌入已签名的可执行文件，macOS ZIP 则使用独立 blockmap；两者都让 electron-updater 在平台支持时只下载变化的数据块，而应用替换与本地 pnpm staging 事务仍是两个独立操作。

## 安全与发布策略

核心 dsh 与私有 Desktop Host 只能来自签名 Electron 发布内经过完整性记录的本地 npm tarball；pnpm overrides 防止传递核心包回退到 registry。Store 归档经过完整性检查，并在隔离的解包目录中完成全部验证，归档文件随后才能进入可写包状态。插件安装接受桌面策略允许的 registry 包 spec，但绝不接受原始 pnpm 命令。激活前必须具备精确版本、lockfile 完整性、经过评审的 `allowBuilds` 集合、仅限用户的目录权限、遮盖后的诊断和健康检查。

Electron 产物必须签名；macOS 产物必须公证。发布自动化必须通过明确的环境变量提供应用 ID、macOS Developer ID 限定名、预期 Team ID 与一套完整的 notarytool 凭据。配置加载会拒绝缺失或格式错误的标识符和不完整的公证凭据，macOS 打包还会强制签名，避免证书发现过程静默选择其他已安装身份或生成未签名发布。Seed 准备会验证每个内嵌 Mach-O 文件的精确 Authority 与 Team ID，以及时间戳和 hardened-runtime 标记。签名后钩子会执行 Apple 的深度严格应用验证，并要求同一叶证书 Authority 与 Team ID 完全匹配，验证通过后才继续生成产物。Electron-builder 随后公证应用并钉票、签署 DMG。DMG 的 artifact-completion hook 会单独公证每个 DMG 并钉票，再要求其使用配置的身份、具备有效票据并通过 Gatekeeper；只有该 hook 成功，上传事件才会执行。macOS 更新使用签名 ZIP，因此 DMG 不生成 blockmap；否则钉票会让已经生成的 DMG blockmap 失效。自定义协议提供已安装的前端分发目录和活跃模块图点名的客户端文件，并拒绝路径穿越或访问这些根目录之外的内容。插件安装器 API 只对 Electron 拥有的管理 GUI 可用，不存在于浏览器应用或后端 RPC 中。

Windows 发布打包通过 `/f` 向已配置且与 SafeNet 兼容的 SignTool 提供 `DSH_DESKTOP_WINDOWS_CER_FILE` 指定的公开 EV 叶证书，并通过必需的 `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` 标识匹配的私钥。证书文件保留在源码仓库之外，私钥仍留在 USB Token 上。electron-builder hook 把每个产物交给采用 CRLF 的 `windows-sign.cmd`；该 CMD 只调用一次 SignTool，并指定 SafeNet `/kc "[{{PIN}}]=容器"` 值与 CSP、SHA-256 文件摘要和 DigiCert SHA-256 RFC 3161 时间戳。hook 不会改用其他 SignTool，也不会重试失败的请求。打包编排不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 seed 准备子进程，只会把证书路径、SignTool 路径、密钥容器和 PIN 传入 electron-builder。签名器在已清理的 CMD 环境中只提供经过校验的签名字段；CMD 会禁用延迟展开，在 SignTool 启动前清除这些字段，并仅在 SignTool 必需的命令行中保留 PIN。所有对外诊断都会替换 PIN，而且只能允许专用构建账号和管理员检查该 runner。签名器会在企业 Code Integrity 检查 electron-builder 的临时 NSIS bootstrap 前先为该可执行文件签名；对于生成的可执行文件，只有证书表条目指向文件末尾之外时，才会在最终签名前清除该条目。SignTool、证书、容器、PIN、Token 或签名不可用时，打包会在产生未签名产物前失败。自定义协议提供已安装的前端分发目录和活跃模块图点名的客户端文件，并拒绝路径穿越或访问这些根目录之外的内容。插件安装器 API 只对 Electron 持有的管理 GUI 可用，不存在于浏览器应用或后端 RPC 中。

打包应用会忽略开发资源和项目环境变量覆盖。只有未打包的 Electron 进程可以替换 Node.js 可执行文件、pnpm 入口、seed 或活跃项目。

在种子 store 子集之外，内置上游 Node.js 与 pnpm 预计增加约 35–50 MB 压缩体积和 120–165 MB 安装体积。分架构构建必须报告实际组件级体积增量。

## 实现

| 表面 | 实现 |
|---|---|
| 壳 | `apps/desktop` 负责 Electron 窗口、受限 preload、自定义协议、子进程生命周期、项目事务、插件 GUI、更新协调和 electron-builder 配置。 |
| 已安装运行时 | 私有 `@deepseek-ai/dsh-desktop-host` 从活跃项目启动无端口桌面组合，并通过经过验证的分帧字节管道流式传输 API 与资源响应。 |
| 包状态 | 发布种子和后续每次修改都通过内置 Node.js 与 pnpm 执行，并使用桌面端拥有的 store、config、cache、state 和 home 路径；核心包从发布 tarball 解析，插件从固定 npm registry 解析。 |
| 资格验证 | macOS 打包要求已配置的公司身份与公证凭据可用，在解包最终归档后验证每个原生 seed 对象，验证完整应用签名，并要求应用和 DMG 都完成公证且通过 Gatekeeper。Windows 打包要求已配置的公开证书、SafeNet 私钥容器、Token Password 与 SignTool，并验证生成的每个签名。更新托管、跨上一版本的已安装产物测试和各平台 GUI 录制仍是发布环境门槛。 |

`dev:desktop` 会构建当前 workspace，把已构建 CLI 包、私有 Desktop Host 包及其依赖链接投影为一次性项目，使用隔离的 Harness home，打开 Main、Renderer 和 Host 调试器，并在不准备发布资源的情况下启动未打包 Electron。该模式的链接依赖图不是由 pnpm 安装的桌面项目，因此会禁用包修改。固定的 macOS arm64、macOS x64 与 Windows x64 打包命令会把同一目标传给运行时准备、seed 安装和 electron-builder；每条命令还提供未封装安装器的变体，用于在生成安装器前验证发布路径。

## 考虑过的替代方案

**使用 Electron 的 Node.js 执行 dsh。** 这可以减小包体积，但会让 dsh 耦合到 Electron 的 Node 补丁、fuse、原生 ABI、TLS 行为和进程生命周期。内置上游 Node.js 可以让 dsh 继续使用其受支持运行时。

**通过 JSON IPC 以 Base64 承载 Fetch 消息体。** JSON IPC 可以只保留一种消息机制，但会膨胀每个请求与响应消息体、在两个进程中构造大字符串、在分派前缓冲完整请求，还会再次编码 RPC JSON 中已经表示为 Base64 的图片字节。原始分帧管道保留明确的带版本协议，同时不要求 Electron 与上游 Node.js 共享 V8 序列化行为。

**把产品 Web UI 永久打包进 Electron。** 独立 UI 与后端更新需要新的版本化兼容计划。从同一个 dsh 包安装后端与 Web UI 可以保持当前发布绑定。

**复用现有 CLI 或浏览器插件安装器。** 这会跨越桌面授权与发布 scope，并可能使用用户的包管理器状态。桌面包修改完全由 Electron 拥有。

**让 desktop profile 使用 CLI 管理的包或插件。** 任一产品都可能改变另一方的依赖图、Cordis 版本、插件版本或原生模块。因此 desktop profile 持有完整 `node_modules`，并拒绝通过 CLI profile fallback 解析 bundle。

**把 dsh 与插件安装到不同桌面项目。** 这会产生第二解析锚点和 peer dependency 回退。一个普通 npm 项目已经提供所需安装与解析模型。

**从 registry 包删除非目标 Mach-O 文件。** 架构裁剪可以节省少量 seed 空间，但包可能有意附带多个架构变体，调用方也可以观察安装后的文件集。签署每个实际携带的 Mach-O 对象，无需发明 Desktop 专属包布局就能满足公证要求。

**把 Windows EV 私钥导出到 PFX 文件。** 外部提供的公开叶证书让 SignTool 构造签名，`/csp` 与 `/kc` 则定位硬件密钥。EV 私钥保持不可导出，并留在 Token 上。

**提交包含凭据的签名脚本或持久保存 Token Password。** 包含凭据的 CMD 文件、`.env` 或 Windows 用户/系统环境变量都会让 Token Password 以静态形式被读取。已提交的 CMD 只包含环境变量引用，打包步骤则把密码作为 runner 临时 secret 接收。

**让 electron-builder 或通用目录同步直接发布。** 直接发布可能在所有引用产物就绪前暴露频道元数据，可能把陈旧或其他目标的文件混入发布，也无法证明已完成签名的构建仍与当前 dsh 版本一致。目标专用且经过校验的上传可以明确控制发布顺序与发布身份。

## 结果

- 没有系统 Node.js 或 pnpm 的干净离线机器把种子安装进 `.dsh/profiles/desktop`，并启动可工作的 dsh 会话。
- 已签名应用记录固定少量的 seed store 分片，而不是记录每个 pnpm 缓存文件；macOS 分片内每个 Mach-O 对象都带有发布 Developer ID、安全时间戳与 hardened runtime，每个 Windows 产物都带有配置的硬件支持 EV 签名，安装后的私有 store 仍保持普通 pnpm 布局。
- `.dsh/profiles/desktop/node_modules` 包含并解析桌面 dsh 包和每个 GUI 安装的桌面插件。
- 每个桌面 pnpm 操作都使用内置可执行文件和 `.dsh/desktop/pnpm/store`；不读取用户 `PATH`、配置、store 或 profile `node_modules`。
- Electron-only GUI 安装、删除和更新普通 npm 插件包，而不暴露原始 pnpm 参数。
- 后端与浏览器应用不能修改桌面包。
- npm/CLI dsh 与 Electron 绝不从对方的 `node_modules` 解析或安装插件。
- 在产品窗口打开前，活跃后端与 Web UI 报告相同 dsh 版本和兼容壳 API。
- 安装、健康检查或更新失败后，当前 profile 仍然可用，或在重启后恢复 `rollback/profile`。
- 一个 Desktop 版本绑定 Electron 与 dsh；每次 dsh 更新都通过一个 Electron 更新弹窗交付，并产生一次用户可见的重启。
- 共享 `.dsh` 数据在迁移或修改前拒绝不兼容的读取方。
- 不打开回环监听端口，沙箱渲染进程不能访问任意文件系统或 Electron API。
- Workspace 开发无需下载发布资源即可运行当前已构建代码，未封装安装器的应用验证仍保留生产安装路径。
- Windows 发布打包要求已验证的 SignTool、EV Token、匹配的公开叶证书、Token Password 和明确的密钥容器，绝不会回退到未签名产物或可导出的密钥文件。
- 目标更新只有在已完成签名的构建及其引用的每个产物通过发布校验后才能暴露新频道元数据；保留的历史产物继续供差分更新使用。
- 每个发布阻断平台上的签名已安装产物均能从上一个受支持版本成功更新。

## 评审决策

| 决策 | 建议 |
|---|---|
| 首次启动 | 打包离线种子 store 子集，并通过 pnpm 安装 |
| Desktop profile | 一个包含精确 dsh 与插件依赖、由 Electron 持有的保留 profile |
| 插件管理 | Electron-only GUI 与包服务；没有 CLI、后端或浏览器安装路径 |
| 激活 | 暂存项目、完整健康检查、记录式目录替换和一个回滚副本 |
| 初始平台 | macOS arm64/x64 与 Windows x64；Linux 尚无受支持的发布目标 |
| 更新行为 | 后台检查，差分下载与重启前显式确认，启动时校准 dsh |

## 风险

插件生命周期脚本会执行第三方代码。在 GUI 安装功能交付前，获准 registry、包策略、精确版本、完整性、`allowBuilds` 和诊断都需要安全评审。

更新绑定的 dsh 可能使插件 peer dependency 或原生模块失效。pnpm 解析与完整项目健康检查必须在替换活跃项目前拒绝暂存项目。

通过 npm 安装的 dsh 与桌面 dsh 可能在共享持久化数据时使用不同版本。每个共享 owner 都必须在读取、迁移或写入前执行格式版本与进程锁。

不同操作系统的目录替换行为不同，而且可能中断。激活记录与已安装产物故障测试必须证明每次文件系统移动都可以恢复。

代码签名、公证和更新托管需要生产发布基础设施。只运行仓库测试不能完成这些认证。
