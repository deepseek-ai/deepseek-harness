# Agent Note: 按包锚定的子系统页面与精简的分组 README

Status: implemented

[English](2026-08-03-package-anchored-subsystem-pages.md) | 中文

## 问题

[子系统目录](../../archived/process/2026-06-20-core-data-structures-catalog.md)最初用主干-vs-seam 规则界定首页范围：如果循环在每个轮次都持有、派生、流式传输或记录某个类型，它就是「核心」。该规则选择的是类型而非包，因此当目录增长到四十多页后，首页变成了跨包大杂烩：LLM（大语言模型）对话词汇排在 agent（智能体）约定之前，创建/所有权词汇（`AgentHandle`、`CreateAgentOptions`、`ResumeAgentOptions`、`AgentFactory`）在目录中无处记录（生成器把它们豁免给了某个包 README），读者无法根据类型所在位置预测哪一页记录它。与此同时，各包分组 README 没有统一形状——有的带分节表格、游离的设计短文，或本应属于子系统页面的尾部段落。

## 决策

每个 `docs/subsystems/` 页面锚定到声明其词汇的包或包分组，页面归属跟随仓库布局：[core.md](../../../../docs/subsystems/core.zh.md) 是 `packages/core` 的页面（创建与所有权、`Agent` 句柄及其投递/取消/拦截约定、指向该组专属页面的链接），[llm-streaming.md](../../../../docs/subsystems/llm-streaming.zh.md) 完整涵盖 `packages/llm`，依此类推。全仓通用类型模式（`…Map → 派生联合`、品牌化 id）保留在 core.md 一个明确标注的收尾小节中，而不是与包内容交错。这在*页面范围界定规则*的意义上取代了主干-vs-seam 规则；存活下来的放置启发式更简单：类型记录在其声明包对应的页面，相关实现机制仍集中记录在其所属页面。

生成签名引用的每个类型都必须能在目录中某处解析：agent 所有权词汇从生成器的 `TYPE_LINK_EXEMPTIONS` 移入 `LINK_MAP → core.md`，因此豁免只留给确实仅用于服务内部或来自 vendored 代码的类型结构。每个粘贴的声明只有一个家（`SessionEvent` 位于 [session.md](../../../../docs/subsystems/session.zh.md)；core.md 概括并链接）。

每个 `packages/<group>/README.md` 配对都是统一形状的精简入口：一段先说明「为什么」的介绍、一张包表格（包 / 角色 / ctx 键）、一个指向对应子系统页面的收尾链接。未声明独立子系统参考资料的分组会在 `GROUPS_WITHOUT_SUBSYSTEM_PAGE` 中附上非空理由。如果承载关键信息的正文超出这一结构所能容纳的范围，就将其迁移到对应的子系统页面，而非删除。

`verify-subsystem-pages` 同时从分组 README 和子包 manifest（元数据清单）发现分组。它会拒绝缺少分组 README、分组既没有面向读者且直接指向 `docs/subsystems/` 下某一个英文文件的链接也没有显式豁免、豁免为空或成为孤立项、已豁免分组新增链接，以及链接指向的页面不存在；代码、注释、图片、嵌套路径和路径穿越都不能满足所有权声明。该检查作为独立的 `doc-sync`（文档同步）叶节点运行，因此新增包分组时不能悄悄遗漏其文档拥有方。

[子系统 README](../../../../docs/subsystems/README.zh.md) 在中英文两侧索引目录中的每一页；`scripts/project-doc-site.spec.ts` 强制每个页面对应一个表格行，因此新增或合并吸收的页面无法悄悄缺席索引。

## 考虑过的替代方案

**保留主干-vs-子系统界定规则。**它逐类型回答「这个类型是核心吗？」，这正是首页积累了四个包的类型、却缺失 `packages/core/agent` 一半公开接口的原因。按仓库布局进行预测的方案胜出。

**扁平的单文档目录。**在[原目录 Agent Note](../../archived/process/2026-06-20-core-data-structures-catalog.md) 中已被否决；增长到四十一页证实了该结论。

**只在包 README 中记录所有权词汇（豁免的现状）。**这让 `AgentHandle` 与创建/恢复选项在自称类型参考的目录中不可见，生成的 `Types:` 页脚也无法链接它们。

## 后果

- 哪一页记录某类型可由 `packages/<group>/` 预测；子系统 README 是由测试强制的完整索引。
- 每个包分组都会将其子系统拥有方或合理的缺席原因暴露给评审，且 `verify-subsystem-pages` 会拒绝未分类的新增项和陈旧豁免。
- 生成的签名页脚链接 agent 所有权词汇，而不是静默豁免。
- `verify-type-equiv` 的 1:1 manifest（元数据清单）保证每个粘贴单一归属；重复的 `SessionEvent` 粘贴已移除。
- [原目录 Agent Note](../../archived/process/2026-06-20-core-data-structures-catalog.md) 仍拥有 `ts type-equiv` 漂移检查机制；此处仅取代其页面范围界定规则。
