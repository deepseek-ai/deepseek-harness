# Agent Note: 创作 preset 的 agent 自行挂载校验其组装

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-preset-authoring-agent-validates-its-own-composition.md) | 中文

## 问题

`cordis` preset 随包发布 `editing-cordis-compositions`，它是 agent 创作 preset 时唯一的指导来源。其中四条陈述与事实不符，而分量最重的两条恰好指向该 skill 自称「最容易让人栽跟头的规则」。

它把 `tool-bash` 当作「行名看不出发布服务」的示例——「看着像工具，其实 provides `bashEnv`」。`tool-bash` 不发布任何服务，它声明 `inject: ['tools', 'bash', 'systemPrompt', 'bashEnv']`，`bashEnv` 来自宿主组装自己的 `shell-env` 行。agent 照此给 `tool-bash` 套上 `isolate` realm，该行会永远等待被自己的 realm 挡住的服务，整个 preset 挂载失败。

它的 `isolate` 示例把 `jobs-local` 与 `tool-jobs` 组在一起。`jobs-local` 位于宿主平面，而已发布组装在自己的注释里写明：给 `tool-jobs` 套 entry-local realm 会让 `run_in_background` 回答「background jobs unavailable」。示例与紧挨着它的文件互相矛盾。

它把字符串 realm label 描述为跨子树共享一个实例。label 只是加入同一 realm，`provide()` 在同一 realm symbol 下第二次注册仍然抛错——`standard` 的头部注释早已如此说明。

它让 agent 去读包的 README 判断某行是否发布服务。每个 harness 包都声明了 `files`，且没有任何一份声明包含自己的 README，因此装机部署中一份也没有。在那里该指令根本无法执行。

四条之下还压着一个能力断言：agent「自己起不了会话」，于是校验退化成肉眼核对 YAML 字段，再把结果经设置页的红色标记交给用户。那个标记是发现阶段的结构检查，远弱于这句话给人的印象。

## 决策

skill 教 agent 通过 `ctx.agentPresets` 自行挂载校验其组装，其余每个示例都取自同一仓库中已发布的组装。

`standingKeyFor(id)` 是校验手段。它走 `ensureStanding()`——与会话启动完全相同的真实挂载，只是不创建 agent——因此能拒绝包无法解析的行、配置非法的行、把服务发布进根 realm 的行，以及始终未激活的行。挂载失败会删除常驻条目并 dispose 其 scope，不留残留；挂载成功则装上首次真实会话本来也会装上的那个常驻代际。因此 skill 把它安排为完成编辑后的最终检查，而不是逐行循环。

skill 明确写出：`list()` 的 `broken` 字段**不是**校验。发现阶段的健康检查只证明文件能被 Loader 的方言解析且行带 `name`，上述四类失败全部能通过它。

agent 按 `cordis_mount` 自身文档所述的方式够到 roster 服务：挂一个声明 `inject: ['agentPresets', 'tools']` 的临时插件，并为自己注册一个工具——因为挂载只返回自身的确认信息，而已注册的工具才是服务结果在下一步抵达模型的途径。skill 逐字附上该插件。`agentPresets` 位于生成的 `cordis_inspect what:"api"` 目录中并带完整 JSDoc，沙箱 façade 仅凭 `fiber.inject` 而非白名单放行服务，因此这条路径没有为该 skill 做任何特例。

`copy(from, id, name)` 被指定为创作写入手段，取代 shell 复制：它校验 id、拒绝任何根已提供的 id、失败时回滚、重写副本的 `preset.yml`，并在宿主侧运行而无需沙箱升级。沙箱升级的说明保留，移到真正适用之处——其后编辑 `agent.cordis.yml` 仍然写在会话工作区之外。

「某行是否发布服务」改由 `cordis_inspect what:"services"` 回答，它会给出每个存活服务的持有 fiber。

