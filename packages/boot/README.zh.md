---
description: "boot 包组：dsh app bin 如何启动——环境加载、profile 与 patch 层、清晰的启动失败信息，以及由应用持有的命令行。"
kind: "package-group"
---

# boot/：共享的 app bin 启动粘合层

[English](README.md) | 中文

## 概述

boot 组负责启动 profile 应用并管理其已安装组合。`app-boot` 解析配置并启动 Loader，`cmdline` 提供应用参数，`plugin-manager` 提供与 CLI 共享的当前 profile 操作。各包 README 负责各自的细节。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`app-boot`](app-boot/README.zh.md) | 从 `cordis.yml` 启动 dsh 应用：加载 `.env`、应用 profile 与 patch 层，并清晰报告启动失败 | （供各 bin 使用的库） |
| [`cmdline`](cmdline/README.zh.md) | 让应用持有自己的 flag、`--help` 与退出码；启动器自身 flag 之后的一切原样传入 | `cmdlineArgs`、`appExit` |
| [`hmr`](hmr/README.zh.md) | 协调模块与配置重载，并与包修改互斥执行 | `hmr` |
| [`plugin-manager`](plugin-manager/README.zh.md) | 通过共享 CLI 操作管理当前 profile 插件与组合包 | `pluginManager` |

<a id="related-documentation"></a>
## 相关文档

- [dsh 应用](../../apps/cli/README.zh.md)——在其启动序列中使用这些 helper 的 `dsh` bin。
- [Profile 组合包](../bundle/README.zh.md)——可由 `dsh --profile` 组合挂载的可安装 patch 层。
- [dsh-home-paths](../util/home-paths/README.zh.md)——两个包都依赖的 harness home 解析器。
- [dsh-cmdline](cmdline/README.zh.md)——flag 家族如何由应用持有而非启动器。

- [Profile 管理](../../docs/subsystems/boot.zh.md)——服务方法与结果记录。

<a id="dev-note"></a>
## 开发备注

无。
