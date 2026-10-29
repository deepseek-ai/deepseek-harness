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
| 发布 `prepare` 和 `publish` | `self-hosted`，以及选中的 `DESKTOP_PUBLISH_RUNNERS` 条目中的 `label` |

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

发布到 test 或 production 都必须在 Windows 选择 `signing=signed`，或在 macOS 不勾选**跳过公证**。无签名、无公证的包仅限内部调试，不能发布或用于自动更新。托管路由 job 会在安装依赖前，依据所选 run 和 attempt 对应的 artifact 名称拒绝已标明的调试包。缺少 artifact 元数据不代表允许发布：原机器仍会验证留存清单和签名。遇到调试包拒绝提示时，需重新完成签名或公证，再使用新包的 run ID / attempt 发布；重跑发布不能使现有产物获得发布资格。

选择对应平台的 `Package Desktop` 工作流、preset、源码、通道和版本模式。test 的 `source_ref` 接受仓库内分支名（如 `feature/desktop-update`）或 `dsh-v*` tag；production 仅接受 `master` 或 `dsh-v*` tag。符合 `dsh-v` 后接数字、其余为字母、数字、点或连字符的名称按 tag 处理，即使存在同名分支。tag 必须与所选产品版本一致。建议从 `master` 启动打包工作流，再单独填写打包源码；不支持直接填写 commit SHA、PR ref 或 fork 仓库。源码必须包含 CI 适配脚本，旧源码会在安装依赖前失败。仅选择可信分支：其构建代码将在签名机器上执行。这是操作约定，不提供工作流来源强制限制或凭据隔离。发布使用记录的 commit，并要求该提交仍在所选分支历史中；正常追加提交不影响发布，删除分支或导致历史分叉的强推会拒绝。tag 发布要求 tag 仍指向记录的提交。从 `master` 发起发布；托管路由 job 会在派发到原机器前拒绝其他 ref。实际打包源码提交单独记录。`version_mode=default` 对 production 选择 product，对 test 选择 auto；product 保留所选源码版本，auto 追加日期/run/attempt，manual 要求填写 `build_version`。latest 包要求稳定版本，因此 test/latest 需选择 product 或稳定的手填版本。可选 `test_release_id` 是测试 URL 前缀：留空沿用机器默认值，同一平台连续升级测试需保持相同值，并应定期轮换默认值。它不是 GitHub run ID。格式校验和轮换限制见[打包配置](../../packaging/README.zh.md#configuration-and-local-builds)。

打包只保留文件。成功后，在 `master` 上打开 **Publish Desktop · COS → Run workflow**，填写打包运行 URL 中的 `package_run_id`，并可填写 `package_run_attempt`。留空选择最新尝试，且该尝试必须成功，不会回退到较早的成功尝试；显式填写则选择对应的成功构建。Windows 必须完成签名，macOS 必须完成公证和 stapling。GitHub job 证据确定原 runner，本机清单在审批前提供 preset、版本、源码和通道。不会下载安装包或请求 artifact。旧清单的 `publishRequested=false` 不影响发布资格；本机文件缺失或变化会停止发布。

在原 runner 安装依赖前，准备阶段和审批后的发布 job 都会检查所选 `publishing/<preset>.json` 是否为可读取的 JSON。配置缺失时会报告路径；补齐后可使用同一个包重试发布。之后仍会执行完整配置与签名校验。上传前，发布器校验全部留存文件的哈希、版本及目标信息，再复核平台签名。macOS 校验 DMG，并解压 ZIP 校验 app 票据；Windows 校验 Authenticode、配置的签名证书指纹及时间戳。准备阶段生成中文审批摘要，分别展示版本、通道、平台和环境，以及留存的 test release ID、安装包与升级 YAML 的完整 URL、原打包尝试链接、源码 ref/SHA、平台校验结果及拟创建的 tag。折叠详情包含 COS 存储桶，以及实际上传字节的大小和 SHA-256（包括改写后的 YAML）。公开仓库的摘要会公开测试前缀和下载 URL；前缀不提供访问鉴权。两种发布 job 均等待 **Review deployments → Approve and deploy**，随后重新核对已批准的 manifest 与上传计划摘要。文件或目标变化会被拒绝。审批不能修改版本；应拒绝并重新打包。两种环境都上传缺失文件、校验远端字节，再更新 YAML。此工作流没有只上传文件的模式。production 最后为记录的打包提交创建 `desktop-v<version>`；已有 tag 必须指向同一提交。

<a id="recovery-and-records"></a>

## 恢复与记录

解决故障后重跑失败的发布 job，以保持准备阶段选定的打包尝试；也可显式填写原打包运行和尝试，发起新的发布。尝试留空时重跑所有 job 会重新解析最新打包尝试，并需要重新审批。不要仅为重试上传而重新打包。缺失对象会上传，相同对象跳过，同名但字节不同的对象会停止操作。写入结果不明时通过读取远端字节核对。频道已有更高版本时，旧上传不能替换它。每个包只更新自身内置通道：nightly 写入 `nightly.yml` / `nightly-mac.yml`，latest 写入 `latest.yml` / `latest-mac.yml`。latest 二进制位于目标二进制前缀下的 `latest/` 子目录，与已有 nightly 对象分离。同一源码和版本发布到两个通道需要分别打包；已有发布 tag 仅在源码提交相同时复用。

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
