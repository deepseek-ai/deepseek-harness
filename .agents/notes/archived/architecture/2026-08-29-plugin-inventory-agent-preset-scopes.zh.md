# Agent Note: 插件清单携带每个 Agent 预设的组合

Status: implemented
Archived: 2026-09-04

[English](2026-08-29-plugin-inventory-agent-preset-scopes.md) | 中文

## 问题

[按会话的 agent preset](2026-08-03-per-session-agent-presets.zh.md) 把所有模型侧行移到了 agent 平面，而设置页的插件列表仍只投影 `ctx.loader.entries()`。这个表面因此看不见会话实际运行的插件——直接 plug 的预设子树从不出现在 Loader 条目里——还对其余部分构成误导：web overlay 刻意的 `disabled: true` 墓碑（`tool-bash`、`tool-fs`、`plan-mode`……）渲染成二十多行看似单纯"已停用"的条目，而同名模块在每个标准模式会话里运行。旁边，通用设置还有一个默认预设下拉，与名单分区自己的设为默认动作写同一个 `agent-presets.default` 字段——同一事实两个编辑器，其中一个还看不见它在选择的名单。

## 决定

**清单同时陈述两个平面。**`pluginInventory/list` 增加可选的 `agentPresets` 块——每个名单预设一组，含 id、trust、显示名、默认标记、健康状态与压平的组合行——由新增的 `AgentPresets.compositionInventory()` 提供：已有存活 standing mount 的预设由其最新世代的 Loader 条目作答——匹配限定在本运行时自己的 root 内，同进程的第二个 Cordis 运行时不会替它作答；即使文件事后损坏也照常作答（挂载才是会话实际运行的组合，broken 裁决只适用于无人组合的预设）——开机以来从未被组合的预设由其组合文件作答。`dsh-host-plugin-inventory` 经 `ctx.get('agentPresets')` 把名单当作可选伙伴解析（即 `plugin-package-inventory-deepseek` 的模式），自己只把根 Fiber 状态映射到公共阶段词汇，因此没有名单的部署继续只提供 Loader 条目、字段缺席。

**文件答案靠求值而非猜测，且读取从不挂载。**`!!js` disabled 门是平台/环境条件，[Loader 自己在每次挂载决策时都会求值](2026-08-11-loader-entry-disabled-interpolation.zh.md)，因此文件读取用 Loader 上下文对它们求值，报告本机挂载会做出的决定；求值器拒绝的门保持 `'conditional'` 并携带表达式文本供展示。该读取只解析和求值——不 import、不组合——所以列出所有预设的插件不会激活其中任何一个，回归测试钉住完整清单读取后 `livePresetMounts()` 为空。搭这个表面还暴露了反向泄漏：`EntryTree` 的构造器把每棵新树挂到最近拥有者 Loader 条目的 `subtree` 槽上，于是第一个 standing mount 把整棵预设组合挂在了 roster 自己的行下，根 `loader.entries()` 把它当宿主条目走了一遍。`PresetTree` 现在归还该槽位，恢复 standing mount「不在 Loader 里」的书面契约；回归测试钉住挂载前后根条目列表逐项相同。

**列表按作用域分组，误导行获得自己的状态。**预设组在前、可折叠且默认展开，其切换器是通用设置同款的「选择胶囊 + 菜单」控件，只改显示、初始停在默认预设且不写任何设置——查看 `minimal` 绝不能改变新会话运行什么。预设名经 `dsh-agent-presets/display` 的共享 `presetDisplayText` 纯函数解析——组正是为此携带 `trust`，而 inline-safe 纯模块是同时满足客户端打包纯度门（禁止跨插件运行时导入）与 typert client 分析器（不新增 Context 服务面）的接缝——内置预设跟随当前语言字典，用户自建元数据保持不翻译。全局组随后且默认收起，失败行浮在最前；一个全局停用、而同一模块标识至少有一个预设行实际启用的条目，就地标记为预设提供并在详情里列出启用它的预设——用第三种状态取代引发这一切的笼统"已停用"，并且刻意不做成子分组：上方的预设组已经把这些插件按组合展示，一个复述它们的第二个聚簇理应被移除。状态圆点只为存活的根 fiber 渲染——文件态的行只带启停标签，未挂载的预设不会读作一列灰色的谜之圆点。提供者规则严格取 `enabled === true`：把条件声明也算作提供者，会替 `tool-pwsh` 在 POSIX 上宣称一个它从不兑现的按会话提供。搜索横跨两组、强制撑开分组，并指出未选中预设里的匹配。

**通用设置行是删除，不是搬家。**默认值保留两个仍能作用于它的表面——名单分区的设为默认（名单可见）与新会话 chip（针对即将开始的会话）——因此 `ui-agent-preset` 删掉该行、它的菜单以及 settings store 的写入/可写性半边，后者收敛为标题标签读取的展示名单 store。

## 考虑过的替代方案

**把每个预设都渲染成常开分节。**四个内置预设已把约 100 行压到折叠线以下；切换器保持一次一个组合可见，行级的提供者详情与搜索指引保留了全展开布局想买到的跨作用域答案。

**文件态门保持不求值（首次挂载前一律 `conditional`）。**诚实，但重演了本次要消除的误导：冷启动的宿主上，默认预设的 `tool-bash` 读作"条件启用"，其全局行在第一个会话挂载预设之前退回单纯的"已停用"。

**在 Agent 预设分区做结构化组合查看器。**同一批行的第二个家；分区保留面向作者的原始 YAML 查看器，插件列表拥有结构化视图。

**启停开关随本次一起做。**把行的 `disabled` 写回自定义预设的 `agent.cordis.yml` 需要保注释的局部 YAML 编辑、"对新会话生效"的提示，以及内置预设的复制后编辑路径——刻意留作独立改动；本次只做读侧真相。

## 后果

搜索 "bash" 现在一屏回答引发本次改动的问题：在标准模式里启用、在全局平面被停用处按会话提供、只有真的无人启用之处才是单纯的已停用。线上快照的行启停是联合类型 `boolean | 'conditional'` 并携带门表达式，settings-chrome 的 golden 钉住分组布局。`ui-agent-preset` 失去 `AgentPresetRow` 与 `PresetMenu`；`settings.agentPreset` 文案命名空间声明移到插件入口，`settings-chrome` 的英文场景改用导航标签而非已删除的行来探测 locale 解析。
