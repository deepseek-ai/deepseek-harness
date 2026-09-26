# Agent Note：Desktop 发布版本改为命令参数，不再改写清单

Status: implemented

[English](2026-09-21-desktop-build-version-as-input.md) | 中文

## 问题

[从完整 dsh 版本派生 Desktop 测试版本](2026-09-16-desktop-release-version-derivation.zh.md)确定了测试构建叫什么，但没有确定这个名字存在哪里。发布一次测试构建要先运行 `release:dsh`，把版本写进所有发布家族清单和锁文件——295 个文件——因为打包、更新 feed 和上传校验都各自从工作区读取版本。这些改动从不提交，所以每次测试构建都会留下脏工作区直到有人还原，而还原后的工作区又不再描述已经发布出去的产物。`<base>.YYYYMMDD.index` 里的序号同样靠人对着发布记录和 bucket 挑选，而这是脚本可以完成的查询。

另有两件事在构建之后无法还原。交给同事或推到测试 feed 的构建没有任何标签可查，它来自的构建树也不是工作区，因此没有任何东西把安装包和源码连起来。production 发布同样只在 bucket 里留下痕迹。

## 决策

构建发布的版本是一个参数。`--build-version` 指定它，`--build-version auto` 给出当天的下一个序号，该值经 `extraMetadata` 进入 electron-builder，并作为同一个输入贯穿更新 feed 与上传校验。清单保留产品版本，因此任何打包运行都不修改被跟踪的文件。

[Desktop 发布规则](../../../../apps/desktop/README.zh.md#release-versions)中的版本规则不变：production 发布 dsh 基础版本，预发布基础版本追加 `.YYYYMMDD.index`，稳定基础版本追加 `-test.YYYYMMDD.index`。校验直接使用 `semver`，因为 `electron-updater` 就是用 `semver.gt` 把 feed 版本与已安装的 `app.getVersion()` 比较。

本决策取代上述 Note 的两条要求。发布家族清单不再被改写；外壳版本也不再等于内置运行时版本：内置运行时就是产品版本的 dsh 包，`verifyDesktopRuntime` 接收准备该运行时树的一方写入的版本，而安装升级验证会为自己的材料改写这个版本。应用本来就把两者分别上报给强制更新策略。

所有产物的清单都记录 `dshBuildCommit` 与 `dshBuildDirty`。production 上传在产物公开后把打包所用 commit 打成 `desktop-v<版本>` 标签，失败时只打印需要手工执行的命令，而不让已完成的上传变成失败；来自有改动工作区的构建不打标签。test 与本地构建有意不留标签，因为为每个测试构建打标签会淹没真正的发布。

上传从打包写下的完成记录中读取发布版本，而不是从变量读取，因此[发布字段仍然只来自目标文件](../../../../apps/desktop/README.zh.md#release-versions)。

## 考虑过的替代方案

**继续改写清单，事后还原。** 脏工作区本身就是缺陷，而还原会与任何同时读取工作区的操作竞争，也会让已发布产物所描述的状态在仓库中不复存在。

**只在临时副本里改写打包运行时的清单。** 内置 dsh 会因此宣称一个 npm 上不存在的版本，副本还得与锁文件保持一致，没有任何收益。

**不要参数，全部自动编号。** 操作者需要在打包前与用户确认版本。自动编号以 `auto` 提供并打印所选版本，而不是作为默认行为。

**为每个构建打标签。** 测试 feed 持续接收构建，逐个打标签会让 `desktop-v*` 无法再用于查找发布。改由产物自身携带 commit。

## 影响

打包运行不再改动仓库，因此构建产物的代码树就是标签或记录的 commit 所指的那棵树。`auto` 会访问目标 bucket，`--check` 下同样如此；未配置 bucket 或列举未能在期限内完成时回退到本地输出目录，不完整的列举结果会被丢弃，以免复用序号覆盖已发布的安装包。production 上传现在会写入仓库，而早先的发布自动化刻意避免这一点；这次写入只是一个标签，由操作者自己的命令在上传成功后执行。
