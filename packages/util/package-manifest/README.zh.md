---
description: "包身份、运行时要求和 DSH 插件元数据的共享 TypeScript 声明。"
kind: "package-library"
---

# @deepseek-ai/dsh-package-manifest

[English](README.md) | 中文

## 概述

使用 `DshPackageManifest` 描述包元数据、`DshManifest` 描述 `dsh` 下的公共字段，以及 `DshClientManifest` 等成员类型描述单个领域。各读取方负责 JSON 解析、校验和默认值解析。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从包根导入类型。仅检查自己的源码时使用开发依赖；若发布的声明文件引用这些类型，则使用生产依赖。

```ts
import type { DshClientManifest, DshPackageManifest } from '@deepseek-ai/dsh-package-manifest'

const client: DshClientManifest = { platform: 'web' }
const manifest: DshPackageManifest = {
  name: 'example-dsh-plugin',
  version: '1.0.0',
  engines: { node: '>=24', dsh: '0.1.5-alpha.1' },
  dsh: {
    manifestVersion: 1,
    bundle: { patch: './cordis.patch.yml' },
    client,
  },
}
```

`DshPackageManifest` 描述 DSH 使用的 package.json 字段，其中 `name` 和 `version` 必填；它不是完整的 npm schema（模式）。本地 profile 读取方使用 `Partial<DshPackageManifest>`，因为 profile 无需发布版本。`DshManifest` 仅描述 `dsh` 下的公共作者字段。TypeScript 检查示例并删除 `import type`；这些接口不解析 JSON，也不写入文件。

以下元数据字段均可选。省略时，格式版本或兼容的宿主版本保持未声明状态；读取方不推断默认值。

| 字段 | 含义 |
|---|---|
| `dsh.manifestVersion` | manifest（元数据清单）格式标识；声明的格式为 `1`，独立于 npm 包版本和 Session 格式版本。 |
| `engines.dsh` | 作者声明的兼容 DSH 版本，使用 SemVer 范围，也可填写精确的预发布版本。此字段与 `engines.node`、`engines.npm` 并列；engines 对象可省略 `dsh`。 |

公共组合声明定义在 [`src/types.ts`](src/types.ts) 中。内部 `configTrees`、`sessionFormatMigration` 和生成的 `moduleFallback` 元数据分别由镜像打包器、目录生成器和启动器读取方拥有；公共类型不暴露这些字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

包根仅重新导出 [`src/types.ts`](src/types.ts) 中的声明。本包不发布运行时不变量伴随模块，因为它没有运行时状态或可独立观察的关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Profile 启动器](../../boot/app-boot/README.zh.md#profiles)——manifest 加载与组合。
- [公共包元数据](../../../.agents/notes/implemented/architecture/2026-09-10-public-package-manifest.zh.md)——字段位置与读取方归属。

<a id="model-experience"></a>
## 模型体验

无，因为本包仅导出类型。

#### KV Cache 影响

类型声明不增加模型输入，因此不影响提供方的缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **仅提供静态类型。** 消费方读取并校验所需的 JSON 字段，再将共享声明适配为运行时数据。本包不提供解析器、getter helper、文件检查或默认值。
- **兼容性仅作声明。** 当前安装器和加载器不强制检查 `dsh.manifestVersion` 或 `engines.dsh`；声明范围不会拒绝不兼容的宿主，也不会校验 SemVer 语法。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
