# 实操手册：添加 Session 日志格式版本

[English](adding-a-session-format-version.md) | 中文

## 概述

本教程介绍如何添加下一个结构性 Session 日志版本，同时不改写已发布数据。阅读[版本与发布状态真源](../session-format-status.zh.md)，确定工作区写入器与最新已发布格式。令 N 表示经核实的已发布格式，N+1 表示目标版本；名称与元数据中的这些占位符须替换为数字。开始前，请准备可用的贡献者工作区，并阅读[包检查清单](adding-a-package.zh.md)、[格式库](../../packages/session/session-format/README.zh.md)和[已发布格式决策](../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)。

## 目录

- [1. 选择版本与发布基线](#choose-the-version)
- [2. 添加恒等迁移边](#add-an-identity-edge)
- [3. 实现每份产物独占的 Stage 与校验](#stages-and-validation)
- [4. 更新当前版本消费方](#current-version-consumers)
- [5. 创建快照后继代际](#snapshot-successors)
- [6. 验证集成结果](#validate)
- [开发备注](#dev-note)

<a id="choose-the-version"></a>
## 1. 选择版本与发布基线

当 header、事件信封、核心事件语义或表面重建发生结构性变更时，提升格式版本。普通事件新增不需要提升版本；遵循[版本规则](../../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)。区分 Session 格式整数与包发布版本、SQLite schema 版本、投影单元版本及协议包装层版本。

为 N+1 使用共享的 `release/*` 集成基线。基线变更添加写入器、codec、catalog 接线、恒等迁移与验证。从该基线创建各个独立子分支，并将其 PR（Pull Request）的目标设为发布分支，而非另一个独立子分支。每个子分支在同一个相邻迁移包内添加自身的结构变换、校验器、消费方和测试。不要只为表示评审顺序而分配额外版本。通过 PR 将评审后的子分支合入发布分支，并在发布前验证组合结果。遵守发布分支的强制推送与删除保护；不要强制同步该分支。

已发布 codec 和迁移语义保持冻结。不要通过修改已发布迁移边来实现新的结构性功能。只有 N→N+1 迁移边可在 N+1 发布前纳入协同变更；发布后，进一步的结构性变更需要下一条相邻迁移边。

未发布 N+1 的集成测试应使用可丢弃、相互隔离的 Harness home。中间版本产生的 N+1 文件已标为目标写入器版本，因此后续对 N→N+1 的修改不会再次迁移该文件。请在全新测试 home 中从未变更的历史输入重新运行；绝不通过改写已提交代际或复用真实用户 home 来修复这个问题。

变更写入器之前，使用[归档命令](../persistence-changes/historical-formats/README.zh.md#maintenance)保留其完整持久化 schema，再在 `docs/persistence-changes/historical-formats/vN.*` 下添加双语格式参考。保留所有更早的记录。格式覆盖检查要求低于新写入器的每个整数版本都有独立文档；当前生成的目录只覆盖新写入器。

<a id="add-an-identity-edge"></a>
## 2. 添加恒等迁移边

按照包检查清单为 N→N+1 创建库，而非挂载插件。恒等正文转换仅是最初的接线骨架。[V2 到 V3 规范](../../packages/session/session-format-v2-to-v3/README.zh.md#v2-to-v3-specification)是明确转换与保留规则的固定示例，而不是可继续扩展或视为恒等转换的迁移边。

在 manifest（元数据清单）中声明 `dsh.sessionFormatMigration`，包含数值 `from: N` 和 `to: N+1`、导出路径，以及导出的迁移、源 codec、目标 codec、目标 header 校验器和目标恢复器。复用前一条迁移边所属包导出的源 codec，并依赖该包；不要复制或重新定义已发布 codec。从新包导出目标 codec 和校验器。将迁移边加入 catalog 的直接依赖，并添加工作区的 TypeScript 路径与项目引用。

在添加新迁移边声明的同时，将[核心 Session 类型](../../packages/core/session/src/types.ts)中的 `SESSION_FORMAT_VERSION` 设为 N+1，然后生成 catalog。下面的命令只生成已声明的迁移链；它不会实现新版本：

```sh
pnpm run gen-session-format-catalog
```

[生成器](../../scripts/gen-session-format-catalog.ts)要求从零到写入器版本的每一步恰好有一个相邻迁移包，目录与包名匹配、相邻 codec 导出匹配，并声明所需依赖。它拒绝缺口、重复或多余的迁移边、未知元数据成员，以及未通过对等依赖（peer dependency）加开发依赖共享 Session 的 catalog。请修复声明，而非手改 `generated.ts`。Catalog 在构建时静态确定；插件挂载不得决定历史数据是否可读。

<a id="stages-and-validation"></a>
## 3. 实现每份产物独占的 Stage 与校验

使用 [Stage 接口](../../packages/session/session-format/src/types.ts)，不要使用整份产物的数组到数组迁移器。不可变的 `SessionFormatMigration` 声明提供 `migrateHeader`、`validateTargetHeader` 和 `createStage`。每次调用 `createStage` 都为一份源产物创建独立状态。计数器、待处理事件和引用映射归该状态所有；不同 Session 之间绝不共享可变 Stage。

实现 `transformEvent(event, context)`、`transformRun(run, context)` 和 `finish(context)`。通过 `context.emitEvent` 或 `context.emitRun` 同步输出；一次调用可以产生零个、一个或多个输出。让 Stage 直接消费 codec 所有的紧凑 run，或者迭代 `run.expand()`，而不物化中间数组。调用方负责调度，迁移链先结束上游 Stage，再结束下游 Stage。

继承截点是逻辑事件数量，不是物理行数。只有在 EOF 前已知时才公开 `headerInheritedEventCount`；`finish` 返回精确的目标截点。前一条改变事件数量的迁移边可能使该数量在构造时不可知。必要时从已校验的种子标记推导它，并测试从每个受支持历史代际到 N+1 的有种子多跳恢复，而非仅测试直接 N 输入。绝不以零替代未知截点。

显式定义新迁移边的事件准入与变换规则。[V2 到 V3 源审计](../../packages/session/session-format-v2-to-v3/README.zh.md#source-audit)和 [Alpha V0→V1 规则](../../.agents/notes/implemented/architecture/2026-08-31-alpha-historical-unknown-event-refusal.zh.md)分别负责对应已发布迁移边的策略，而非新迁移边的策略。不要将任一策略推广到所有迁移边。结构或事件位置变化时，必须分类源事件、载荷成员与引用，并显式判断不透明数据能否保持有效。[同版本保留](../../.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.zh.md)本身不能证明结构变换安全。校验目标语义，并为每个新增可接受案例提供一个被拒绝的反例；绝不放宽旧迁移边来掩盖不受支持的转换。

通过 `sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })` 验证严格恢复，按顺序传入各行并调用 `finish()`。这会执行物理解码、完整迁移链与已安装当前 Session 校验。生产环境的 recoverable/transformed 策略不能替代 fixture（测试前置数据）和发布验证所需的严格校验。保留已记录的历史校验例外，不要宣称源校验比迁移边实际执行的更严格。

<a id="current-version-consumers"></a>
## 4. 更新当前版本消费方

追踪每个当前版本消费方，包括 Session 创建与恢复、JSONL 文件名选择与发布、catalog 的当前编码器与恢复器、投影缓存的代际身份、回放与快照归一化，以及 TypeScript/Python SDK 录制。当值表示当前版本时使用写入器常量；在已发布 codec 和历史 fixture 中保留字面历史版本。通过各自所有者更新当前文档与生成参考。

不要自动提升无关版本。请求包装层的 `sessionFormatVersion` 标识嵌入的 Session 代际；外层 schema 版本有自己的含义。投影单元状态版本同样不能替代缓存的 Session 代际身份。

验证读取与写入两条路径。仅 header 的列表操作不得读取正文或发布。历史读取打开可以直接返回迁移后的内存产物而不写入；写入打开必须先校验并发布唯一的最终当前后继代际，再允许追加。源路径、字节与 inode 保持不变。所选代际高于当前版本或无效时，不得回退到前代。[准备阶段决策](../../.agents/notes/implemented/architecture/2026-09-05-read-only-session-migration-preparation.zh.md)负责发布时序。

<a id="snapshot-successors"></a>
## 5. 创建快照后继代际

阅读[快照所有权](../../snapshots/AGENTS.md)和[快照库](../../packages/test-support/session-snapshot/README.zh.md)。选择拥有数据的场景，而非仅引用它的适配器。实现 N+1 后，保留每份历史文件，并按目标版本的规范父子文件名生成后继文件。绝不将前代重命名为目标文件名，或仅修改其 header。

如果回放输入不变，在所有者上执行无密钥 refresh，再执行不写回的 replay。以下 SDK 命令使用 `text-turn` 和工作区的写入器版本。先实现并接入 N+1，才能用它们生成该版本；功能变更应选择实际受影响的所有者：

```sh
pnpm run test:snapshot:refresh snapshots/sdk/sdk.snapshot.ts -t text-turn
pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t text-turn
```

一起审查新代际、请求伴随文件与协议输出。验证每个前代的字节保持相同，且父子角色连续。选择规则采用数值最高的代际，因此应将共享引用更新为所有者选中的父代际。不要把 packed 布局迁移器当作版本升级器。如果模型 transcript（文本记录）必须变化，由场景所有者按照[测试策略](../testing.zh.md)使用所需提供方密钥进行实时录制。

通过 `snapshot.yml` 的 `sessionFormat.version` 与受支持的 `coverage` 名称显式保留历史案例；record 和 refresh 不改动这些 Session fixture。更新[语料策略](../../scripts/session-snapshot-corpus-policy.ts)以采用当前代际，同时保留聚焦的直接迁移边、多跳、packed row、重试/失败及交付 profile 覆盖。检查语料和两个 SDK 投影；不要仅为消除校验失败而批量 refresh 无关场景。

<a id="validate"></a>
## 6. 验证集成结果

从仓库根目录运行。以下命令检查 catalog 声明、Stage 组合、已发布的 V2→V3 迁移边与代际选择。它们是基线检查；需为新迁移边添加聚焦覆盖：

```sh
pnpm run verify-session-format-catalog
pnpm exec vitest run scripts/gen-session-format-catalog.spec.ts packages/session/session-format/tests packages/session/session-format-v2-to-v3/tests packages/session/session-format-catalog/tests
pnpm run test:snapshot scripts/session-snapshot-corpus.corpus.ts
```

实现新迁移边后，将其实际测试路径加入聚焦的 Vitest 命令。根据实际 diff 添加受影响的 JSONL、回放、投影与 SDK 测试；发布 Worker 路径变化时还需构建产物冒烟测试。要求严格迁移成功、骨架保持恒等、拒绝格式错误与未知必需事件、重复恢复确定、并发 Stage 状态独立、有种子的多跳截点正确、前代不变且无回退。报告确切命令与失败，不要推断整个测试套件的结果。

更新[所属 Agent Note](../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)，而非添加重复决策记录。发布前保持[发布记录](../session-format-status.zh.md#updating-the-record)不变；发布后，使用已核实的发布证据更新它。审计相关活跃记录的取代关系；保留独立理由，并保持归档记录冻结。一起更新双语正文，通过仓库工具重新记录每个变更的配对，然后运行文档检查：

```sh
pnpm run verify-translation-pairing --write docs/cookbook/adding-a-session-format-version.md
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
git diff --check
```

<a id="dev-note"></a>
## 开发备注

无。
