---
description: "通过 Web 侧边栏或 agent 启停 profile 插件，并安装、删除或选择组合包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

[English](README.md) | 中文

应用拥有的 profile 通过启动器信息提供内置包管理器调用方式。它在包操作和 registry 检查中优先于 `pnpmCommand`；其环境仅应用于这些子进程。

## 概述

管理当前 profile 的插件，无需手动编辑配置。启停单个插件条目、选择已安装的组合包，以及安装或删除外部组合包。在 YAML 中启用 HMR 时，配置变化立即生效；未启用 HMR 时，运行中的组合保留到重启。改动影响使用该 profile 的全部会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [失败行为](#failure-behavior)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

基于 base 的 profile 提供管理服务。在 Web 中，侧边栏的**插件**页（[ui-plugin-manager](../../client/ui-plugin-manager/README.zh.md)）管理 profile 的组合包及其能唯一定位的行；设置页的插件列表保持只读。Agent 预设条目保持只读。`plugin_manager` 工具提供相同操作，在标准和 Creator 预设中启用。其他预设仍默认禁用。每个工具操作都要求 `danger-full-access` 或本次调用的批准。在较低沙箱模式下，`ask` 会请求审批；`never`、拒绝、取消或审批渠道不可用时均不执行。批准不改变会话的权限模式。profile 变更跨会话持久化，已安装的 Host 代码在宿主进程内运行，不受工作区沙箱限制。依赖构建脚本仍需单独批准。

未使用 Agent 预设的部署在 profile patch 中启用工具；使用预设的会话由其预设中的 `tool-plugin-manager` 条目控制。

```yaml
- id: tool-plugin-manager
  disabled: false
```

插件开关只更新 profile 的 `cordis.patch.yml` 中最后一条匹配覆盖项的 `disabled`；没有匹配项时追加。匹配依据是条目 id，以及覆盖项声明的模块名称。如果组合包层和其余 profile patch 已使条目处于所请求的状态，仅含 `id` 与 `disabled` 的覆盖项会被移除，也不会追加覆盖项，因此 profile patch 只记录与组合包不同的设置。该比较不计入 home 和单次启动 patch；它们在 profile patch 之后应用，不决定 profile patch 记录什么。组合包开关修改 `package.json` 的有序 `dsh.profile.bundles` 列表。关闭保留依赖；开启追加到列表末尾，可能改变配置优先级。安装新组合包默认启用。home 和单次启动 patch 保留更高优先级。

`listBundles` 保留默认隐藏的组合包，并投影各包的 `dsh.bundle.listedByDefault` 声明供 GUI 使用；它不改变选入或激活行为。声明不是布尔值时返回元数据诊断。已选择但无法加载的组合包仍会出现在 `listBundles` 中，并携带 `error`；`enabled` 表示保存的选择，不代表加载成功。插件页面显示错误并允许取消选择。损坏的组合包无法启用。管理组合包的文件变得不可读后仍受保护。

`listBundles` 为各组合包及其声明的插件行提供可选的展示 `meta`，包括已禁用的组合包。Client 从这些值中选择语言。单独的 `description` 字段是该组合包原始的 `package.json.description`；元信息诊断不会阻止管理操作。`source` 以 `pnpm add` 接受的 spec 给出 profile 依赖：git 地址或 URL 按记录给出，但去掉 http(s) URL 的 user information（查询字符串保持原样）；`file:` 或 `link:` 路径按 profile 目录解析为绝对路径，`~` 展开为主目录；注册表版本范围、标签或别名接在包名的 `@` 之后，以别名安装的包的 spec 也是如此。安装提供的组合包没有该字段，即使 profile 也依赖它，因为实际加载的是安装中的副本。`plugin_manager` 工具的列表结果不包含 UI 展示元信息和更新资格。

`listBundles` 将随附可选组合包和按需目录项标为 `official`，与包的安装状态独立。`availability` 表示可读取的安装随附包、profile 包，或 `missing`；按需目录项不计入未声明的传递依赖副本。`installed` 仅表示 profile 是否声明该依赖。尚未安装的按需条目携带内嵌的本地化元信息，以及 Host 生成、包含当前 DSH 版本与安装 spec 的 `installTarget`，无需访问注册表。profile 已声明但文件不可读的包保留依赖声明，并展示原有错误。

`inspect(spec, options)` 在任何东西安装之前读出 spec 指向什么：注册表包名通过 `pnpm view` 询问注册表，在 profile 目录中运行，因而与安装使用同样的代理与认证设置；绝对路径读取其 `package.json`；git 地址或 tarball 只答复自己的形式和它被拉取的 `host`。答复携带名称、版本、描述、该包是否声明组合包，以及作答的 `registry`，否则给出 `problem`：`invalid-spec`、`already-installed`、`not-found`、`not-a-package`、`not-a-bundle`、`network` 或 `unknown`，并附上问过的 `registries`。调用方的 `signal` 或 `inspectTimeoutMs` 会结束查询。

已发布的安装提供 `package@<当前 DSH 版本>`。源码 Web 与开发 Desktop 提供 `link:<工作区包的绝对目录>`，目录来自当前 CLI 的安装位置，包括其开发符号链接。包名通过工作区清单解析；当前工作目录和预发布版本后缀不用于选择 checkout。包、bundle patch 或已构建入口缺失时报告诊断，不回退到注册表。使用 `pnpm install` 和 `pnpm run build` 准备 checkout。链接包使用该 checkout 的依赖与 peer；代码改变后仍需重新构建并重启。即使版本相同，注册表副本或其他 checkout 的链接也可能需要替换。

官方按需安装调用和其他组合包相同的 `installBundle` 操作。注册表目标使用 `saveExact: true`；开发目标保留普通 `link:` 依赖。显式更新先删除已安装的包，再以当前 `enabled` 选择状态安装目标；没有 HMR 时，自启动起运行的组合包无法删除，因此安装直接覆盖它并报告 `restart-required`。删除之后安装失败或被取消时，该包保持未安装，重新安装的组合包排在选择列表末尾。关闭仅取消选择配置层，移除使用原有移除检查。安装失败恢复 profile 清单和锁文件；安装成功后激活失败可能保留已保存的依赖和选择。原有 peer 兼容性检查继续生效，不增加仅针对官方条目的版本准入规则。

`listVersions(name, options)` 读取 `listBundles` 标为 `updatable` 的已安装组合包的新版本：以自身包名、按注册表 spec 保存（不是 `npm:` 别名）的第三方 profile 依赖，清单声明 semver 版本，且不承载插件管理。一次 `pnpm view <name> versions time dist-tags` 按注册表计划询问，计划从 `options.registry` 开始，否则从本进程上次安装该包所用的注册表开始，否则从配置的注册表开始。随后从作答的注册表逐个读取比已安装版本新的最新 `versionListLimit` 个版本，每个版本一次 `pnpm view <name>@<version>`，同时最多 `versionLookupConcurrency` 个，因为 pnpm 对范围只打印最高的匹配版本。列表按从新到旧排列，带有各版本的 dist-tag、发布时间、预发布标记、弃用说明、是否声明组合包，以及在其 `engines.dsh` 或 DSH peer 拒绝当前运行版本且没有豁免时的 `incompatible` 记录；`omitted` 统计未列出的新版本数，`attempts` 列出问过的每个注册表及其失败原因。拒绝为 `not-updatable`、`not-found`、`network` 或 `unknown`；任一版本查询失败都会拒绝整个列表。官方组合包跟随 DSH 版本，不会列出。

`updateBundle(name, version, options)` 把可更新的组合包替换为一个更新的确切版本；更旧的版本会被拒绝。目标版本先按与 `listVersions` 相同的计划查询，版本不存在、未声明组合包，或其 `engines.dsh` 或 DSH peer 拒绝当前 DSH 时，更新停在 `step: 'check'`，profile 保持不变。有 HMR 时，更新先移除已安装版本，使其插件停止，再以 `saveExact` 和当前的选中状态从作答的注册表安装 `name@version`。该安装失败、被取消，或已安装但无法启动时，先移除仍留下的目标版本，再从本进程安装被移除版本所用的注册表重新安装它，没有记录时按配置的计划安装，与移除的做法一致，结果以 `restore` 报告；重新安装也失败时，包处于未安装状态。移除或安装被拒绝（例如锁等待超时）时，报告为该步骤失败。没有 HMR 时，目标版本直接安装在运行中的版本之上，结果报告 `restart-required`。`plugin-manager/update-state` 以调用方的 `requestId` 通告 `checking`、`removing`、`installing` 与 `restoring`；目标版本的安装以同一 id 流式输出日志并接受 `cancelInstall`，重新安装不带 id，因此取消无法中止它。

`installBundle` 在启动 pnpm 前通过 `git ls-remote` 检查 GitHub 仓库，使用 profile 目录及安装器的 Git 与代理配置。`githubConnectionTimeoutMs` 默认为 5000 毫秒，只限制这次检查，不限制包下载或构建。检查禁用凭据助手和认证提示；只有网络失败与超时会停止安装，通过现有失败类型与诊断日志返回，并标记 `failedAt: 'spec-host'`。认证、仓库查找及其他失败继续交给 pnpm，包括其 HTTPS 到 SSH 的回退。取消安装或销毁管理器会停止检查及其子进程。注册表包、本地路径、压缩包和其他 Git 主机跳过此检查。仓库可达后，下载或组合包验证仍可能失败。

HTTP(S) Git URL 指向 pnpm 没有 HTTPS 到 SSH 回退的主机（即 `hosted-git-info` 不认识的任何主机，例如自托管 GitLab）时，在启动 pnpm 前通过 `git ls-remote` 探测。探测使用安装器的 Git 配置与凭据助手，并禁用 Git 的终端与 askpass 提示；在 POSIX 上探测也没有控制终端，因此 SSH 无法提示。HTTP(S) 无法读取仓库而 `ssh://git@<host>/<path>` 可以读取时，pnpm 以该 SSH URL 加上原片段安装，profile 也记录该 URL。否则按原 spec 安装。每次探测受 `gitTransportTimeoutMs` 限制，默认为 5000 毫秒；取消安装或销毁管理器会停止探测。带凭据或查询串的 URL 跳过探测。

注册表按顺序询问。计划从 `options.registry` 开始，否则从配置的 `registry`（`null` 即 pnpm 自身配置指定的那个）开始，并在一个注册表不可达、超时或答复没有这个包或版本（尚未同步的镜像会如此）时继续问 `fallbackRegistries`。配置集合之外的注册表只问它自己，因而私有源永远不会落到公共源；pnpm 自身的注册表只在它指向的地址（每次做计划前经 `pnpm config get registry` 读出）是 npm 官方源或某个备选源时才算集合成员，否则视为私有源只问它自己。pnpm 自身配置已经指向的注册表只问一次。查询以 `--registry` 运行 `pnpm view` 且不带 pnpm 自身的重试，所以死掉的注册表会在 `inspectTimeoutMs` 内报告并转问下一个；pnpm 把拒绝以 JSON 打印在 stdout，读法与 stderr 相同。安装保留 pnpm 的重试设置。`registries()` 把配置集合和 pnpm 指向的地址答复给选择器。[注册表 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.zh.md) 拥有理由。

可在浏览器使用的 `@deepseek-ai/dsh-plugin-manager/registry` 入口导出 `OFFICIAL_NPM_REGISTRY` 和 `NPMMIRROR_REGISTRY`，供消费方识别这两个公共注册表。

`installBundle` 接受调用方生成的 `requestId`，`plugin-manager/install-log` 在其下流式转发每次 pnpm 运行的输出，`plugin-manager/install-state` 通告 `installing`、`cancelling` 与 `applying`；每问一个注册表通告一次 `installing`，`attempt` 带上这次的注册表、序号和计划长度。安装沿用查询的计划，从 `options.registry` 开始，以 `--registry` 运行 `pnpm add`，两次尝试之间恢复 profile 文件；换一个注册表能改变的失败才转问下一个，其他失败即停，错误行点名 git 或 tarball spec 自身拉取主机的失败也停，因为没有注册表能替代那台主机；`failedAt` 说明最后一次失败的运行连不上的是二者中的哪一个。`cancelInstall(requestId)` 停止运行，只在 Git 检查或 pnpm 退出且文件恢复后答复 `cancelled`，组合包已在应用时答复 `too-late`，其他 id 答复 `not-running`；安装调用随后报告 `application: 'cancelled'`。失败、被取消或装入了没有组合包 patch 的包的运行，会把 `package.json` 与 `pnpm-lock.yaml` 恢复原样；`packageResult.kind` 按退出方式与输出对最后一次运行分类，`registries` 列出问过的每个注册表，`bundle` 给出完成的运行新增的包，`version` 给出它的清单版本，它可能与 `inspect` 读到的版本不同，例如 pnpm 的 `minimumReleaseAge` 暂缓了最近的发布。`listBundles` 携带每个组合包的一句话简介（包的 `description`）、其 patch 声明的行及其存活条目，以及它覆盖的内置行；它列出 profile 自己的组合包、安装提供的组合包，以及被选中却没有组合包 patch 的名字（作为 `not-bundle` 问题），未选中的普通依赖不列出。启动器的 `OPTIONAL_BUNDLES` 点名的组合包是 `optional`：随安装提供、默认关闭、由用户开启，永不可卸载，也不被任何随附模板选中（[理由](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.zh.md)）。每个完成的操作都会发出 `plugin-manager/changed`；在管理器之外应用的一代 patch（HMR 监视到 CLI 或手工编辑后）不发通知，页面要到下一次读取才知道。

`waitForInstall(requestId)` 让客户端在响应丢失后等待活动安装的结果，包括不可取消的应用阶段。它返回与原调用相同的结果，请求不在活动中时返回 `null`。已完成的结果不保留；`null` 不表示成功或已取消。

pnpm 11 拦下依赖脚本时，失败的安装在 `pendingBuilds` 里报告 profile 中所有待决定的 `allowBuilds` 键，包括先前尝试留下的键、本次运行报告为已忽略的包名，以及 pnpm 为其拒绝准备的 git 托管包建议的键。git URL 携带凭据（密码，或 HTTP(S) 上的用户名）的键不会被记录，因此该安装只提供手动批准。pnpm 只在能够交互提示时才把这些条目写入 `pnpm-workspace.yaml`，因此由管理器自行记录本次运行报告的包名；失败的运行会恢复 `package.json` 与 `pnpm-lock.yaml`，但有意不恢复 `pnpm-workspace.yaml`。Web 插件页提供**允许这些脚本并重试**；工具可以在用户于对话中批准这些脚本后，通过 `install_bundle` 的 `approvedBuilds` 代为授权。服务只校验待决定的名字，不核实对话中的批准。授权按记录的键保存在当前 profile，该键会把 git 托管包固定到其提交，允许以宿主用户的权限执行命令，并在再次安装失败后保留。只能批准当前未决定的名字；已有的拒绝与通配规则不能通过此操作覆盖。`allowBuilds` 里出现 YAML 锚点或别名时拒绝授权。重试保留原来的启用选择。

<a id="version-compatibility-and-exemptions"></a>
### 版本兼容性与豁免

点名软件包的安装命令（`add`，或带 spec 的 `install`）会在 pnpm 运行前完成检查：本地路径直接读取其 `package.json`，registry spec 通过 pnpm 的 registry 查询得到该范围选中的版本及其声明的 `engines` 和 `peerDependencies`。未满足的 DSH 版本要求会在 pnpm 运行前使操作失败，因此不会下载任何内容、不会运行构建脚本；调用方随请求提交的构建批准在此检查之前记录，会保留下来。git 或 tarball spec 必须先抓取，因此在安装后才判定：此时操作会恢复 profile 清单与锁文件，并按恢复后的锁文件重新安装（profile 原本没有锁文件时，按恢复后的清单重新安装且不创建锁文件），同时报告该恢复是否成功；已获准构建脚本的副作用可能保留。本次运行未改动的依赖不会阻塞无关操作：它保持已安装状态，运行会输出点名它的警告，由 profile 启动拒绝加载。请求 `enabled: false` 的安装同样受检。启动检查独立执行；版本范围语义见 [App boot](../app-boot/README.zh.md#profiles)。版本豁免不授权依赖脚本。

豁免保存在 profile 自己的 `compatibility.json` 中（与 `package.json`、`cordis.patch.yml` 并列），将精确的 `package-name@version` 映射到精确 DSH 运行时版本列表。写豁免不改变依赖、组合包选择或 patch 层。插件升级和 DSH 升级都不继承授权。使用 `plugin_manager` 的 `list_version_exemptions` 获取运行时版本与已有授权，再通过 `set_version_exemption` 提交 `target`、`runtimeVersion` 和 `enabled`。授权还要求 `acceptRisk: true`；只能在警告用户不兼容插件可能导致崩溃或数据丢失，并获得用户对此版本组合的明确许可后传入。服务校验确认参数和版本，不核实对话历史。撤销可以移除历史运行时版本的授权。

授权在下一次组合时生效。在线 profile 会重新组合，被授权的插件会在当前会话中挂载，结果报告 `applied`；仅启动型 profile 在重启前保留当前条目并报告 `restart-required`。

CLI 提供 `dsh plugin --profile <profile> version-exemptions`、`allow-version <package@version> --dsh-version <runtime> --accept-risk` 和 `revoke-version <package@version> --dsh-version <runtime>`。授权会在保存前打印风险警告。兼容性拒绝带有 `incompatible-version` 错误码，以及每个被拒绝软件包的 `name`、`version`、`runtimeVersion` 和未满足的 `requirements`（键为 `engines.dsh` 或 DSH peer 包名）；各界面自行呈现这份记录。Web 页面通过 locale 词典生成文案，CLI 拒绝时打印精确的 `allow-version` 命令。通过工具或 CLI 添加豁免后，重试原操作。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pnpmCommand` | `pnpm` | pnpm 可执行文件名或路径，与 `dsh plugin` 命令一样通过 `PATH` 解析。 |
| `inspectTimeoutMs` | `20000` | 单次检查所做注册表查询的上限，单位毫秒。 |
| `githubConnectionTimeoutMs` | `5000` | 安装前 GitHub 仓库连接检查的时限，单位毫秒。 |
| `gitTransportTimeoutMs` | `5000` | 安装前对自托管 Git 仓库每次 HTTP(S) 与 SSH 访问探测的时限，单位毫秒。 |
| `registry` | pnpm 自身配置 | 查询与安装首先询问的注册表，http(s) URL；缺省为 pnpm 自身配置指定的那个。 |
| `fallbackRegistries` | `['https://registry.npmmirror.com/']` | 前一个注册表不可达或没有该包副本时依次询问的注册表，http(s) URL；pnpm 自身的注册表只在它指向 npm 官方源或这里的某一个时才进入顺序。 |
| `outputBytes` | `16384` | 每次操作返回的 pnpm 诊断字节上限；完整输出保留在返回的日志路径中。 |
| `lockWaitMs` | `120000` | 获取 profile 写锁的最长等待毫秒数。 |
| `versionListLimit` | `20` | 版本列表读取并返回的、比已安装版本新的最新版本个数。 |
| `versionLookupConcurrency` | `4` | 版本列表同时运行的单版本注册表查询个数。 |
| `idleTimeoutMs` | `600000` | service 包操作允许持续无捕获输出的最长毫秒数，达到即被管理器终止；继承描述符运行的 `dsh plugin` 不受此上界约束。 |
| `detailMaxBytes` | `1048576` | 组合包详细介绍文档的最大大小，以及为读取它而读取的 locale 文件的最大大小，单位字节。 |
| `detailImageMaxBytes` | `5242880` | 与组合包详细介绍文档一同提供的图片的最大大小，单位字节。 |
| `detailFetchTimeoutMs` | `15000` | 为读取当前安装提供、尚未安装的组合包的详细介绍文档而发出的单次 npm 文件 CDN 请求的时限。 |
| `detailNpmFileSources` | `['jsdelivr', 'unpkg', 'npmmirror']` | 读取当前安装提供、尚未安装的组合包时按顺序使用的 npm 文件 CDN；一次读取的 `npmFileSources` 把其中列出的 CDN 移到最前。 |

<a id="bundle-detail-documents"></a>
### 组合包详细介绍文档

`readBundleDetail(name, language, { npmFileSources? })` 为 `listBundles()` 列出的组合包读取**插件**页中该组合包页面显示的详细介绍：locale `meta.detail` 文件，否则为 README，即[文档顺序](../../util/plugin-detail/README.zh.md#document-order)第 1 步和第 2 步的定义。两者都没有时，结果为 `{ status: 'none' }`；不读取组合包声明的仓库。`npmFileSources` 按顺序列出读取当前安装提供、尚未安装的组合包时先请求的 npm 文件 CDN；它未列出的已配置 CDN 排在其后，`detailNpmFileSources` 未列出的 CDN 不会被请求。找到的文档携带其 `origin`（`locale` 或 `readme`）、在包内的 `path`，以及去掉开头 YAML front matter 块后的 Markdown 内容。

已安装的组合包从其目录读取，不访问网络。当前安装提供、尚未安装的官方组合包按其提供的版本从 npm 文件 CDN 读取；以开发链接形式提供的组合包没有文档。结果不被缓存，因此重新安装的组合包显示其自身的文档。

`GET /api/plugin-manager/detail-file?bundle=<name>&document=<path>&path=<destination>`（加上 `&sources=<cdn>,...` 时先请求这些 CDN）向已通过认证的 owner 连接提供组合包文档旁的图片。目标路径相对于该文档；以 `/` 开头时相对于包根目录。只提供包内的 PNG、JPEG、GIF、WebP、AVIF 和 SVG 文件，响应带有 `Content-Security-Policy: sandbox`、`X-Content-Type-Options: nosniff` 和 `Cache-Control: no-store`；其他路径或未列出的组合包返回 404。

失败：`listBundles()` 未列出或无法解析其目录的组合包为 `plugin-manager/unknown-bundle`；无效语言为 `plugin-manager/invalid-language`；`plugin-manager/detail-unavailable` 携带 `reason`，取值为 `too-large`、`network`，或在 locale 文件或 `meta.detail` 格式错误、指定的文件不存在时为 `invalid`。图片路由对这些失败依次返回 404、413、502 和 400。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务与 `dsh plugin` 共用 [operations.ts](src/operations.ts) 中的包管理操作。启动器提供当前 profile；[DSH HMR](../hmr/README.zh.md) 串行执行模块重载、文件监听和管理写入。每次配置刷新重新读取组合包选择与 patch 层，更新原有根 Include，并等待已移除插件释放资源及剩余 Loader 树稳定。CLI 与 service 操作共用 profile manifest 写锁，防止并发包操作和 manifest 写入。HMR 不获取该锁。pnpm 在 HMR 队列之外执行；安装在 pnpm 成功后选入组合包，删除则在执行 pnpm 前取消选入并完成卸载。

没有 HMR 时，安装新包、启用组合包以及删除成功后，都会发布 profile 的 runtime resolution；有 HMR 时，每个操作都把发布交给 [HMR](../hmr/README.zh.md) 的重新组合，该重新组合在相关插件停止后移除被丢弃的映射。共享依赖的规范化目录和作用域不变时，可以改由另一个组合包声明。没有 HMR 时，已取消选入的启动组合包仍在运行：只要保存的选择列表中缺少任何这样的组合包，后续包操作就保留整张当前表，并报告 `restart-required`。其他新安装和未运行组合包的删除仍可在没有 HMR 时发布；激活等待重启。有 HMR 时，spec 指明已安装的包，`installBundle()` 在运行 pnpm 之前以 `already-installed` 拒绝安装；spec 可以是 registry 包名、本地目录，或保存依赖时使用的 git 或 tarball spec。因此，有 HMR 时无法在不能删除的包（例如带有插件管理的组合包）上安装。安装另一个版本需要先卸载再安装，因此在安装新版本之前，旧版本的插件停止，其模块被逐出，其映射被移除；Web 页面中官方插件的更新会依次执行这两步。运行 pnpm 之后才能确定包名的 git 或 tarball spec 仍可能安装到已安装的包上：没有 HMR 时报告 `restart-required`；有 HMR 时，重新组合替换已加载文件发生变化的运行中插件。替换版本导入或启动失败时报告 `failed` 及激活诊断，该诊断给出导入错误；旧版本不再运行，此后每次操作都会再次导入它，因此其文件或依赖被修正后它即启动。未变化的导入失败在后续操作中作为警告报告；已变化的导入失败使后续操作失败。已安装的包现在解析到其他目录，或 DSH 安装的映射发生变化，使 runtime resolution 拒绝发布时，它停止并重新启动该发布将丢弃的行，组合保持不变，并报告带 `package-moved` 的 `restart-required`。停用或删除组合包时，会逐出因此被删除映射的那些包的模块。每个 `restart-required` 结果都带有 `restartReason`：`no-hmr`、`package-moved`，或只有重启后才能加载的已变化模块的 [HMR 待处理原因](../hmr/README.zh.md)，除非操作报告 `overridden`（[决策](../../../.agents/notes/implemented/architecture/2026-09-30-profile-package-refresh-and-manifest-invalidation.zh.md)）。

service 运行若在 `idleTimeoutMs` 内没有任何捕获输出即被终止，与退出状态一并报告 `timedOut`，不论信号留下什么退出状态都归类为 `timeout`，且不再转问下一个注册表，因此单次操作占用 profile 锁的时长有上界；CLI 继承终端、不捕获输出，因此不受此上界约束，由操作者中断。运行以进程退出为完成点，随后只在一个有界的宽限窗口内排空管道，因此继承管道的孙进程无法让操作挂起。诊断文件会在调用结束前关闭，包括准备或创建进程失败的情况。被终止的运行会停止整棵进程树并等待其消失，因为生命周期脚本的存活时间超过启动它的 pnpm 进程（issue #4981）。每个操作把它启动的 pnpm 运行记录在 `.plugin-manager/run.json` 中，并在运行结束时删除该记录。持有者进程已退出的锁会被下一个写入方接管，但该进程的 pnpm 进程树可能仍在运行，因此发现记录的操作最多等待五秒让记录中的运行停止，否则不运行 pnpm，并以指明该进程与记录文件的诊断失败。仅依赖字段变化不会触发配置重载。

结果包含最后尝试的阶段、目标、磁盘变化、应用状态和错误码。Web 词典呈现管理文案；pnpm 与 Loader 的诊断保持原样。无关的已有故障作为警告返回；新出现、配置变化后的故障，以及显式启用目标未激活，都会使操作失败。包管理运行失败或被取消，或组合包校验失败时，会恢复 pnpm 运行前快照的 manifest 与 lockfile（[理由](../../../.agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.zh.md)）；后续失败按[失败行为](#failure-behavior)所述保留已保存的改动。安装按 request id 跟踪到调用结束，因此取消只针对一次运行，并且不取 profile 锁就能等待它结束。CLI 继承认证环境和终端描述符；service 使用清理后的环境并捕获输出。管理器直接读取文件和 Loader 状态，不维护第二份目标状态注册表，因此不发布单独的运行时不变式伴生入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [App boot](../app-boot/README.zh.md)——profile 配置层与启动策略。
- [Plugin inventory](../../host/plugin-inventory/README.zh.md)——当前 Loader 和预设状态。
- [插件管理页](../../client/ui-plugin-manager/README.zh.md)——基于本服务的 Web 侧边栏页面。
- [Plugin settings](../../client/ui-settings-plugin-inventory/README.zh.md)——只读的 Web 清单。

<a id="model-experience"></a>
## 模型体验

### 管理工具

#### 模型看到什么

[`plugin_manager` 工具](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plugin-manager) 列出插件条目和组合包，并执行影响整个 profile 的改动。结果包含保存状态变化、应用状态和包管理诊断。未直接应用的变更结果会增加 `nextStep`，这是一句根据应用状态、拒绝代码、包管理器失败类型或重启原因生成的说明，指出模型下一步做什么或告诉用户什么。管理操作不会向 Agent 注入消息。

#### Token 影响

装配工具消费者时提供工具声明；每次调用追加返回的清单或改动结果。

#### KV Cache 影响

工具结果追加到对话中。启停其他工具可能改变后续工具声明及其缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Web 一次批准显示出来的整组待决定包，没有逐包选择。
- 插件移到更新的提交后，已批准的 git 键仍留在 `pnpm-workspace.yaml` 中；没有任何机制移除过期的批准。
- 命令改动锁文件时，pnpm 按默认注册表校验锁文件中的每个 tarball URL。某个包从其他注册表安装后，使用默认注册表安装另一个包，或在重启后删除该包，可能以 `ERR_PNPM_TARBALL_URL_MISMATCH` 失败。
- 更新把目标保存为确切版本，失败后的重新安装也把原版本保存为确切版本，即使 profile 原先保存的是范围。有 HMR 时，重新安装的组合包排到选中列表末尾，这可能改变哪个组合包的配置优先。
- 更新把移除与安装作为两次 profile 操作运行，其他操作可能在两者之间运行。
- 在 Windows 上，Git 传输探测沿用父进程的控制台，SSH 的主机密钥或密码提示可能出现在启动终端中，直到 `gitTransportTimeoutMs` 到期。在 POSIX 上，`known_hosts` 中没有的主机会让 SSH 探测失败，因此在接受一次主机密钥（例如执行 `ssh -T git@<host>`）之前一直走 HTTPS。凭据助手对话框或 ssh-agent 确认（例如 Touch ID 或 `ssh-add -c` 对话框）超过时限时算作探测失败；HTTPS 探测超时时，可达的 SSH 形式会写入 profile。私有仓库在 pnpm 启动前最多等待两倍 `gitTransportTimeoutMs`。SSH 形式固定使用 `git` 用户和 SSH 默认端口，其他 SSH 端点需要 `url.<base>.insteadOf` 规则。两种探测都失败时，诊断是 pnpm 的 HTTPS 失败，不报告 SSH 探测失败的原因。
- 依赖需要新的构建脚本批准的新版本会更新失败，并重新安装为原版本；移除该包后通过普通安装批准其脚本。
- 没有 HMR 时，替换包需要重启进程。在 Plugin Manager 之外重新链接仍处于安装状态的包，需要等待重启。
- 仅启动时加载的 profile 不能删除当前进程启动时使用的包；停止进程后使用 `dsh plugin`。
- 管理器不能关闭自身所需的管理组件、修改其他 profile 或编辑 agent 预设组合。
- 失败的删除可能留下部分依赖改动，失败或被取消的安装可能在 `node_modules` 或 pnpm 缓存中留下已下载文件。文件缺失的未启用依赖仍可删除。诊断日志保留在 profile 的 `.plugin-manager/logs` 目录中。
- 管理结果描述 Host 激活状态。浏览器同步失败会在设置的插件列表中单独显示。
- Desktop 包管理操作仍由 Desktop shell 负责。

<a id="failure-behavior"></a>
### 失败行为

失败保留已完成步骤，并报告实际残留状态。没有有效组合包声明的 profile 依赖仍可见、可删除，但不能启用。

| 失败操作 | 处理方式 |
|---|---|
| 安装：pnpm 执行或组合包校验失败 | 恢复 pnpm 运行前快照的 `package.json` 与 `pnpm-lock.yaml`；pnpm 已下载的文件可能保留。报告安装失败。 |
| 启用：保存选择项或加载失败 | 保留已安装的依赖和已保存的选择项。报告启用失败，允许修正、停用或卸载。 |
| 包操作成功后解析表发布失败 | 保留已完成的磁盘改动和上一张运行时表。报告 `application: 'failed'` 及发布诊断；pnpm 的零退出码不代表发布成功。 |
| 卸载：任一步失败 | 停在失败步骤，保留已完成的改动和待重试删除的依赖，报告卸载失败。不重新启用组合包。 |

pnpm 执行和组合包校验成功即完成安装，后续发布或启用失败不撤销安装。卸载依次执行：从 `dsh.profile.bundles` 移除组合包、卸载运行时贡献、执行 `pnpm remove`，然后发布 runtime resolution，除非没有 HMR 且已取消选入的启动组合包仍在运行。`pnpm remove` 使用本管理器在当前进程中最近一次安装该包时所用的注册表，因为 pnpm 按默认注册表校验锁文件中的 tarball URL；进程启动前安装的包使用安装时首先询问的注册表删除。任一步失败都不继续执行后续步骤；删除后的发布失败不会恢复已删除的包。 profile 依赖和安装都不持有的已选名称（例如已下线的组合包）同样可卸载；其卸载在取消选择后结束，不运行 pnpm。

恢复只重写这两份快照文件；用户编写的 patch 配置、应用数据、诊断日志以及 pnpm 已下载的文件保持原样，没有 manifest 引用的包由下一次包操作清理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
