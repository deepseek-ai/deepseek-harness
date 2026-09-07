# Agent Note: 默认的本地指令覆盖层

Status: implemented
Archived: 2026-09-04

[English](2026-07-21-local-instruction-overlay.md) | 中文

## 问题

被 git 忽略的个人指导文件（`AGENTS.local.md` / `CLAUDE.local.md`）是 Claude Code 的一项约定，用于存放刻意不提交、每位开发者各自的覆盖内容。[agent-instructions 插件](2026-06-24-workspace-context.zh.md)每个目录只加载一个候选，因此只有把某个 `.local.` 名字加进 `instructionFileCandidates` 才能读到它；而由于一个目录只有一个胜出者，这样做只会让它*遮蔽*已提交的基础文件，而不是补充它。这与这些名字所暗示的「基础文件加个人覆盖层」的叠加模型正好相反，而且它默认是关闭的。

## 决策

插件为每个项目目录额外加载第二个独立的候选列表。`localInstructionFileCandidates` 默认为 `['AGENTS.local.md', 'CLAUDE.local.md']`，并与 `instructionFileCandidates` 采用相同的同目录校验来解析。在从项目根到会话 cwd 的每个项目目录中，插件先加载基础候选，然后叠加加载本地候选；本地文件排在基础文件之后，因此在字节预算之内其内容优先级更高。两个列表都会在[按目录内容去重](2026-07-21-instruction-load-all-dedup.zh.md)之下完整加载。将 `localInstructionFileCandidates` 置空即可关闭该覆盖层。

该默认值定义在插件的 `Config` schema 中，而非某个产品的 `cordis.yml` 里，因此每个嵌入方（TUI、ACP、headless）读取 `.local.` 文件的行为一致，部署方也可以在一处覆盖或关闭该行为。这与插件自身持有的 `instructionFileCandidates` 默认值保持对称。

固定的用户全局文件 `$DSH_HOME/AGENTS.md` 没有本地覆盖层，始终只有基础文件。

## 每个候选各自独立的 scope

同一目录下的基础候选与本地候选，在基线冻结、待定窗口、版本缓存和协调过程中都必须彼此独立，因此对其中一个的改动绝不能抑制另一个。现在每个 `(directory, candidateName)` 对都是各自独立的 scope 键——参见[按候选划分的 scope 键](2026-07-21-instruction-load-all-dedup.zh.md)，它取代了此前基础/本地的层级哨兵。发现过程在每个项目目录中先遍历基础列表、再遍历本地列表，`reconcileInstructionContext` 为每个目录枚举每个配置的候选，`probeScopeInstruction` 则解码候选名以精确读取该文件。面向模型的提示词从文件的展示路径推导出供人阅读的目录标签，因此 scope 键永远不会到达模型。

## 备选方案

**更高优先级的先到先得（加载 `.local.` 而非基础文件）。** 否决：一个会替换已提交文件的个人覆盖层，会在覆盖层存在时丢弃共享的项目指导，这与 Claude Code 的叠加模型正好相反。

**通过 `instructionFileCandidates` 保持按需开启。** 否决：一个目录只有一个胜出者，因此加进该列表的 `.local.` 名字会遮蔽基础文件，而非补充它。packages 指引要求把按需开启项排除在出厂默认之外，但此处强有力的现有实践、以及用户对 `.local.` 文件总会被读取的预期，压过了这一考量。

**在产品 `cordis.yml` 层面设默认，而非在插件 schema 中。** 否决：这样只会为记得开启该功能的那个产品入口启用 `.local.`，从而在 TUI/ACP/headless 之间割裂行为，并重复一个本应与既有候选默认值放在一起的取值。

**两个层级复用原始目录作为 scope 键。** 否决：同一目录下的基础文件与本地文件会在每个以 scope 为键的映射中冲突，于是对其中一个的改动会抑制或覆盖另一个。为每个候选设置各自独立的 scope 键让两者保持独立，且无需扩展持久化的元数据结构。

**将覆盖层扩展到用户全局 scope。** 暂缓：`$DSH_HOME` 是单个固定的 `AGENTS.md`，没有可供补充的已提交基础文件，因此在出现具体需求前始终只有基础文件。

## 后果

`.local.` 指导在所有产品中默认被读取，无需按部署单独配置，与邻近工具保持一致。每个项目目录可以为每个存在的候选贡献一个持久 scope 而非仅一个，因此动态发现、编辑和移除会分别独立地协调基础文件与本地文件。已发布 v0 基线已经记录[按候选划分](2026-07-21-instruction-load-all-dedup.zh.md)的 scope 键。用户全局 scope 仍然只有基础文件，这一点作为已知限制记录在包 README 中。
