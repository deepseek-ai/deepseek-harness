---
description: "将完整 Desktop 安装包与更新清单发布到选定下载服务。本参考文档说明部署标识、上传凭据、固定下载和审计记录。打包配置与签名操作由独立文档维护。"
---

# Desktop 发布

[English](README.md) | 中文

## 概述

将完整 Desktop 安装包与更新清单发布到选定下载服务。本参考文档说明部署标识、上传凭据、固定下载和审计记录。打包配置与签名操作由独立文档维护。

## 目录

- [发布前提](#prerequisites)
- [部署环境与测试发布标识](#upload-updates)
- [发布安装包与更新清单](#publish-feeds)
- [固定安装包下载](#fixed-downloads)
- [上传凭据](#credentials)
- [上传审计与恢复](#audit-and-recovery)

自托管留存构建使用 [CI 发布工作流](ci/README.zh.md)，在原机器保留安装包并支持恢复发布。 以下命令继续作为现有人工授权的本地上传器使用：它们保留 checkout 内的审计记录，并使用操作员的 Git 身份，不共享 CI 发布器的锁、审批或仅补 tag 恢复机制。不要让两种上传器并发写入同一频道。两者复用相同的上传计划校验；分开编排可保留现有手动命令，同时为 CI 增加不可变 attempt 恢复能力。统一或退役手动命令属于独立工作。

<a id="prerequisites"></a>

## 发布前提

发布需要完整的 release 产物和操作者明确授权。生成安装包或下载 Actions 产物不会发布它。先阅读[发布版本规则](../packaging/README.zh.md#release-versions)并保留打包证据。机器 preset 用于打包，不支持 upload/COS 命令：取消设置 `DSH_PACKAGING_PRESET`，并提供既有目标 dotenv 上传配置。配置以及真实 COS/CDN 验收由发布操作者验证。

<a id="upload-updates"></a>

## 部署环境与测试发布标识

`DSH_DESKTOP_AUTO_UPDATE_ENV` 同时选择打包写入的 URL 与后续 COS 上传环境，可取 `test` 或 `production`；缺省为 `test`。测试打包通过 `DOWNLOAD_TEST_ORIGIN` 提供 HTTPS origin；生产使用 `https://download.deepseek.com`。上传通过 `DOWNLOAD_TEST_COS_BUCKET` 或 `DOWNLOAD_PROD_COS_BUCKET` 提供所选 bucket。生产清单位于 `dsh-desk/feeds/<target>/`，安装包位于 `dsh-desk/bin/<target>/`。测试发布必须配置 `DOWNLOAD_TEST_RELEASE_ID`：32 位小写十六进制字符，分别插入路径 `dsh-desk/<release-id>/feeds/<target>/` 和 `dsh-desk/<release-id>/bin/<target>/`。YAML 引用、稳定通道别名和 blockmap 都位于该发布目录内。目标为 `mac-arm64`、`mac-x64` 和 `win-x64`。

更新目标与上传凭据都与所选环境对应：

| 环境 | 公开 origin | COS bucket | COS 凭据 |
|---|---|---|---|
| `test` 或未设置 | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`、`DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`、`DOWNLOAD_PROD_COS_SECRET_KEY` |

每个测试发布批次用下方命令生成新 ID，将输出填入 `.env.macos` 或 `.env.windows` 的 `DOWNLOAD_TEST_RELEASE_ID`。这两个被 Git 忽略的平台文件管理该值，shell 变量不能覆盖它，dotenv 值也不会进行 shell 展开。打包、上传和重试必须沿用同一个 ID；上传会拒绝更新 URL 不一致的完成记录。需要验证跨版本升级时，后续版本沿用已安装客户端的 ID。生产环境不使用该字段。

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(16).toString('hex'))"
```

通过完整下载链接分发每个测试批次。已安装的测试客户端保留当前批次的清单地址，不会自动发现新 ID。格式校验无法判断随机性，请使用生成器的输出。随机路径降低被猜中的概率，不限制持有链接者访问；撤下批次需要删除其 COS 对象并清除对应 CDN 目录缓存。

<a id="publish-feeds"></a>

## 发布安装包与更新清单

在目标 `.env` 中配置更新地址与所选 COS bucket、SecretId、SecretKey，再打包并上传同一个目标：

```sh
pnpm run package:desktop:mac:arm64
pnpm run upload:mac:arm64
```

内测打包在目标 `.env` 中显式设置 `DSH_DESKTOP_AUTO_UPDATE_ENV=test` 和 `DOWNLOAD_TEST_ORIGIN=https://download-test.deepseek.com`；上传使用 `DOWNLOAD_TEST_COS_BUCKET=bj-toc-download-test-1320056602` 及独立测试凭据。test 和 production 都使用固定 Nightly 通道，部署选择不提供通道切换。

前期内测包使用 `test` 部署。只有正式发布才显式选择 `production`；更换上传凭据不会改变已有安装包的更新目标。打包不需要 COS 凭据，会禁用 electron-builder 发布、移除子进程的 COS 凭据，并且仅在签名与公证成功后记录完成状态。上传在读取凭据前验证该记录、部署、目标、共同版本号、文件名、大小与 SHA-512。安装包和 blockmap 先于 YAML 上传；历史对象继续保留。每个版本发布 `nightly.yml` 或 `nightly-mac.yml`；稳定版本还发布指向相同产物的 `latest.yml` 或 `latest-mac.yml`。发布的 YAML 使用安装包绝对 URL。上传器不设置 Cache-Control，包括 COS SDK 否则会添加的空头部：缓存策略由部署基础设施负责，清单不缓存，安装包缓存单独配置。同一目标应串行发布，并在发布验收前验证公网产物与清单内容。

Windows NSIS 上传要求安装包旁存在生成的非空 `.exe.blockmap`。blockmap 先于通道 YAML 上传；NSIS 安装包元数据不要求另一种 web-installer 格式使用的内嵌 `blockMapSize`。文件清单测试使用固定版本构建器的 blockmap 生成器，而不是手工编造内嵌映射字段。

<a id="fixed-downloads"></a>

## 固定安装包下载

固定安装包下载在仓库根目录使用 `pnpm run upload:latest:mac:arm64`、`pnpm run upload:latest:mac:x64` 或 `pnpm run upload:latest:win:x64`。它们把已完成目标的 DMG 或 EXE 上传到 `desktop/dsh-latest-macos-arm64.dmg`、`desktop/dsh-latest-macos-x64.dmg` 或 `desktop/dsh-latest-windows-x64.exe`。生产 URL 以 `https://download.deepseek.com/` 开头；测试 URL 使用 `DOWNLOAD_TEST_ORIGIN`。两个部署环境均复用目标 dotenv 中的部署、bucket 和凭据、全部常规发布校验以及下述上传审计。每个命令覆盖一个固定对象，不发布更新清单、blockmap 或发布标签。测试固定下载在测试 bucket 中跨发布 ID 共享；包内更新 URL 仍要求原有发布 ID。发布由操作人员显式执行，也允许预发布版本。部署基础设施必须配置重新验证，或在覆盖后清除固定下载的缓存。本地回环测试覆盖上传行为；真实 COS 和 CDN 验收由发布操作人员负责。

<a id="credentials"></a>

## 上传凭据

Windows 操作人员可以在仓库外保存 CLIXML 对象，其中 `SecretId` 和 `SecretKey` 是经 DPAPI 加密的 SecureString 字段。[凭据启动器](../scripts/upload-with-credentials.ps1)要求显式提供 `-CredentialFile` 和 `-Environment production` 或 `test`；不指定 `-Upload` 时，只验证解密以及向本地 Node 子进程注入凭据，不发起网络请求。它要求 `PATH` 中有 Node，并使用加密该文件时的 Windows 用户和机器。明文、空字段及纯空白字段都会失败。父进程环境保持不变；子进程先清除无关密钥与 Node 预加载选项，再仅接收所选 COS 凭据对。原始子进程 stderr 不会显示，stdout 中的凭据值会被遮盖。此检查不能证明 COS 授权有效。显式上传还要求 `-Upload -Target <target> -Bucket <bucket>` 及下述常规发布完成前提；真实云端上传仍需发布操作人员验收。在该上传调用中添加 `-Latest`，即可替换固定安装包，而不发布更新清单或发布标签。此启动器支持长期密钥，不支持 STS 凭据。显式上传要求所选部署环境和 bucket 与目标 dotenv 文件及已完成的打包记录一致，才会发起网络写入；即使 dotenv 文件含有其他 COS 密钥，也使用 DPAPI 凭据对。

<a id="audit-and-recovery"></a>

## 上传审计与恢复

test 与 production 的 `upload:*` 上传在发布前置检查通过后，分别保留新的 `.desktop-build/upload-records/<environment>-<target>-*` 目录。`plan.json` 记录目标、版本、每个文件的大小/SHA-512 和发布的 YAML 字节；刷盘的 `events.jsonl` 记录 PUT 意图及可用的响应状态/请求 ID；`result.json` 记录完成结果或最后失败阶段。缺少最终结果表示中断或存储不可用，不表示成功。不记录凭据值、认证头或原始 SDK 错误。审计写入失败即停止后续 PUT。每个对象都以一次流式腾讯 COS PUT 上传，并携带显式长度与 Content-MD5；COS SDK 仅在请求体不是流时才会重发请求，上传器自身也不重试。保留部分记录，检查远端状态后再执行下一次操作：超时或回执写入失败不能证明对象未存储。这些记录仅在本地，不防篡改，也不会自动备份；每次发布应将它们与构建证据一同归档到受控存储。公网 CDN 回读仍是单独的发布验收，上传结果明确标记为 `not-performed`。

## 开发备注

无。
