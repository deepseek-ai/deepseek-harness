# Agent Note: Python 运行时按锁文件部署

Status: implemented

[English](2026-11-01-locked-python-runtime-deploy.md) | 中文

## 问题

Python 可执行文件打包需要使用与工作区锁文件相同的依赖版本和完整性记录。legacy hoisted 部署忽略该锁文件，重新解析兼容的注册表版本：允许 `tslib@^2.8.1` 的 manifest 可能安装 `2.9.1`，而锁文件记录的是 `2.8.1`。Office 归档准备随后因缺少锁定的完整性记录而拒绝构建。工作区的冻结安装成功，并不能约束后续的 legacy 部署。

## 决策

Python 构建器使用 pnpm 的默认部署，从工作区锁文件派生独立的生产锁文件，再冻结安装。本记录只替代[单文件可执行程序分发决策](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)中的部署策略；其中的运行时架构和载体布局继续有效。

部署保留源锁文件的对等依赖设置，包括 `autoInstallPeers: true`。冻结安装保留已解析的版本和对等依赖关系，不会重新解析新的注册表对等依赖。强制指定 `autoInstallPeers: false` 与派生锁文件的设置冲突，会使冻结安装失败。生成的依赖树不必与关闭对等依赖解析的 legacy 依赖树相同，但所选依赖必须来自锁定的依赖图。`verify-runtime-closure.ts` 独立要求在部署前显式声明工作区对等依赖及 preset 插件；`verifyStagedDependencies` 在链接实体化与去重后拒绝缺失的直接依赖目录。

[`scripts/python-runtime-deploy.pnpmfile.mjs`](../../../../scripts/python-runtime-deploy.pnpmfile.mjs) 将已审阅的本地 `file:` 审批转换为派生锁文件使用的精确绝对文件 URL。批准、拒绝、未决定状态和严格构建校验均保持不变。默认部署执行已批准的安装脚本，其生成的文件可能进入暂存载荷。工作区策略和源锁文件保持不变。

## 考虑过的替代方案

**保留 legacy 部署并补全缺失的完整性记录。** 这会接受源锁文件没有选择的版本，并在另一个兼容版本发布后重复出现故障。

**在默认部署中关闭对等依赖自动安装。** 这与源锁文件的设置冲突；重新解析另一套依赖图会放弃源锁文件的决定权。

**禁用部署脚本，或按名称批准本地包。** 跳过脚本会遗漏必需的 postinstall 准备。仅按名称批准不能授权非 semver 的本地文件依赖；转换精确标识可以保留原有审批决定。

## 测试

真实 pnpm 对照使用相同 manifest 和锁文件，legacy 部署安装 `tslib@2.9.1`，默认部署保留 `2.8.1`。Linux 可执行文件及本地构建并安装的 wheel SDK 冒烟测试通过。定向测试拒绝缺失的依赖目录和部署参数回退，保留审批状态，并覆盖两种 metadata 路径基准。跨平台打包及安装后 wheel 校验仍由 CI 负责。

## 影响

运行时版本可以追溯到工作区锁文件，不完整的直接依赖树会在可执行文件打包前失败。安装脚本产物和锁定的对等依赖选择可能与 legacy 部署不同，因此不承诺载荷逐字节相同。SSH helper 部署使用独立的闭包 manifest 和原生载荷校验，其 legacy 部署不属于本次 Python 运行时修复范围。
