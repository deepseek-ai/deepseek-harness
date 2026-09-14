# Agent Note: 工作区文件统一为 API 双面包

Status: implemented

[English](2026-09-07-workspace-files-dual-face-package.md) | 中文

## Problem

工作区文件服务与浏览器资源提供者共同演进，但其编译图包含指向 Remote 装配和 Sidebar UI 的反向依赖。拆包避开了这些环，却分离了线路协议与其 Client 模型的归属。只有 Host 实现、Client 编译入口仅含类型的包，也缺少 Client 目录分析用于区分运行时导出的 `dsh.client` 与 `./client` 声明。

## Decision

`packages/api/workspace-files` 拥有两面的实现。Host 与 Client 叶配置仍由各自的根聚合直接引用，solution 根配置引用两片叶子。Host 导出文件服务，`./client` 导出实际的资源提供者插件，`dsh.client` 声明浏览器插件。web-app 的一个条目加载两面。这只取代[工作区文件服务记录](2026-09-05-workspace-files-service.zh.md)中的拆包决定，其授权、分页与流语义保持不变。

两条依赖方向使编译图保持无环：

- `client/resources` 从定义 `RemoteResult` 与 `RemoteFailure` 的 `typert/protocol` 包导入它们，不依赖 `api/remotes`；后者负责装配消费资源模型的提供者。
- 文本预览使用文件包导出的参数类型声明 `SidebarRightResourceParamsMap.file`。文件提供者声明其资源值，但不导入 Sidebar UI。调用方需要该导航声明时，导入查看器的类型入口。

这消除了 `remotes → workspace-files → resources → remotes` 和 `remotes → workspace-files → sidebar-right → ui-conversation → remotes`。Cordis 运行时服务注入仍独立于 TypeScript 工程引用。

## Alternatives considered

**保留两个包。** 这隔离了编译环，却拆开同一文件能力的 Host 与 Client 归属。删除反向类型依赖后，可以采用与其它 API Controller 相同的双面组织。

**删除根 Client 引用。** 传递引用仍会编译该叶子，但两个根聚合必须显式命名本包对应的编译面。

**修改目录分析或增加空 Client 插件。** 两者都不能提供要求的浏览器实现。实际的 `./client` 导出和 `dsh.client` 使用分析器已有的双面支持路径。

## Consequences

Host 线路方法和浏览器资源行为不变。浏览器实现、测试与文档归同一个包所有；Client 类型依赖止于协议和资源模型层，不反向触及 UI 或 Remote 装配。

## Verification

Cordis inspect 目录检查分析声明的 Client 导出，两个编译聚合保留其叶引用，Host 与 Client 文件服务测试覆盖相同的实现。现有依赖与工程引用检查约束这些编译关系。
