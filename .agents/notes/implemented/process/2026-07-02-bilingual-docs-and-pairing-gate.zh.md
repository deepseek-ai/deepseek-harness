# Agent Note: 通过配对兄弟文件与配对门禁实现双语文档

Status: implemented

[English](2026-07-02-bilingual-docs-and-pairing-gate.md) | 中文

## 问题

本仓库的文档语料会被公司内外的人和 agent（智能体）以中英两种语言阅读。在没有机制的情况下纯靠手工维护第二语言，正是译文腐烂的根源：一侧持续演进，另一侧默默失实，而没有门禁能够发现。对于这类不变式，本仓库一贯的做法是将其编码为机械检查（见[质量门禁](2026-06-11-quality-gates.zh.md)与 [doc-sync（文档同步门禁）强制](../../archived/process/2026-06-11-doc-sync-enforcement.md)），因此双语政策随附一道门禁一起交付。

## 决策

- **配对兄弟文件，两种语言同权。** 一对文档由三个兄弟文件组成：英文 `foo.md`、中文 `foo.zh.md`，以及一份一致性记录 `foo.i18n.yaml`。没有哪种语言是正典：一篇文档可以先用中文撰写和评审、之后再译成英文，反之亦可；约束配对的是：两侧必须表达相同的内容，且配对整体合并（两种语言加记录，绝不单独落一侧）。政策见 [docs/i18n/README.md](../../../../docs/i18n/README.zh.md)；翻译规则见 [docs/i18n/translation-rules.md](../../../../docs/i18n/translation-rules.zh.md)；术语真源见 [docs/i18n/terminology.md](../../../../docs/i18n/terminology.md)。
- **伴随记录保存两侧 blob hash，使一致性可检查。** `foo.i18n.yaml` 保存两侧文件在上一次确认一致时各自的完整 Git blob hash。此后修改了任一侧而未重新确认配对，都能被机械检测出来（纯内容比较，无需查询历史），而且同一个 PR（Pull Request）内改动的文件也能计算出 hash，commit hash 式的记录做不到这一点。重新记录（`verify-translation-pairing --write <pair>`，要求点名所确认的配对；批量重新记录是显式的 `--write --all`）会产生一份可评审的 YAML diff：确认一致在 PR 中是一个显式、可见的动作。
- **`verify-translation-pairing` 加入 `doc-sync`。** 门禁（[scripts/verify-translation-pairing.ts](../../../../scripts/verify-translation-pairing.ts)）强制执行以下规则：每个已发现且未排除的源文档都有完整配对；每个现有配对都完整（三个文件齐全）且一致（两侧的 hash 均与记录匹配、中文侧和所有人工撰写的英文源都带语言切换行而清单内的生成英文源除外、结构签名一致）；被排除的生成文档、指令文档或本身即双语的文档不得配对。目标属于该活跃语料的相对文档链接使用与源文件 locale 相同的目标兄弟文件；结构签名则把 `.md` 与 `.zh.md` 兄弟文件规范化为同一个语义目标，并保留完全相同的 query/fragment 后缀；该细化规则由[双语文档链接本地化决策](../../archived/process/2026-08-18-localized-bilingual-links.md)负责。[scripts/translation-pairing.manifest.json](../../../../scripts/translation-pairing.manifest.json) 只包含显式排除项，因此任何要求都无法绕过发现流程而接受较弱的检查。只有当 `.zh.md` 围栏序列与其无后缀兄弟文件拥有顺序相同、正文按字节一致的同一组受跟踪围栏时，面向源码的代码门禁才会将其作为派生内容消费；不完整、顺序变更、重分类或已改动的序列仍会独立受检，因此由其所属的代码门禁或配对门禁报告不匹配。
- **全语料统一要求。** 范围内的每篇文档从创建起就必须有完整配对；政策没有逐文件推进状态、日期分界或 README 专用类别。仓库根目录的政策文档会被显式点名：`CONTRIBUTING.md`、`BRAND_GUIDELINES.md` 与 `SAFETY.md` 虽然不在文档目录中，仍遵循同一套发现与配对规则。README 发现会覆盖 vendor 源码、依赖目录与被忽略的构建产物目录之外所有文件名不区分大小写匹配 README 的文件，包括今后新增的顶层目录。发布到文档站的配对使用 `pairedPages()`，由根 locale 投影 `.zh.md`，由 `/en/` 投影 `.md`；仅创建对侧文件并不会发布它。
- **配对记录是元数据，而不是 Cordis Loader 配置。** Cordis 配置发现会接受实际的 `.cordis.yml` 和 `.cordis.yaml` 文件，同时排除 `*.i18n.yaml`，即使文档名中包含 `cordis` 也不例外。这样既能继续校验可执行的 Loader 配置项，又不会把翻译 hash 当作配置来解析。
- **翻译是 agent 的工作，由人评审。** 常规改动采用由 [docs/i18n/README.md](../../../../docs/i18n/README.zh.md) 规定的直接单遍路径。[扩展翻译 skill（技能）](../../../skills/dsh-translate-docs/SKILL.md)保留委派翻译和其他较重机制，供用户显式调用；两条路径均以文档契约为真源。

