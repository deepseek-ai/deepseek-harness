# Agent Note: 通过路径编码的子目录对 Agent Note 进行分类

Status: implemented
Archived: 2026-09-04

[English](2026-06-20-agent-note-classification.md) | 中文

## 问题

仅按生命周期组织的 Agent Note 目录树（`proposed/` / `implemented/` / `rejected/`）无法记录每个文件包含哪一*类*决策。读者浏览某个生命周期时，如果不逐一打开文件，就无法区分新功能、移除项或工具策略变更。

本仓库一贯的倾向是[机械质量门禁优于行文规范](2026-06-11-quality-gates.zh.md)：不被机器检查的约定终将腐烂。因此这里的分类方案必须可强制执行，而非靠自觉的文件头。

## 决策

增加第二个维度，即 Agent Note 的**类别**，并将其编码在路径中：`{lifecycle}/{class}/yyyy-mm-dd-topic.md`。文件夹*就是*标签。文件位置声明其类别；封闭集合限定为「这些文件夹且仅限这些」；既有的 [verify-md-links](2026-06-18-markdown-cross-link-lint.zh.md) 门禁已经保护移动文件所需的路径改写。

### 六个类别的封闭集合

| 类别 | 涵盖范围 |
|---|---|
| `feature` | 面向用户或模型的新功能。 |
| `bug-fix` | 修正缺陷或填补事故复盘（postmortem）暴露的空白。 |
| `simplification` | 移除代码、行为或对外接口范围，不引入新功能。 |
| `architecture` | 关于**交付源码**的结构性决策——包之间的关系、运行时词汇。 |
| `process` | **围绕**代码的工具、策略或工作流，而非运行时行为。 |
| `testing` | 测试基础设施与策略。 |

`architecture` 与 `process` 的分界是：**architecture** 关乎我们交付的源码；**process** 关乎源码周边的工具与工作流。本 Agent Note 本身属于 `process` 决策：它改变仓库的组织方式与门禁，而不是 harness 的运行时行为，因此位于 `implemented/process/` 下。

### 两道门禁

两者都是 `doc-sync`（文档同步门禁）的成员，风格与 `verify-md-wrap` 一致（tsx ESM，只校验不生成，首个违规即以非零退出码退出）：

- **`scripts/verify-agent-note-classification.ts`**：定义封闭的生命周期与类别集合。它断言生命周期文件夹下的每个文件都位于规范集合中的类别文件夹内（生命周期根目录下散落的 `.md` 或未知类别文件夹都会失败），并拒绝集中式 `INDEX.md`。规范集合位于 `scripts/agent-note-tree.ts` 中，[README](../../README.zh.md) 则以行文记录每个类别。
- **`scripts/verify-doc-refs.ts`**：检查引用文档的源码注释。Agent Note 路径不仅出现在 Markdown 中，也出现在 TypeScript 文档注释中（例如以仓库根为起点的 `.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md`）。`verify-md-links` 看不到这些引用，因此目录重组可能静默留下失效引用。该门禁扫描 `packages/**` 下仓库自有的 `.ts` 文件（排除已构建的 `lib/` 与 `vendor/`），查找 `docs/….md` 和 `.agents/notes/….md` token，解析每个以仓库根为起点的路径并断言其存在。它要求使用 `.md` 扩展名，因此会忽略行文中不带扩展名的引用。

## 曾考虑的替代方案

- **在每个文件中添加 `Classification:` 文本行**（紧邻 `Status:`），由门禁解析。可行，但它将路径已能承载的事实重复到文件中，且行内容可能与所在文件夹不一致。路径编码使标签与其存储合二为一，没有需要保持同步的东西。
- **设立 `refactor` 类别。** 与 `simplification` 几乎完全重叠；唯一有人试图用来区分的标准是「可观察行为是否改变？」，而 `simplification` 已经编码了这一点（它不改变）。一个类别即可，无需两个。
- **生成或手工维护的文档集索引。** 不予采纳：生命周期/类别目录树才是权威结构；集中式清单会制造合并热点，却没有提供目录树导航或仓库搜索无法实现的发现能力。

## 后果

- 每份 Agent Note 都位于一个类别文件夹下。读者浏览单个文件夹，即可查看某个生命周期内的全部简化或测试决策。
- `doc-sync` 链中多了两个快速 tsx 脚本；无新依赖（mdast/GFM 栈已因 `verify-md-wrap`/`verify-md-links` 而存在）。
- 新增类别必须是显式决策：修改 `scripts/agent-note-tree.ts` 中的 `const` 与 [Classification 章节](../../README.zh.md#classification)，而不是只用 `mkdir` 创建文件夹。门禁会拒绝未知文件夹，因此临时类别无法悄然混入。
- 源码注释中的文档引用同样受门禁约束：被 `.ts` 注释引用的文档一旦移动或重命名，`doc-sync` 与 CI 中的 `verify-doc-refs` 就会失败，从而堵住 `verify-md-links` 在结构上无法发现的一类漂移。
