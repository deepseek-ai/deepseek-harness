---
description: "将测试二进制上传与人工授权的固定 feed 发布分离，用于 Windows 安装版更新验收。"
---

# 测试更新上传与发布

[English](README.md) | 中文

## 摘要

上传两个已验证版本而不公布版本 2，待操作者启动已安装的版本 1 后才发布版本 2 的固定 feed。默认命令检查本地物料，不读取凭据或联网。实际 COS 写入需要另行获得人工授权并验证。

## 目录

- [前提条件](#prerequisites)
- [人工操作顺序](#sequence)
- [证据与恢复](#evidence)
- [开发备注](#dev-note)

<a id="prerequisites"></a>

## 前提条件

完成[演练指南](../README.zh.md)中的两个安装包验证。保留通过的 `verification/check-*/result.json` 回执及未修改物料。发布工具将回执与当前安装包、blockmap、feed 和清单字节重新核对。它绝不签名或安装任何文件。

现有 `.env.windows` 加载器提供 `DSH_DESKTOP_AUTO_UPDATE_ENV=test`、`DOWNLOAD_TEST_ORIGIN=https://download-test.deepseek.com`、`DOWNLOAD_TEST_COS_BUCKET=bj-toc-download-test-1320056602` 及 `DOWNLOAD_TEST_COS_SECRET_ID` / `DOWNLOAD_TEST_COS_SECRET_KEY`。只有这两个上传秘密进入 COS 客户端；绝不放入命令或记录。传输实现将请求限制在 test 存储桶和独立的 Windows 验收路径内。

二进制上传操作额外查询存储桶版本控制；查询成功且既非启用也非暂停状态之前，它拒绝写入。feed 发布复用成功的二进制上传回执，不重复查询桶配置或下载安装包。COS 文档说明 [`x-cos-forbid-overwrite`](https://cloud.tencent.cn/document/product/436/7749) 无法保护开启版本控制的存储桶中的对象。查询被拒绝仅意味着该配置未知，不能证明上传被拒绝。

所有机器只使用一个发布者。本地 `publication.lock` 排除共享物料目录的重叠操作，不限制其他机器。版本 2 发布在替换前检查现有版本 1 feed；该读取与写入不是原子的比较并交换操作。其他发布者不得并发写入同一个 feed。

<a id="sequence"></a>

## 人工操作顺序

以下是待人工执行的步骤，不是已完成的远端验收。在仓库根目录使用保留的清单、准确版本及匹配的验包回执执行。不加 `--execute` 时，两个命令都只打印本地计划，不发送请求：

```powershell
node --import tsx apps/desktop/scripts/publish-installed-update.ts upload-binaries "<run.json>" "<version>" "<verification/result.json>"
node --import tsx apps/desktop/scripts/publish-installed-update.ts publish-feed "<run.json>" "<version>" "<verification/result.json>"
```

1. 先在本地检查两个版本。每次单独授权上传后，给 `upload-binaries` 加上 `--execute`，在交互终端输入 `UPLOAD <version> <run-id>`。上传安装包和 blockmap 绝不发布 feed。已存在且匹配的二进制仅回读、不覆盖；字节不符立即停止。
2. 保持固定 feed 不存在。安装版本 1 并通过安装后的快捷方式启动，确认显示版本和日志中的 `workspace-ready`。授权任何 feed 写入前，先完成演练指南中的 404 场景。保持版本 1 运行。
3. 给版本 1 的 `publish-feed` 加上 `--execute`，输入 `PUBLISH <version> <run-id>` 授权发布。其二进制必须已存在并通过公网回读。初始 feed 必须不存在，或包含完全一致的版本 1 字节。完整回读 feed 后，在仍运行的版本 1 应用内完成同版本场景；保留证据，另行授权后才发布版本 2。
4. 使用下述命令及其准确确认授权版本 2 发布。提供原安装应用的 `dsh-update-qualification/<run-id>/journals` 目录。要求启动证据及符合预期的旧 feed。操作者独立核对安装路径及版本 1 仍在运行。

```powershell
node --import tsx apps/desktop/scripts/publish-installed-update.ts publish-feed "<run.json>" "<version-2>" "<version-2-verification/result.json>" --journals "<journal-directory>" --execute
```

发布和公网回读成功后，才继续演练指南。工具使用固定公网 URL，不加破缓存参数，上传时设置 `Cache-Control: no-store`，并验证返回字节及哈希。二进制上传保留完整公网回读。feed 发布仅在远端读取 feed，要求本批次 `publication-records/operation-*` 下存在成功的 `upload-binaries` 结果，且其本地计划完全匹配；回执缺失、失败或不匹配时停止发布。发布结果记录复用回执的路径及回执／计划哈希。这证明此前分发成功，不证明不可变对象持续可用；不得删除或替换这些对象。SDK 写入没有自动重试。

<a id="evidence"></a>

## 证据与恢复

每次操作保留 `publication-records/operation-*`：计划、带时间戳的阶段、最终结果，以及适用时的 feed 原文。记录包含可安全保留的请求 ID 和可用 HTTP 状态，不含原始 SDK 错误或认证头。失败即停止后续写入；超时不能证明服务器拒绝了此前写入。保留记录和远端对象，检查最后阶段及真实远端状态，另行确认后才执行下一次操作。

按准确 API 诊断 `403 AccessDenied`：`GetBucketVersioning`、`GetObject` 与 `PutObject` 需要不同权限。要求扩权或修改 CDN 配置前，先对照保留的成功记录，并用当前凭据检查失败操作。没有尝试上传时，不能把新增配置查询失败报告为上传失败。读取成功也不能证明当前写入权限；优先审查不必要的新增前置检查，而不是扩大最小权限上传身份的授权。

人工请求的后续操作验证已匹配对象，不重写它们。`alreadyPublished: true` 表示核对已存在的目标 feed，不是一次新发布；发布时间使用原操作证据。非预期 feed 字节会使操作停止，包括尝试用版本 1 替换版本 2。崩溃可能留下 `publication.lock`；确认没有发布者运行并保留失败记录后，才由操作者移除这个准确的空目录。绝不为了绕过活跃发布者而删除锁。

qualification COS 版本查询的总截止时间为 30 秒，对象读取与 PUT 的总截止时间为 15 分钟。到期会中止底层 HTTP 请求，并在释放操作锁前等待请求关闭；持续传输不会延长时限。

<a id="dev-note"></a>

## 开发备注

顺序测试使用内存存储替身；传输测试使用替代 HTTP 处理器执行真实 SDK 序列化。两者均不能证明 COS 写入已验收。2026-09-14，当前凭据读取保留的 test 探针返回 HTTP 200 且 SHA-512 匹配，而 `GetBucketVersioning` 返回 403；没有尝试 PUT。另一次 2026-09-11 探针已验证 test 上传、固定 feed 刷新和 updater 下载。TODO：在不削弱命名空间隔离、完整性检查与失败即停的前提下审查额外的桶配置前置条件；本次文档纠正并未实现移除该条件。

随后经操作者授权的批次 `installed-update-r5dYNH` 在 `.desktop-build/qualification/` 下保留 `object-overwrite-probe/result.json` 和 `binary-upload/result.json`。新建 49 字节测试对象成功；再次携带禁止覆盖参数 PUT 相同字节时返回 `409 FileAlreadyExists`，源站及公网哈希保持不变。限定本批次的纯二进制驱动随后使用相同请求头上传两个签名安装包及其 blockmap，重新核对验包回执，并验证全部四个完整公网响应。记录包含四次成功的新对象 PUT，没有重试、feed 或配置写入，探针保持保留。对独立 feed URL 的 HEAD 观测返回 404。本次人工操作以观测到的对象级防覆盖行为替代桶配置查询；上方通用 CLI 的前置条件未修改。这些回执证明测试对象已分发，不证明 feed 发布、安装后启动或已安装版本升级。
