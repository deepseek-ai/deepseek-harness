# Agent Note: 基于隔离 App 副本的并行 macOS 公证

Status: implemented

[English](2026-09-09-parallel-macos-notarization.md) | 中文

## 问题

Desktop 发布同时提供用于安装的 DMG 和用于更新的 ZIP。等待 App 公证完成后才创建 DMG，会让两次 Apple 提交串行执行。代理可以提高上传吞吐量，但不能让两个独立的服务等待过程重叠。钉票会修改 App，因此并发公证和打包不能安全地共享同一个可写目录。

## 决策

固定目标安装包命令先组装一个 App，写入并验证其中的 `app-update.yml`，随后签名，再通过 `ditto` 创建两个独立副本。必须显式写入该配置，因为初始构建只有目录目标时，electron-builder 会跳过 macOS 更新配置钩子，而后续 `--prepackaged` 调用不会重新组装 App。App 路线公证其副本并钉票，验证签名、票据、Gatekeeper 接受状态与更新配置，再由 electron-builder 生成 ZIP 和更新元数据。DMG 路线验证其副本的更新配置，随后立即封装副本、签署映像，再通过现有 artifact-completion hook 公证映像、钉票并验证。每个 electron-builder 进程都通过 `--prepackaged` 接收真正的 `.app` 路径、独立的输出目录和 `--publish never`。

ZIP 包含已单独钉票的 App。DMG 包含已签名但未单独附加票据的 App；根据 Apple 的[容器说明](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)，外层票据覆盖内嵌代码。Apple 还说明了 [Gatekeeper 检查外层容器时接收票据的行为](https://developer.apple.com/forums/thread/125512)。单独提取未钉票 App 依赖在线或缓存票据；ZIP 则提供内嵌票据。仅生成目录的命令仍会公证 App 并钉票。

错误传播和临时目录清理前必须等待两路均结束。只有两路均成功且使用已配置更新源时，才允许移入 DMG、ZIP、ZIP blockmap 和频道元数据。已钉票的 App 替换签名目录构建，调用方最后写入发布完成记录。App 更新配置缺失或不匹配会在移入前失败；任何错误都会使该记录保持缺失，现有上传校验因而会拒绝不完整发布。独立输出目录还避免了 electron-builder 诊断文件与频道元数据的并发写入。

本决策细化了 [Desktop 打包决策](../architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)中的公证顺序；原决策继续负责发布身份、签名、更新归属与发布要求。

## 考虑过的替代方案

**两路共享一个 App。** DMG 读取可能与 `stapler` 写入重叠，使 bundle 内容不确定。独立副本使每条路线中提交与分发的字节保持稳定。

**只公证 DMG。** ZIP 更新独立分发，需要已钉票的 App。保留两次提交可以明确维持这项独立验收。

**保留串行公证，仅使用代理。** 同一个 214.84 MiB DMG 直连上传耗时 203.83 秒，通过所测系统代理上传耗时 38.59 秒，但两种网络路径都不能消除 Apple 提交间的串行依赖。代理配置仍由构建主机负责；打包脚本不修改主机网络设置。

**App 公证结束前，在同一次 electron-builder 调用中运行两个目标。** ZIP 必须读取已钉票副本。独立的 prepackaged 调用可以保留 electron-builder 自己的归档、blockmap 和元数据实现，无需修改目标调度或给依赖打补丁。

## 影响

2026-09-09，在同一台 Mac、同一系统代理下，arm64 完整打包在并行公证时耗时 490.78 秒，串行时耗时 751.33 秒，缩短 34.7%。两条产物路线相隔 8 毫秒启动，App/ZIP 耗时 307.36 秒，DMG 耗时 268.54 秒。Apple 接受了两次提交，两者上传完成时间仅相差约一秒。每种配置只有一次完整构建样本，缓存与 Apple 队列变化使我们不能将全部差值归因于并发。

两个临时 App 副本与独立产物目录增加了磁盘峰值占用。两次上传可能争用网络带宽，Apple 也可能分别排队处理；阶段计时记录实际行为，不构成 CI 延迟预算。一路失败后会等待另一路结束再清理，这可能延迟错误报告，但能避免删除仍由子进程持有的文件。

[编排测试](../../../../apps/desktop/tests/package-macos.spec.ts)通过同步屏障验证重叠执行、票据隔离、收集两路错误、强制检查更新配置，以及拒绝移入不完整产物。聚焦配置测试覆盖固定更新源的写入，并拒绝缺失、不匹配或字段不完整的配置。受控的串行回归会使重叠断言失败。真实签名 macOS 打包、ZIP 解压后验证、DMG 完整性与内嵌签名检查、最终上传计划验证用于验收平台工具；跨版本已安装应用更新和干净 Mac 上的离线安装仍属于发布验收工作。
