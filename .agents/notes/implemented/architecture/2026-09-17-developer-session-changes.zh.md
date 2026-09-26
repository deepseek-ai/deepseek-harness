# Agent Note：使用 developer 消息记录增量 Session 变更

Status: implemented

[English](2026-09-17-developer-session-changes.md) | 中文

## Problem

动态工具变更需要持久且有序的记录，提供方才能在改变可用工具时保留对话的缓存前缀。将这些变更编码为自由文本提醒会丢失结构化的工具身份，并将 Session 状态与提示词措辞耦合。

## Decision

`DeveloperMessage` 按对话顺序记录已接纳且模型可见的 Session 变更。添加块仅存储 `toolName`；所在事件的 `headerSeq` 选择更早的完整 `request/header`，其中每个添加名称必须恰好对应一个模式。同一事件的所有添加绑定到同一个请求头版本。添加替换当前同名定义；移除仅记录名称，不重复模式。没有添加块的消息不携带请求头引用。同名替换、重启、fork 和 surface 替换保留历史定义身份，不查询当前注册表或最新请求头。没有被任何已接纳请求暴露的中间注册表变更无需 developer 记录。

`developer/message` 携带消息及其接纳 turn/step 坐标。原生读取方和 Session 接纳逻辑拒绝缺失、前向、未知、非请求头及歧义模式引用、不完整的被引用定义，并拒绝已退役的内嵌定义，同时保留无关 JSON 字段。`sourceEventSeqs` 保持为独立的派生元数据。替换保留选定的请求头，并引用被覆盖的 surface 节点；不同请求头版本的添加必须分属不同事件。fork 保留所引用的前缀，压缩不删除请求头事件。未来改变事件数量的迁移必须将 `headerSeq` 作为同一文件内的事件引用重映射。空 developer 内容保留其 surface 位置，不添加模型消息，也不能覆盖受保护的 system 头节点。tools 包按照[生产者自有来源规则](2026-09-09-producer-owned-message-sources.zh.md)拥有 `tool-registry` 来源种类。

`ToolAdditionBlock.tool` 声明为可选的 `never`，并标注 `@persistenceReserved`。模式历史因此记录这个被拒绝的字段：后续允许任何值都会改变现有值类型并要求格式递增，无关的可选元数据仍属于可兼容添加。

`ToolSchema.deferLoading` 请求延迟加载工具定义，与工具添加历史相互独立。工具构造、注册表投影与提示词组装保留该标记。动态添加与定义加载是不同事实；预先声明的延迟加载定义无需虚构添加记录。

V4 编解码器将 developer 角色限定在 `developer/message` 字段内，并拒绝 inbox 与标题请求数组中的该角色。原生验证检查 developer 必需字段、历史请求头绑定及工具变更块仅限 developer 的约束，同时保留附加 JSON 属性。因此，可选元数据添加符合持久化检查器的可选属性规则，仍可读取；附加字段不能削弱必需字段、角色或打开 step 的检查。可忽略标记不代表读取方支持该事件：物理解码保留 developer 载荷，直到按词表执行接纳；写入方和原生读取方仍拒绝格式错误的已知数据。developer 接纳逻辑将格式错误的普通消息字段留给解码器恢复。已安装的 Session 接纳逻辑验证 surface 关系，不把 developer 记录转换为已发布 V3 的 user 记录。[已发布格式迁移规则](2026-08-31-released-session-format-migrations.zh.md)继续保护已提交的前代文件。

Session V4 预留 issue #4146 所需的持久表示。生产发出、提供方投影、UI 展示和压缩集成见[动态工具更新决策](2026-09-20-dynamic-tool-updates.zh.md)。

## Alternatives considered

**将文本提醒作为 developer 内容。** 此格式表示结构化 Session 变更；模型指令属于 system 消息。未来的 developer 内容尚未指定，不将其限制为提醒。

**在每次添加中重复定义。** 完整请求头已经保留精确模式。历史引用避免第二份持久化副本，同时保留同名替换的身份。若绑定到最新请求头或注册表，则会重新解释较早的添加。

**将延迟加载视为存在工具添加记录的证据。** 这会阻止预先声明的延迟工具。模式标记描述加载方式，内容块记录动态添加。

## Consequences

Session V4 持久化 issue #4146 的工具变更表示。发出、路由投影、DeepSeek 序列化及 Chat 和 Trajectory 展示由[动态工具更新决策](2026-09-20-dynamic-tool-updates.zh.md)负责。
