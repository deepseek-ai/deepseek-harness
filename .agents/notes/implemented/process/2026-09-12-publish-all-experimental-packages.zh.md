# Agent Note: 发布所有当前实验性包

Status: implemented

[English](2026-09-12-publish-all-experimental-packages.md) | 中文

## 问题

用户需要通过 npm 使用 Auto review、Inspector、CPython PTC 后端与浏览器 worker 库，同时保留其实验性 API 状态。仅在源码 checkout 中测试，不能证明 tarball 包含已安装消费方所需的运行时文件与 import。

## 决策

`packages/experimental/` 下的所有当前包都通过 dsh 发布系列与本地 npm baseline 发布。各 manifest（元数据清单）省略 `private`，并设置 `publishConfig.access: public`。[发布拒绝列表](2026-09-12-experimental-publication-denylist.zh.md)仍可用于未来的私有例外，但不包含任何目录。实验性 npm 名称、显式启用组合、依赖隔离、兼容性预期与支持限制保持不变。

Inspector tarball 包含 `lib/worker.js`，Host 入口通过相邻 URL 启动它。其构建产物测试先打包并解压包，再启动该 Worker。WebWorker 打包器通过运行时的公开库入口导入模块代理与替换包表；编译后的 repository 分片不需要运行时 TypeScript 源码。其已打包消费方测试在普通 Node 下导入两个解压后的 tarball，并在不使用这两个包源码目录的情况下挂载生成的基础镜像与数据叠加层。

CPython PTC 后端携带 Python 脚本，在 Unix 上仍需要受支持的外部解释器。浏览器 worker 包提供已安装库 API；打包器的仓库 CLI（命令行界面）仍需要文档要求的已构建 checkout。发布不会把这些包加入任何随附 profile，也不会让浏览器预览成为产品启动入口。

## 曾考虑的替代方案

**让被排除的包继续保持私有。** 即使所选组合显式接受实验性行为，用户仍无法安装使用。

**只修改 manifest 访问字段。** Inspector 会遗漏其 Worker，编译后的 WebWorker 打包器会导入运行时 tarball 中不存在的源文件。已打包消费方检查必须覆盖可能被源码测试掩盖的运行时文件。

**将这些包提升到产品组。** 安装不需要移除实验性 npm 名称，也不需要接受稳定 owner 与支持义务。

## 后果

所有当前实验性包都可由显式消费方使用。发布集合与包作者承担完整公开产物的责任，同时保持默认产品组合隔离。空拒绝列表通过 fixture（测试前置数据）继续验证未来私有排除项。
