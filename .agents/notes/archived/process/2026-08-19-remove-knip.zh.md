# Agent Note: 从仓库门禁中移除 Knip

Status: implemented
Archived: 2026-09-30

[English](2026-08-19-remove-knip.md) | 中文

## 问题

Knip 从静态源码图推导未使用文件、export 和依赖。DeepSeek Harness 还会从包 manifest（元数据清单）和配置中装载 Cordis 插件、向 `lib/` 生成 Typert 契约面、拆分 Host 与 Client 程序，并声明仅由生成代码或运行时装载代码消费的依赖。因此，仓库必须维护 workspace 专用入口列表和忽略依赖例外，才能让受支持路径通过扫描。包与测试布局变化还必须维护这份对可执行图的第二重近似描述。

仓库已经为视作发布约定的故障提供了更窄的检查：TypeScript 与 Oxlint 验证源码 import，workspace 约束验证 manifest，`verify-optional-dependency-imports` 验证可选 import，`verify-runtime-closure` 验证运行时依赖，`verify-client-packages` 验证 Client 打包，publint 验证发布包。通用未使用代码结果只是建议，而其例外却是必需维护项。

## 决策

Knip 不再是仓库依赖或质量门禁。根 manifest 不含 Knip 脚本或 devDependency，门禁图和 `hygiene` 命令不调用它，仓库也不携带 Knip 配置。包指南和注释直接描述运行时或生成代码要求，不再讲解 Knip 例外。

仓库没有检查全仓未使用文件、export 或依赖的静态门禁。维护者需要从调用点、manifest、配置、生成产物、测试、文档和 Cordis Loader 路径证明一项删除是安全的。

## 考虑过的替代方案

**保留 Knip 及其例外清单。** 这会保留一项宽泛的建议信号，但每条受支持的动态或生成路径都需要配置，而这些配置会重述 manifest、构建配置和包专用检查已经拥有的事实。这份例外清单使普通包变更依赖一个无法表示组装后应用的源码图。

## 后果

CI 和 `hygiene` 少运行一个命令，包变更也不再更新一份并行的入口与依赖例外清单。仓库放弃自动生成宽泛的未使用代码与未使用依赖报告；评审与简化工作必须根据真实装载路径证明删除安全。

未来的未使用代码检查必须理解 manifest 驱动的 Cordis 装载、生成输出与 Host/Client 拆分，且不需要逐 workspace 忽略清单。在此之前，缺少源码 import 的依赖本身不能证明该依赖是死代码。
