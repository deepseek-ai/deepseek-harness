# 双语文档

[English](README.md) | 中文

本仓库的文档会被公司内外的人和 agent（智能体）阅读，因此范围内的每篇文档都以英文和简体中文维护。本页定义配对约定、检查、范围与排除规则；[translation-rules.md](translation-rules.zh.md) 定义如何翻译；[terminology.md](terminology.md) 是术语真源。agent 的日常工作遵循 [docs/AGENTS.md](../AGENTS.md) 中的轻量路径；扩展版 [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) 工作流仅在用户显式调用时可用。

<a id="the-pairing-contract"></a>

## 配对约定

- **两种语言同权。** 一篇文档可以先用任一语言撰写和评审（先写中文的 Agent Note 与先写英文的一样正当），另一侧由它翻译而来。两个文件谁也不高于谁；约束它们的是二者必须说同样的话。
- **一对文档是三个同目录文件。** 英文 `foo.md`、中文 `foo.zh.md`，加一份一致性记录 `foo.i18n.yaml`，都在同一目录。不用语言目录，不用独立翻译仓库，不用中英混排的单文件。配对必须整体合并：PR（Pull Request）永远不会只带一种语言而缺其余两个文件。
- **一致性记录。**`foo.i18n.yaml` 保存两侧文件在上一次被确认「说同样的话」时各自的完整 Git blob hash：

  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```

  用 blob hash 而不是 commit hash，这样同一个 PR 里改动的文件也能算出记录（`git hash-object foo.md`），一致性是纯内容比较。`--write` 会先把这些快照存入本地 Git 对象库再写下记录，未提交的 worktree 内容也不例外；它还会在内容寻址的 `refs/dsh/translation-pairing/snapshots/` ref 下固定每个不同的已存 blob，使垃圾回收无法让已记录的恢复指针失效。记录的 hash 能还原任一侧上次确认时的确切文本，所以失去同步的配对是「按被改一侧的 diff 最小化地修补另一侧」，从不整篇重译。日常工作会直接完成这份修补；用户显式调用扩展工作流时，可改由 `pnpm run gen-translation-brief <pair>` 以能安全对齐的最窄粒度汇集这次更新，并由 `--apply` 在结构校验后拼接仅涉及围栏代码块的改动。两侧对齐后，`pnpm run verify-translation-pairing --write <pair>` 重新记录两个 hash；那份 YAML diff 就是「确认一致」这个动作本身，可以被评审，也正因如此，`--write` 要求点名你确认过的配对（`--write --all` 是显式的全语料形式）。

  当两个分支都包含同一配对的有效确认时，已安装的 `dsh-translation-pairing` Git 合并驱动只会在 Git 默认文本合并能分别干净合并记录所指向的英文三方 blob 与中文三方 blob，且合并后的配对仍保留必需的语言切换行和结构签名时，组合出一份新记录。中文文件必须保留指向英文的反向链接；普通撰写的英文源必须保留指向中文的链接，而清单内的生成英文源不作此要求。任何合并驱动无法验证的结构都保留为普通冲突；`pnpm run resolve-translation-pairing-conflicts` 会对已经停止的合并执行同一套遇错即保留冲突的操作，暂存每份可安全生成的配对记录，并在还有其他配对冲突时以非零状态退出。[自动配对合并 Agent Note](../../.agents/notes/implemented/process/2026-08-08-automatic-translation-pairing-merges.zh.md) 负责记录该机制与备选方案。
- **语言切换行。** 中文文件一律在 H1 标题后立即以 `[English](foo.md) | 中文` 链回英文。普通撰写的英文文件在同一位置以 `English | [中文](foo.zh.md)` 互链；清单内的生成英文源省略此行，以便与生成器输出逐字节一致。发布到 GitHub 以外位置的 README（例如 PyPI 项目元数据）可以改用指向同一对侧文件的规范 `https://github.com/deepseek-ai/deepseek-harness/blob/master/<repository-path>` URL，使切换行在该位置仍可访问。
- **结构与另一侧一一对应。** 标题深度与顺序、列表类型、有序列表起始编号、列表项数量、表格行列数、保留原样 query/fragment 后缀的语义链接目标，以及逐字节一致的代码块在配对两侧一一对应。相对文档链接的目标属于活跃双语语料时，英文侧使用其 `.md` 路径，中文侧使用其 `.zh.md` 路径。该范围内缺少对侧属于配对完整性错误，不得回退；范围外的目标保留原路径。完整保持规则见 [translation-rules.md](translation-rules.zh.md)。既有 Markdown 门禁对 `.zh.md` 文件原样生效（`verify-md-wrap`、`verify-md-links`）。

## 门禁：verify-translation-pairing

`pnpm run verify-translation-pairing`（`doc-sync`（文档同步门禁）的一环，贡献者会针对文档变更在本地运行，CI 则会完整运行）机械地强制执行这份约定：

1. 范围内的每篇文档都有完整配对。发现 README 时，basename 不区分大小写，因此 `missions/readme.md` 与其他文档根一样属于范围。
2. 任何已存在的配对产物都完整且一致：三个文件齐全、每一侧的当前 blob hash 等于记录值（改了任一侧而没重新确认配对就变红）、中文侧和所有普通撰写的英文源都带语言切换行（清单内的生成英文源除外）、每条普通相对文档链接都使用源文件一侧对应的目标 locale，且结构签名按序一致：标题深度、逐字节一致的代码块（信息字符串与内容）、表格行列数、列表类型、有序列表起始编号、列表项数量，以及除切换行之外保留原样 query/fragment 后缀的语义链接目标。
3. 列为 `excluded` 的文件完全没有 `.zh.md`，也没有 `.i18n.yaml`。`.agents/notes/archived/` 下冻结的 Agent Note 不受这个持续演进的门禁约束；专用校验器会要求其现有的三个配对文件完整，并将其封存。

