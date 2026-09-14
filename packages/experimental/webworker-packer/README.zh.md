---
description: "面向构建或排查实验性预览部署的维护者，说明浏览器 worker 虚拟文件系统（VFS）镜像打包。"
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-packer`

[English](README.md) | 中文

## 概述

VFS 镜像打包器：把一份合成 profile 变成浏览器 worker 挂载为文件系统的 gzip 压缩基础 tar，并把不透明数据目录变成按序应用的 overlay tar（[实验组](../README.zh.md)）。不做任何源码编译——基础镜像携带仓库真实构建产物，预览部署调试的正是 served 部署交付的字节。打包预览镜像或排查镜像内容时，请阅读本页。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

公开 npm 包通过库入口导出 `packVfsImage` 和 `packVfsOverlay`。调用方提供合成配置、包目录和解析根目录；本包不安装 profile 层。运行时的库入口提供打包所用的模块代理表与替换表。

打包器在 [`src/repository.ts`](src/repository.ts) 中拥有内部 `dsh.configTrees` 声明、校验和源目录解析。该字段不属于公共插件 manifest API。

打包是三层标准栈：

1. **Roster**——合成 profile 的插件行（标准 YAML 解析、Include 方言、`!!js` 原样保留），加上 CLI（命令行界面）在 `package.json` `dsh.configTrees` 里声明的每棵配置树（agent（智能体） presets）的行，按 Node 式依赖闭包物化。外部 peer 边绝不会绑定到 worker，workspace peer 保留在链上。
2. **发布视图**——每个 workspace 或 vendored 包贡献其构建后的 npm 切片（`files` 走 picomatch），不带源码和 workspace `dist/`。外部包的 `main` 或 `exports` 可能指向 `src/` 或 `dist/`，因此两处发布 JavaScript 都会保留，只应用通用的测试、map、声明与归档排除规则。
3. **可达性 sweep**——用运行时加载器自己的解析，从全部 workspace 导出面加 worker 装配种子（`IMAGE_ENTRY_SEEDS`）出发，打包时把每个可达模块转换为符合包装层约定的形式。该转换会报告名称可静态确定的 import、re-export 与动态 import、经 `require` 发起的调用，以及通过 `node:module` 或 `module` 具名导入（含导入别名）在模块作用域直接发起的 `createRequire(import.meta.url)('pkg')` 调用。页面资产（`./client` 导出背后的 `lib/client.js`）原样直发；自家代码的不可解析请求会让打包失败，第三方不可解析请求则允许延后到 require 时明确失败。

`repository.ts` 拥有仓库形态输入（`vendor/`、`packages/`、`native/system/packages/` 与 `apps/` 的 workspace 扫描；经真 CLI dump 路径合成 profile）；`pack.ts` 一概不拥有，同一库换参即可打另一棵树。Native 扫描使 Landlock 入口包成为普通发布视图依赖，其可执行文件仍由 Worker 平台实现。CLI 为 `dsh-pack-vfs-image --out <file> [--profile web]`；`apps/web` 的 `build:preview` 在预览壳构建后运行它。

仓库适配器还声明 `webworker-runtime/tests/fixtures/` 下仅用于 preview 的 fixture（测试前置数据） tree。CLI 会把每套具名 fixture 打成一份独立的确定性 overlay 归档，并写出浏览器可读的 manifest（元数据清单）。Overlay 文件绕过 npm 发布视图和模块可达性排除规则，因此点目录与示例源码会完整保留；其挂载位置仅限 `home/` 与 `workspace/`。`pack.ts` 把它们视为不透明字节；会话与 Workspace 的解释仍归拥有这些格式的运行时包。

-----

<a id="model-experience"></a>
## 模型体验

无：本包在构建期运行并写出镜像文件，其产物本身不进入任何模型请求。

#### KV Cache 影响

无：本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **规则表依赖人工判断**（`rules.ts`：exclude glob、页面资产模式、入口种子），由 `tests/` 钉住；worker 需要触达的新资产类别应加表行，而不是改扫描器。
- **可达性只推断精确请求形式**——计算得到的 `import` 与 `require` 参数、保存下来的 `createRequire` 结果、经 CommonJS 获取的 `createRequire`，以及基准不是 `import.meta.url` 的调用只在运行时解析；若目标已被裁掉就会显式失败。只能通过这些形式触达的目标需要显式镜像入口种子。
- **vendored 包源码（`src/*.ts`）被排除**——运行时无人解析它们；未来若有 worker 内源码巡检功能需要专门的 include 规则。
- **打包器假定构建产物 `lib/` 是新鲜的**：它从不编译，工作区构建陈旧就会打包陈旧字节。先跑仓库构建。
- **CLI 必须位于原有仓库位置**：`dsh-pack-vfs-image` 相对于自身安装文件定位检出目录，并从中读取源码 CLI、配置树和预览 fixture。npm 安装支持参数化的库 API；CLI 和仓库辅助函数需要完整且已构建的 DeepSeek Harness 检出目录。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是没有生产事件流或可变数据的构建时 pass；无法解析的自有代码请求与全有或全无的包装层约定会直接让 pack 失败。
