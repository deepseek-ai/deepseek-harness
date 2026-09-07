---
description: "供启动器、客户端、构建工具和外部包共同使用的 package.json.dsh 元数据 TypeScript 声明。"
kind: "package-library"
---

# @deepseek-ai/dsh-package-manifest

[English](README.md) | 中文

## 概述

使用 `DshManifest` 为包的 Harness 元数据添加类型，也可用 `DshClientManifest` 等成员类型描述单项声明。启动器、客户端、构建工具和外部包导入同一组类型；各读取方负责 JSON 校验和默认值解析。

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
import type { DshClientManifest, DshManifest } from '@deepseek-ai/dsh-package-manifest'

const client: DshClientManifest = { platform: 'web' }
const dsh: DshManifest = {
  bundle: { patch: './cordis.patch.yml' },
  client,
}
```

`DshManifest` 描述 `bundle`、`profile`、`client`、`configTrees`、`sessionFormatMigration` 和 `moduleFallback`，不包含外层 npm manifest。`moduleFallback` 是启动器生成的元数据，不是作者配置项。TypeScript 检查该对象，并在编译时删除 `import type`；JSON 文件不能导入类型，此示例也不会写入 `package.json`。声明见 [`src/types.ts`](src/types.ts)。

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
- [声明归属](../../../.agents/notes/implemented/architecture/2026-09-05-package-manifest-types.zh.md)——范围与依赖依据。

<a id="model-experience"></a>
## 模型体验

无，因为本包仅导出类型。

#### KV Cache 影响

类型声明不增加模型输入，因此不影响提供方的缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **仅提供静态类型。** 这些声明不校验 JSON、不检查文件存在性，也不提供默认值。`configTrees` 服务于实验性镜像打包器，`sessionFormatMigration` 仅从工作区迁移包中发现；声明它们不会注册外部插件行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
