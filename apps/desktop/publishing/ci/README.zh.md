---
description: "在专用 macOS 和 Windows runner 上发布留存的 Desktop 安装包。"
---

# Desktop CI 发布

[English](README.md) | 中文

## 概述

在原打包机器上发布完整安装包，无需再次下载安装包。test 和 production 都先发布二进制文件，再更新 YAML。两种环境都需要 GitHub Environment 审批；只有 production 通过 GitHub App 创建 tag。真实 COS、CDN 和管理员权限仍需部署验收；本地 fixture 不证明这些权限可用。

## 目录

- [机器配置](#machine-setup)
- [打包与发布](#package-and-publish)
- [恢复与记录](#recovery-and-records)
- [恢复频道](#restore-a-channel)

<a id="machine-setup"></a>

## 机器配置

保持 `DSH_PACKAGING_CONFIG_DIR` 指向现有机器打包目录。完成的构建复制到其同级 `releases/<run-id>/<attempt>/`；`DSH_DESKTOP_RELEASES_DIR` 可用绝对路径覆盖该根目录。文件清单包含安装包、更新归档、blockmap、完成记录和不含凭据的 manifest。调试包会留存，但不能发布。复制内容通过校验后才开放 attempt 目录，已有 attempt 不能被替换。GitHub 保留相同文件清单 14 天。本地文件保留到操作员删除；校验或发布期间不要删除对应 attempt。

在配置目录下创建 `publishing/test.json`，获得授权后再创建 `publishing/production.json`。每份配置声明 `bucket`、不带路径的 HTTPS `origin` 和绝对路径 `credentialsFile`。凭据文件只包含 `secretId` 和 `secretKey`。macOS 还需 `macOS.signingIdentity` 和 `macOS.teamId`；Windows 需要 `windows.certificateThumbprint`。production 必须使用 origin `https://download.deepseek.com`，并提供 `githubApp.clientId` 和绝对路径 `githubApp.privateKeyFile`。这些文件不进入 Git。上传器支持长期 COS 凭据，不支持 STS 会话凭据。不可覆盖的二进制写入要求 bucket 版本控制关闭。

将仓库变量 `DESKTOP_PUBLISH_RUNNERS` 配置为已注册 runner 名称到唯一标签和目标的 JSON 映射，例如 `{"mini":{"label":"dsh-mini-publish","target":"mac-arm64"}}`。该标签只能分配给这台 runner。Windows 使用目标 `win-x64`。路由 job 检查原构建成功的 job，发布器再检查自身 runner 名称与记录一致。机器之间不需要共享文件系统或局域网连接。

管理员必须创建 `desktop-test` 和 `desktop-production`，分别设置必需审批人并允许 `master` 部署分支。工作流会检查两种环境的审批人配置。test 可允许发起者自行审批。GitHub App 需要安装到本仓库、具有 Contents write 权限，并获准在 `desktop-v*` tag ruleset 下创建发布 tag。审批不会把审批人的 tag 权限传给 App。缺少配置会停止发布，不回退到个人 token。App action 创建短期 token，并在结束后撤销。使用发布账户的文件系统权限保护本机私钥及 COS 凭据文件。token action 需要密钥内容，因此已屏蔽日志的 PEM 在 job 期间也会经过 runner 临时 `GITHUB_OUTPUT` 文件；日志屏蔽不限制本地文件访问。

Environment 审批限制此工作流，不限制同一机器账户运行的任意代码。账户隔离和强制源分支限制属于独立运维工作。保持现有发布 Environment 不变。test job 使用自己的审批人，不创建真实发布 tag；本地模拟接口覆盖 tag 创建与恢复，但不验证 App 权限。

<a id="package-and-publish"></a>

## 打包与发布

选择对应平台的 `Package Desktop` 工作流、preset、源码、通道和版本模式。`source_ref` 接受 `master` 或与所选产品版本一致的 `dsh-v*`；源码必须包含这些 CI 适配脚本，因此旧 tag 会在安装依赖前失败。发布器从默认分支运行，单独记录实际源码提交。`version_mode=default` 对 production 选择 product，对 test 选择 auto；product 保留所选源码版本，auto 追加日期/run/attempt，manual 要求填写 `build_version`。latest 包要求稳定版本，因此 test/latest 需选择 product 或稳定的手填版本。可选 `test_release_id` 是测试 URL 前缀：留空沿用机器默认值，同一平台连续升级测试需保持相同值，并应定期轮换默认值。它不是 GitHub run ID。格式校验和轮换限制见[打包配置](../../packaging/README.zh.md#configuration-and-local-builds)。

选中 `publish`，请求在打包成功后发布。Windows 必须签名；macOS 必须完成公证和 stapling。独立的 `Publish Desktop · COS` 工作流从 GitHub 读取小型请求 manifest，将其与原 run 和 attempt 核对，再路由到原机器。安装包使用本机留存文件。构建失败或未请求发布时不会上传。

上传前，发布器校验全部留存文件的哈希、版本及目标信息，再复核平台签名。macOS 校验 DMG，并解压 ZIP 校验 app 票据；Windows 校验 Authenticode、配置的签名证书指纹及时间戳。准备阶段生成审批摘要，列出版本、通道、平台、环境、源码 ref/SHA、package run/attempt、对象路径及拟创建的 tag。两种发布 job 均等待 **Review deployments → Approve and deploy**，随后重新核对已批准的 manifest 与上传计划摘要。文件或目标变化会被拒绝。审批不能修改版本；应拒绝并重新打包。两种环境都上传缺失文件、校验远端字节，再更新 YAML。此工作流没有只上传文件的模式。production 最后为记录的打包提交创建 `desktop-v<version>`；已有 tag 必须指向同一提交。

<a id="recovery-and-records"></a>

## 恢复与记录

解决故障后重跑发布工作流，不要仅为重试上传而重新打包。原 package run 和 attempt 保持不变。缺失对象会上传，相同对象跳过，同名但字节不同的对象会停止操作。写入结果不明时通过读取远端字节核对。频道已有更高版本时，旧上传不能替换它。每个包只更新自身内置通道：nightly 写入 `nightly.yml` / `nightly-mac.yml`，latest 写入 `latest.yml` / `latest-mac.yml`。latest 二进制位于目标二进制前缀下的 `latest/` 子目录，与已有 nightly 对象分离。同一源码和版本发布到两个通道需要分别打包；已有发布 tag 仅在源码提交相同时复用。

同级 `upload-records/` 目录保留操作标识、逐行事件和最终结果。频道写入意图同时记录先前和目标 YAML。失败记录阶段、安全错误分类与诊断，不保存原始服务响应。审计初始化在文件完整后才可见；遗留的 `.initializing-*` 目录不参与已完成发布的扫描。写入和回读在继续操作前落盘；没有最终结果代表中断，不代表成功。Actions 还将操作记录保存为诊断 artifact，保留 30 天。这些本地记录不防篡改。COS 回读验证存储字节，不代表公开 CDN 行为；公开下载需单独验收。

频道更新完成但 tag 失败时，结果为 `published-tag-pending`，job 明确失败。重试时，已落盘的频道完成证据只允许恢复 tag，即使后来发布已推进频道，也不会重新发布旧 YAML。已有冲突 tag 需要管理员调查，不会自动移动。

正常发布和手动恢复获取同一把本地频道锁。崩溃可能在同级 `publish-locks/` 下留下锁目录；手动删除前确认没有写入任务运行。runner 标签本身不能协调其他机器的写入。每个频道保持单一发布机器，迁移时保留记录。

<a id="restore-a-channel"></a>

## 恢复频道

在发布机器上通过 `node --import tsx` 运行仓库脚本 `apps/desktop/scripts/rollback-desktop-channel.ts`。保持 `GITHUB_REPOSITORY`、`RUNNER_NAME`、`DSH_PACKAGING_CONFIG_DIR` 和 `DESKTOP_PUBLISH_ROUTE` 对应原打包上下文。route JSON 包含 `runId`、`attempt`、`commit`、`runnerName`、`target`、`preset`、`sourceRef` 和 `channel`，可从留存 manifest 的 source 字段取得。`--record` 指定该次成功发布的审计目录，`--expected-version` 指定当前线上版本，`--reason` 填写操作原因。

不带 `--execute` 时，脚本读取远端对象并打印确切 YAML 变更，不执行写入。预览需要 COS 读取凭据。带 `--execute` 时，脚本校验历史文件，将前后 YAML 保存在新的审计记录中，再次检查当前频道，然后仅恢复 YAML。它不上传二进制文件，也不改变 tag。已经与目标字节完全相同的频道会跳过，其余频道必须匹配预期当前版本，因此可以恢复写完一个 feed 后中断的操作。其他当前版本会中止操作。恢复不是多对象事务；部分失败后需先检查审计记录再继续。

Desktop 客户端禁用自动降级。恢复旧 feed 可以阻止更多客户端获得问题版本，已经安装更高版本的客户端不会降级。发布更高版本号的修正版是独立恢复方式。

## 开发备注

无。
