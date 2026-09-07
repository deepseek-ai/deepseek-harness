# Agent Note: pre-step 手势边界上的用户显式 skill 调用

Status: implemented
Archived: 2026-09-04

[English](2026-08-08-user-explicit-skill-invocation.md) | 中文

## 问题

`disable-model-invocation: true` 的 skill（技能）在设计上就是仅限用户的：它绝不进入面向模型的目录，`skill` 工具也拒绝加载它。它唯一正当的入口是一次显式的用户手势——而 web 客户端此前没有这个入口。`skills/list` 过滤到模型与用户的交集（把仅限用户的 skill 挡在菜单之外），输入的 `/name` 一行以纯文本落入默认提示词 sink，而这行文本到达的模型又被禁止加载该 skill——于是退化为模型去 `read` 那份 SKILL.md 文件，或者干脆无视这次手势（issue #1470）。即使对普通 skill，纯文本引用也让用户调用只是模型可以忽略的协作线索，而不是保证。

## 决策

用户显式调用是一次宿主侧的 pre-step 注入，对每一个用户可调用的 skill 和每一种运行入口一致：

- `dsh-tool-skill` 注册第二个 `agent/pre-step` 监听器（与其目录监听器并列，也是 `agent-instructions` 与运行时上下文快照搭乘的同一 seam）：它在该步骤已认领的消息中扫描以空白为界的 `/name` token——文本中任意位置均可，与 transcript（文本记录）chip 装饰所用的词边界形状相同——收集按首见去重的名称，逐个经 `ctx.skills.get` 加载，在已加载定义上检查 `isUserInvocable`（产生注入内容的正是这同一次查找），用共享的 `renderSkillContent` 渲染，并把注入追加在该步骤所有其他注入之后：背景在前（工作区规则、运行时策略、目录），模型必须着手处理的材料在最后、最贴近它的回答。注册顺序钉住了这一位置——手势监听器先于目录监听器注册，因此 waterfall（瀑布式事件）会把携带目录的列表交给它来扩展。
- 精确性来自封闭集合匹配，与斜杠命令完全一致：`/goal` 对照命令注册表解析，`/name` 对照工作区的用户可调用 skill 目录解析；未命中即保持为普通行文，因此绝不猜测。只扫描 `source.kind === 'user'` 的消息——外部文本无法伪造手势。路径（`/usr/bin`）、分数（`5/8`）与带前缀的 token（`foo/name`）都会破坏该边界。
- 客户端沿用[纯文本引用决策](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.zh.md)：菜单 pick 落下字面文本 `/name `，该文本随提示词原样提交；ui-skill 不实现任何裁决钩子，也没有引用 codec。`skills/list`（现在是该领域唯一的 RPC）提供每一个用户可调用的 skill 并携带 `modelInvocable`，供菜单标出仅限用户的条目。与宿主命令同名的名称解析为命令——客户端会在该行成为提示词之前完成裁决并将其认领。
- 注入是一条携带 `skill-invocation` 来源（`{ name, form: 'instructions' }`）的 `user` 角色消息，因此 `user/message` 落账、上下文注入的 transcript 行（以 skill 名称标注）与回放全部免费获得；`renderSkillContent` 位于 `dsh-skill` seam，由注入和 `skill` 工具结果共用，二者内容逐字相同，目录的结尾一句会告诉模型遵循注入块而不是重新加载。

同类产品调研（Pi、OpenCode、Claude Code、Kimi Code、Codex、DeepSeek-Reasonix——本地检出）一致表明：用户显式触发都是模型零参与的程序化注入；最终形态最接近 Codex 核心侧的 `$name` mention 扫描——它同样让每一种运行入口免于自行实现识别。

## 考虑过的替代方案

- **`skill.invoke` RPC（宿主注入、客户端认领）**——最先实现，共两轮迭代：先是单条混合消息（用户文本折进正文），后是经 inbox 原语投递的手势提示词加注入两条消息。经真实会话测试后否决：混合消息让用户行文污染了注入；两条消息的形态依赖唤醒顺序的微妙之处（`followup` 在第一个唤醒调用内同步认领整个 next-turn 队列，把之后的消息滞留到下一轮次——已实际复现），而专设 RPC 复制了 `session.prompt` 已提供的路径，还让 TUI/ACP（Agent Client Protocol）不得不各自重新实现识别。pre-step 扩展点把 RPC、认领机制与顺序隐患一并干净移除。
- **从 RPC 处理器调用 `agent.inject()`**——inject 队列（`next-step`，不唤醒）会在 next-turn 提示词之前被认领，使注入在日志中排到手势之上；而与会唤醒的 `followup` 搭配又会重新引入同样的顺序耦合。pre-step 监听器在步骤组装内部注入，那里的顺序是显式的。
- **宿主 `/skill <name>` 命令**（命令注册表，plan 模式先例）——两个 token 的 UX、没有名称补全、仅限用户的 skill 在菜单里仍不可发现；按 cwd 的 skill 目录也与静态命令注册表格格不入。否决。
- **客户端展开**（拉取正文、拼进提示词）——授权沦为可被绕过的客户端善意，日志失去调用语义，而且 Codex 已删除其等价机制（custom prompts）转向核心注入。否决。
- **提示词协议上的结构化引用载荷**（Codex `UserInput::Skill` 的类似物：客户端在文本旁附带 `{skills: [...]}`，边界优先采用它而不是扫描）——考虑过并暂缓：现有斜杠命令体系在协议上本身就是行文本，封闭集合的目录匹配已经消除了猜测；已记为台账事项，以备手势精确性某天需要客户端意图。
- **每次注入一条前导语**（Kimi 的 `User activated the skill …`）——弃用，改为一次性的目录句子：同样的上下文、只支付一次，且注入块与工具结果保持逐字节一致。

## 后果

- 纯文本引用如今就是客户端的全部故事：草稿承载纯文本，chip 视觉由 lexicon 派生，发出的文本由宿主边界评判——手动键入的手势、菜单 pick 与 TUI 提示词无从区分，也同样具有确定性。
- 每一次用户可调用 skill 的调用都无条件付出其完整渲染正文的成本——这是确定性的代价，同类调研表明所有产品都在支付。在句子中间提到一个已知 skill 名称也会加载它；这就是 Codex 的 mention 语义，属于有意接受。
- `skill-invocation` 来源搭乘 `user/message`，因此「模型可见 ⟺ 已记录」在不新增事件类型的情况下继续成立，回放与 UI 读取的是元数据而非文本标记。
- 放弃逐次注入前导语后被接受的残余：no-reload framing 只搭乘目录，而所有 skill 都仅限用户的工作区永远不会发布首个目录——注入可能在完全没有 framing 的情况下到达，模型可能多余地调用一次 `skill` 工具（替换目录的空分支携带该句；从未发布的情形没有）。仅为 framing 而发布目录被判定比这一次可恢复的错误更糟。