## 验证

验证约定分别覆盖每个边界。`verify-translation-pairing` 固定配对完整性、hash、语言切换行和结构，其发现测试则固定具名的根目录政策文档与自动 README 覆盖；[`project-doc-site.spec.ts`](../../../../scripts/project-doc-site.spec.ts) 固定已发布配对按 locale 选择对应源文件；[`cordis-config-files.spec.ts`](../../../../scripts/cordis-config-files.spec.ts) 固定 Loader YAML 的发现以及翻译记录的排除；[翻译提示词可运行预期](../../../../scripts/translation-prompt.expected.spec.ts)则固定渲染后的系统消息、五对经评审的示例、源请求和所消费的响应。这些检查共同使配对漂移、发布漂移、配置误分类和模型可见提示词漂移都可在评审中看见。

## 曾考虑的替代方案

- **英文为正典源、指纹放在译文内**：`.zh.md` 文件携带一条 HTML 注释记录英文源的 blob hash，翻译只沿 EN → ZH 单向流动。否决：团队需要中文先行的撰写方式（先写、先审中文 Agent Note，再译英文），两种语言同权，而单向正典模型无法表达这一点。覆盖**两侧**的伴随记录取代了文件内的单向指纹；blob hash 的机制本身保持不变。
- **语言目录（`docs/en/` + `docs/zh/`，Kubernetes/ECharts 模式）**：否决。本仓库没有将 locale 映射到路由的文档站框架；如果移动所有英文文件，所有既有交叉引用都要随之修改；且 `verify-md-links`/`verify-doc-refs` 将需要路径映射逻辑，而非原样工作。
- **独立翻译仓库（PingCAP `docs`/`docs-cn` 模式）**：否决。适合有独立发布节奏的文档产品，对 monorepo 自身的文档而言过重；还会把译文置于本仓库门禁触及不到的地方。
- **中英混排单文件（一个文件、两种语言）**：否决。每个 diff 都翻倍，破坏一段一行约定的 diff 易读性，且局部不一致不可见。
- **Commit hash 式记录（MDN `l10n.sourceCommit` 模式）**：否决，改用 blob hash。同一个 PR 内的改动还没有 commit hash，MDN 模式无法表达「与本 PR 引入的状态一致」，且校验它需要 git 历史而非文件内容。
- **比较配对两侧的 git 时间戳（无记录）**：否决。纯格式化的改动会误报，一次无关改动之后提交的对侧文件会漏报；只有内容同一性这个信号才与门禁的承诺名实相符。

## 业界先例

带语言后缀的配对兄弟文件是中国大厂的主流约定（ant-design 的 `index.zh-CN.md`/`index.en-US.md`；arco-design 的 `README.zh-CN.md` 加顶部切换行；Apache ShardingSphere 的 387 对 `.cn.md`/`.en.md`），但这些仓库都没有在 CI 中**强制**配对或一致性检查；约定纯靠评审维系。一致性自动化存在于中国以外：MDN 的 `l10n.sourceCommit` front-matter 指纹、Vue 的 Ryu-Cho action（监视上游 commit，为陈旧译文自动开 issue/PR）、Kubernetes 的本地化漂移脚本、微软 Azure co-op-translator（CI 中由源 hash 驱动的 LLM 重译）。本设计将两者结合：中文生态的文件布局，加上 hash 配对门禁，再加一个由 agent 运行的工作流替代 bot 服务。

## 后果

- 修改已配对文档的任一侧，同一个 PR 就有义务更新对侧并重新记录配对。门禁将 doc-sync 规则双语化，不变式由 CI（而非评审者的记忆）承载。
- 每个配对给目录树多添一个文件。记录由机器写入（`--write`），代价是目录噪音而非维护负担；换来的是「谁在何时确认过这对文档一致」可以从 yaml 的 git blame 直接回答。
- 两侧说法冲突时，没有机械规则裁决谁赢，由 PR 评审裁决。这是同权的代价，且是有意接受的：另一个选项（正典语言）会禁止中文先行撰写。
- 生成的英文文档仍由源码派生，并由各自的生成器实施新鲜度门禁。有经评审中文对侧的生成页面遵循三文件配对工作流，但有一项结构例外：生成的英文源文件不含语言切换行，因为添加该行会使生成器新鲜度检查失败；中文对侧仍链接回英文源。没有经评审对侧的生成页面保留为显式排除项，并在网站上投影英文。
- 只含排除项的 manifest（元数据清单）通过同一路径，要求当前及今后纳入范围的每篇文档都必须配对。不存在显式要求、分界或类别条目可以落在发现范围之外，却看似已经强制执行。
- 记录的 hash 兼作更新工具：[gen-translation-brief](../../../../docs/i18n/README.zh.md) 会从中还原任一侧上次确认的文本并组装最小更新简报，因此这套机制从不强迫整篇重译。
