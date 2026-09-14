---
description: "用户设置能力族的包映射：解析各 namespace 配置的 ctx.settings 服务，以及存储它的 YAML/JSON 文件提供方。"
kind: "package-group"
---

# settings/：用户可编辑配置

[English](README.md) | 中文

## 概述

`settings/` 组让插件配置变为用户可编辑：插件用一个 schema 注册具名 namespace，用户在一份文档里覆盖值，无需改动 `cordis.yml`。用户覆盖优先于部署自身的配置与 schema 默认值，变更实时生效。两个包覆盖该能力：`settings/` 提供设置服务，`settings-file/` 把所有 namespace 存进一个用户可编辑的 YAML 或 JSON 文档。设置是可选的：没有挂载提供方时，配置保持组合原样。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

两个包覆盖该能力；完整约定由各子级 README 负责，穷尽式服务接口面由子系统参考负责。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`settings/`](settings/README.zh.md) | 设置服务：注册 namespace 并读取或修改其值 | `ctx.settings` |
| [`settings-file/`](settings-file/README.zh.md) | 把设置存进一个本地 YAML/JSON 文件并实时发布外部修改 | 注册 `ctx.settings` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解共享词汇，再看本家族遵循的能力 seam 拆分。

- [设置子系统参考](../../docs/subsystems/settings.zh.md)——namespace、分层解析、descriptor、变更提交与生成的 Cordis 接口。
- [能力 seam](../../docs/capability-seams.zh.md)——本家族遵循的 Service Definition / Service Provider / Consumer 拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
