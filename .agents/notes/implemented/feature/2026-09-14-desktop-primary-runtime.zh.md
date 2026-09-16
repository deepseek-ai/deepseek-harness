# Agent Note: Desktop 第一方 Runtime

Status: implemented

[English](2026-09-14-desktop-primary-runtime.md) | 中文

## Problem

Desktop 代理需要在没有开发环境的机器上获得确定的 Python 数据处理库和独立 Node 解释器。系统解释器的选择必须继续由用户控制。

## Decision

Desktop 将 Python、Node.js、pnpm、numpy 和 pandas 作为绑定应用版本的产物交付。路径查询工具从应用资源将产物安装到 Harness home 下的固定目录，并返回绝对路径。它不修改 PATH、环境变量或包管理器配置。pnpm 使用原生全局安装规则。

应用版本和组件版本记录在 `runtime.json` 中，不放在目录名里。安装发布完整的暂存副本，并在替换成功前保留之前的目录。同版本复用已安装文件；升级替换受管目录内用户添加的 Python 依赖。Desktop 单实例所有者和工具共享的安装 Promise 串行处理正常安装请求。

Node 下载并校验完整锁定 wheel 集的哈希，将这些仅含库的压缩包解压到 site-packages。这避免选择构建主机的 Python 和 pip 版本，也无需实现依赖解析或通用 wheel 安装。含 `.data` 安装目录的 wheel 会被拒绝；命令行入口包装器不属于该库产物。本机 smoke 在临时文件删除后执行最终产物，因此解释器链接必须在迁移后仍有效。

macOS 仅向独立 Node 可执行文件授予 `com.apple.security.cs.allow-jit`。缺少此权限的强化运行时签名会阻止 V8 分配代码区域。解释器和库的 smoke 检查在签名后以及暂存清理后执行；签名有效本身不能证明程序可运行。

Desktop ZIP 解压通过定向依赖覆盖为 `extract-zip` 固定 `yauzl` 3.4.0。2.x 读取器在 Node 26 上可能无法完成较大 deflate 条目的读取（[上游问题](https://github.com/thejoshwolfe/yauzl/issues/176)）；保留现有解压器可保留其路径校验和 wheel 条目检查。开发启动器使用顶层 await，避免准备未完成却成功退出。大压缩 wheel 回归测试检查完整的解压字节。

## Alternatives considered

**只使用系统解释器。** 无法保证可用性或预装 numpy 和 pandas。

**注入 PATH 并指定 pnpm 全局目录。** 这些方式会改变命令选择，或要求 pnpm 全局命令目录已在 PATH 中。绝对解释器路径和 pnpm 原生行为无需这些改动即可满足请求范围。

**独立更新和版本目录。** Runtime 发布与 Desktop 绑定，且请求的安装位置固定。

## Consequences

应用携带额外的原生文件，并在升级时替换完整受管产物。Windows 上运行中的解释器可能阻止替换。本机构建 smoke、安装与复用及恢复测试、无密钥工具错误会话分别覆盖安装和模型输出路径；macOS 签名复用现有原生 Runtime 签名器。解释器压缩包和 Python wheel 固定哈希，许可证随各分发包保留。
