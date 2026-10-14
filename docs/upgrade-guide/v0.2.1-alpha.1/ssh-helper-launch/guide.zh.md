---
kind: upgrade-guide
description: "SSH 和 Node PTC 配置改用显式启动模式，SSH 客户端要求使用匹配的协议 2 helper。"
---

# SSH helper 与 PTC 启动配置

[English](guide.md) | 中文

## 变更

自定义 SSH 组合必须一起更新 `cordis.yml` 和已安装的 helper。`dsh-ssh` 将顶层 `node`、`bootstrapPath` 和 `bootstrapHash` 替换为 `launch`，并要求 SSH 协议 2。`dsh-ptc-runtime-node` 将 `nodeExecutable` 和 `bootstrapPath` 替换为 `launch`。连接的 `nodeExecutable` 和 `bootstrapPath` getter 替换为 `ptcLaunch`。

## 迁移

1. 使用脚本 helper 时，将 `node`、`bootstrapPath` 和 `bootstrapHash` 移入 `launch: { kind: node-script }`。`helper`、`helperHash`、`host` 和 `workspace` 保持原位置。安装匹配的 helper 脚本并更新 `helperHash`；配置了 bootstrap 时，一起更新该文件及其摘要。
2. 使用打包后的 helper 时，解压完整发行包，设置 `launch: { kind: executable }`，将 `helper` 设为可执行文件的远端绝对路径，将 `helperHash` 设为 `manifest.json` 中该文件的摘要。
3. 在组合现有的 JavaScript 配置中，通过 `launch: ctx.ssh.ptcLaunch` 配置远端 PTC 提供方。显式配置本地 Node worker 时，使用 `launch: { kind: 'node-script', executable: previousNodeExecutable, bootstrapPath: previousBootstrapPath }`。省略本地启动配置时，仍选择当前进程的运行时。
4. 启动配置好的 profile，执行一次远端文件读取、进程命令和 PTC 调用。出现协议或摘要不匹配时，需要一起更新已安装的 helper 及其配置。参见 [SSH 部署要求](../../../../packages/ssh/ssh/README.zh.md#use-this-package)。
