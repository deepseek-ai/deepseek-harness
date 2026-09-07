# Agent Note: 移除专用 repository 插件路径

Status: implemented
Archived: 2026-09-04

[English](2026-08-09-remove-repository-plugin.md) | 中文

## 问题

repository 插件路径与 profile 组合包路径重复实现了第三方包的安装和组合。它增加了 `.dsh-plugin` manifest（元数据清单）、生成的包装层、准备工作可执行文件、第二套 Git／包缓存、Loader 内置项，以及 repository 专用的 skill（技能）和 MCP 适配器。profile 组合包已经能通过 profile 包管理器安装 npm 或 Git 包说明符，保留正常的依赖与生命周期语义，并提供一个有序 `cordis.patch.yml` 层，其中可以挂载普通 Cordis 插件。

重复的路径所能提供的配置也少于组合包。其 `repositories` 列表选择源字符串，但生成的包装层挂载代码入口时无法传入用户提供的插件配置。因此，repository 专用的准备流程增加了大量代码和 CI 工作，却没有成为通用的外部插件分发机制。

## 决策

DeepSeek Harness 只保留一种独立的外部插件分发路径：可安装的 profile 组合包。`dsh plugin --profile <name> add <package-or-git-spec>` 将依赖记录到 profile 包中，安装的包通过声明 `dsh.bundle.patch` 提供自己的 patch 层。包管理器负责获取源、管理版本和依赖、运行构建生命周期，并维护锁文件。组合包 patch 负责选择 Cordis 插件并提供完整的插件配置。

移除 `@deepseek-ai/dsh-repository-plugin` 包、`.dsh-plugin` 编写格式、`dsh-plugin-prepare` 可执行文件、生成的包装层、不可变 repository 缓存、base 中的 `repository-plugins` 配置项，以及专用 GitHub 验收流水线。vendor 中未再使用的 `@cordisjs/plugin-loader/repository` 子路径及其随附的 pnpm 依赖，也随唯一消费方一并移除。现有 repository 缓存目录只是不会再产生作用的用户数据；DSH 既不会读取，也不会删除这些目录。

组合包直接组合现有归属方。提供 skill 的组合包挂载 `@deepseek-ai/dsh-skill-filesystem`；提供 MCP 服务器的组合包挂载 `@deepseek-ai/dsh-mcp-client`；原生行为则挂载普通的已编译 Cordis 插件。这些包继续保有各自的校验、生命周期、注册和 teardown 契约。根据预发布兼容政策，不保留针对 `.dsh-plugin` 的兼容解析器或迁移机制。

本说明整合了已移除的 repository 缓存、静态格式、纯配置集成、由 npm 支持的准备流程和受信任代码入口决策。其原始动机保留于此：独立用户需要由包管理器负责的外部组合方式；Git 和 npm 依赖可以执行受信任的生命周期代码；静态 skill 与 MCP 贡献应复用现有归属方；来源标识应位于 profile 的依赖说明符和锁文件中。相应实现特有的包装层、缓存 generation 和准备协议不再约束产品。

## 曾考虑的替代方案

**保留 repository 插件，将其作为组合包的便利包装层。** 不予采纳，因为这会为同一个包保留两条安装命令、两种 manifest 格式，以及两套失败／缓存标识。如果一层便利包装不能传递普通的插件配置，其能力仍然不及它所包装的机制。

**让 repository 包装层加载组合包 patch。** 不予采纳，因为 repository 缓存和准备协议仍会重复 profile 依赖安装。组合包已经可以通过 pnpm 接受 npm、Git、file 和 link 说明符。

**为未来可能出现的消费方保留通用 Loader repository 缓存。** 不予采纳，因为在移除相关包后，它已无当前消费方，却仍让一个 vendor 中与浏览器相邻的包携带固定版本的包管理器运行时。只有当无需显式安装即可在配置阶段激活这一能力成为 profile 依赖无法满足的产品需求时，才有理由重新引入专用缓存；届时该消费方可以选择自己的缓存约定。

**禁用 repository 插件，但保留其磁盘格式以供迁移。** 根据预发布方针，不予采纳。保留解析器或兼容 loader 会在没有外部兼容义务的情况下，让已移除的契约继续存在。

## 后果

- 第三方包统一使用一种安装与组合模型，采用普通依赖声明和完整的 patch 层插件配置。
- 安装或更新外部组合包时，必须显式通过 `dsh plugin` 执行包管理器操作，而不是编辑受监听的源列表。用户 patch 的 HMR（热模块替换）仍可配置已安装组合包所提供的配置项。
- 安装 profile 时，宿主机的 `PATH` 中必须提供 `pnpm`。对于显式的包管理操作，这一要求可以接受，并且可避免仅为配置阶段激活而随产品交付已移除缓存所使用的固定版本包管理器运行时。
- `.dsh-plugin` 包和现有 repository 源列表 patch 停止工作。用户仍可自行删除其缓存文件，但系统不会迁移或自动删除这些文件。
- 专用 pnpm 运行时、准备工作可执行文件、包装层生成器、Git 凭据 CI 设置、repository 缓存和 repository 专用测试全部消失。
- 静态资源需要一种由组合包拥有、可相对于包解析的路径形式，使声明式组合包可以将 `dsh-skill-filesystem`、`dsh-mcp-client` 或其他插件指向它随包交付的文件，而无需定制运行时代码。该能力归组合包格式所有，而不是 repository 适配器。

## 测试

静态门禁会拒绝残留的包、配置、文档、图和 workspace 引用。现有 `dsh plugin` 已构建 CLI（命令行界面）验收测试覆盖 profile 初始化、包管理器安装、组合包发现和层调和。声明式、相对于包解析的 skill 与 MCP 组合包资源仍是本移除层中已明确记录的覆盖缺口。
