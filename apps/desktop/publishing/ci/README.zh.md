---
description: "在专用 macOS 和 Windows runner 上发布留存的 Desktop 安装包。"
---

# Desktop CI 发布

[English](README.md) | 中文

## 概述

在原打包机器上发布完整安装包，无需再次下载安装包。test 和 production 都先发布二进制文件，再更新 YAML。两种环境都需要 GitHub Environment 审批；只有 production 通过 GitHub App 创建 tag。真实 COS、CDN 和管理员权限仍需部署验收；本地 fixture 不证明这些权限可用。

## 目录

- [配置顺序](#setup-sequence)
- [Runner 标签与排队排查](#runner-labels)
- [机器配置](#machine-setup)
- [打包与发布](#package-and-publish)
- [放量与官网发布](#rollout-and-website-publication)
- [恢复与记录](#recovery-and-records)
- [恢复频道](#restore-a-channel)

<a id="setup-sequence"></a>

## 配置顺序

首次配置专用机器时按此顺序操作。部署操作员负责注册、凭据、审批和真实上传验收；仓库检查不能证明机器已具备发布能力。

1. 准备 runner 专用 checkout 和仓库外的配置目录。按 [Windows 机器与签名配置](../../windows-signing/README.zh.md#machine-setup)或 [macOS runner 与签名配置](../../packaging/README.zh.md#macos-actions)准备工具、模板和平台凭据。
2. 通过 GitHub **Settings → Actions → Runners** 或组织的 runner 管理页面注册 runner。记录准确的注册名称，允许本仓库访问其 runner group，并分配[必需标签](#runner-labels)。注册时保留默认标签。
3. 按平台指南安装并启动守护任务。Windows 计划任务和 macOS LaunchAgent 都要求配置的用户登录，不能在登录前无人值守启动。确认已连接 GitHub 且出现 `Listening for Jobs`，再检查 GitHub 中 runner 在线。
4. 完成[本机发布配置](#machine-setup)、仓库变量 `DESKTOP_PUBLISH_RUNNERS` 和两个部署 Environment。仓库管理员负责路由与审批人；COS 管理员负责桶配置及对象读写权限；production 还需要配置 GitHub App。
5. 按[打包与发布](#package-and-publish)完成一次 Windows 已签名或 macOS 已公证的 **test** 打包。确认打包 job 使用预期的注册 runner 并留存文件。从 `master` 发起发布，填写该 run ID 和 attempt；确认 `prepare` 确实在同一台机器上启动并生成审批摘要。
6. 审核摘要中的环境、版本、频道和 URL 后，再批准测试上传。验证发布记录、公开安装包下载和升级 feed。test 验收不能证明 production 权限可用：production 需独立配置与审批。保留 run/attempt 和验收结果，供故障恢复使用。

<a id="runner-labels"></a>

## Runner 标签与排队排查

GitHub 要求 runner 同时匹配 job 的 `runs-on` 列表中的全部标签。[默认标签规则](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow)说明了为什么使用 `--no-default-labels` 注册后，runner 即使在线也可能无法接单。当前工作流要求：

| Job | 同一台 runner 必须具备的标签 |
| --- | --- |
| Windows 打包 | `dsh-win-package-trial` |
| macOS 打包 | `self-hosted`、`macOS`、`ARM64`、`dsh-mac-package-trial` |
| 所有原机发布和放量任务 | `self-hosted`，以及选中的 `DESKTOP_PUBLISH_RUNNERS` 条目中的 `label` |

只有 `dsh-win-package-trial` 的 runner 可以打包 Windows，却不能接发布任务。路由条目不会给 GitHub 中注册的 runner 添加标签。需由 runner 管理员修正注册标签；修改路由的 `target` 或重启正常监听的进程都不能补齐缺失标签。

job 排队时，先对照 job 页面请求的标签与 **Settings → Actions → Runners** 中的标签，再检查仓库/group 访问权限，以及匹配的 runner 是否在线且空闲。守护任务运行只说明进程存在。托管的 `route` job 成功只说明已选定打包任务，不代表 `prepare` 能被分配。部署等待审批时需要 Environment 审批人操作，已经分配但失败的 job 则需查看步骤日志。重启前先区分这些状态。

<a id="machine-setup"></a>

## 机器配置

保持 `DSH_PACKAGING_CONFIG_DIR` 指向现有机器打包目录。完成的构建复制到其同级 `releases/<run-id>/<attempt>/`；`DSH_DESKTOP_RELEASES_DIR` 可用绝对路径覆盖该根目录。文件清单包含安装包、更新归档、blockmap、完成记录和不含凭据的 manifest。调试包会留存，但不能发布。复制内容通过校验后才开放 attempt 目录，已有 attempt 不能被替换。GitHub 保留相同文件清单 14 天。本地文件保留到操作员删除；校验或发布期间不要删除对应 attempt。

从 [macOS test](../../config/publishing/macos/test.json.example)、[macOS production](../../config/publishing/macos/production.json.example)、[Windows test](../../config/publishing/windows/test.json.example) 或 [Windows production](../../config/publishing/windows/production.json.example) 模板开始，创建 `publishing/` 目录，将所选文件复制到 `DSH_PACKAGING_CONFIG_DIR` 下的 `publishing/<preset>.json`。用机器实际配置替换示例 bucket、test origin、绝对路径、macOS 签名身份和 Team ID 或 Windows 证书指纹，以及 production App client ID；保留固定的 production origin。模板不含凭据，也不授予 COS、GitHub 或签名权限。引用的秘密文件保存在 Git 之外，只允许发布账户访问。macOS 的 arm64 和 x64 共用配置，目标由留存包决定。

每份配置声明 `bucket`、不带路径的 HTTPS `origin` 和绝对路径 `credentialsFile`。凭据文件只包含 `secretId` 和 `secretKey`。macOS 还需 `macOS.signingIdentity` 和 `macOS.teamId`；Windows 需要 `windows.certificateThumbprint`。production 必须使用 origin `https://download.deepseek.com`，并提供 `githubApp.clientId` 和绝对路径 `githubApp.privateKeyFile`。上传器支持长期 COS 凭据，不支持 STS 会话凭据。管理员必须维持 test 和 production bucket 未启用版本控制（不能是已启用或已暂停状态）。发布流程以此为部署前提，不调用 `GetBucketVersioning`，也不要求该权限。二进制 PUT 仍携带 `x-cos-forbid-overwrite`；防覆盖保证依赖管理员维持桶配置。

将仓库变量 `DESKTOP_PUBLISH_RUNNERS` 配置为已注册 runner 名称到唯一标签和目标的 JSON 映射，例如 `{"mini":{"label":"dsh-mini-publish","target":["mac-arm64","mac-x64"]}}`。该标签只能分配给这台 runner。目标可为单个名称或非空列表；上述 Mac 条目允许同一台机器处理两种架构的打包工作流。Windows 使用目标 `win-x64`。留存包的目标必须与所选打包工作流一致。路由 job 检查原构建成功的 job，发布器再检查自身 runner 名称与记录一致。机器之间不需要共享文件系统或局域网连接。

管理员必须创建 `desktop-test` 和 `desktop-production`，分别设置必需审批人并允许 `master` 部署分支。工作流会检查两种环境的审批人配置。test 可允许发起者自行审批。GitHub App 需要安装到本仓库、具有 Contents write 权限，并获准在 `desktop-v*` tag ruleset 下创建发布 tag。审批不会把审批人的 tag 权限传给 App。缺少配置会停止发布，不回退到个人 token。App action 创建短期 token，并在结束后撤销。使用发布账户的文件系统权限保护本机私钥及 COS 凭据文件。token action 需要密钥内容，因此已屏蔽日志的 PEM 在 job 期间也会经过 runner 临时 `GITHUB_OUTPUT` 文件；日志屏蔽不限制本地文件访问。

Environment 审批限制此工作流，不限制同一机器账户运行的任意代码。账户隔离和强制源分支限制属于独立运维工作。保持现有发布 Environment 不变。test job 使用自己的审批人，不创建真实发布 tag；本地模拟接口覆盖 tag 创建与恢复，但不验证 App 权限。

<a id="package-and-publish"></a>

## 打包与发布

发布表单支持可选的 `staging_percentage`，取值为 0 到 100 的整数。该值作用于保留包所属的 nightly 或 stable 渠道，显示在审批摘要中，并写入发布的 YAML 和审计记录，不修改保留产物。留空沿用包内默认值（通常为全量）。已完成的发布不能通过重试修改比例；同版本清单内容冲突仍会报错。

发布到 test 或 production 都必须在 Windows 选择 `signing=signed`，或在 macOS 不勾选**跳过公证**。无签名、无公证的包仅限内部调试，不能发布或用于自动更新。托管路由 job 会在安装依赖前，依据所选 run 和 attempt 对应的 artifact 名称拒绝已标明的调试包。仅重跑归档时，artifact 名称保留原构建 attempt，早期检查可能未识别该包；本地清单资格校验仍会在发布前拒绝调试包。缺少 artifact 元数据不代表允许发布：原机器仍会验证留存清单和签名。遇到调试包拒绝提示时，需重新完成签名或公证，再使用新包的 run ID / attempt 发布；重跑发布不能使现有产物获得发布资格。

选择对应平台的 `Package Desktop` 工作流、preset、源码、通道和版本模式。test 的 `source_ref` 接受仓库内分支名（如 `feature/desktop-update`）或 `dsh-v*` tag；production 仅接受 `master` 或 `dsh-v*` tag。符合 `dsh-v` 后接数字、其余为字母、数字、点或连字符的名称按 tag 处理，即使存在同名分支。tag 必须与所选产品版本一致。建议从 `master` 启动打包工作流，再单独填写打包源码；不支持直接填写 commit SHA、PR ref 或 fork 仓库。源码必须包含 CI 适配脚本，旧源码会在安装依赖前失败。仅选择可信分支：其构建代码将在签名机器上执行。这是操作约定，不提供工作流来源强制限制或凭据隔离。发布使用记录的 commit，并要求该提交仍在所选分支历史中；正常追加提交不影响发布，删除分支或导致历史分叉的强推会拒绝。tag 发布要求 tag 仍指向记录的提交。从 `master` 发起发布；托管路由 job 会在派发到原机器前拒绝其他 ref。实际打包源码提交单独记录。`version_mode=default` 对 production 选择 follow-dsh，对 test 选择 build-number；follow-dsh 跟随所选源码的 dsh 包版本号，build-number 在任一环境均追加日期/run/attempt，manual 要求填写 `build_version`。已有派发命令中的 `-f version_mode=auto` 须改为 `-f version_mode=build-number`，`-f version_mode=product` 改为 `-f version_mode=follow-dsh`；本地 CLI 的 `--build-version auto` 不变。工作流暂时传递旧模式名，以兼容已含 CI 适配脚本但早于模式改名的源码；当前解析器同时接受新旧名称。计划于 2027-01-04 同时删除 workflow 映射和解析器别名，并要求所选源码支持新模式名；该日期不会触发自动失效。操作人员选择的渠道接受任意受支持的构建版本，包括 alpha 和 RC 版本；渠道不改变版本优先级，也不允许客户端降级。可选 `test_release_id` 是测试 URL 前缀：留空沿用机器默认值，同一平台连续升级测试需保持相同值，并应定期轮换默认值。它不是 GitHub run ID。格式校验和轮换限制见[打包配置](../../packaging/README.zh.md#configuration-and-local-builds)。

打包只保留文件。成功后，在 `master` 上打开 **Publish Desktop · COS → Run workflow**，填写打包运行 URL 中的 `package_run_id`，并可填写 `package_run_attempt`。留空选择最新尝试及其成功的 package job；归档重跑继续使用原始构建 attempt，新的构建失败时不回退到较早成功构建。显式填写则选择对应构建，独立的 GitHub 归档失败不取消其资格。Windows 必须完成签名，macOS 必须完成公证和 stapling。GitHub job 证据确定原 runner，本机清单在审批前提供 preset、版本、源码和通道。不会下载安装包或请求 artifact。旧清单的 `publishRequested=false` 不影响发布资格；本机文件缺失或变化会停止发布。

在原 runner 安装依赖前，准备阶段和审批后的发布 job 都会检查所选 `publishing/<preset>.json` 是否为可读取的 JSON。配置缺失时会报告路径；补齐后可使用同一个包重试发布。之后仍会执行完整配置与签名校验。上传前，发布器校验全部留存文件的哈希、版本及目标信息，再复核平台签名。macOS 校验 DMG，并解压 ZIP 校验 app 票据；Windows 校验 Authenticode、配置的签名证书指纹及时间戳。准备阶段生成中文审批摘要，分别展示版本、通道、平台和环境，以及留存的 test release ID、安装包与升级 YAML 的完整 URL、原打包尝试链接、源码 ref/SHA、平台校验结果及拟创建的 tag。折叠详情包含 COS 存储桶，以及实际上传字节的大小和 SHA-256（包括改写后的 YAML）。公开仓库的摘要会公开测试前缀和下载 URL；前缀不提供访问鉴权。两种发布 job 均等待 **Review deployments → Approve and deploy**，随后重新核对已批准的 manifest 与上传计划摘要。文件或目标变化会被拒绝。审批不能修改版本；应拒绝并重新打包。两种环境都上传缺失文件、校验远端字节，再更新 YAML。此工作流没有只上传文件的模式。production 最后为记录的打包提交创建 `desktop-v<version>`；已有 tag 必须指向同一提交。

<a id="rollout-and-website-publication"></a>

## 放量与官网发布

按 10% → 30% → 100% 放量时，先通过 COS 流程以 `staging_percentage=10`、`upload_website=false` 完成首次发布，再从 `master` 发起 **Publish Desktop · Rollout & Website**，填写原打包 run ID 并选择 attempt（默认 1，请与原打包 run 核对）。逐步放量时将 `rollout_percentage` 分别设为 30、100；仅发布官网时留空。`upload_website` 默认为 false；必须填写比例或启用官网发布。在此示例中，最后一轮启用它即可上传生产官网安装器并刷新缓存。官网发布独立于放量比例，不要求达到 100%；官网安装包面向所有下载用户。仅发布官网时，publish job 只校验 feed，不修改放量比例。每个平台使用各自的打包 run。

准备阶段检查 GitHub 身份、保留清单、小体积更新 YAML 和已完成的首次发布记录，不重新计算安装包哈希，也不重复检查签名或公证。Environment 审批后，执行阶段读取当前 COS 更新清单，核对版本、安装包 URL、大小、哈希和其他元数据仍对应已发布包，只修改 `stagingPercentage`。更新清单缺失或已被其他包替换时拒绝执行。同一比例重复执行不写入；不允许降低比例。审批展示目标比例，当前比例在执行时从 COS 读取。

官网上传复用原机保留的安装器，只校验该安装器的哈希，沿用已有上传与刷新恢复记录。仅重试缓存刷新时沿用官网审批和上传记录，不再依赖原更新 YAML 或首次 feed 发布记录。官网上传在安装器校验、上传期间保持频道锁，防止中途被更新的 feed 替换；此时竞争该频道的发布会失败。因此纯放量不需要安装器文件，发布官网则需要。比例变更前后的 YAML 写入独立放量审计记录。此流程必须在首次 COS 发布之后执行，不构建安装包、不上传版本化安装包，也不创建 release tag。

<a id="recovery-and-records"></a>

## 恢复与记录

归档 job 使用系统 bsdtar 创建 store 模式 ZIP：Windows 为 `%SystemRoot%\System32\tar.exe`，macOS 为 `/usr/bin/tar`。`invalid ZIP output settings` 表示归档名称缺失或格式非法，或保留目录、临时目录、`GITHUB_OUTPUT` 缺失，会在校验文件前拒绝。`desktop archival: SystemRoot is required to locate Windows bsdtar` 表示缺失 Windows 系统目录设置。`ZIP creation failed with <tar>` 指明失败的归档工具；检查其 stderr、工具是否可用，以及 `RUNNER_TEMP` 剩余空间。

打包 workflow 将 `package` 与 `upload-artifact`（GitHub 产物归档）分开。所有打包模式（包括 test 和 unsigned）都要求在打包前配置 `DESKTOP_PUBLISH_RUNNERS`，用于将归档路由到原机器。归档失败后仅重跑 `upload-artifact`；它校验原始 manifest 和 hash，不重新构建、签名或公证。打包诊断归档尽力执行，不改变构建成功状态。归档重跑若一直排队且未分配 runner，应先检查解析出的 runner 标签和上游 package 输出，不能直接认定机器离线。输出缺失时需由操作者从原留存目录和 manifest 恢复文件；重跑整个 workflow 会重新构建，不属于仅归档恢复。Actions 验收须验证输出复用。

生产 COS 发布默认启用官网安装包上传和缓存刷新（`upload_website=true`）。取消后仅发布版本化资源及自动更新清单；test 发布不修改生产官网。`upload-website-installer` 上传固定安装包，`purge-website-installer` 刷新该 URL。官网安装包校验器只需要最终 DMG/EXE 和保留的 manifest，匹配生产资格、构建身份及平台，只计算一次安装包 hash，并通过同一打开的文件句柄上传。production nightly 和 stable 包都可以替换官网固定安装包。操作者负责选择预期版本；固定对象没有防降级保护，重跑旧发布可能覆盖新安装包。勾选官网上传时，审批前摘要展示固定官网 URL、选定版本和无防降级保护的说明。原有版本与自动更新发布保留自身校验。

将仓库变量 `DOWNLOAD_PROD_EO_ZONE_ID` 配置为生产 EdgeOne 站点。生产 COS 凭据还需要 `teo:CreatePurgeTask` 和 `teo:DescribePurgeTasks` 权限。官网上传在 Actions 中按 bucket/平台互斥，在原机器上按 bucket/对象互斥；缓存观察单独运行。版本发布、官网上传和缓存刷新分别使用生产审批 Environment，后续 job 和重跑可能需要再次审批。GitHub 每个并发组最多保留一个排队 job，新排队 job 可能取消旧排队 job；重跑前应检查取消记录。

官网状态保存在 releases 根目录同级的 `upload-records/website-<发布 run ID>-<target>/state.json`。macOS 和 Windows 在各自本地磁盘使用相同记录格式。官网 URL 和保存文件名遵循[固定下载规则](../README.zh.md#fixed-downloads)。上传重跑同时核对字节和 `Content-Disposition`；字节相同但响应头缺失或错误时，上传一次并读回验证。记录已完成但远端字节改变时停止恢复，需要重新审批发布。完成标记在元数据修复失败后仍保留。每次新的上传意图清除旧刷新记录，因此修复元数据后需重新刷新缓存；上一次任务 ID 和诊断需查 EdgeOne 历史。未知写入先读取再决定重试；CDN 响应头透传仍需实测。原机器路由和准备阶段输出完整时，仅重跑刷新 job 即可查询已保存任务。启用官网上传时，官网 job 仅跳过明确选择的 test 环境。各 job 的本地预检要求其注入的 `route` 或 `selection` 输出存在。官网审批缺失或变化时，在上传或提交刷新任务前失败。`website-destination` 缺失会扩大两个官网并发组的互斥范围。`runner` 输出缺失可能导致无法调度，尚未进入预检。输出缺失时停止局部重试，workflow 不重建这些输出。重新启动发布 workflow 前，先检查当前远端状态并确认上传范围的审批；这不属于仅缓存恢复。不要为恢复发布输出重跑打包。人工重跑确认旧任务失败后可提交一次。提交响应丢失时查询匹配的历史记录，不重新提交。unknown 带任务 ID 表示提交已确认；没有 ID 则可能从未提交。人工恢复前应检查 EdgeOne 历史，重新发起发布运行是恢复方式之一。操作者也可使用已有的[固定下载刷新命令](../README.zh.md#fixed-downloads)；Windows 操作者使用该处说明的 DPAPI 凭据启动器。该命令只提交固定 URL 刷新，不观察完成状态，也不更新本次 Actions 运行的 journal。确认恢复完成前应在 EdgeOne 检查返回的任务。

刷新观察每十秒查询一次，最长五分钟；结果未知或观察超时后额外查询一次。明确的 failed、timeout、canceled 结果使 job 失败。仍无法确认时成功退出，并输出 Actions warning 和醒目摘要；持久化状态保持 unknown，不标为完成。诊断 artifact 尽力归档，本地记录仍是恢复依据。模拟服务测试覆盖这些路径；发布操作者必须在生产依赖恢复能力前验证 COS/EdgeOne 权限、job-id 筛选、时间范围查询、任务类型和时间戳格式、Actions 跨 attempt 恢复及实际 CDN 行为。

解决故障后，仅在上文要求的上游输出完整时重跑失败的发布 job，以保持准备阶段选定的打包尝试；否则停止局部重试。新发布可显式选择原打包运行和尝试。尝试留空时重跑所有 job 会重新解析最新打包尝试，并需要重新审批。不要仅为重试上传而重新打包。缺失对象会上传，相同对象跳过，同名但字节不同的对象会停止操作。写入结果不明时通过读取远端字节核对。频道已有更高版本时，旧上传不能替换它。每个包只更新自身内置通道：nightly 写入 `nightly.yml` / `nightly-mac.yml`，stable 写入 `stable.yml` / `stable-mac.yml`。stable 二进制位于目标二进制前缀下的 `stable/` 子目录，与已有 nightly 对象分离。同一源码和版本发布到两个通道需要分别打包；已有发布 tag 仅在源码提交相同时复用。

同级 `upload-records/` 目录保留操作标识、逐行事件和最终结果。频道写入意图同时记录先前和目标 YAML。失败记录阶段、安全错误分类与诊断；COS 失败还标明 `GetObject` 或 `PutObject`，并在可用时记录经过校验的 HTTP 状态码和 request ID。访问拒绝提示会指出需检查的权限。不保存原始服务响应或凭据。审计初始化在文件完整后才可见；遗留的 `.initializing-*` 目录不参与已完成发布的扫描。写入和回读在继续操作前落盘；没有最终结果代表中断，不代表成功。Actions 还将操作记录保存为诊断 artifact，保留 30 天。这些本地记录不防篡改。COS 回读验证存储字节，不代表公开 CDN 行为；公开下载需单独验收。

频道更新完成但 tag 失败时，结果为 `published-tag-pending`，job 明确失败。重试时，已落盘的频道完成证据只允许恢复 tag，即使后来发布已推进频道，也不会重新发布旧 YAML。已有冲突 tag 需要管理员调查，不会自动移动。tag 创建被拒绝时保留其 HTTP 状态及经过校验的 GitHub request ID，后续查询不会用 tag 不存在的错误替换创建失败。仓库规则拒绝会提示操作人员检查匹配的 ruleset，不记录原始响应。

正常发布和手动恢复获取同一把本地频道锁。崩溃可能在同级 `publish-locks/` 下留下锁目录；手动删除前确认没有写入任务运行。runner 标签本身不能协调其他机器的写入。每个频道保持单一发布机器，迁移时保留记录。

<a id="restore-a-channel"></a>

## 恢复频道

在发布机器上通过 `node --import tsx` 运行仓库脚本 `apps/desktop/scripts/rollback-desktop-channel.ts`。保持 `GITHUB_REPOSITORY`、`RUNNER_NAME`、`DSH_PACKAGING_CONFIG_DIR` 和 `DESKTOP_PUBLISH_ROUTE` 对应原打包上下文。route JSON 包含 `runId`、`attempt`、`commit`、`runnerName`、`target`、`preset`、`sourceRef` 和 `channel`，可从留存 manifest 的 source 字段取得。`--record` 指定该次成功发布的审计目录，`--expected-version` 指定当前线上版本，`--reason` 填写操作原因。

不带 `--execute` 时，脚本读取远端对象并打印确切 YAML 变更，不执行写入。预览需要 COS 读取凭据。带 `--execute` 时，脚本校验历史文件，将前后 YAML 保存在新的审计记录中，再次检查当前频道，然后仅恢复 YAML。它不上传二进制文件，也不改变 tag。已经与目标字节完全相同的频道会跳过，其余频道必须匹配预期当前版本，因此可以恢复写完一个 feed 后中断的操作。其他当前版本会中止操作。恢复不是多对象事务；部分失败后需先检查审计记录再继续。

Desktop 客户端禁用自动降级。恢复旧 feed 可以阻止更多客户端获得问题版本，已经安装更高版本的客户端不会降级。发布更高版本号的修正版是独立恢复方式。

## 开发备注

无。