面向源码的代码门禁会把精确的 `.zh.md` 围栏序列视为其无后缀兄弟文件的派生内容，而不会再次编译相同代码或在 manifest（元数据清单）中重复登记。该序列必须在长度、顺序、围栏类型和按字节精确的正文上一致；否则两份副本仍会独立受检，配对门禁也会报告结构不匹配。

`pnpm run verify-translation-pairing --list` 打印范围内每篇文档的当前配对状态（missing、out-of-sync 或 ok）。它从不失败；其中 missing 与 out-of-sync 行指出普通检查会拒绝的违规。

`pnpm run verify-translation-pairing <pair...>` 只检查被点名的配对——配对的三个文件中的任意一个（或其裸词干）都能点名它——因此更新循环几秒内就能验证自己的配对，而不必重新扫描全语料。`doc-sync` 与 CI 运行的是无参数的全语料形式；限定范围的绿灯在 PR 层面永远不能替代它。

这个门禁带来的实际规则是：**当一个 PR 修改了已配对文档的任一侧时，同一个 PR 在术语指导下直接一次完成对侧文件的更新，并用 `--write <pair>` 重新记录配对**，与本仓库既有的代码与 README 的 doc-sync 规则完全一致。留下失去同步的配对的 PR 会在 CI 变红。

门禁的限制很明确：**门禁通过意味着这组文档在当前内容上的一致性得到了确认，不代表确认本身正确可靠。** 它检查记录的 hash 与 Markdown 结构；它无法判断两侧是否在说同样的话，也无法判断措辞是否准确、术语是否得当、行文是否自然；这部分约定由评审者把关，见 [translation-rules.md](translation-rules.zh.md)。重新记录了 hash 但另一侧翻得潦草的配对能通过门禁；它不得通过评审。

## 范围与排除

**范围**：根目录 `CONTRIBUTING.md`、`BRAND_GUIDELINES.md` 与 `SAFETY.md` 文档、除 vendor 源码外的全部 README，以及 `.agents/notes/**`、`docs/**` 与 `python/**` 下的全部活跃文档。匹配 README 时只看文件名且不区分大小写，因此今后新增的目录无需再修改 manifest。依赖目录、被忽略的构建产物目录以及冻结的 `.agents/notes/archived/` 目录树只在发现阶段排除，不属于持续演进的翻译源文档。

有经评审的中文对侧的生成英文参考文档和图文档遵循配对规则。生成器仍是英文真源，新鲜度门禁与配对门禁各自独立强制其约束；重新生成导致英文变化后，配对会保持失去同步状态，直至经评审的中文对侧完成更新并重新记录。Cordis subsystem 区块生成器等同时拥有两侧输出的生成器，会把配对文档路径投影到各自 locale，同时保持其余生成字节一致。生成的英文源文件不含普通撰写文档所带的语言切换行，因为添加该行会使生成器新鲜度检查失败；中文对侧仍链接回英文源。生成页的中文对侧只能改写若直译便不再符合经评审译文事实的自指生成与维护说明；所有技术内容仍受普通忠实性规则约束。

**排除**（永不配对，门禁拒绝为它们建 `.zh.md` 或 `.i18n.yaml`）：

- [cordis-api/inherited.md](../cordis-api/inherited.md)：该生成文档没有经评审的中文对侧，因此网站的两个 locale 都投影英文源文件。
- `docs/AGENTS.md`、`.agents/notes/**/AGENTS.md` 以及指向它们的 `CLAUDE.md` 指令符号链接：agent 指令，与根 `AGENTS.md` 一样只以英文维护。
- `docs/i18n/terminology.md` 与 [style-samples.md](style-samples.md)：二者本身即为中英对照文档。
- [translation-prompt.md](translation-prompt.md)：自动翻译流水线的提示词模板；正文逐字进入模型请求，配对翻译会改变流水线行为。
- `.agents/notes/archived/`：冻结的历史三文件配对。[`verify-archived-agent-notes`](../../scripts/verify-archived-agent-notes.ts) 校验其完整性和内容封存记录；翻译维护绝不能重写这些文件。

**统一要求**：当前及今后纳入范围的每篇文档，合并时都必须构成完整的双语配对。[scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) 只包含显式排除项；不存在逐文件推进清单、日期分界或 README 专用政策类别。

## 分工

日常更新对侧文件时，负责处理的 agent 会先加载 [terminology.md](terminology.md)，再直接一次性更新；它不会调用翻译 skill（技能）、生成简报、执行单独的翻译评审轮次，也不会委派给 subagent。扩展版 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) 工作流保留这些较重的机制，仅供用户显式调用。门禁负责检查配对是否完整、记录的 hash、中文反向链接和普通撰写源的切换行（生成源按本文规则例外），以及本文列出的结构签名；翻译质量、术语和签名未涵盖的结构要求仍由评审把关。提示词约定也有可执行实现：[scripts/translation-prompt.ts](../../scripts/translation-prompt.ts) 会把仓库内置的模板（注入术语表；模板自带经人工校准的规则）渲染为英译中或中译英两个方向的提示词，并解析三段式响应；`doc-sync` 中的 `verify-translation-prompt` 会检查两个渲染方向与仓库内示例。
