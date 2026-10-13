# 防御性模式

[English](README.md) | 中文

来之不易的规则：本目录中每条模式都是本仓库在评审中执行的**要求**，以「规则 + 它所防止的缺陷」的形式陈述。每条规则都写明：必须成立什么、评审据什么判定、边界在哪、例外由谁批准，以及一个正例与一个反例。动手修改某类制品之前，先读对应那一页。

<a id="why-these-rules"></a>

## 这些规则背后的思想

下面五条习惯覆盖了绝大部分内容，每一页都是它们在某类制品上的落地：

- **把正确性显式化。** 把它写进结构——具名调用点、显式生命周期、显式条件与类型——而不是事后用时序去补偿。
- **只留一个真相。** 一份数据一条读取路径，一个事实一个正家，共享状态一个所有者。
- **走注册面扩展。** 新能力靠注册接入；既有载体不再承接新逻辑，而不是在它内部长出分支。
- **把改动面压成评审面。** 改动只包含其声明的行为变化所需的行；迁移是搬代码而不是重写；涉及性能的改动附带测量。
- **要求可证伪、可复算。** 口径能被改动前后的实测或门禁证明/否证，而不是靠人肉同步。

| 你在改什么 | 读哪篇 |
|---|---|
| 包导出面、包形态、构建面、依赖声明 | [package-surface.zh.md](package-surface.zh.md) |
| 远程服务、`@Remote` 方法、API 分发、API 层的业务归属 | [remote-and-api.zh.md](remote-and-api.zh.md) |
| 客户端组件、slots、store、hooks、effect | [client-components.zh.md](client-components.zh.md) |
| Session 读取、持有、会话节点、renderer | [conversation-and-session.zh.md](conversation-and-session.zh.md) |
| 时序、状态表示、共享归属、去中心化、重构、迁移、性能证据、清理、回调、子进程 | [general.zh.md](general.zh.md) |

类型定义与各子系统语义见 [subsystems/](../subsystems/README.zh.md)；本目录承载**规则**，语义页承载**类型的含义**。[dsh-code-review](../../.agents/skills/dsh-code-review/SKILL.md) 在评审 pull request 时读本目录，日常修改经 [AGENTS.md](../../AGENTS.md) 路由到同一张表。
