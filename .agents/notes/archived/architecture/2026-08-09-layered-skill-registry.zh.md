# Agent Note: skill 注册表由宿主持有并按 scope 分层

Status: implemented
Archived: 2026-09-04

[English](2026-08-09-layered-skill-registry.md) | 中文

## 问题

agent-preset stack 曾把整个 skill 能力——注册表、本地提供方和 `skill` 工具——搬进每个 preset 的 `isolate` realm，理由是"agent 拥有哪些 skill"属于 agent 平面的选择。这一框架混淆了两个不同的问题：*部署*供给哪些 skill，与*agent*是否消费它们。repository 插件的 prepared wrapper 声明 `inject: ['skills']` 并把它的 skill 根目录挂载为宿主平面的提供方；web 与 headless profile 不再组合宿主注册表后，该 wrapper 永远等待，repository-plugin e2e 因而挂死，当时通过删掉 fixture 的 skill 根目录绕过。按 preset 的 realm 注册表还让网关的 skill 列表依赖存活 agent——冷会话的 `/` 弹窗根本没有注册表可读。

工具注册表从未有过这个问题：它是一个宿主单例，基于 `dsh-scope` 按 scope 分层，因此部署级工具（MCP 服务器、插件 entry）注册进全局层，preset 的行注册进该 preset 的层。

## 决定

`SkillRegistry` 采用同一形态。它持有 `ScopedLayers<SkillLayer>`；`registerProvider()` 与 `register()` 落入调用方上下文 scope 对应的层——宿主行与 repository 插件落入全局层，preset 的 `skill-filesystem`（由常驻组合挂载，其上下文携带该 preset 的 scope key）落入该 preset 的层。提供方名称在每层内唯一而非进程级唯一，这正是让每个 preset 都能挂载自己的 `local` 提供方的前提。

读取通过 `SkillViewOptions` 携带观察 scope（调用中的 agent，agent 本身就是自己的 scope key）。注册表将全局层与该 scope 的链合并：**最近层直接赢得重名，rank 只在单层内裁决重名**——即工具注册表的遮蔽规则。曾考虑跨层 rank 合池并予以否决：rank 的设计前提是各来源彼此知情；在全局池下，后安装的 repository 插件可能凭注册顺序平手规则静默顶掉 preset 自带的同名 skill，远程改变 preset 的行为。最近层优先让组合的行为由其作者决定。

发现缓存以解析后的 scope 链加一个修订计数为键，因此空会话重组——只重设 agent scope key 的父级、不触碰注册表——对下一次读取立即可见。

组合随之调整：web-app bundle 重新启用 base 的 `skill` 注册表行（只有 `skill-filesystem` 与 `tool-skill` 仍归 preset），preset 组合拆掉 `isolate: skills` realm，改为直接落在宿主注册表上的平铺行。网关的 skills 域以 presenter scope 读取宿主注册表——存活 agent，否则记录在案的 preset 的 standing key——冷会话由此列出其组合真正供给的目录而不再报错；`serviceFor` 分支保留，兼容仍以 realm 自挂注册表的组合。

## 影响

**部署级 skill 会到达每个挂载 `tool-skill` 的 preset 会话。**repository-plugin e2e 的 skill 根目录与断言已恢复；shipped-Web e2e 证明 badge 行（同一种宿主注册形态）汇入 standard preset agent 的目录，而宿主视图保持仅全局。

**层可见性与消费仍是两个独立选择。** `minimal` agent 原则上可读全局层，但不组合 `skill` 工具——agent 是否拥有 skill 依旧由 preset 通过挂载或省略 `tool-skill` 决定。

**提供方选项仍是借用的调用方对象。**`SkillViewOptions` 扩展 `SkillLookupOptions`；注册表消费 `scope`，提供方只从同一个只读对象中读取自己的契约，保持既有的借用恒等保证。

**TUI profile 不受影响。**所有行都在宿主时只有一个（全局）层，合并视图等于旧的单注册表视图，rank 行为不变。

**跨层遮蔽是静默的。**层内败者照旧记录日志；较近层顶替较远层的名称沿用工具注册表的惯例，不记录。注册表仍不提供检查被遮蔽定义的 API。

## 曾考虑的替代方案

**跨全部可见层的 rank 合池。**忠实于单注册表的优先级，但跨层平手按注册顺序裁决（启动期提供方永远赢过常驻挂载），preset 自带 skill 可能被它看不见的部署变更顶掉。因组合稳定性否决；见"决定"。

**保留按 preset 的 realm 注册表，把 repository skill 作为目录交给 preset 的提供方扫描。**wrapper 的 `inject: ['skills']` 契约仍然破损（或者按 profile 分叉 wrapper），发现配置在每个 preset 里重复，冷会话依旧无处可读。否决。
