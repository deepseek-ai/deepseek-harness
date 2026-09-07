# Agent Note: Shared client control primitives

Status: implemented

[English](2026-09-05-shared-client-control-primitives.md) | 中文

## Problem

客户端功能插件通过 slot 组合，彼此从不 import 对方的值，因此 `@deepseek-ai/dsh-client-ui-primitives` 是它们共享 React 组件的唯一通道。在某个功能包内部长出来的控件，对下一个需要同样东西的包不可见，而复制它的标记与 CSS 是当时最省事的做法。三类控件已经这样分叉：36×20 的开关只存在于 `ui-settings-plugins`；只读胶囊徽章在 `ui-agent-preset`、`ui-settings-plugins`、`ui-settings-plugin-inventory` 里被分别声明了五次，带着两种圆角和各自编写的配色；插件相位状态点在 `ui-settings-plugin-inventory` 里被重新实现，就在它所复制的共享 `StateDot` 旁边。

修复所需的两半，作者当时一半也拿不到。没有任何清单要求他们在写控件前先看 `ui-primitives`，而这个包也没给他们可看的东西：README 只列了六个源文件，包却导出了四十多个符号。

## Decision

**第二个客户端包需要的控件，住在 `ui-primitives`。** 这条规则是对作者的引导，不是门禁：功能包在需求确实特殊时仍可以自己写组件，下面的[保留在原包的控件](#what-stays-local)记录了本次改动中的这些例子。规则禁止的是复制——控件已经存在时，作者要么用它，要么把那处有意的差异提升成一个 prop。

`Tag` 是只读胶囊徽章。几何锁定在 `ui-agent-preset` 确立的尺寸：`999px` 圆角、`1px 8px` 内边距、11px 字号配 17px 行高、500 字重、`inline-flex`、不换行。单个闭合的 `TagTone` 联合选择配色，每个成员都因为有已发布的调用点需要它而存在：`outline` 与 `solid` 来自 agent preset 区块，`neutral` 与 `quiet` 来自插件设置字段，`success`、`info`、`warning`、`danger` 来自插件清单的启用标签。与所有 Cordis-free 原语一样，这个组件不自带任何文案。

`Switch` 是双态开关，采用 `ui-settings-plugins` 确立的 36×20 轨道与 16px 滑块。`label` 必填且没有默认值，渲染点无法省略无障碍名称；`title` 在部署禁用该控件时承载锁定原因。

`StateDotState` 增加 `idle`，一个静态灰点，与 `done`、`warning`、`error` 采用同样的光晕加实心核结构。插件清单的 `pending` 与 `unloading` 相位表示没有进行中的活动，原有四态没有对应成员；没有 `idle`，这两个相位会彻底失去标记。这次增补对已经消费 `StateDot` 的八个包是安全的：它们各自从自己的闭合状态联合**产生** `StateDotState`，没有任何一个对 `StateDotState` 本身做 switch。

**`ui-primitives` README 里的组件目录，是这条规则得以可用的前提。** 它列出每个导出组件的用途，以及它不适用的场合，并点名三组容易混淆的配对：`Tag` 与 `Pill`、`DisclosureRow` 与卡片式折叠、包内的 `FoldToggle` 与对外导出面。`Pill` 是可选中的胶囊按钮——它接受 `active` 与 `onClick`，用于视图切换与筛选器；`Tag` 是只读徽章，两者都不接受。`Pill` 自己的头注释此前把自身宣传为可用作徽章，与目录互相矛盾，现已改掉。

规则写在 [packages/client/AGENTS.md](../../../../packages/client/AGENTS.md) 新组件清单的第一步，[docs/web-styling.md](../../../../docs/web-styling.zh.md) 指向该目录，让从样式一侧进来的作者也能到达。

## 如何找出重复

按名字搜会漏。`.badge`、`.tag`、`.chip`、`.configTag` 找不到以角色而非外观命名的胶囊——`PluginCard` 的未保存标记叫 `.pending`，而它的规则与两个文件之外的徽章逐字节相同。能找出它们的是几何特征：同时带有 `border-radius: 999px` 与 `padding: 1px 8px` 的 CSS Modules 规则。本次改动后，这个特征恰好匹配两条规则：`Tag` 本身与下面那个损坏徽章。未保存标记只剩一个 `flex: none` 布局类，已不再匹配该特征。

<a id="what-stays-local"></a>
## 保留在原包的控件

机械搜索会把下面这些控件归到被提升的那三类里。它们留在各自的包中，因为那种归并只是表面相似：

- **`ui-trajectory` 的工具栏开关**带 `role="switch"`，但它是 88px 宽的带标签控件、轨道内联，而且当前渲染为 `hidden`。它和 `Switch` 不是同一个部件。
- **`ui-schedule` 的状态点**是表示下次运行的静态蓝点，逾期转为琥珀色。`StateDot` 没有静态蓝——它唯一的蓝是 `ongoing`，一个动画像素方阵——日程列表里每行一个动画，既说错了含义也说错了观感。
- **`ui-plan` 的模式 chip** 与 **`ui-conversation` 的 `ReferenceChip`** 都是可交互的：前者是警告色调的按钮，带 hover、focus、disabled 与关闭操作；后者是带自有截断逻辑的 Lexical 原子节点。两者都不是只读徽章。
- **`ui-trajectory` 的单元格 tag** 与 **`ui-user-questions` 的推荐徽章**使用各自的几何——一个是表格密度下的 6px 圆角，一个是侧栏强调色上 600 字重的 6px 圆角。把它们塞进胶囊基准，改掉的是有意的设计，不是意外的分歧。
- **`TerminalBlock` 的退出状态胶囊**保持为静态 `Pill`。它落在 24px 的命令行上、用的是 pill 自己的几何，`Tag` 的 11px 胶囊放不进那一行。只读与可选中的区分是通常的判据，但这一处由尺寸决定，目录里也是这么写的。
- **`ui-agent-preset` 的损坏徽章**共用胶囊几何，但带着没有第二处使用的实底错误色填充，而且它是自带提示元素的悬停锚点。改用 `Tag` 就得在功能包样式表里保留一份配色覆盖，并依赖跨文件 CSS 顺序来让它生效。

## Alternatives considered

**做一个 `SettingsCard` 原语。** 否决。`.card` 出现在十五个包里，但只有三处带设置页语义，而这三处的差异在行为而不在外观：`ui-settings-plugins` 的 `PluginCard` 暂存编辑，且只在 Host 确认保存后才折叠；`ui-agent-preset` 的卡片可选中；插件清单的卡片是只读的。`PluginCard` 自己的头注释已经记录了它为何不能使用共享折叠行。单个组件将不得不通过 props 接纳全部三种行为，而没有任何一个调用方会用到其中一种以上。

**加门禁，拒绝 `ui-primitives` 之外的 `role="switch"` 或 `.switch` 规则。** 否决。目标是让作者复用已有的东西，不是阻止他们构建。门禁会挂掉一个确实有特殊控件的包——`ui-trajectory` 的带标签工具栏开关正是这种情况——而误拒的代价落在最没法跟它讲道理的作者身上。目录加清单条目针对的是真正的失败原因：作者不知道那个控件存在。

**用额外的 `Tag` props 保留现有的每一种外观。** 否决。插件清单的 5px 圆角与 agent preset 的胶囊是同一类标签的两种形状，两处差异都不是决定出来的。两个都留会把一次意外固化进公开联合，并且让下一个作者去猜该挑哪个。

**扩展 `Pill` 而不是新增 `Tag`。** 否决。`Pill` 高 24px、圆角 12px、字号 12px；徽章基准更密也更圆。合并会产生一个尺寸取决于是否传了 `onClick` 的组件，并抹掉只读与可选中的区分——而目录正需要这个区分来回答"我该用哪个"。

**给 `Tag` 设计 `variant × tone` 双轴 API。** 否决。三个 variant 乘六个 tone 描述十八种组合，其中八种会发布，而且它允许调用方请求没有定义外观的组合。扁平的八成员联合把每个值映射到恰好一种已发布外观。

**让 `pending` 与 `unloading` 不渲染点，而不是新增 `idle`。** 否决。这两行今天显示灰点，在一个目的是统一呈现的改动里把它删掉，等于从清单中拿走信息。

**把复用规则写进根 `AGENTS.md`。** 否决。这条规则只管 `packages/client`，而根文件正好处在 `scripts/doc-budgets.manifest.json` 给它的 1950 词上限上，写在那里就必须挤掉一条不相干的仓库级规则。

## Testing

`Tag`、`Switch` 与扩展后的 `StateDot` 在 `packages/client/ui-primitives/tests` 中各有组件测试，处于每文件 100% 覆盖率门禁之内。`StateDot` 的配色通过读取其样式表来钉住：CSS Modules 在组件测试里解析为类名映射，因此某个状态缺了配色规则时会落到继承色上，而任何渲染断言都不会察觉。

迁移后的渲染点保留各自包内原有的测试，未作改动。web e2e 的 golden 是 ARIA 快照，完整的 replay web 套件无需重录即可通过，因为这次迁移保住了每一个 role、无障碍名称与状态——`Switch` 保留带 `aria-checked` 的 `role="switch"`，而由于 `StateDot` 是 `aria-hidden`，插件清单的相位点把 `role="img"` 名称保留在外层包裹元素上。

这同时也是自动化证据的边界。本仓库没有任何门禁比较像素，因此胶囊几何、状态点光晕与字重变化，只能由评审对照 PR 中的明暗两套截图来确认。

## Consequences

- 新的客户端控件现在有一处可查、一处可加，而目录把这次查询变成读一个文件，而不是在四十多个导出上 `grep`。
- `TagTone` 有八个成员，因为发布了八种外观。加第九个需要一个真的需要它的渲染点，而不是一个对称性论证。
- 插件清单的标签从 5px 矩形变为胶囊，其中"已停用"标签的底色从 `--dsw-alias-bg-layer-1` 变为 `neutral` 色调的 `--dsw-alias-bg-module-platform`，由近乎透明变成可见的灰底。相位点获得光晕，并在 `loading` 与 `unloading` 两个相位动画。插件设置字段中"未配置"徽章的字重从 400 改为基准的 500。这些都是有意的视觉变更，记录在此，以免后来的读者把它们当成回归。
- 本次迁移移除了一个 `#b45309` 字面量。插件清单的 `conditional` 标签写的是 `var(--dsw-alias-state-warning-primary, #b45309)`，而这个别名并不存在——真正的 token 是 `--dsw-alias-state-warn-primary`——所以明暗两套主题一直在绘制那个被 [docs/web-styling.md](../../../../docs/web-styling.zh.md) 禁止的硬编码兜底色。
- 这条规则无法被机械检查。将来的作者仍然可以复制一个控件，只有评审能拦住。这是不设门禁所接受的代价：另一条路会拒绝正当的工作，而上面那份保留在原包的清单就是正当工作确实存在的证据。
- `ui-primitives` 多出两个各自只有一个消费方的组件。开关尤其如此，提升它是因为它是一个通用控件，也因为正在进行中的插件管理工作会采用它，而不是再加两份拷贝。
