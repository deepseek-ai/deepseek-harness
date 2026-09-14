# Agent Note: 公共 package manifest 字段

Status: implemented

[English](2026-09-10-public-package-manifest.md) | 中文

## 问题

插件作者需要从统一的公共导入路径获取 npm 身份、运行时要求和 DSH 声明。内部镜像打包、Session 目录和生成的代理元数据不定义社区插件扩展点。将这些字段一起暴露，会让外部作者误以为内部机制也可供使用。

## 决策

[`DshPackageManifest`](../../../../packages/util/package-manifest/src/types.ts) 描述 DSH 使用的 package.json 字段，其中 `name` 和 `version` 必填。其可选的 `dsh` 成员使用 `DshManifest` 描述公共组合与作者元数据。该类型只选取所需 npm 字段，不是完整的 package.json schema（模式）。App-boot 通过 `Partial` 适配无需发布身份的本地 profile。

运行时要求位于顶层 `engines`：`dsh`、`node` 和 `npm` 均为可选版本字符串，也允许其他 engine 名称。`dsh.manifestVersion` 标识声明格式 `1`。当前安装器和加载器不强制检查格式与 DSH 兼容性声明。

镜像打包器拥有 `configTrees`，工作区目录生成器拥有 Session 迁移声明，app-boot 拥有生成的模块后备元数据。这些内部工具仍可读取既有磁盘字段，但公共 manifest 类型不暴露这些字段。此范围细化了[共享声明归属决策](2026-09-05-package-manifest-types.zh.md)，后者的包位置与依赖规则仍然有效。

各消费方负责 JSON 解析、字段校验、默认值解析和运行时数据适配。接口不会校验已解析的 JSON。只有多个消费方需要相同校验或归一化时，helper 才属于共享包；重复属性访问的 getter 不提供共享策略。

## 考虑过的替代方案

**将内部元数据保留在公共声明中。** 仅限工作区的迁移目录和实验性镜像打包器，不会因为其元数据可被发现就提供公共插件行为。

**将 DSH 兼容性放在 `dsh.engines` 下。** [VS Code](https://code.visualstudio.com/api/references/extension-manifest) 将宿主要求放在顶层 `engines.vscode`。顶层 `engines.dsh` 让作者在同一位置声明运行时要求；自定义键的检查仍由 DSH 负责。

**仅用 peer dependency 声明宿主要求。** Peer dependency 约束已安装的 npm 包，包括 CLI 包 `@deepseek-ai/dsh`。插件位于独立 profile 项目时，它们无法标识当前运行的 DSH 进程。

**通过统一的强制解析器解析所有领域。** 现有读取方消费不同字段子集，并各自拥有错误与默认值。合并它们会让客户端读取方校验无关的 profile 声明。公共类型保持独立于文件系统访问和解析策略。

## 后果

外部作者获得完整的包级声明和更小的 DSH 作者 API。已移除内部类型的消费方必须使用各自负责的实现。打包器与仓库目录不再依赖公共声明包；app-boot 保留生产依赖，因为其发布的 profile 类型引用该包。

编译器和构建后的 NodeNext 导入检查验证包身份必填、部分 profile、顶层 engine 声明，以及公共 API 不含内部字段。现有 profile、打包器和 Session 目录测试继续覆盖其接受的文件与畸形声明。Session 格式、插件加载规则和模型可见行为均不改变。