指导保留 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/` 作为「我的 preset 在哪」的答案，同时把 agent 实际读取或编辑的路径改走 `list()` 或 `resolve()`。写出该路径对人讲是对的，喂给文件工具是错的：部署可以配置其他根目录，而 `list()` 无法揭示一个尚且为空的用户根。

该路径如今是本包的属性，而非某个启动器的属性。除非 `includeUserRoot` 为 false，`AgentPresets` 自行推导 `<dshHome>/.agent-presets` 作为 `user` 根，正如 [`dsh-skill-filesystem`](../../../../packages/skill/skill-filesystem/README.zh.md) 推导 `<dshHome>/skills`；`apps/cli` 只提供**随附**根——那是唯有已安装 app 才能解析的路径。它取代的那种不对称曾付出过代价：两个根都由单一启动器补入时，`dsh run` 启动的 roster 一个根都没有，解析 `standard` 直接失败（当时的修法是让每个启动器都执行该 patch）。推导出的根追加在全部已配置根之后，因此随附 id 仍会遮蔽占用它的家目录目录，而 `writableRoot()` 仍优先选择显式配置的 `user` 根。它在构造时解析一次：若根目录集合在一次 `list()` 与依据其答案执行的 `copy()` 之间发生变化，写入的将是调用方从未见过的目录。

禁止改动随发布安装的约束，从创作步骤中的一段提升为顶部的 `## Off-limits` 一节，并扩展到禁止改宿主组装绕行。新增的自校验调用不削弱它：`copy()` 拒绝任何根已提供的 id，`remove()` 拒绝随部署发布的 preset。

## Measured behavior

下表每一行都由启动已发布的 Web 组装、并在由 `cordis` 组装出的 agent 上经 `ctx.tools.execute` 调用工具得出——全程无模型参与。

| 被测组装 | `list()` 的 `broken` | `standingKeyFor()` |
|---|---|---|
| 行指向不存在的包 | 空 | `Cannot find package '@deepseek-ai/dsh-does-not-exist'` |
| 服务行未套 realm，名字宿主已提供 | 空 | `service "tasks" has been registered at <LocalJobRegistry>` |
| 服务行未套 realm，名字宿主未提供 | 空 | `row(s) published process-global service(s) [workflows]; …` |
| 同一行置于 `isolate` 内 | 空 | 挂载成功 |
| 消费者行无人提供服务 | 空 | `1 row(s) did not activate: … waiting for workflows` |
| 行缺少必填配置字段 | 空 | `invalid config: $.allowParallelInProgress missing required value` |

skill 自带的 `cordis_mount` 代码片段经工具注册表逐字执行：它成功挂载，其 `preset_check` 工具在下一次读取时出现在组装该 agent 的目录中，对有效 preset 回答 `mounted OK`，对无效 preset 回答挂载拒绝原因。

## 考虑过的替代方案

**把校验留给用户，只修四处错误。** 这些错误与那句能力断言同源——指导是按 preset 层的公开面写的，而不是按被组装出的 agent 实际够得到的东西写的——而无法自查的 agent 交出的组装，其缺陷设置页同样看不见。

**把 `list()` 的 `broken` 字段教成校验手段。** 它正是设置页展示的字段，看起来像是预期答案。它对所有要紧的失败一律放行，而把它当成校验，正是原指导显得完整的原因。

**给 preset 加一个一等的 preset 校验工具。** 组合出的路径已经存在，且由 `cordis_mount` 自己的 schema 记载；专用工具会给一个「无需专用工具即可够到运行时」的 preset 再添一个面向模型的行。

## 后果

- 校验成功会留下一个永不回收的常驻代际，这是 roster 按代际本就承担的[常驻挂载](../architecture/2026-08-08-per-preset-standing-mounts.zh.md)代价——由 agent 在编辑收尾时付一次，而不是由用户在首次会话时付。
- skill 现在依赖 `cordis_inspect` 生成的 API 目录对 `agentPresets` 保持最新；`doc-sync` 中的 `verify-cordis-api` 是守住这一点的门禁。
- 有两个示例现在是对 `standard` 组装的引用。若该文件的 `delegation` 组发生变化它们会漂移，而 `web-agent-presets` e2e 捕捉不到。
- 被修正的四条陈述原本是该 skill 对 realm 规则仅有的具体图示。选择替换而非删除，规则才仍然可教；替换后的示例读一个已发布文件即可核验。

## Related

取代[破损 preset 是 roster 行](2026-08-09-broken-preset-roster-rows.zh.md)中关于创作模式指导的那一条，其健康检查决策依然有效——本篇只推翻它「agent 起不了会话；设置页的红色标记是用户的检查手段」这一结论。创作的 copy-only 形态由[copy-only preset 创作](../simplification/2026-08-08-copy-only-preset-authoring.zh.md)负责。
